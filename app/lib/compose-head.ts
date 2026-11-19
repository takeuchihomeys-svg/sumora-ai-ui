// app/lib/compose-head.ts — 頭の一言（受けの開口語）を実物の数で分け直す（COMPOSE_HEAD_SPLIT・既定 off・純関数）
//   作業員10・2026-11-12 統括役（頭の一言 56%・作業員23 のカタログの3分岐＝動く かしこまりました 37%・受けなし 29%・はい 20%／答えるだけ 受けなし 62%／頂いた 〇〇頂きありがとうございます 46%＝多数派でない）
//   名前は作業員23 の sentence-pattern-catalog の OpenerWord（kashikomari / hai / arigato / daijobu / none）に揃える
//
// ■ 数え（費用0・竹内さんの 198番 roles-r1 ＋ problems の竹内さんの番 176通・名前と挨拶の行を剥がした最初の1文）
//   何で分かれるか: 一番効くのは「お客様の文の種類」、次に「直前のこちらの送信」。誘導先・主の役目では分かれにくい
//     お礼だけ        → はい 59%（198）・52%（problems）
//     初回（挨拶の番） → 受けなし 83%（ご連絡頂きありがとうございます は挨拶の段）
//     問い            → 受けなし 40%・46%（直前にこちらが約束・問うた番は かしこまりました 44%）
//     送ってきた（画像・URL・条件のフォーム）→ 受けなし 63%・55%（直前にこちらが約束した番は かしこまりました 64%）
//     依頼            → かしこまりました 38%・39%
//     報告・事情      → かしこまりました 59%（problems）・受けなし 41%（198）
//     直前にこちらが問うた → かしこまりました 60%
//   この木を当てた中の値: 198番 87/198（44%・直前の送信なし）・problems 94/176（53%）／3分岐 64/198（32%）・35/176（20%）／いつも かしこまりました 60/198・67/176
//   ⚠ 中で測った値（同じ番で作った）。半分しか当たらない＝頭の一言は会話の流れ（同じ日の何通目か等）でも分かれる。見ていない番で確かめる

type Env = Record<string, string | undefined>;
export function composeHeadSplitOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.COMPOSE_HEAD_SPLIT ?? "").trim().toLowerCase() === "on";
}
export type HeadWord = "kashikomari" | "hai" | "arigato" | "daijobu" | "none";
export const HEAD_WORD_JA: Record<HeadWord, string> = { kashikomari: "かしこまりました", hai: "はい", arigato: "〇〇頂きありがとうございます", daijobu: "大丈夫です", none: "受けなし（答え・本題から書く）" };
export type CustomerKind = "sent" | "thanks" | "considering" | "request" | "question" | "report";
export type PrevKind = "first" | "sent" | "asked" | "promised" | "other";

export function customerKindOf(text: string): CustomerKind {
  const c = String(text ?? "");
  if (/\[画像\]|\[ファイル\]|https?:\/\/|ご希望のお部屋探しご条件|①【/.test(c)) return "sent";
  if (/ありがとう/.test(c) && !/[?？]|ですか|ますか/.test(c)) return "thanks";
  if (/検討/.test(c)) return "considering";
  if (/お願い|ください|下さい|したい|欲しい|ほしい|頂けますか|いただけますか|もらえ/.test(c)) return "request";
  if (/[?？]|ですか|ますか|でしょうか|かな/.test(c)) return "question";
  return "report";
}
export function prevKindOf(prev: { text: string | null; aix?: boolean } | null): PrevKind {
  if (!prev) return "first";
  const t = prev.text ?? "";
  if (prev.aix || /🌟|ピックアップさせて|お送りさせて(?:頂|いただ)きました|ご査収/.test(t)) return "sent";
  if (/[?？]|でしょうか|如何|いかが|ございますか/.test(t)) return "asked";
  if (/確認させて|させて頂きます|お送りさせて頂きます/.test(t)) return "promised";
  return "other";
}
/** 頭の一言の木（上の数え・多い方を採る） */
export function headWordOf(o: { customerText: string; prev: { text: string | null; aix?: boolean } | null }): { word: HeadWord; why: string } {
  const ck = customerKindOf(o.customerText), pk = prevKindOf(o.prev);
  if (pk === "first") return { word: "none", why: "初回は挨拶の段（ご連絡頂きありがとうございます）だけ（83%）" };
  if (ck === "thanks") return { word: "hai", why: "お礼だけの番は はい（52〜59%）" };
  if (ck === "question") return pk === "promised" || pk === "asked" ? { word: "kashikomari", why: "直前にこちらが約束・問うた後の問い（44%）" } : { word: "none", why: "問いの番は答えから（受けなし 40〜46%）" };
  if (ck === "sent") return pk === "promised" ? { word: "kashikomari", why: "こちらが約束した後に送ってきた（64%）" } : { word: "none", why: "送ってきた番は受けなし（55〜63%）" };
  return { word: "kashikomari", why: ck === "request" ? "依頼の番（38〜39%）" : ck === "considering" ? "検討の番" : "報告・事情の番（59%）" };
}
export function headNote(o: { customerText: string; prev: { text: string | null; aix?: boolean } | null }, env?: Env): string {
  if (!composeHeadSplitOn(env)) return "";
  const h = headWordOf(o);
  return `- 頭の一言: ${HEAD_WORD_JA[h.word]}（${h.why}・竹内さんの実送信の数）`;
}
