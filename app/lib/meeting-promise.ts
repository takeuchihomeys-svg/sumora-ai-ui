// app/lib/meeting-promise.ts
// ⚠ 2026-10-02 竹内さんの訂正「おって連絡とかじゃあなくて内覧日決まったら 1件目の内覧場所を集合場所とする そこから物件内覧する」:
//   待ち合わせ場所はその時に分かっている（1件目の内覧の物件の現地・番地まで）＝「待ち合わせ場所追ってご連絡」は書かない。
//   日にちが決まったら次は AIX【待ち合わせ】（1件目の物件を先に入れる・aix-prefill.meetingPropertyPrefill）。
//   この約束の形は ①手本・ナレッジから外す（example-hygiene）②下書きに出たら自動で送らない（auto-reply-policy ⑥-7）。
//   下の meetingPromisePending は、過去にこの形で送ってしまった会話の続き（約束が残っている）を AIX【待ち合わせ】に戻すためだけに残す
// 2026-10-02 ⑫ 21巡（待ち合わせまで行く流れ・竹内さん「待ち合わせ場所で待ち合わせ決めるパターンがはいっていない」）:
//   スタッフ「9/24日13:00からはよろしくお願いいたします😊！！芝犬の飼育可能か含め待ち合わせ場所追ってご連絡させていただきます！！」の後、
//   お客様の返事（「ギリギリですが大丈夫です！！」「わかりました」）でスタッフは AIX【待ち合わせ】を押した（flow2_fbffca_t12・flow18_t12）。
//   ブレインは返信を選び、下書きは「何卒よろしく」や日にちの聞き直しだった＝約束した待ち合わせ場所が送られないまま。
//   行動台帳の約束（pickup／check／estimate）に待ち合わせは無い → 待ち合わせ場所の約束が残っている時は AIX【待ち合わせ】（約束を果たす AIX・2段の2段目）。
//   待ち合わせの住所は番地まで資料から（feedback_meeting_address_full）＝ AIX が開いた時にスタッフが確かめる（needs_material）。
//   線は scripts/audit-meeting-promise.ts（本番の約束の後に AIX【待ち合わせ】を押したか・待ち合わせの文を手で送ったか）
type Msg = { sender: string; text: string | null | undefined };
/** 待ち合わせ場所を後で送る約束（「待ち合わせ場所追ってご連絡させていただきます」「待ち合わせ場所改めてお送りさせていただきます」） */
export const MEETING_PROMISE_RE = /(?:お)?待ち合わせ(?:場所|の場所)[^。\n！!]{0,14}(?:追って|改めて|後ほど|前日|当日|お送り|ご連絡|お伝え|あわせて)[^。\n！!]{0,8}(?:させて(?:頂|いただ)きます|いたします|致します)/;
/** 待ち合わせの案内を送った印（住所・〒・「待ち合わせ場所は」） */
const MEETING_SENT_RE = /待ち合わせ(?:場所)?(?:は|：|:)|〒\s*[0-9０-９]{3}|[0-9０-９]+丁目[0-9０-９\-－]+|現地(?:に|で)(?:て)?お待ち/;

/** 古い順の会話で、こちらの待ち合わせ場所の約束がまだ果たされていないか（最後がお客様の発言の時だけ） */
export function meetingPromisePending(messagesOldestFirst: ReadonlyArray<Msg>): boolean {
  const n = messagesOldestFirst.length;
  if (n === 0 || messagesOldestFirst[n - 1].sender !== "customer") return false;
  for (let i = n - 1; i >= 0 && i >= n - 16; i--) {
    const m = messagesOldestFirst[i];
    if (m.sender === "customer") continue;
    const t = String(m.text ?? "");
    if (MEETING_SENT_RE.test(t) && !MEETING_PROMISE_RE.test(t)) return false; // 約束より後に案内を送った
    if (MEETING_PROMISE_RE.test(t)) return true;
  }
  return false;
}
