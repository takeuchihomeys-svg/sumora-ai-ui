// app/lib/quote-interest.ts — 送った物件を引用したお客様の問いの関心（費用・内覧・審査・空き）を読む（純関数・LLM なし・記録だけ）（台帳 #793）
// 2026-11-26 作業員A（統括役の了承）: 刺さった点の網（hook-points）は刺さりの言葉＋点の重なりしか拾わず、60日の引用 71通で 1つだけだった。
//   引用の返信の多くは問い（「初期費用は」「ここも見れますか」「審査通りやすいですか」「まだ空いてますか」）＝その物件への関心の型。
//   刺さりの候補として別の欄（sent_properties.customer_interest_points）に残す。ブレインには渡さない。
//   審査の関心は申込より前の問いだけ（申込以降の中身は読まない＝呼ぶ側が申込以降なら審査を外す）。
//   スイッチ SENT_QUOTE_INTEREST: 既定 on（記録だけ）／off
// liked＝問いでなくても「気になります」「いいですね」「第一候補」（60日の引用で問いの次に多い・刺さりの網は点の重なりが無いと拾わなかった）
export type QuoteInterest = "cost" | "viewing" | "screening" | "vacancy" | "liked";
export const QUOTE_INTEREST_JA: Record<QuoteInterest, string> = { cost: "費用", viewing: "内覧", screening: "審査", vacancy: "空き", liked: "気に入った" };
export function quoteInterestOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SENT_QUOTE_INTEREST ?? "").trim().toLowerCase() !== "off";
}
const ASK_RE = /[?？]|ですか|ますか|でしょうか|教えて|知りたい|お願いします|かかります|なりますか|いくら/;
const NET: Array<[QuoteInterest, RegExp]> = [
  ["cost", /初期費用|費用|いくら|金額|日割|家賃|お見積|見積|安く/],
  ["viewing", /見れ|見られ|見に行|内覧|内見|見学/],
  ["screening", /審査|通り(?:やす|ます)|保証会社/],
  ["vacancy", /空いて|あいて|空き|まだ(?:あり|あ)り?ますか|募集(?:中|して)|埋まって/],
];
/** 問い・頼みの形の時だけ関心を返す（断り・お礼だけ・申込以降の審査は返さない・純関数） */
export function quoteInterestOf(replyText: string, o: { postApply?: boolean } = {}): QuoteInterest[] {
  const t = String(replyText ?? "").normalize("NFKC");
  if (/見送|やめ|他で決|微妙|イメージと|断念|保留/.test(t)) return [];
  // 「築年数が気になります」は心配（物の点＋が気になる）＝物件そのもの（これ・ここ・こちら・物件・一番）が気になる時だけ
  const liked: QuoteInterest[] = /(?:これ|ここ|こちら|物件|一番)(?:が|も|は)?(?:とても|すごく)?気にな(?:り|る|っ)|いいですね|良いですね|いいな|見てみたい|第一候補/.test(t) ? ["liked"] : [];
  if (!ASK_RE.test(t)) return liked;
  return [...NET.filter(([k, re]) => re.test(t) && !(k === "screening" && o.postApply)).map(([k]) => k), ...liked];
}
