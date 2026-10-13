// 読むだけ: 直近90日の送った物件（画像の読み取り）× 今のお客様の条件 → エリア・通勤・間取り・広さの外れ方を数える
import { createClient } from "@supabase/supabase-js";
import { parseAreaWant, buildPropertyLocation, matchArea, matchAnchors, parseCommuteWants, matchCommute } from "../app/lib/area-want";
import { normalizeFloorPlanWant, matchFloorPlan, isTooSmallPlan, isWideFloorPlan, isSameClassPlan, isLargerPlan } from "../app/lib/property-brain";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const since = new Date(Date.now() - 90 * 864e5).toISOString();

async function all<T>(q: (from: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) { const { data, error } = await q(f); if (error) throw error; out.push(...data); if (data.length < 1000) break; }
  return out;
}
const inc = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

(async () => {
  const imgs = await all<any>((f) => sb.from("sent_image_properties").select("conversation_id,property_name,facts,created_at").gte("created_at", since).not("facts", "is", null).range(f, f + 999));
  const sp = await all<any>((f) => sb.from("sent_properties").select("conversation_id,property_customer_id,sent_at").not("property_customer_id", "is", null).gte("sent_at", new Date(Date.now() - 200 * 864e5).toISOString()).range(f, f + 999));
  const conv2pc = new Map<string, string>();
  for (const r of sp.sort((a, b) => a.sent_at.localeCompare(b.sent_at))) conv2pc.set(r.conversation_id, r.property_customer_id);
  const ids = [...new Set(conv2pc.values())];
  const pcs = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from("property_customers").select("id,desired_area,commute_station,commute_minutes,preferences,other_requests,floor_plan,floor_area_min,floor_area_max,area_mode,additional_conditions").in("id", ids.slice(i, i + 200));
    for (const p of data ?? []) pcs.set(p.id, p);
  }
  const seen = new Set<string>();
  const area: Record<string, number> = {}, comm: Record<string, number> = {}, fp: Record<string, number> = {}, sqm: Record<string, number> = {};
  const fpPairs: Record<string, number> = {};
  const farEx: string[] = [];
  let n = 0;
  for (const r of imgs) {
    const f = r.facts; if (!f || typeof f !== "object") continue;
    if (/申込/.test(String(f.status ?? ""))) continue;
    const pcId = conv2pc.get(r.conversation_id); if (!pcId) continue;
    const pc = pcs.get(pcId); if (!pc) continue;
    const key = `${r.conversation_id}|${r.property_name ?? ""}|${f.room_no ?? ""}`; if (seen.has(key)) continue; seen.add(key);
    n++;
    const sts: any[] = Array.isArray(f.stations) ? f.stations : [];
    const summary = "x\n" + sts.filter((s) => s?.station).map((s) => `${s.line ?? ""}「${String(s.station).replace(/駅$/, "")}」徒歩${s.walk ?? ""}分`).join("\n");
    const loc = buildPropertyLocation(summary, null);
    const free = [pc.preferences, pc.other_requests].filter(Boolean).join("\n");
    const want = parseAreaWant(pc.desired_area, free);
    const am = want.any ? (matchAnchors(want, loc) ?? matchArea(want, loc)) : null;
    const ac = !want.any ? "NO_AREA_WANT" : (am?.code ?? "NONE");
    inc(area, ac);
    if (/FAR|CLOSE|REGION|2STOPS|STATION_WIDE|NEAR/.test(ac) && farEx.length < 25) farEx.push(`${ac}: 希望「${String(pc.desired_area ?? "").slice(0, 30)}」→ ${sts.map((s) => s.station).join("/")} ${am?.why ?? ""}`);
    for (const c of matchCommute(parseCommuteWants(pc), loc)) inc(comm, c.code);
    const fw = normalizeFloorPlanWant(pc.floor_plan);
    const p = f.floor_plan;
    let fc = "unknown";
    if (fw.any || (!fw.plans.length && fw.minRank == null)) fc = "no_want";
    else if (!p) fc = "plan_unread";
    else {
      const m = matchFloorPlan(fw, p);
      fc = m === "match" ? "MATCH" : isWideFloorPlan(fw, p) ? "WIDE(LDK→同部屋数DK)" : m === "near" ? "NEAR(同部屋数の型違い)" : isSameClassPlan(fw, p) ? "SAME_CLASS(2DK↔1LDK)" : isLargerPlan(fw, p) ? "LARGER(広い)" : isTooSmallPlan(fw, p) ? "TOO_SMALL(外す候補)" : m === "mismatch" ? "MISMATCH(保留)" : m;
      if (fc !== "MATCH") inc(fpPairs, `${pc.floor_plan} → ${p}`);
    }
    inc(fp, fc);
    const a = typeof f.area_sqm === "number" ? f.area_sqm : parseFloat(f.area_sqm);
    const min = pc.floor_area_min ?? fw.sqmMin;
    if (min == null) inc(sqm, "no_min");
    else if (!Number.isFinite(a)) inc(sqm, "unread");
    else if (a >= min) inc(sqm, pc.floor_area_max != null && a > pc.floor_area_max ? "over_max" : "OK");
    else if (a >= min * 0.9) inc(sqm, "SLIGHTLY_UNDER(9割)");
    else if (a >= min - 5) inc(sqm, "WIDE(−5㎡)");
    else if (a >= min - 10) inc(sqm, "UNDER(−5〜−10㎡・保留)");
    else inc(sqm, "UNDER(−10㎡超・保留)");
  }
  const top = (m: Record<string, number>, k = 40) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, k);
  console.log(JSON.stringify({ n, convs: new Set([...seen].map((s) => s.split("|")[0])).size, area: top(area), commute: top(comm), floor: top(fp), sqm: top(sqm), fpPairs: top(fpPairs, 25), farEx }, null, 1));
})();
