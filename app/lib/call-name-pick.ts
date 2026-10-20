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
//   ③ 表示名（本当の名前が分からない時だけ・絵文字の表示名も「🎀さん」で呼ぶ＝2026-10-20 竹内さんの答え）④ 数字だけ・空なら ""（名前を付けずに書く）。
//   固定（call_name）は名前の字がある物だけ（絵文字の表示名は固定しない＝本当の名前が分かったらそちらで呼ぶ）。

/** 名前の字（かな・カナ・漢字・英字）が1つでもあるか。絵文字・記号・数字だけの名前（🎀・❤︎・⭐️・327）は false */
export function hasNameLetter(raw: string | null | undefined): boolean {
  const s = typeof (raw ?? "").normalize === "function" ? (raw ?? "").normalize("NFKC") : raw ?? "";
  return /[ぁ-んゝゞァ-ヴヽヾ一-鿿々〆A-Za-z]/.test(s);
}

/**
 * 2026-10-20 竹内さん（見直しの答え）「本当の名前が分からない会話は、名前なしではなく『表示名（絵文字）＋さん』で呼ぶ（例『🎀さん』）。
 *   数字だけ・空の表示名など『〇〇さん』として崩れる物は名前なし」。
 *   呼べる名前: 名前の字がある、または絵文字・記号（🎀・❤︎・⭐️・♡・★）がある。数字だけ・句読点だけ・空は呼べない
 */
const PICTO_RE = /[\p{Extended_Pictographic}\p{So}]/u;
export function isCallableName(raw: string | null | undefined): boolean {
  const s = String(raw ?? "").trim();
  if (!s) return false;
  return hasNameLetter(s) || PICTO_RE.test(s);
}

/**
 * 呼び名を1つに決める（決定の向き: 分かっている名前＞表示名（絵文字でも）＋さん）。
 *   stored: conversations.call_name（会話に固定した呼び名・名前の字がある時だけ）
 *   conversational: 会話から決めた呼び名（スタッフが呼んだ名前・名乗り・申込の名前・表示名の順で決めた物）
 *   display: LINE の表示名（本当の名前が分からない時の最後の手段・グループの会話名は渡さない）
 * 名前の字がある物を先に、無ければ絵文字・記号の名前（「🎀」）、それも無ければ ""（呼びかけを書かない）
 */
export function pickCallName(i: { stored?: string | null; conversational?: string | null; display?: string | null }): string {
  const clean = (x: string | null | undefined) => String(x ?? "").trim().replace(/(?:さん|様|さま)$/, "").trim();
  const s = clean(i.stored);
  if (s && hasNameLetter(s)) return s;
  const c = clean(i.conversational);
  if (c && hasNameLetter(c)) return c;
  const d = clean(i.display);
  if (d && hasNameLetter(d)) return d;
  for (const x of [c, d]) if (x && isCallableName(x)) return x;
  return "";
}

/** 「〇〇さん」（呼べる名前が無ければ ""・絵文字の名前は「🎀さん」） */
export function sanOf(name: string | null | undefined): string {
  const n = String(name ?? "").trim().replace(/(?:さん|様|さま)$/, "").trim();
  return n && isCallableName(n) ? `${n}さん` : "";
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
