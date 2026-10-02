// app/lib/final-check-gate.ts
// 最終チェック（LLM の3パス＋書き直し）が要る下書きかを決める（純関数・DB 依存なし・LLM なし）。
//
// 2026-10-02 竹内「いま全部ファイナルチェックしているので、ファイナルチェックが必要かどうかの監査をつけたら
//   APIも節約できるし、無駄がなくなる」
//
// ■ 線の引き方（誤削除0と同じ考え方＝見逃し0）
//   scripts/audit-final-check-gate.ts で、過去の最終チェック（例ごとの記録 reply_context_snapshot・
//   conversations.ai_draft_check・line_watch_turns）を「下書きの危なさ」で分け、LLM の段が実際に
//   見つけた事実・安全の指摘を1件ずつ目で読んだ。**見逃す本当の指摘が0になる所だけ**を skip にした。
//   ・下書きが「決まり文句だけ」（はい😊！！／何卒よろしくお願い致します！！／お気軽にご連絡ください！！ 等）
//     ＝金額・日付・時刻・物件名・号室・住所・宣言（〜させて頂きます）・約束が1つも無い
//   ・お客様の発言が「了承・お礼だけ」（ありがとうございます／わかりました／お願いします）＝問い・依頼・予定の変更が無い
//   この2つが両方そろう時だけ、LLM の段を省いても見つける物が無い（監査の数字はファイル末尾）。
//
// ■ 必ず全部チェックする（理由はそれぞれ）
//   ・自動に切り替えた会話（auto_send_enabled）… 自動送信の関所 canAutoReply は ai_draft_check の block を見るので、
//     チェックを省くと「止める目」が無いまま送られる（fail-closed）
//   ・センシティブ（クレーム・審査否決・キャンセル）… 既存の決まり
//   ・ブレインの enforcement_level=required … 既存の決まり
//   ・初回の返信 … 挨拶・会社の紹介が入る特別な文
//   ・決定論の検査に block がある … 修正ループが要る
//   ・申込以降の会話・会話の記録が読めなかった時 … 迷ったら全部チェック（fail-closed）
//   ・分からない物（決まり文句に無い文が1つでもある・お客様の発言を読めない）… 迷ったら全部チェック
//
// ■ 既定は影の運用（shadow）
//   FINAL_CHECK_GATE=on の時だけ実際に省く。既定（未設定）は判定を記録するだけで、今までどおり全部チェックする。

export const FINAL_CHECK_GATE_VERSION = "fc-gate-2026-10-02";

export type FinalCheckGateRun = "full" | "light" | "skip";

export type FinalCheckGateInput = {
  /** チェックにかける下書き（後処理の後・最終チェックの前） */
  draft: string;
  /** 未返信のお客様の発言（MSG_SEP でつないだ物で良い） */
  customerText: string;
  /** 確定したお客様の呼び名（「〇〇さん」の行を決まり文句として読むため） */
  customerName?: string | null;
  /** センシティブ案件（クレーム・審査否決・キャンセル）＝ route の sensitiveGateNote が空でない */
  isSensitive?: boolean;
  /** conversations.auto_send_enabled（自動に切り替えた会話） */
  isAutoSendConversation?: boolean;
  /** ブレインの enforcement_level が required */
  enforcementRequired?: boolean;
  /** 初回の返信 */
  isFirstContact?: boolean;
  /** 決定論の検査（runDeterministicChecks）に block がある */
  detBlock?: boolean;
  /** 申込以降の会話（post-apply.ts の判定） */
  postApply?: boolean;
  /** 会話の記録（auto_send_enabled・申込の記録）が読めなかった＝分からない物は全部チェック */
  stateUnknown?: boolean;
};

export type FinalCheckGateDecision = {
  run: FinalCheckGateRun;
  /** 判定の理由（日本語のキー・ログと監査で数える） */
  reasons: string[];
  /** 決まり文句に当たらなかった文（full の理由の中身・監査で目で読む） */
  unsafeSentences: string[];
  version: string;
};

/** 絵文字・感嘆符・句読点・空白を落として、文の骨だけにする */
export function normalizeSentence(s: string): string {
  return String(s ?? "")
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u{FE0F}|\u{200D}|\u{2063}/gu, "")
    .replace(/[！!？?。、,，．.\s　〜~ー]+$/g, "")
    .replace(/[！!。、\s　]+/g, "")
    .trim();
}

/** 文に分ける（改行・。！!？?） */
function splitSentences(text: string): string[] {
  return String(text ?? "")
    .split(/\n|(?<=[。！!？?])/)
    .map((x) => x.trim())
    .filter((x) => normalizeSentence(x).length > 0);
}

// ── 決まり文句（文の骨が丸ごと一致する時だけ安全）──
// 2026-10-02: 実送信・下書きの短い返信（scripts/audit-final-check-gate.ts の「決まり文句だけ」群）を読んで並べた。
//   ⚠ 「ご査収ください」「楽しみにしております」「お待ちしております（場所・日時つき）」は、送った物・決まった予定を前提にする
//     （何も送っていないのに書くと作り話になる）ので**入れない**。
const SAFE_SENTENCE_RES: RegExp[] = [
  // 受け止め・開口
  /^(?:はい|かしこまりました|ありがとうございます|ありがとう御座います|とんでもございません|とんでもないです|お世話になっております|いつもお世話になっております|こんにちは|こんばんは|おはようございます)$/,
  /^(?:ご連絡|ご返信|ご確認|ご丁寧に|お忙しい中)(?:頂き|いただき)?(?:誠に)?ありがとう(?:ございます|御座います)$/,
  // 締め
  /^(?:引き続き)?(?:何卒)?(?:よろしく|宜しく)お願い(?:致|いた)します$/,
  /^(?:それでは)?(?:一度)?失礼(?:致|いた)します$/,
  /^(?:また)?(?:何か)?(?:気になる点|ご不明点|ご不明な点|ご質問)(?:等|など)?(?:が)?(?:出て(?:き|来)ましたら|ございましたら|ありましたら)(?:、)?(?:何時でも|いつでも)?(?:お気軽に)?(?:ご連絡|お知らせ|ご相談)(?:ください|下さい)$/,
  /^(?:また|引き続き)?(?:何時でも|いつでも)?お気軽に(?:ご連絡|お問い合わせ|ご相談)(?:ください|下さい)$/,
  /^ごゆっくり(?:ご確認|ご検討)(?:ください|下さい)$/,
  /^(?:ご連絡|お電話|ご返信|ご返答)(?:を)?お待ちしております$/,
  /^お大事に(?:なさって|して)?(?:ください|下さい)$/,
];

/** 日時の語（本文に出るなら、お客様が同じ語を言っている時だけ許す） */
const TIME_WORD_RE = /本日|明日|明後日|今日|今週|来週|週末|[月火水木金土日]曜|午前|午後/g;

/**
 * 1文が決まり文句か。
 * 先頭の「〇〇さん」（お客様の呼び名）は外して読む（名前の誤りは決定論の検査 NAME_* が見る）。
 * 日時の語（明日 等）は、お客様が同じ語を言っている時だけ「明日のご連絡お待ちしております」の形で許す。
 */
export function isSafeBoilerplateSentence(sentence: string, customerText = "", customerName?: string | null): boolean {
  let s = normalizeSentence(sentence);
  if (!s) return true;
  if (/[0-9０-９〒]/.test(s)) return false;
  const name = normalizeSentence(customerName ?? "");
  if (name && s.startsWith(`${name}さん`)) s = s.slice(name.length + 2);
  else s = s.replace(/^[^\sさ]{1,12}さん(?=(?:お世話|気になる|何か|ご不明|引き続き|何卒|よろしく|宜しく|ありがとう|こんにちは|こんばんは|おはよう|また|お気軽))/u, "");
  // 「明日のご連絡お待ちしております」: お客様が同じ日時の語を言っている時だけ、語を外して読む
  const times = s.match(TIME_WORD_RE) ?? [];
  if (times.length) {
    if (!times.every((t) => customerText.includes(t))) return false;
    s = s.replace(TIME_WORD_RE, "").replace(/^の/, "");
  }
  return SAFE_SENTENCE_RES.some((re) => re.test(s));
}

/** 決まり文句に当たらない文を返す（空なら下書き全体が決まり文句だけ） */
export function unsafeDraftSentences(draft: string, customerText = "", customerName?: string | null): string[] {
  return splitSentences(draft).filter((x) => !isSafeBoilerplateSentence(x, customerText, customerName));
}

// ── お客様の発言が「了承・お礼だけ」か ──
const ACK_TOKENS_RE = new RegExp(
  [
    "ありがとうございます", "ありがとうございました", "ありがとう御座います", "ありがとう", "有難うございます",
    "わかりました", "分かりました", "かしこまりました", "承知(?:いた|致)?しました", "了解(?:です|しました|いたしました|致しました)?", "りょうかい(?:です)?",
    "(?:引き続き)?(?:どうぞ)?(?:よろしく|宜しく)(?:お願い)?(?:いた|致)?(?:します|しまーす|です)?", "お願い(?:いた|致)?します", "お願いしまーす",
    "はい", "ok", "おけ", "助かります", "助かりました", "確認します", "確認してみます", "見てみます", "拝見します", "お疲れ様です", "いえいえ", "こちらこそ",
    "(?:よろしく|宜しく)", "です", "ます",
  ].join("|"),
  "giu",
);

/**
 * お客様の発言（未返信の分）が了承・お礼だけか。問い・依頼・予定・画像・URL があれば false（迷ったら false）。
 */
export function isAckOnlyCustomerText(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (/[?？]|\[画像\]|\[動画\]|\[ファイル\]|https?:\/\//.test(t)) return false;
  if (t.replace(/\s/g, "").length > 60) return false;
  const rest = t
    .replace(/\([^)]{0,12}\)|（[^）]{0,12}）|\[スタンプ\]/g, "") // LINE のスタンプの文字（よろしく）等
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u{FE0F}|\u{200D}|\u{2063}/gu, "")
    .replace(ACK_TOKENS_RE, "")
    .replace(/[！!。、,，．.\s　〜~ーっッw笑🙇]+/gu, "");
  return rest.length === 0;
}

/**
 * 最終チェックの要否。
 *   full  … 今までどおり（決定論＋LLM 3パス＋必要なら書き直し）
 *   skip  … 決定論の検査だけ（LLM の3パスと書き直しを省く）
 *   light … 予約（今は返さない。監査で Sonnet の context_check だけ省く線は見逃しが出たため＝ファイル末尾）
 */
export function needsFinalCheck(input: FinalCheckGateInput): FinalCheckGateDecision {
  const reasons: string[] = [];
  const draft = String(input.draft ?? "");
  const customerText = String(input.customerText ?? "");
  const unsafe = unsafeDraftSentences(draft, customerText, input.customerName);
  if (!draft.trim()) reasons.push("empty_draft");
  if (input.isAutoSendConversation) reasons.push("auto_send_conversation");
  if (input.isSensitive) reasons.push("sensitive");
  if (input.enforcementRequired) reasons.push("enforcement_required");
  if (input.isFirstContact) reasons.push("first_contact");
  if (input.detBlock) reasons.push("deterministic_block");
  if (input.postApply) reasons.push("post_apply");
  if (input.stateUnknown) reasons.push("state_unknown");
  if (unsafe.length) reasons.push("draft_has_content");
  if (!isAckOnlyCustomerText(customerText)) reasons.push("customer_not_ack_only");
  if (reasons.length) return { run: "full", reasons, unsafeSentences: unsafe, version: FINAL_CHECK_GATE_VERSION };
  return { run: "skip", reasons: ["boilerplate_draft_and_ack_customer"], unsafeSentences: [], version: FINAL_CHECK_GATE_VERSION };
}

/** FINAL_CHECK_GATE=on の時だけ実際に省く（既定は影の運用＝判定を記録するだけ） */
export function finalCheckGateEnforced(env: Record<string, string | undefined> = process.env): boolean {
  return (env.FINAL_CHECK_GATE ?? "").trim().toLowerCase() === "on";
}
