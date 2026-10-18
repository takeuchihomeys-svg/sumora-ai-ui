// app/lib/aix-lifeline.ts（純関数・DB/ネットに触れない）
// 2026-10-18 竹内さん 10/18「AIX【確認した（条件・交渉）】に新しく『ライフラインについて』のピッカー。二人入居のピッカーと同じ形。
//   ライフラインを聞かれた時の返信は『別途ご案内させて頂きます』の約束→答えはこのピッカーから」。
//   答えの型は実送信（9/28 469a614a・従業員）「ライフライン特に指定なしとのことです。／【ライフラインご連絡先】／関西電力／0800-…／大阪ガス／0120-…／堺市水道局／0570-…」。
//   連絡先（会社名・電話番号）はスタッフが入れた文字のまま付ける（LLM に写させない＝電話番号の写し間違いを出さない）。戻す AIX_MGMT_LIFELINE=off（場面の網）

export function aixMgmtLifelineEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.AIX_MGMT_LIFELINE ?? "").trim().toLowerCase() !== "off";
}

/** 連絡先の欄の見出し（実送信の形） */
export const LIFELINE_CONTACT_HEAD = "【ライフラインご連絡先】";

/** 電話番号らしい行（LLM が本文に写した連絡先を落とす） */
const PHONE_LINE_RE = /(?:0\d{1,4}[-‐−ー－]?\d{1,4}[-‐−ー－]?\d{3,4})/;
/** 会社名だけの行（電力・ガス・水道の会社） */
const UTILITY_COMPANY_LINE_RE = /^(?:.{0,12}(?:電力|でんき|電気|ガス|水道局|水道部|上下水道|エネルギー))\s*$/;

/**
 * 生成の1行（＋挨拶）に、スタッフが入れた連絡先を見出し付きでそのまま付ける。
 *   生成が連絡先・見出しを書いていたら落とす（スタッフの入力だけを正とする）。連絡先が空なら本文だけ。
 */
export function composeLifelineMessage(generated: string, contacts: string | null | undefined): string {
  const lines = String(generated ?? "").replace(/\r\n/g, "\n").split("\n");
  const headAt = lines.findIndex((l) => l.includes("【ライフライン"));
  const body = (headAt >= 0 ? lines.slice(0, headAt) : lines)
    .filter((l) => !PHONE_LINE_RE.test(l) && !UTILITY_COMPANY_LINE_RE.test(l.trim()));
  const text = body.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const c = String(contacts ?? "").replace(/\r\n/g, "\n").trim();
  if (!c) return text;
  const block = c.startsWith(LIFELINE_CONTACT_HEAD) ? c : `${LIFELINE_CONTACT_HEAD}\n\n${c}`;
  return `${text}\n\n${block}`;
}

/**
 * お客様がライフライン（電気・ガス・水道）の手続き・連絡先を聞いた問い（会社の事実 utilities_procedure と同じ線）。
 *   費用（ガス代込み）・設備（都市ガス・プロパン・オール電化）は外す。
 *   実物: 「ライフラインのご連絡先など送って頂きたいです🙏🏻」(9/25)・「植田様のライフラインも送っていただきたいです！」(9/28)・「水道の開栓は入居日と同時になりますか？」(6/24)
 */
export const LIFELINE_Q_RE = /ライフライン[^。\n]{0,20}(?:[？?]|ですか|ますか|でしょうか|教えて|送って|頂きたい|いただきたい|欲しい|ほしい|知りたい|連絡先|どこ|どう)|(?:電気|ガス|水道|電力|開栓)[^。\n]{0,14}(?:手続|連絡先|申し?込|開栓|開通|どこに|いつまでに|どうすれ|どうしたら)[^。\n]{0,14}(?:[？?]|ですか|ますか|でしょうか|教えて|頂きたい|いただきたい)/;
export const LIFELINE_NOT_RE = /(?:ガス|水道|電気)(?:代|料金|料)|(?:代|料金)[^。\n]{0,4}(?:込|含)|家賃[^。\n]{0,4}込|プロパン|都市ガス|オール電化|コンロ|給湯|IH|キャッシュバック|お話(?:を)?聞く/;
export function isLifelineQuestion(text: string | null | undefined): boolean {
  const t = String(text ?? "").normalize("NFKC");
  if (!t.trim() || /^\s*\[(?:画像|動画|スタンプ|ファイル)\]/.test(t)) return false;
  return LIFELINE_Q_RE.test(t) && !LIFELINE_NOT_RE.test(t);
}

/** こちらの「ライフラインのお手続きにつきましては別途ご案内させて頂きます」の約束の文（約束の台帳で閉じる要件＝ライフライン） */
export const LIFELINE_PROMISE_RE = /ライフライン[^。\n！!]{0,24}(?:別途|改めて|後ほど|追って)[^。\n！!]{0,6}(?:ご案内|ご連絡|お送り|お伝え)(?:させて(?:頂|いただ)き|いたし|致し)ます/;
