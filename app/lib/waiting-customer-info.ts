// app/lib/waiting-customer-info.ts
// 2026-10-06 ⑫ 竹内さん「状況理解できていない。ここは移動の連絡まちの状況」（末桜・イエヤス 10/02）:
//   スタッフ 19:52「かしこまりました！！10/4の内覧をキャンセルさせて頂きます！！移動先が分かりましたら新しいエリアでもお部屋探しさせていただきますので
//   お気軽にお知らせください😊！！」→ お客様 20:26「すみません、お願いします😢」→ 下書き「…オススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！」。
//   出所: 前のピックアップの約束（promise:pickup）が残っていて、ブレインが物件ピックアップ（→2段で約束の返信）を出した。
//   スタッフの最後の発言が「お客様が分かったら・決まったら知らせて」＝お客様の情報待ち。この間のお礼・お詫びでピックアップ・約束・AIX を出さない
//   （約束とピックアップは消さずに待ちにする）。線は scripts/audit-waiting-customer-info.ts（同じ状態のスタッフの実際の返し）

type Msg = { sender: string; text: string | null | undefined };

/** こちらが「お客様の情報が分かったら（決まったら）知らせて」と、お客様の連絡待ちにした文 */
export const WAITING_CUSTOMER_INFO_RE =
  /(?:分かり|わかり|決まり|決定(?:し|され)|確定(?:し|され)|お決まりになり|判明し|落ち着き)(?:ましたら|次第|たら)[^。\n]{0,70}?(?:(?:お気軽に)?(?:お知らせ|ご連絡|お伝え|お声がけ|教えて)(?:ください|下さい|頂け|いただけ|頂きたく)|ご連絡(?:を)?お待ちして)/;
/** お客様の返しがお礼・お詫び・了承だけ（新しい情報・依頼・質問が無い） */
const ACK_ONLY_RE = /^(?:[\s\S]{0,6})?(?:すみません|すいません|申し訳(?:ありません|ございません|ない)|ありがとう(?:ございます)?|有難う|お願い(?:します|致します|いたします)|よろしく|宜しく|わかりました|分かりました|了解|承知|かしこまりました|はい)[\s\S]{0,20}$/;
const NEW_INFO_RE = /[?？]|決まり|分かり|わかり|になりました|エリア|駅|万|間取り|内覧|見積|初期費用|申込|物件|お部屋|https?:|\[画像\]/;

export type WaitingCustomerInfo = { waiting: boolean; evidence: string | null };

/**
 * 古い順の会話で、こちらの最後の発言がお客様の情報待ち（WAITING_CUSTOMER_INFO_RE）で、
 * その後のお客様の発言がお礼・お詫び・了承だけなら waiting=true（ピックアップ・約束・AIX を出さず、短い受け止めで待つ）。
 */
export function waitingOnCustomerInfo(messagesOldestFirst: ReadonlyArray<Msg>): WaitingCustomerInfo {
  const n = messagesOldestFirst.length;
  if (!n || messagesOldestFirst[n - 1].sender !== "customer") return { waiting: false, evidence: null };
  let i = n - 1; const turn: string[] = [];
  while (i >= 0 && messagesOldestFirst[i].sender === "customer") { turn.unshift(String(messagesOldestFirst[i].text ?? "")); i--; }
  // こちらの最後の発言の束（画像だけの発言は飛ばす）
  const staffBundle: string[] = [];
  for (let k = i; k >= 0 && messagesOldestFirst[k].sender !== "customer"; k--) staffBundle.push(String(messagesOldestFirst[k].text ?? ""));
  const hit = staffBundle.map((t) => t.match(WAITING_CUSTOMER_INFO_RE)?.[0]).find(Boolean) ?? null;
  if (!hit) return { waiting: false, evidence: null };
  const turnText = turn.join("\n").normalize("NFKC").trim();
  if (!turnText || NEW_INFO_RE.test(turnText) || !ACK_ONLY_RE.test(turnText)) return { waiting: false, evidence: null };
  return { waiting: true, evidence: hit };
}
