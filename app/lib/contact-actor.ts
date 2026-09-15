// app/lib/contact-actor.ts
// 「連絡してくるのは誰か」の取り違えを直す（穴:G1 分類）。
// 2026-09-15 竹内（yasuki 事例）: お客様「息子に確認の連絡を入れますので夕方くらいに折り返しの連絡をさせて頂きます」
//   → 下書き「息子様からのご返答お待ちしております」。連絡してくるのはお客様ご本人（スタッフは「ご返答お待ちしております」に直して送った）。
//   実データ: スタッフが家族・同居人等「からのご返答／ご連絡をお待ち」と書いた送信は1年で0件。下書きの取り違えは180日で今回の1件
//   → お客様が自分で連絡すると言っている時だけ、下書きの「〇〇様からの」を外す（家族から連絡させる・家族から来る話の時は触らない）

/** 家族・同居人など（管理会社・保証会社は含めない＝「管理会社からのご連絡」は正しい使い方） */
const THIRD_PARTY_SRC = "(?:ご|お)?(?:息子|娘|家族|旦那|主人|奥|嫁|妻|夫|父|母|両親|親御|連帯保証人|保証人|彼氏|彼女|パートナー|婚約者|友人|友達|同居人|兄|姉|弟|妹|祖父|祖母)(?:様|さん|さま)?";
const DRAFT_THIRD_PARTY_WAIT_RE = new RegExp(
  `(?<![一-龯ァ-ヶ])${THIRD_PARTY_SRC}(?:から|より)の?(?=(?:ご返答|ご返事|ご連絡|お返事|ご回答|お電話)[^。\\n]{0,8}お待ち)`,
  "g",
);
/** お客様が自分で連絡する（させて頂きます・します・致します） */
const CUSTOMER_SELF_CONTACT_RE = /(?:折り返し|連絡|返事|返信|回答|お伝え|電話)[^。\n]{0,10}(?:させて(?:頂|いただ)きます|さしていただきます|します|致します|いたします)/;
/** 家族から連絡させる・家族から来る（その時は「〇〇様からの」が正しいこともある） */
const THIRD_PARTY_WILL_CONTACT_RE = new RegExp(`${THIRD_PARTY_SRC}(?:から|より)[^。\\n]{0,8}(?:連絡|電話|返事|返信|回答)|(?:連絡|電話|返事|返信)を?させます`);

export function fixThirdPartyContactWait(draft: string, customerMessage: string | null | undefined): { text: string; count: number } {
  const c = customerMessage ?? "";
  if (!c || !CUSTOMER_SELF_CONTACT_RE.test(c) || THIRD_PARTY_WILL_CONTACT_RE.test(c)) return { text: draft, count: 0 };
  let count = 0;
  const text = draft.replace(DRAFT_THIRD_PARTY_WAIT_RE, () => { count++; return ""; });
  return { text, count };
}
