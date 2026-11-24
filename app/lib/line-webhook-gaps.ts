// app/lib/line-webhook-gaps.ts — LINE の受け口が本文を残さずに捨てていた残りの穴をふさぐ（純関数・台帳 #437・LINE_WEBHOOK_GAPS・既定 off）
//
// 2026-11-24 作業員A（統括役の頼み・台帳 #437「LINE に届いた返信がツールに入らない」・priority 1）。
//   11/21 に作業員M が、保存の失敗・宛先の誤り・中継の時間切れを Blob（private）に貯めて入れ直す形にした（line-webhook-inbox.ts）。残っていた穴:
//     ① 動画・音声・位置情報など、受け口が知らない種類の通は、会話に何も残さず捨てていた（route.ts の「未対応msgType」・スタンプは 11 月に直した）
//        → on の時は「[動画]」「[音声]」「[位置情報]」「[その他の通]」の1行を、スタンプと同じ道（下書きは作らない）で残す。中身は取りに行かない
//     ② アカウントの channel secret が無い時は 500 を返すだけで、本文はどこにも残らなかった（LINE の再送が off なら消える）
//        → on の時は、ほかの失敗と同じく本文を貯めてから 500（署名はまだ確かめられないので、入れ直しの時に確かめる）
//   自動送信には触らない。off の時は今と1つも変わらない。
// テスト: app/lib/__tests__/line-webhook-gaps.test.ts
type Env = Record<string, string | undefined>;
export function lineWebhookGapsOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.LINE_WEBHOOK_GAPS ?? "").trim().toLowerCase() === "on";
}
const PLACEHOLDER: Record<string, string> = { video: "[動画]", audio: "[音声]", location: "[位置情報]" };
/** 受け口が知らない種類の通を会話に残す1行（text・image・file・sticker は今ある道で残すので null） */
export function placeholderTextOf(msgType: string | null | undefined): string | null {
  const t = String(msgType ?? "").trim();
  if (!t || t === "text" || t === "image" || t === "file" || t === "sticker") return null;
  return PLACEHOLDER[t] ?? "[その他の通]";
}
