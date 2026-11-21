/**
 * こちらが手でまとめて送った画像の束で、文字の無い室内写真を、同じ束の資料の物件に結ぶ（2026-11-21 作業員G・台帳 #461 案3・LLM なし）
 *
 * なぜ: 手で送った画像の記録の無い物のうち「室内写真（同じ束に資料がある）」が 14日で 4枚。写真には文字が無いので
 *   物件の読み（DeepSeek）では物件名が出ない。お客様がその写真を引用して「この部屋は…」と聞いた時にどの物件か分からない。
 *
 * 決まり（作らない側に倒す）:
 *   - 同じ1回の送信（LINE のまとめ送り）の画像だけを見る
 *   - その束で物件の記録が付いた画像が、物件（名前＋号室）として**ちょうど1つ**の時だけ、記録の無い画像をその物件に結ぶ
 *     （2つ以上の物件が混ざる束・1つも無い束は結ばない）
 *   - 記録の有る画像は触らない。結んだ記録は source を分ける（batch_sheet）
 *   - 書類の番（sent-image-doc-guard）・申込中の会話は、資料の記録自体が付かないので結ばれない
 *   - 既定 off（SENT_BATCH_PHOTO_ATTRIBUTE=on）
 */

export type BatchImageRecord = { url: string; propertyName: string | null; roomNo: string | null };

const norm = (s: string | null | undefined) => String(s ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();

/** 束の中で結ぶ物（url → 物件）。結ばない時は空 */
export function batchPhotoAttribution(records: ReadonlyArray<BatchImageRecord>): Array<{ url: string; propertyName: string; roomNo: string | null }> {
  if (records.length < 2) return [];
  const named = records.filter((r) => (r.propertyName ?? "").trim());
  if (named.length === 0) return [];
  const keys = new Set(named.map((r) => `${norm(r.propertyName)}#${norm(r.roomNo)}`));
  if (keys.size !== 1) return [];
  const src = named[0];
  return records
    .filter((r) => !(r.propertyName ?? "").trim())
    .map((r) => ({ url: r.url, propertyName: src.propertyName!.trim(), roomNo: (src.roomNo ?? "").trim() || null }));
}

export function sentBatchPhotoAttributeOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SENT_BATCH_PHOTO_ATTRIBUTE ?? "").trim().toLowerCase() === "on";
}
