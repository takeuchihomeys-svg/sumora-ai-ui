// app/lib/unsent-review-ack.ts（純関数・DB/LLM なし）— 答えた後の見直し（決まりで見られる所は決まりで）
// 送っていない番の「お手隙の際にご査収ください」を直す。
//
// 2026-10-16 竹内悠馬（10/16 の画面の事例 f）: 見積は前の日に送り済み・その後こちらが質問に答えた後のお客様の「分かりました！」に
//   下書き「はい😊！！ お手隙の際にご査収ください😌！！ 何卒…」。正しくは「気になる点等出てきましたらいつでもお気軽にご連絡ください」＋新着の約束。
// 線（本番 180日・竹内さんの手打ちの「ご査収ください」310通・読むだけ）:
//   資料・AIX を送った後、こちらがまだ会話文を送っていない時 254＋6＋1（お客様のお礼に「はい😊 お手隙の際にご査収ください」と返す形もここ）。
//   送った後にこちらが会話文を送り、その後にお客様が話した時に「ご査収ください」と書いたのは 約15通（多くは同じ通で新しい資料を案内する文）。
// 決め: 返信の下書き（テンプレ最適化・AIX の文ではない）で、最後に資料・AIX を送った後にこちらが会話文を送っている（＝送った物はもう話した）なら、
//   「（お手隙の際に）ご査収ください」の文を「気になる点等出てきましたらいつでもお気軽にご連絡ください」に替える（同じ締めが既にあれば落とす）。
//   「ご査収頂きありがとうございます」は触らない。戻す UNSENT_REVIEW_ACK=off

export function unsentReviewAckEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.UNSENT_REVIEW_ACK ?? "").trim().toLowerCase() !== "off";
}

export type UraMsg = { sender: string; text?: string | null; isAix?: boolean | null; imageUrl?: string | null };

const ATTACH_RE = /^\s*\[(?:画像|動画|ファイル)\]|^（室内イメージ）|^https?:\/\/\S+$/;
const REVIEW_ASK_RE = /(?:お手隙の際に|お手すきの際に)?\s*ご査収(?:くださ|下さ)い[^\n！!。]*[！!。]*[😊😌]*[！!]*/;
const CONTACT_CLOSE_RE = /お気軽にご連絡/;
const REPLACEMENT = "気になる点等出てきましたらいつでもお気軽にご連絡ください！！";

function isAttachment(m: UraMsg): boolean {
  return m.sender === "staff" && (!!m.imageUrl || !!m.isAix || ATTACH_RE.test(String(m.text ?? "").trim()));
}

/** messages は古い順（今の下書きが答えるお客様の発言まで） */
export function sentSinceLastAttachment(messages: ReadonlyArray<UraMsg>): boolean {
  let lastAttach = -1;
  messages.forEach((m, i) => { if (isAttachment(m)) lastAttach = i; });
  // 資料・AIX を送った記録が窓に無い＝この番に送った物は無い
  if (lastAttach < 0) return true;
  return messages.slice(lastAttach + 1).some((m) => m.sender === "staff" && !isAttachment(m) && String(m.text ?? "").trim());
}

export function fixUnsentReviewAck(draft: string, messages: ReadonlyArray<UraMsg>, enabled = unsentReviewAckEnabled()): { text: string; changed: string | null } {
  if (!enabled || !draft || !REVIEW_ASK_RE.test(draft)) return { text: draft, changed: null };
  if (!sentSinceLastAttachment(messages)) return { text: draft, changed: null };
  const m = draft.match(REVIEW_ASK_RE)!;
  const hasClose = CONTACT_CLOSE_RE.test(draft.replace(m[0], ""));
  const next = draft.split("\n").map((l) => (REVIEW_ASK_RE.test(l) ? l.replace(REVIEW_ASK_RE, hasClose ? "" : REPLACEMENT) : l))
    .filter((l, i, arr) => l.trim() || (i > 0 && arr[i - 1].trim())).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!next.replace(/[\s！!😊😌]/g, "")) return { text: draft, changed: null };
  return { text: next, changed: `${m[0].trim().slice(0, 24)}→${hasClose ? "（落とす）" : "お気軽にご連絡"}` };
}
