// scripts/lib/exam-pickup-copy.ts — 試験の写しの property_pickups を本番の相場の観測（rent_observations）に入れない（2026-11-05 作業員1・弱い所 303）
//
// property_pickups の AFTER INSERT の trigger（rent_observe_pickup_trg → rent_observe_pickup_apply）は会話を見ずに rent_observations に upsert する。
//   試験の写し（YUMA2〜7）の行も入り、last_seen_at・usage_rank・sent_to_customer・pickup_id が動き、伏せで名前が変わった行は新しい部屋として相場の百分位に入る。
// つなぎ（案B・竹内さんの承認した DDL 案A が入るまで）: 名前を空で insert し（関数は名前が空なら RETURN）、あとで名前だけ update する
//   （trigger の UPDATE OF は equipment, terms, status, sent_at, recommended, location で property_name では発火しない）。
//   ⚠ trigger の定義が変わると静かに壊れる → hazard-audit (m) が UPDATE OF の列と「名前が空なら RETURN」を毎朝見る。
//   既定 on（止める EXAM_PICKUP_NAME_LATE=off）
export function examPickupNameLateOn(env: Record<string, string | undefined> = process.env): boolean {
  return (env.EXAM_PICKUP_NAME_LATE ?? "").trim().toLowerCase() !== "off";
}
/** insert する行（名前を空に）と、あとで update する名前（行の順と同じ・空の名前は null） */
export function splitPickupNames<T extends Record<string, unknown>>(rows: ReadonlyArray<T>): { insertRows: T[]; names: Array<string | null> } {
  const names = rows.map((r) => (typeof r.property_name === "string" && r.property_name ? r.property_name : null));
  const insertRows = rows.map((r) => ({ ...r, property_name: "" }) as T);
  return { insertRows, names };
}
/** hazard-audit (m): trigger の定義と関数の中身が「名前で update しても発火しない・名前が空なら戻る」のままか */
export function pickupTriggerStillSkips(triggerDef: string, fnDef: string): { ok: boolean; why: string[] } {
  const why: string[] = [];
  const m = triggerDef.match(/UPDATE OF ([^]*?) ON /i);
  if (!/AFTER INSERT/i.test(triggerDef)) why.push("AFTER INSERT ではない");
  if (!m) why.push("UPDATE OF の列が無い（全部の UPDATE で発火する）");
  else if (/\bproperty_name\b/.test(m[1])) why.push("UPDATE OF に property_name がある");
  if (!/IF\s+coalesce\(p\.property_name,\s*''\)\s*=\s*''\s+THEN\s+RETURN/i.test(fnDef)) why.push("名前が空なら RETURN が無い");
  return { ok: why.length === 0, why };
}
