/**
 * お客様が送った「やり取りのスクショ」の中の文の話し手を読む（純関数・2026-11-21 作業員G・台帳 #468・brain_weaknesses 1494）
 *
 * 実物（伏せた形はテスト）: お客様が他社（申込先の不動産会社）からの返信のスクショを送り、続けて「キャンセルできたとおもいます」。
 *   スクショの中の「入居時期も含めて遅らせる形になりますでしょうか？」は**他社がお客様に聞いた事**で、こちらへの質問ではない。
 *   竹内さんは「他社のキャンセルが進んでいる」と読んで、管理会社に確かめて押さえる番にした。
 *   今までの見出し（IMAGE_TEXT_LABEL）は「物件の特定にだけ使う」で、誰が誰に書いた文かの欄がそもそも無かった（読みの点検の「無い段」）。
 *
 * 決まり:
 *   - 画像のラベルが「物件以外：やり取りのスクショ」の通だけを見る（他の画像は今まで通り）
 *   - 話し手は書き起こしの文の形だけで決める（LLM なし）:
 *       other_to_customer … 他社・管理会社・サービスからお客様への文（敬語の業務文・「〇〇様」「弊社」「送信者：」「メール件名」）
 *       people_chat       … 名前付きの発言（「名前：」が2つ以上・「ユーザー名」）＝お客様と家族・知人などのやり取り
 *       unknown           … どちらとも決められない（今まで通りの見出し）
 *   - どの話し手でも、中の問いは**こちらへの質問ではない**（お客様の言葉は外の通で読む）
 *   - 見出しは「【お客様が送った画像に写っていた文字」で始める（reply-context の isImageTextUnit が画像の通と分かるように）
 *   - 既定 off（SCREENSHOT_SPEAKER_NOTE=on）。off の時は今の見出しと1文字も変わらない
 */

export type ScreenshotSpeaker = "other_to_customer" | "people_chat" | "unknown";

/** image-label.ts の chat の見出し（「物件以外：やり取りのスクショ」）で始まる通 */
const CHAT_SHOT_HEAD_RE = /^\s*(?:\[画像\]\s*)?【物件以外：やり取りのスクショ】/;

/** 業務の文の印（他社・管理会社・サービス → お客様） */
const BUSINESS_RES: RegExp[] = [
  /お世話になっております|お世話になります/,
  /かしこまりました|承知(?:いた)?しました/,
  /ございます|ございません/,
  /弊社|当社/,
  /させて(?:いただ|頂)きます/,
  /(?:宜し|よろし)いでしょうか|いかがでしょうか|でしょうか[？?]/,
  /送信者\s*[:：]|メール件名|件名\s*[:：]/,
  /ご入居ありがとうございます|ご利用いただき/,
  /^\s*\S{1,10}様\s/m,
];

/** 名前付きの発言（「裕哉：」「ユーザー名：」） */
const NAMED_LINE_RE = /(?:^|\s)([^\s：:【】\[\]（）()]{1,12})[：:]\s*\S/g;
const NOT_A_NAME_RE = /^(?:送信者|件名|日時|メール件名|WiFiパスワード|パスワード|URL|TEL|電話|住所|物件名|賃料|家賃|管理費|日付|時間)$/;

export function isChatScreenshotUnit(unit: string | null | undefined): boolean {
  return CHAT_SHOT_HEAD_RE.test(String(unit ?? ""));
}

/** 話し手を決める（純関数）。why は決めた手がかり */
export function readScreenshotSpeaker(unit: string): { speaker: ScreenshotSpeaker; why: string } {
  const body = String(unit ?? "").replace(CHAT_SHOT_HEAD_RE, "").trim();
  const names = new Set<string>();
  for (const m of body.matchAll(NAMED_LINE_RE)) { const n = m[1]; if (!NOT_A_NAME_RE.test(n) && !/^\d/.test(n)) names.add(n); }
  const userNameLabel = /ユーザー名\s*[:：]/.test(body);
  const business = BUSINESS_RES.filter((re) => re.test(body)).length;
  // 業務の文の方を先に見る（「送信者：」「件名：」は名前の行に見えるので名前より強い）
  if (business >= 2) return { speaker: "other_to_customer", why: `業務の文の印 ${business}` };
  if (userNameLabel || names.size >= 2) return { speaker: "people_chat", why: userNameLabel ? "ユーザー名の欄" : `名前付きの発言 ${names.size}` };
  return { speaker: "unknown", why: business ? `業務の文の印 ${business}（足りない）` : "手がかり無し" };
}

/** スクショの中の問いの文（数えるだけ・こちらへの質問として扱わない事の確かめに使う） */
export function questionsInScreenshot(unit: string): string[] {
  const body = String(unit ?? "").replace(CHAT_SHOT_HEAD_RE, "");
  return body.split(/(?<=[？?])|\n/).map((s) => s.trim()).filter((s) => /[？?]$/.test(s)).slice(0, 5);
}

export function screenshotSpeakerNoteOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SCREENSHOT_SPEAKER_NOTE ?? "").trim().toLowerCase() === "on";
}

/**
 * 画像の通の見出し。やり取りのスクショで話し手が決まった時だけ、話し手と「中の問いはこちらへの質問ではない」を書いた見出しにする。
 *   それ以外・スイッチ off は baseLabel（今の IMAGE_TEXT_LABEL）をそのまま返す
 */
export function imageUnitLabel(unit: string, baseLabel: string, env?: Record<string, string | undefined>): string {
  if (!screenshotSpeakerNoteOn(env) || !isChatScreenshotUnit(unit)) return baseLabel;
  const { speaker } = readScreenshotSpeaker(unit);
  if (speaker === "other_to_customer") {
    return "【お客様が送った画像に写っていた文字（やり取りのスクショ・話し手は他社／管理会社／サービスで、お客様に宛てた文。中の問いは相手がお客様に聞いた事で、こちらへの質問ではない。今の手続き・状況（キャンセル・解約・入居の案内など）の把握に使う）】";
  }
  if (speaker === "people_chat") {
    return "【お客様が送った画像に写っていた文字（やり取りのスクショ・話し手はお客様と家族・知人など。中の問いはこちらへの質問ではない。お客様側の事情・気持ちの把握に使う）】";
  }
  return baseLabel;
}
