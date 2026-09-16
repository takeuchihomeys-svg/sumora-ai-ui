// app/lib/viewing-day.ts
// 内覧当日、こちらが送り出した後のお客様のお礼＝返信しないで内覧を待つ場面の判定（純関数・DB 依存なし）。
//
// 2026-09-16 竹内（YUYA 事例）「内覧が10:40〜なので、AIX の挨拶ボタン内覧後のピッカーでセットしている形とする」:
//   内覧当日 9/16 10:30 → お客様 10:03「仕事の都合で到着が10時40分頃になりそうです」→ こちら 10:04「はい！！大丈夫です！！
//   お気をつけてお越し下さい😊！！」→ お客様 10:21「ありがとうございます🙇‍♂️」→ 下書き「はい😊！！／明日以降も気になる点等
//   出てきましたらいつでもお気軽にご連絡ください！！」（内覧は本日なのに「明日以降」・そもそも返信する場面ではない）。
//
// 実データ（180日・内覧当日の朝の案内文の後）: こちらが送り出した後のお客様の短いお礼・了承にスタッフは返信せず、
//   内覧後に「〇〇さん本日お時間頂きありがとうございました！！」（60件）を送っている。
//   例: ひろろ 9/9 09:42「はい」→ 返信なし → 11:50 内覧後の挨拶／yasuki 9/15 10:31「承知致しました」→ 返信なし → 12:02 ／
//       🐈‍⬛ 9/14 15:08「こちらこそよろしくお願いいたします」→ 返信なし → 17:26。
//   ただし「遅れます」「着きました」「何階ですか」には必ず返している（お礼・了承だけの時に限る）。

/** こちらの「送り出し」の一文（内覧当日にお客様を現地へ送り出す・当日の案内） */
export const STAFF_SENDOFF_RE = /お気をつけて|お越し(?:ください|下さい)|お待ちしております|(?:本日|当日)[^\n]{0,24}(?:よろしくお願い|ご案内させて|ご案内いたし)/;

const MEDIA_ONLY_RE = /^\[(?:画像|動画|スタンプ|ファイル)\]$/;

export type ViewingDayAckVerdict = { hold: boolean; staffLine: string; reason: string };

/**
 * 返信しないで内覧を待つ場面か:
 *   ①内覧が本日（台帳の viewingAppointment.day === "today"）②お客様の最後の連投がお礼・了承だけ（呼び出し側の判定を渡す）
 *   ③その直前のこちらの文字の発言が送り出し（お気をつけてお越しください／本日〇時ご案内させて頂きます）
 * messages は古い順。
 */
export function resolveViewingDayAck(
  messagesOldestFirst: ReadonlyArray<{ sender: string; text?: string | null }>,
  customerAckOnly: boolean,
  viewingIsToday: boolean,
): ViewingDayAckVerdict {
  const no = (reason: string): ViewingDayAckVerdict => ({ hold: false, staffLine: "", reason });
  if (!viewingIsToday) return no("viewing_not_today");
  if (!customerAckOnly) return no("customer_not_ack");
  const last = messagesOldestFirst[messagesOldestFirst.length - 1];
  if (!last || last.sender !== "customer") return no("last_not_customer");
  // お客様の連投の前の、こちらの文字の発言（画像だけの通は飛ばす）
  let i = messagesOldestFirst.length - 1;
  while (i >= 0 && messagesOldestFirst[i].sender === "customer") i--;
  while (i >= 0 && messagesOldestFirst[i].sender === "staff" && MEDIA_ONLY_RE.test((messagesOldestFirst[i].text ?? "").trim())) i--;
  const staff = i >= 0 ? messagesOldestFirst[i] : null;
  if (!staff || staff.sender !== "staff") return no("no_staff_before");
  const t = (staff.text ?? "").trim();
  if (!STAFF_SENDOFF_RE.test(t)) return no("staff_not_sendoff");
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  return { hold: true, staffLine: lines[lines.length - 1] ?? "", reason: "viewing_today_sendoff_ack" };
}
