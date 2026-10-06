// app/lib/pickup-list-load.ts — 売上サポ（AIXツール）のピックアップの一覧（/api/property-pickups?view=list）を1か所で読む（画面用）
// 2026-10-06 ⑫ 竹内「LINEツールからaixツールに…切り替える際にストレスかからないように」:
//   親（タブの数・行の「🧠 物件 N件」）と子（PickupReview の一覧）が同じ一覧を別々に読み、60秒と30秒で読み直していた（3.7秒×2）。
//   → 同じ鍵は1回だけ読み（page-cache の in-flight の共有）、戻った時は控えをすぐ出す。最初の1回は今日の分（days=1・約1.5秒）を先に出してから30日分
import { cachedLoad, cacheGet } from "./page-cache";

export type PickupListJson = {
  ok: boolean; error?: string; new_total?: number;
  customers?: Array<{ key: string; property_customer_id: string | null; conversation_id: string | null; pending: number; new_count?: number } & Record<string, unknown>>;
};

export const PICKUP_LIST_DAYS = 30;
export const PICKUP_LIST_FIRST_DAYS = 1;
const keyOf = (days: number) => `pickups:list:${days}`;

/** 一覧を読む（freshMs 以内に読んだ物があればそれ・読み中なら同じ物を待つ） */
export function loadPickupList(days = PICKUP_LIST_DAYS, opts: { freshMs?: number; force?: boolean } = {}): Promise<PickupListJson> {
  return cachedLoad<PickupListJson>(keyOf(days), async () => {
    const res = await fetch(`/api/property-pickups?view=list&days=${days}`, { cache: "no-store" });
    return (await res.json()) as PickupListJson;
  }, opts);
}

/** 控え（画面を作り直した時にすぐ出す物）。30日分が無ければ今日の分 */
export function cachedPickupList(maxAgeMs = 10 * 60_000): PickupListJson | null {
  return cacheGet<PickupListJson>(keyOf(PICKUP_LIST_DAYS), maxAgeMs)?.value ?? cacheGet<PickupListJson>(keyOf(PICKUP_LIST_FIRST_DAYS), maxAgeMs)?.value ?? null;
}

/** 一覧の行から「未確認のピックアップの数」を作る（親のタブ・行の札） */
export function pendingByCustomer(json: PickupListJson | null): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of json?.customers ?? []) if (c.property_customer_id && c.pending > 0) m.set(c.property_customer_id, c.pending);
  return m;
}
