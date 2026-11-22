/**
 * 送った資料の画像の物件の読みが「欄の少ない答え」だった時に1回だけ読み直す（純関数の部分・2026-11-22 作業員G・台帳 #509）
 *
 * なぜ: オススメで送った資料の画像の値で、家賃・間取り・築年が抜けた記録が 14日 38件中 約20件。抜けた画像を同じ問いで読み直すと
 *   8回とも全部の欄が埋まった（答え 104〜109 トークン）。本番で抜けた時の答えは 88 トークン＝DeepSeek がまれに欄の少ない答えを返していた
 *   （こちらのコードの後の処理は値を落としていない）。
 * 決まり: 1件の資料の画像で、家賃・間取り・築年のうち2つ以上が空なら、同じ問いで1回だけ読み直し、埋まった欄の多い方を使う。
 *   既定 off（SENT_IMAGE_READ_RETRY_THIN=on）。回数と費用はログ（sent-image-read:retry-thin）に残す
 */
export function sentReadRetryThinOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SENT_IMAGE_READ_RETRY_THIN ?? "").trim().toLowerCase() === "on";
}

type ItemLike = { rent?: number | null; floorPlan?: string | null; built?: string | null; areaSqm?: number | null; station?: string | null; roomNumber?: string | null; status?: string | null };
const KEY_FIELDS = ["rent", "floorPlan", "built"] as const;
const ALL_FIELDS = ["rent", "floorPlan", "built", "areaSqm", "station", "roomNumber", "status"] as const;
const has = (v: unknown) => v !== null && v !== undefined && v !== "";

/** 家賃・間取り・築年のうち2つ以上が空＝欄の少ない答え */
export function isThinRead(item: ItemLike | null | undefined): boolean {
  if (!item) return false;
  return KEY_FIELDS.filter((k) => !has(item[k])).length >= 2;
}

export function filledCount(item: ItemLike | null | undefined): number {
  return item ? ALL_FIELDS.filter((k) => has(item[k])).length : 0;
}

/** 読み直しの方が埋まった欄が多ければ読み直しを使う */
export function pickRicher<T extends ItemLike>(first: T, retry: T | null | undefined): { item: T; used: "first" | "retry" } {
  if (retry && filledCount(retry) > filledCount(first)) return { item: retry, used: "retry" };
  return { item: first, used: "first" };
}
