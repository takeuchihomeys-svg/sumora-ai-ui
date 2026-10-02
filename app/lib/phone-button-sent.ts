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

// ─── 2026-10-02 ⑫ 20巡（thanks_08）: 電話が終わった後のお客様の返事に、ブレインがもう一度 AIX【電話をかける】を選んだ ───
//   場面: お客様「お忙しい中お電話ありがとうございました」→ スタッフのお礼の返信 → 物件の連絡 → お客様「探していただきありがとうございます😭」に 電話をかける。
//   電話は終わっている＝もう一度ボタンを送る場面ではない（実送信: お礼・続きの手打ち）。AIX【電話する】の「電話終了後」（話した内容のまとめ）は
//   スタッフのメモが要り、本番の押下は全期間 0（ブレインの候補にも無い）＝ここでは返信に戻すだけ。
//   線: 直近2日のこちら／お客様の発言に電話のお礼（＝電話が終わった印）があり、今回のお客様の発言に電話・通話の語が無い時だけ（scripts/audit-call-finished.ts）
export const CALL_FINISHED_RE = /お電話(?:の)?(?:お時間)?(?:頂き|いただき)?(?:誠に)?(?:有難う|ありがとう|有り難う)|お電話(?:にて|で)(?:の)?(?:ご説明|お打ち合わせ|ご相談)(?:頂き|いただき)?(?:有難う|ありがとう)/;
export function callJustFinished(messagesOldestFirst: ReadonlyArray<Msg>): boolean {
  const n = messagesOldestFirst.length;
  if (n === 0 || messagesOldestFirst[n - 1].sender !== "customer") return false;
  let i = n - 1; const turn: string[] = [];
  while (i >= 0 && messagesOldestFirst[i].sender === "customer") { turn.push(messagesOldestFirst[i].text ?? ""); i--; }
  if (/電話|通話/.test(turn.join("\n").replace(/お電話(?:の)?(?:お時間)?(?:頂き|いただき)?(?:誠に)?(?:有難う|ありがとう|有り難う)/g, ""))) return false;
  const lastAt = Date.parse(messagesOldestFirst[n - 1].createdAt ?? "");
  for (let k = n - 1; k >= 0 && k >= n - 12; k--) {
    const m = messagesOldestFirst[k];
    const t = Date.parse(m.createdAt ?? "");
    if (Number.isFinite(lastAt) && Number.isFinite(t) && lastAt - t > 48 * 3600_000) break;
    if (CALL_FINISHED_RE.test(m.text ?? "")) return true;
  }
  return false;
}
