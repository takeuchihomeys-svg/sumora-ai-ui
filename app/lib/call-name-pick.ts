// app/lib/call-name-pick.ts — お客様の呼び名を「会話で確定した名前」から決める（純関数・画面とサーバーの両方で使う）
//
// 2026-10-20 竹内さん（P1 979a4c55）「もともと ayaka さんと言っていたのに、お客さんが LINE のアカウント名を🎀に変えてから
//   呼び方も🎀さんに変わってしまった。原因を見つけて改善するようにする。最初呼んでいた名前で連絡するようにする」
//
// 【根っこ】返信の下書き（generate-reply）は resolveAddressName（スタッフの呼びかけ → 名乗り → 登録名 → 表示名）と
//   固定の呼び名（conversations.call_name）で決めていたが、画面のピッカー（内覧誘導・物件成約した）・文の手直し（polish-draft）は
//   LINE の表示名（conversations.customer_name ＝ line-webhook がプロフィールで上書きする）をそのまま「〇〇さん」に差し込んでいた。
//   さらに固定の呼び名はスタッフが冒頭で2回以上呼んだ時しか保存せず、表示名が変わると表示名に倒れる会話が残っていた。
// 【決め方】① 保存した呼び名（call_name）② 会話で確定した名前（スタッフの呼びかけ・名乗り・申込の名前＝resolveAddressName 等の結果）
//   ③ どれも無ければ ""（名前を付けずに書く）。表示名は ② の中で最後の手段としてだけ使い、絵文字・記号・数字だけなら使わない。

/** 名前の字（かな・カナ・漢字・英字）が1つでもあるか。絵文字・記号・数字だけの名前（🎀・❤︎・⭐️・327）は false */
export function hasNameLetter(raw: string | null | undefined): boolean {
  const s = typeof (raw ?? "").normalize === "function" ? (raw ?? "").normalize("NFKC") : raw ?? "";
  return /[ぁ-んゝゞァ-ヴヽヾ一-鿿々〆A-Za-z]/.test(s);
}

/**
 * 呼び名を1つに決める。
 *   stored: conversations.call_name（会話に固定した呼び名）
 *   conversational: 会話から決めた呼び名（スタッフが呼んだ名前・名乗り・申込の名前・表示名の順で決めた物）
 * どちらも名前の字が無ければ ""（呼びかけを書かない）
 */
export function pickCallName(i: { stored?: string | null; conversational?: string | null }): string {
  const clean = (x: string | null | undefined) => String(x ?? "").trim().replace(/(?:さん|様|さま)$/, "").trim();
  const s = clean(i.stored);
  if (s && hasNameLetter(s)) return s;
  const c = clean(i.conversational);
  if (c && hasNameLetter(c)) return c;
  return "";
}

/** 「〇〇さん」（名前が無ければ ""） */
export function sanOf(name: string | null | undefined): string {
  const n = String(name ?? "").trim().replace(/(?:さん|様|さま)$/, "").trim();
  return n && hasNameLetter(n) ? `${n}さん` : "";
}

/**
 * 呼び名を会話に固定してよいか（resolveAddressName の出所）。
 *   スタッフが行頭で呼んだ名前（staff_greeting_head）・元の名前の固定（staff_original_locked）・お客様の名乗り（customer_self_intro）だけ。
 *   文の中の呼びかけ（staff_inline＝第三者の事がある）・登録名・表示名は固定しない（表示名の変更で変わる物を固定しない）。名前の字が無ければ固定しない
 */
export function lockableCallNameSource(source: string | null | undefined, name: string | null | undefined): boolean {
  if (!hasNameLetter(name)) return false;
  return source === "staff_greeting_head" || source === "staff_original_locked" || source === "customer_self_intro";
}
