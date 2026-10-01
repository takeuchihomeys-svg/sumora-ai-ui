// app/lib/sent-image-order.ts
// 売上サポ → AIX【物件ピックアップした】で送る資料の画像の並び（純関数・DB 依存なし）。
//
// 2026-10-01 竹内さん「送った資料の1枚目が一番オススメの物件にする形 1枚目の👑」:
//   旧: 送る画像の並びは GET /api/property-pickups?ids= が rank（拡張が検索した順）で並べ直していた＝画面の並び（👑 → 点の順）と違った。
//     実送信（scripts/tmp-audit-pickup-first-image.ts・売上サポから2件以上を送った 20回）: 1枚目（rank 順）と画面の先頭が同じ 8/20。
//     👑（まとめの best_id）が分かる3回（YUMA 以外）で、1枚目が 👑 だったのは 1/3。
//     2通目（aix-template-generate）が推す物件は画面の並びの先頭（sortForReview）だったので、送った1枚目と2通目の物件が食い違う回があった。
//   → 送る並び＝画面の並び（👑 が先頭・次に点の順。PickupReview の sortForReview(items, roundBestId)）にし、GET は頼まれた ids の順で返す。
//     2通目は「送った画像の1枚目」（AixModal が AIX の記録 picker_choices.first_pickup_id に残す）を推す。
//   ⚠ 送った印の記録（/api/property-pickups/send → pickup-sent-plan.planPickupSentWrites）は、届いた画像の URL を rank 順の行と位置で結ぶ。
//     並びを変えたので、画面は URL を rank 順に並べ直してから渡す（imageUrlsInRankOrder）。並べ直せない時は渡さない（結ばない＝誤記録0）

/** 頼まれた ids の順に並べる（ids に無い行は後ろに rank・id の順） */
export function orderByRequestedIds<T extends { id: number; rank: number }>(rows: ReadonlyArray<T>, ids: ReadonlyArray<number>): T[] {
  const pos = new Map<number, number>();
  ids.forEach((id, i) => { if (!pos.has(id)) pos.set(id, i); });
  const big = Number.MAX_SAFE_INTEGER;
  return [...rows].sort((a, z) => ((pos.get(a.id) ?? big) - (pos.get(z.id) ?? big)) || (a.rank - z.rank) || (a.id - z.id));
}

/**
 * 届いた画像の URL（送った順＝items の順）を、送った印の記録が結ぶ順（rank → id）に並べ直す。
 * items と urls の数が合わない・rank が読めない時は [] （URL を渡さない＝記録は画像の読み取りに任せる）
 */
export function imageUrlsInRankOrder(items: ReadonlyArray<{ id: number; rank: number | null | undefined }>, urls: ReadonlyArray<string>): string[] {
  if (items.length === 0 || items.length !== urls.length) return [];
  if (items.some((it) => typeof it.rank !== "number" || !Number.isFinite(it.rank))) return [];
  return items.map((it, i) => ({ it, url: urls[i] }))
    .sort((a, z) => ((a.it.rank as number) - (z.it.rank as number)) || (a.it.id - z.it.id))
    .map((x) => x.url);
}

/**
 * 送った画像の1枚目が売上サポのどの行か。セットした画像（File）と送る直前の並びを同一性で比べる。
 * 送る直前の1枚目がセットした画像のどれでもない（スタッフが差し替えた）・分からない時は null
 */
export function firstSentPickupId<F>(p: { handoffIds: ReadonlyArray<number> | null | undefined; handoffFiles: ReadonlyArray<F> | null | undefined; sentFiles: ReadonlyArray<F> | null | undefined }): number | null {
  const ids = p.handoffIds ?? [], files = p.handoffFiles ?? [], sent = p.sentFiles ?? [];
  if (ids.length === 0 || ids.length !== files.length || sent.length === 0) return null;
  const i = files.indexOf(sent[0]);
  return i >= 0 ? ids[i] : null;
}
