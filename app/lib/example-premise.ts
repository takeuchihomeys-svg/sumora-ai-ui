// app/lib/example-premise.ts
// few-shot の手本（ai_reply_examples）を「その前提がこの会話にあるか」で選別する（純関数・DB 依存なし）。
//
// 【なぜ要るか】
// 手本は「お客様:／スモラ:」1ペアで見せるため、**前提（前返信の約束・送付済み物件・確定した内覧）が剥がれる**。
// LLM は場面を読まずに言い回しだけ写すので、前提の無い手本は必ず事故になる。
//
// 【2026-09-19 竹内（慶次事例）で見つけた穴】
// 慶次さん（条件変更の場面）に「**本日はご内覧頂きありがとうございました！！**」が生成された。
// この会話に内覧の事実は無い。出所は手本で、proposing の手本4,292件のうち **37件が内覧後のお礼**。
// その手本の顧客メッセージは「つきました！」「到着しました！」「お願いします！」「かしこまりました！」＝
// 慶次さんの「ありがとうございます／よろしくお願いします」と**埋め込みが近く、場面が違うのに引かれた**。
// 前提フィルタには 撮影・ご査収・現地到着・見積・審査・申込書類 の6つしか無く、
// **「内覧が完了した前提のお礼」が入っていなかった**ので素通りした。
//
// 【強化した点】
// 旧: 前提の有無を**直前スタッフ発言の語**だけで見ていた（語が窓から外れると前提なし扱い／あると誤って前提あり）。
// 新: **行動台帳の事実（場面）**を先に見る（viewingInvited / meetingPlaceSent / propertiesSentCount / estimateSent）。
//     台帳が無い経路（check-reply 等）では従来どおり語で見る＝どちらでも動く。
//     ＝ 設計知見「場面ラベル一致を必ず先頭」「決定論で算出できる値は LLM に選ばせない」
//
// 四者同名: ここの vocab ↔ derivePremiseLabel の注記 ↔ action-ledger の実行前提語ゲート ↔ final-check。

import {
  FORM_LABEL_RE,
  CUSTOMER_ESTIMATE_INTENT_RE,
  CUSTOMER_PROPERTY_REF_RE,
  CUSTOMER_ROOM_POSITIVE_RE,
  STAFF_ESTIMATE_PROMISE_RE,
  CUSTOMER_SCREENING_CONCERN_RE,
  CUSTOMER_APPLY_OR_DOC_RE,
} from "./line-reply-prompts";

/** 行動台帳から取る「場面の事実」。無い経路では undefined でよい（語での判定に落ちる） */
export type PremiseFacts = {
  viewingInvited: boolean;
  meetingPlaceSent: boolean;
  propertiesSentCount: number;
  estimateSent: boolean;
  /**
   * 直近の内覧の動き（打診・確定・到着・待ち合わせ・来店）からの経過日数。無ければ null。
   * 2026-09-19 竹内（慶次事例の続き）「内覧挨拶は当日にAIXからおこなうなら分かるが、
   *   今回の場合持ち越したことで変な文になっていた」→ **鮮度**で判定する。
   */
  daysSinceViewingMove?: number | null;
  /**
   * 2026-09-22 竹内（𝓡さん事例）: お客様が送ってきた物件が**全部こちらが前に送った物件**（own-property-match で照合済み）。
   *   この時「お送り頂きました物件の募集状況確認させて頂きます」の手本を見せると写す（YUMA で 3回中1回写した）。
   */
  ownPropertyReturnedAll?: boolean;
};

/** 内覧・来店の動き（打診・確定・到着・待ち合わせ） */
export const VIEWING_MOVE_RE =
  /内覧|内見|ご案内可能|待ち合わせ|待合せ|現地|ご来店|来店|着きました|つきました|到着|ご都合よろしいお日にち|直近ですと/;

/**
 * 「内覧のお礼」を書いてよい鮮度の上限（日）。
 * 実送信68通で測った: 直前N日以内に内覧の動きがある通数
 *   0.5日 44通 / 1日 51 / 2日 59 / 3日 62 / 5日 65 / 7日 67 / **14日 68（誤削除0）**
 * ＝ 14日を超えて内覧の動きが無い会話では、この型を手本に出さない。
 * （66/68通が「本日」＝当日の文。持ち越すと必ず嘘になる）
 */
export const VIEWING_THANKS_MAX_DAYS = 14;

/** 会話から「直近の内覧の動きからの経過日数」を出す（純関数。messages は順不同でよい） */
export function daysSinceViewingMove(
  messages: ReadonlyArray<{ text?: string | null; createdAt?: string | null }>,
  nowMs: number = Date.now(),
): number | null {
  let newest = -Infinity;
  for (const m of messages) {
    if (!VIEWING_MOVE_RE.test(String(m.text ?? ""))) continue;
    const t = m.createdAt ? Date.parse(m.createdAt) : NaN;
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  if (!Number.isFinite(newest)) return null;
  return Math.max(0, (nowMs - newest) / 86_400_000);
}

export type PremiseInput = {
  /** 直前のスタッフ発言＋AIX 履歴（従来の判定材料） */
  staffHist: string;
  /** 今回のお客様の発言 */
  customerMessage: string;
  /** 行動台帳の事実（あれば優先して使う） */
  facts?: PremiseFacts | null;
};

export type PremiseRule = {
  key: string;
  /** 手本の本文にこの語があれば「その前提が要る」 */
  vocab: RegExp;
  /** 今の会話でその前提が満たされているか */
  satisfied: (o: { staffHist: string; cust: string; facts?: PremiseFacts | null }) => boolean;
  /** 手本に付ける注記（LLM に「この前提が無ければ真似しない」と伝える） */
  label: string;
};

/**
 * 「内覧のお礼」を書いてよい場面か。
 * 2026-09-19 竹内（慶次事例の続き）: 内覧が**かなり前**なら書かせない。
 *   ①鮮度が分かるならそれが正（14日以内の内覧の動きがあるか）
 *   ②鮮度が取れない時は「一度でも内覧の話が出ているか」（台帳）
 *   ③台帳も無い経路（check-reply 等）は語で見る
 */
function viewingThanksOk(o: { staffHist: string; facts?: PremiseFacts | null }): boolean {
  const d = o.facts?.daysSinceViewingMove;
  if (d !== undefined && d !== null) return d <= VIEWING_THANKS_MAX_DAYS;
  if (o.facts) return o.facts.viewingInvited || o.facts.meetingPlaceSent;
  return VIEWING_MOVE_RE.test(o.staffHist);
}

/** お客様が自分で見つけた物件を送ってきた時だけの語（手本・ナレッジの両方の入口で同じ語を落とす＝四者同名） */
export const CUSTOMER_FOUND_PROPERTY_VOCAB = /お送り(?:頂|いただ)きました(?:物件|お部屋|[0-9０-９一二三四五六七八九十]件)|(?:募集状況|空室|空き状況)(?:を)?確認させて/;

export const PREMISE_RULES: PremiseRule[] = [
  {
    key: "shooting",
    vocab: /撮影/,
    satisfied: ({ staffHist, cust }) => /撮影|写真|動画|オンライン内見|オンライン内覧/.test(`${staffHist}\n${cust}`),
    label: "直前返信で室内撮影・写真送付を約束済み（現在の会話に同じ約束が無ければ真似しない）",
  },
  {
    key: "delivered",
    vocab: /ご査収|お送りした|お送りさせて頂きました/,
    satisfied: ({ staffHist, facts }) =>
      (facts ? facts.propertiesSentCount > 0 : false) ||
      /【画像】|お送りさせて頂きました|お送りしました|ピックアップしお送り|property_send|ご査収/.test(staffHist),
    label: "直前に物件・資料を送付済み",
  },
  {
    key: "arrived",
    vocab: /現地到着|到着しております|本日[0-9０-９]{1,2}時/,
    satisfied: ({ staffHist, facts }) =>
      (facts ? facts.meetingPlaceSent : false) ||
      /[0-9０-９]{1,2}\s*[/／月]\s*[0-9０-９]{1,2}.{0,10}[0-9０-９]{1,2}時/.test(staffHist),
    label: "内覧日時確定済み",
  },
  // 2026-09-19 竹内（慶次事例）で足した穴。「内覧が完了した前提のお礼」＝内覧の話が一度も無い会話では真似させない。
  // 線は実送信11,985通で測った: 当たる文68通。待ち合わせ案内だけを要求すると5通が誤削除（電話・来店で決めた本物）、
  // 内覧打診まで含めると誤削除0（action-ledger の viewing_thanks と同じ線＝四者同名）。
  {
    key: "viewing_done",
    vocab: /(?:本日|先日|昨日)[^\n。！!]{0,8}(?:ご内覧|内覧|ご見学|お時間)[^\n。！!]{0,10}(?:頂き|いただき|くださり|下さり)[^\n。！!]{0,8}(?:ありがとう|有難う)/,
    satisfied: ({ staffHist, facts }) => viewingThanksOk({ staffHist, facts }),
    label: `直近${VIEWING_THANKS_MAX_DAYS}日以内に内覧・来店がある（実送信66/68通が「本日」＝当日の文）。内覧していない・かなり前の会話では真似しない`,
  },
  {
    key: "estimate",
    vocab: /(?:御|お)?見積(?:書|り|もり)?/,
    satisfied: ({ staffHist, cust, facts }) =>
      (facts ? facts.estimateSent : false) ||
      CUSTOMER_ESTIMATE_INTENT_RE.test(cust) ||
      CUSTOMER_PROPERTY_REF_RE.test(cust) ||
      CUSTOMER_ROOM_POSITIVE_RE.test(cust) ||
      STAFF_ESTIMATE_PROMISE_RE.test(staffHist),
    label: "お客様が費用・見積を質問／特定物件を送付／内覧後前向き反応のいずれかが会話にある（①〜⑧フォームの⑦初期費用は該当しない）",
  },
  {
    key: "screening",
    vocab: /審査面|保証会社|独立系/,
    satisfied: ({ cust }) => CUSTOMER_SCREENING_CONCERN_RE.test(cust),
    label: "お客様が審査・保証の不安を自ら発言済み",
  },
  {
    key: "apply_docs",
    vocab: /申込書類|入居申込書|必要書類|身分証(?:の)?(?:お写真|コピー)/,
    satisfied: ({ cust }) => CUSTOMER_APPLY_OR_DOC_RE.test(cust),
    label: "お客様が申込意思を表明済み",
  },
  {
    // 2026-09-22 竹内（𝓡さん事例）: お客様が送ってきた物件が全部こちらの送った物件の時は、
    //   「お客様が見つけた物件」前提の手本（お送り頂きました物件の募集状況確認）を見せない。
    //   実送信: この場面でスタッフが募集状況確認を宣言したのは 0/9回（scripts/audit-own-property-returned.ts）
    key: "customer_found_property",
    vocab: CUSTOMER_FOUND_PROPERTY_VOCAB,
    satisfied: ({ facts }) => !(facts?.ownPropertyReturnedAll ?? false),
    label: "お客様が自分で見つけた物件を送ってきた（こちらが前に送った物件の送り返しではない）",
  },
];

/**
 * 前提の無い手本を落とすための正規表現。満たされていない前提の語だけを並べる。
 * どれも満たされていれば null（＝何も落とさない）。
 */
export function buildPremiseExcludeRe(o: PremiseInput): RegExp | null {
  const cust = (o.customerMessage ?? "").replace(FORM_LABEL_RE, "");
  const staffHist = o.staffHist ?? "";
  const parts = PREMISE_RULES
    .filter((r) => !r.satisfied({ staffHist, cust, facts: o.facts }))
    .map((r) => r.vocab.source);
  return parts.length ? new RegExp(parts.join("|")) : null;
}

/** どの前提が欠けているか（ログ・監査用。黙って落とさない） */
export function missingPremiseKeys(o: PremiseInput): string[] {
  const cust = (o.customerMessage ?? "").replace(FORM_LABEL_RE, "");
  const staffHist = o.staffHist ?? "";
  return PREMISE_RULES.filter((r) => !r.satisfied({ staffHist, cust, facts: o.facts })).map((r) => r.key);
}

/** 手本に付ける前提の注記（決定論で作る・LLM に選ばせない） */
export function derivePremiseLabel(reply: string): string {
  const labels: string[] = [];
  for (const r of PREMISE_RULES) if (r.vocab.test(reply ?? "")) labels.push(r.label);
  // 旧実装から引き継ぐ、ルールに紐づかない2つの注記
  if (/確認(?:でき|出来)次第/.test(reply ?? "")) labels.push("管理会社への確認事項が発生している");
  if (/ご都合よろしいお日にち/.test(reply ?? "")) labels.push("特定物件を推した直後");
  return labels.join("・");
}
