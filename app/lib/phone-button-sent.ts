// app/lib/phone-button-sent.ts
// 電話のボタン（AIX【電話をかける】）をこちらが既に送った直後のお客様の返事か（純関数）。
//
// 2026-10-01 YUMA の再生テスト（scripts/yuma-replay-scenarios.ts）: こちらが「[通話リクエスト] 電話をかけるボタン」＋「お手隙の際にこちらの電話をかけるボタンより
//   お電話お願い致します」を送った後の「14:30-15:00くらいに掛けても大丈夫でしょうか？」に、ブレインがもう一度 AIX【電話をかける】を選んだ（reply_mode=aix＝下書きなし）。
//   スタッフの実送信は「かしこまりました！！／大丈夫です😊！！／お手隙のタイミングでお電話おかけください！！」（手打ち）。
//   線（200日・電話のボタンを送った後のお客様の返事 9番・scripts/tmp-phone-after の結果を dept_line_reply.md に記録）: スタッフがもう一度 電話をかける を押したのは 0番
//   （時刻の相談・「15時以降にお電話いたします」・お礼・書類 → 手打ちか何もしない）。→ ボタンが直前のこちらの発言の束にあれば 電話をかける を出さない（返信で答える）
// テスト: app/lib/__tests__/phone-button-sent.test.ts

type Msg = { sender: string; text: string | null | undefined; createdAt?: string | null };

/** 電話のボタン（LINE コールの依頼の文）の形 */
export const PHONE_BUTTON_RE = /\[通話リクエスト\]|電話をかけるボタン/;

/**
 * 今回のお客様の連投の直前の「こちらの発言の束」（6時間以内）に電話のボタンがあるか。
 * messagesOldestFirst は古い順。最後がお客様の連投でなければ false。
 */
export function phoneButtonJustSent(messagesOldestFirst: ReadonlyArray<Msg>): boolean {
  let i = messagesOldestFirst.length - 1;
  if (i < 0 || messagesOldestFirst[i].sender !== "customer") return false;
  while (i >= 0 && messagesOldestFirst[i].sender === "customer") i--;
  const lastStaffAt = Date.parse(messagesOldestFirst[i]?.createdAt ?? "");
  for (; i >= 0 && messagesOldestFirst[i].sender !== "customer"; i--) {
    const m = messagesOldestFirst[i];
    const t = Date.parse(m.createdAt ?? "");
    if (Number.isFinite(lastStaffAt) && Number.isFinite(t) && lastStaffAt - t > 6 * 3600_000) break;
    if (PHONE_BUTTON_RE.test(m.text ?? "")) return true;
  }
  return false;
}
