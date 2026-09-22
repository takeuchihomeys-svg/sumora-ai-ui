// app/lib/promise-tracker.ts
// お客様への約束（こちらがこれからする事の宣言）を拾い、果たしたか・遅れているかを見る（純関数・DB 依存なし）。
//
// 2026-09-22 竹内「約束を大切に、どれだけ約束しているか。お客さんとの約束のLINE。
//   約束する場面なら約束するようにブレインを強化」
//
// ■ 実測（scripts/audit-style-promise.ts / audit-style-promise-detail.ts・直近180日・スタッフの手打ちの返信）
//   約束を含む返信 56.5%（1,785/3,158）。成約した会話では 60.5%。
//   会話あたりの約束: 成約 16.2件・果たした 88.9%（21会話） ／ それ以外 7.7件・果たした 78.9%（268会話）
//     → 成約する会話は、約束が約2倍で、約束を守っている。
//   種類ごと（果たした＝14日以内に、こちらの発言に結果の報告・送付の形跡がある）:
//     物件探し  1,010件 果たした82.9% 中央値 9.6時間 90%で 65.7時間 催促 1.2%
//     確認        647件 果たした70.8% 中央値 5.7時間 90%で116.5時間 催促 2.3%
//     見積書      256件 果たした92.2% 中央値 2.5時間 90%で 48.1時間 催促 0.4%
//     資料の送付  162件 果たした79.0% 中央値18.1時間 90%で185.4時間 催促 1.2%
//     ご連絡      152件 果たした55.9% 中央値52.5時間 90%で196.4時間 催促10.5%  ← 一番守られていない・一番催促される
//     交渉         83件 果たした77.1% 中央値11.5時間 90%で 88.0時間 催促 4.8%
//   AI 下書き → 実送信（3,049組）: 約束を AI だけが書いてスタッフが消した 487 ／ スタッフだけが書いた 193。
//     消された上位: 確認 204（結果を報告する回に「確認します」・聞かれていない確認）／お気に召されましたら〜 178／物件探し 132
//     書けていない上位: 交渉 21（AI 12）＝ AI は交渉の約束を書き落とす
//
// ⚠ 判定は測った時と同じ関数（監査スクリプトはここを import する＝四者同名）。
//   上の率は「お客様へのお願い（〜の程よろしくお願い致します）」を除く前に測った値（除いた後の全件監査は scripts/audit-open-promises.ts）。
//   全件監査（直近14日・106会話）: 約束260件・果たした82.7%・遅れ7／遅れ気味7／新着・審査待ち14／記録なし（公式LINEから返信）6

export const PROMISE_RE = /(?:確認|ご連絡|連絡|お送り|送付|ピックアップ|お探し|探させ|交渉|作成|手配|ご案内|お調べ|調べ|抑え|押さえ|お伝え)[^\n。！!]{0,14}(?:させて(?:頂|いただ)きます|致します|いたします|します)(?!でしょうか)/;
export const PROMISE_DEADLINE_RE = /(?:本日中|今日中|明日|明朝|明後日|[0-9０-９]{1,2}時|[0-9０-９]{1,2}[\/／月][0-9０-９]{1,2}|今週|来週|週明け|月曜|火曜|水曜|木曜|金曜|土曜|日曜|午前中|午後|夕方|夜)/;
export const PROMISE_NEXT_RE = /(?:確認|ピックアップ|出)(?:でき|出来)?次第/;

/** 本文から約束の文を取り出す（過去形＝済んだ報告は除く） */
export function promiseSentences(text: string | null | undefined): string[] {
  return (text ?? "").split(/\n|(?<=[！!。])/).map((s) => s.trim())
    .filter((s) => PROMISE_RE.test(s) && !/(?:致しました|させて(?:頂|いただ)きました|しました)/.test(s)
      // お客様へのお願い（「お送りの程よろしくお願い致します」「確認してお願いします」）は約束ではない（全件監査で見つけた誤り）
      && !/の程|お願い(?:致|いた)?します|お願いします/.test(s));
}

export type PromiseKind = "交渉" | "物件探し" | "見積書" | "条件つきの提案" | "確認" | "内覧・ご案内" | "申込・押さえる" | "資料の送付" | "ご連絡" | "その他";

export function promiseKind(s: string): PromiseKind {
  if (/交渉/.test(s)) return "交渉";
  if (/ピックアップ|お探し|探させ|新着/.test(s)) return "物件探し";
  if (/見積/.test(s)) return "見積書";
  if (/お気に召され|よろしければ/.test(s) && /ご案内|抑え|押さえ|申込/.test(s)) return "条件つきの提案";
  if (/確認/.test(s)) return "確認";
  if (/ご案内|内覧/.test(s)) return "内覧・ご案内";
  if (/抑え|押さえ|申込/.test(s)) return "申込・押さえる";
  if (/お送り|送付/.test(s)) return "資料の送付";
  if (/ご連絡|連絡|お伝え/.test(s)) return "ご連絡";
  return "その他";
}

/** お客様が先に動く条件つきの約束（お客様の番。こちらの遅れではない）: 「お送り頂き次第」「URL お送り頂けましたら」「よろしければ」「お時間厳しい場合」 */
export const CONDITIONAL_ON_CUSTOMER_RE = /(?:頂|いただ)(?:き次第|けましたら|ければ|きますと|けると)|よろしければ|お気に召され|場合(?:は|、)?/;
/** 相手次第の約束（新着が出次第・審査の進捗あり次第）＝遅れではなく待ち */
export const WAITING_ON_OTHERS_RE = /出次第|で次第|随時|新着|(?:進捗|結果|回答|連絡)(?:が)?(?:あり|出)次第|審査/;
/** 管理会社・保証会社への連絡（お客様が結果を待つ約束ではない）: 「管理会社にお伝えいたします」「免許証ない旨ご連絡させていただきます」 */
export const THIRD_PARTY_RELAY_RE = /(?:管理会社|オーナー|保証会社|大家)(?:様)?(?:に|へ)(?:も)?(?:ご連絡|お伝え|連絡|伝え)|旨(?:を)?(?:ご連絡|お伝え)/;
/** 追いかける種類（お客様が結果を待つ約束）。内覧のご案内・条件つきの提案・申込は「お客様の返事待ち」なので追わない */
export const TRACKED_KINDS: ReadonlySet<PromiseKind> = new Set(["物件探し", "確認", "見積書", "資料の送付", "ご連絡", "交渉"]);

/** 果たした形跡（後のこちらの発言に結果の報告・送付がある）。測った時と同じ条件 */
export const PROMISE_DONE_RE = /確認(?:させて(?:頂|いただ)きました|致しました|しました)|確認しましたところ|募集中|募集終了|\[画像\]|ご査収|お送りさせて(?:頂|いただ)きました|交渉(?:させて(?:頂|いただ)きました|の結果|したところ)/;

/** 約束の話題（確認・ご連絡・交渉の対象）。報告にこの語が出てきたら、その約束を果たしたとみなす */
const PROMISE_TOPIC_RE = /一番手|番手|お部屋止め|申込|代理契約|名義|ペット|駐車場|駐輪|バイク|入居(?:日|時期|可能日)?|退去|募集状況|空室|空き状況|保証会社|審査|更新料|家賃|管理費|初期費用|礼金|敷金|フリーレント|設備|エアコン|インターネット|ネット|鍵|内覧|楽器|二人入居|同棲|法人/;
/** 報告の形（結果を伝えている） */
const REPORT_FORM_RE = /(?:となります|となりました|完了|取れ|でした|ございます|ございません|御座います|おります|可能|不可|大丈夫|とのこと|との事|頂けます|いただけます|出来ません|できません)/;

/**
 * その約束を、後のこちらの発言で果たしたか。
 * 2026-09-22 YUMA 再現: 「代理契約可能か確認出来次第ご連絡」の後に別件の物件送付（[画像]・ご査収）があると、
 *   測った時の定義（PROMISE_DONE_RE・話題を問わず最初の報告）では果たした扱いになり、遅れが見えなかった。
 *   追いかける時は、物件探し・資料・見積書は送付の形で、確認・ご連絡・交渉は**約束の話題が報告に出てきた時**だけ果たしたとする
 */
export function isPromiseKept(kind: PromiseKind, sentence: string, laterStaffTexts: readonly string[]): boolean {
  const later = laterStaffTexts.join("\n");
  if (kind === "物件探し" || kind === "資料の送付") return /\[画像\]|https?:\/\/|ご査収|ピックアップさせて(?:頂|いただ)きました|お送りさせて(?:頂|いただ)きました/.test(later);
  if (kind === "見積書") return /見積|初期費用：|初期費用さらに/.test(later);
  const topic = sentence.match(PROMISE_TOPIC_RE)?.[0];
  if (!topic) return PROMISE_DONE_RE.test(later);
  // 報告での言い方（募集状況の確認の答えは「募集中となります」「募集終了」「申込が入っておりました」）
  const said = /募集状況|空室|空き状況/.test(topic) ? /募集状況|募集中|募集され|募集して|募集終了|募集に出て|空室|空いて|埋ま|申込(?:が)?入|退去予定/ : new RegExp(topic);
  return laterStaffTexts.some((t) => said.test(t) && REPORT_FORM_RE.test(t) && !promiseSentences(t).some((p) => said.test(p)));
}

/** 種類ごとの実測（時間）。中央値を超えたら「遅れ気味」、90% を超えたら「遅れ」 */
export const PROMISE_STATS: Record<string, { keptPct: number; medianH: number; p90H: number; nudgePct: number; n: number }> = {
  "物件探し": { keptPct: 82.9, medianH: 9.6, p90H: 65.7, nudgePct: 1.2, n: 1010 },
  "確認": { keptPct: 70.8, medianH: 5.7, p90H: 116.5, nudgePct: 2.3, n: 647 },
  "見積書": { keptPct: 92.2, medianH: 2.5, p90H: 48.1, nudgePct: 0.4, n: 256 },
  "資料の送付": { keptPct: 79.0, medianH: 18.1, p90H: 185.4, nudgePct: 1.2, n: 162 },
  "ご連絡": { keptPct: 55.9, medianH: 52.5, p90H: 196.4, nudgePct: 10.5, n: 152 },
  "交渉": { keptPct: 77.1, medianH: 11.5, p90H: 88.0, nudgePct: 4.8, n: 83 },
};

export type TrackMsg = { sender: string; text?: string | null; createdAt?: string | null; isAix?: boolean | null };
export type OpenPromise = {
  kind: PromiseKind;
  sentence: string;
  at: string;
  elapsedH: number;
  /** 期限の語（「明日」「9/30」「本日中」）が入っているか */
  hasDeadline: boolean;
  status: "期限内" | "遅れ気味" | "遅れ" | "待ち（新着・審査の結果次第）" | "記録なし（公式LINEから返信した可能性）";
};
export type PromiseTrack = {
  /** 直近14日にこちらがした約束（追いかける種類） */
  made: number;
  kept: number;
  open: OpenPromise[];
};

const WINDOW_MS = 14 * 86400_000;
const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);

/**
 * 会話（古い順）から、直近14日の約束と、まだ果たしていない約束を出す。
 * 果たした＝isPromiseKept（送付の約束は送付の形・確認/ご連絡/交渉は約束の話題が後の報告に出てきた時）。
 */
export function trackPromises(messagesOldestFirst: ReadonlyArray<TrackMsg>, now: number = Date.now()): PromiseTrack {
  const msgs = messagesOldestFirst.filter((m) => Number.isFinite(ms(m.createdAt)));
  let made = 0, kept = 0;
  const open: OpenPromise[] = [];
  msgs.forEach((m, i) => {
    if (m.sender !== "staff") return;
    const at = ms(m.createdAt);
    if (now - at > WINDOW_MS) return;
    for (const s of promiseSentences(m.text)) {
      const kind = promiseKind(s);
      if (!TRACKED_KINDS.has(kind)) continue;
      if (CONDITIONAL_ON_CUSTOMER_RE.test(s)) continue;   // お客様の番（こちらの約束の追跡に入れない）
      if ((kind === "ご連絡" || kind === "確認") && THIRD_PARTY_RELAY_RE.test(s) && !/次第|結果/.test(s)) continue;   // 管理会社への連絡だけ
      made++;
      const done = isPromiseKept(kind, s, msgs.slice(i + 1).filter((x) => x.sender === "staff").map((x) => x.text ?? ""));
      if (done) { kept++; continue; }
      const elapsedH = (now - at) / 3600_000;
      // 約束の後にお客様が2通以上話しているのに、こちらの発言の記録が1通も無い＝公式LINE（OA Manager）から返信した（webhook に届かない）。遅れと言い切らない
      const after = msgs.slice(i + 1);
      const unrecorded = !after.some((x) => x.sender === "staff") && after.filter((x) => x.sender === "customer").length >= 2;
      const st = PROMISE_STATS[kind];
      open.push({
        kind, sentence: s.slice(0, 80), at: m.createdAt ?? "", elapsedH,
        hasDeadline: PROMISE_DEADLINE_RE.test(s),
        status: unrecorded ? "記録なし（公式LINEから返信した可能性）" : WAITING_ON_OTHERS_RE.test(s) ? "待ち（新着・審査の結果次第）" : st && elapsedH > st.p90H ? "遅れ" : st && elapsedH > st.medianH ? "遅れ気味" : "期限内",
      });
    }
  });
  // 同じ種類は最新の1件だけ残す（同じ約束を何度も言い直している）
  const latest = new Map<PromiseKind, OpenPromise>();
  for (const p of open) latest.set(p.kind, p);
  return { made, kept, open: [...latest.values()] };
}

/** お客様の発言の場面ごとの「約束を入れる率」（手打ちの返信・直近180日。場面は sent-shape customerSceneOf） */
export const PROMISE_RATE_BY_SCENE: Record<string, { all: number; won: number | null; n: number }> = {
  "条件フォーム受領": { all: 91.5, won: 90.9, n: 153 },
  "条件提示": { all: 76.3, won: 70.0, n: 97 },
  "内覧の話": { all: 65.9, won: 80.8, n: 214 },
  "その他": { all: 56.5, won: 58.5, n: 895 },
  "断り・キャンセル": { all: 53.7, won: 54.5, n: 54 },
  "短い了承・お礼": { all: 53.7, won: 62.5, n: 354 },
  "検討中・一時保留": { all: 52.5, won: null, n: 61 },
  "質問": { all: 51.3, won: 58.3, n: 951 },
  "物件の画像・URLだけ": { all: 49.2, won: 33.3, n: 63 },
  "申込・審査・書類": { all: 48.7, won: 57.6, n: 316 },
};

const hStr = (h: number) => (h >= 48 ? `${Math.round(h / 24)}日` : `${Math.round(h)}時間`);

/**
 * ブレインに渡す【お客様との約束】。事実（今開いている約束・遅れ）と、実測（場面の約束率・成約との関係）だけを渡す。
 * どう返すか（途中経過を伝える・約束する・しない）はブレインが決める。
 */
export function buildPromiseBrainNote(track: PromiseTrack, scene: string | null): string {
  const lines: string[] = ["\n【🤝 お客様との約束（確定事実＋実測）】"];
  lines.push(`・この会話の直近14日: こちらの約束 ${track.made}件・果たした ${track.kept}件${track.open.length ? `・まだ果たしていない ${track.open.length}件` : ""}`);
  for (const p of track.open) {
    const st = PROMISE_STATS[p.kind];
    lines.push(`  - 【${p.status}】${p.kind}の約束（${hStr(p.elapsedH)}前${p.hasDeadline ? "・期限の語あり" : ""}）「${p.sentence}」`
      + (st ? `（実送信で果たすまでの中央値 ${hStr(st.medianH)}・90%で ${hStr(st.p90H)}）` : ""));
  }
  if (track.open.some((p) => p.status === "遅れ" || p.status === "遅れ気味")) {
    lines.push("  → 遅れている約束がある。今回の返信で、その約束の結果か途中経過（いつ頃ご連絡できるか）に触れるかを判断する（実送信で「ご連絡します」の約束は果たされたのが55.9%だけで、催促も10.5%と一番多い）。");
  }
  const r = scene ? PROMISE_RATE_BY_SCENE[scene] : undefined;
  if (r) lines.push(`・今回の場面「${scene}」でスタッフが約束（これからする事の宣言）を入れた率: ${r.all}%${r.won != null ? `（成約した会話 ${r.won}%）` : ""}${r.all >= 50 ? "＝入れる方が普通" : ""}`);
  lines.push("・成約した会話は約束が会話あたり16.2件・果たした88.9%（それ以外は7.7件・78.9%）。約束は果たせる事だけにする（AI が書いてスタッフが消した約束の上位は、結果を報告する回の「確認します」と、聞かれていない事柄の確認）。交渉の約束は AI が書き落としやすい（スタッフが足した21回・AI 12回）。");
  return lines.join("\n");
}
