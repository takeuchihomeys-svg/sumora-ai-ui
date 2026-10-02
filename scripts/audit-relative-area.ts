// 2026-10-02 ⑯ 「なんば・梅田に出やすい」の当て直し（読むだけ・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-relative-area.ts [--customer=<id>]
//   ① 全てのお客様で「◯◯に出やすい」「タクシー」を読み、area_plan の区と駅の数を出す
//   ② area_plan の駅が station_map（各サイトの名前）で引けるか（引けない駅は検索に入らない）
//   ③ 保存済みの property_pickups.location のエリアの札を、新しい読みで付け直した時の前後（行は書き換えない）
//   ④ 相場の材料（rent_observations）でお客様に送れる文
import { createClient } from "@supabase/supabase-js";
import { readRelativeArea, buildAreaPlan, wardAccessFacts } from "../app/lib/osaka-area-profile";
import { parseAreaWant, matchArea, type PropertyLocation } from "../app/lib/area-want";
import { customerAreaAndRent } from "../app/lib/area-rent-server";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const only = (process.argv.find((a) => a.startsWith("--customer=")) ?? "").split("=")[1] || null;

(async () => {
  let q = db.from("property_customers").select("id, customer_name, desired_area, preferences, other_requests, floor_plan, rent_max, pet");
  if (only) q = q.eq("id", only);
  const { data: custs } = await q.limit(1000);
  const rel = (custs ?? []).filter((c) => readRelativeArea(c.desired_area, [c.preferences, c.other_requests].filter(Boolean).join("\n")).anchors.length > 0 || only);
  console.log(`■ ① 「◯◯に出やすい」を読めたお客様: ${rel.length} / ${(custs ?? []).length}人`);
  const { data: sm } = await db.from("station_map").select("token, realpro_lines").neq("source", "unknown").limit(5000);
  const known = new Set((sm ?? []).filter((r) => (r.realpro_lines ?? []).length > 0).map((r) => r.token as string));
  for (const c of rel) {
    const free = [c.preferences, c.other_requests].filter(Boolean).join("\n");
    const w = readRelativeArea(c.desired_area, free);
    const plan = buildAreaPlan(w);
    if (!plan) { console.log(`- ${String(c.customer_name).slice(0, 2)}… 「${c.desired_area}」→ 地点なし`); continue; }
    const missing = plan.stations.filter((s) => !known.has(s.station)).map((s) => s.station);
    console.log(`- ${String(c.customer_name).slice(0, 2)}…（${c.id.slice(0, 8)}）「${String(c.desired_area).slice(0, 40)}」\n    ${plan.summary}\n    ② station_map に無い駅 ${missing.length}: ${missing.slice(0, 12).join("・")}`);
    if (only) for (const f of wardAccessFacts(plan, 12)) console.log(`    ・${f}`);
    // ③ 保存済みのピックアップの札の前後
    const { data: rows } = await db.from("property_pickups").select("property_name, location").eq("property_customer_id", c.id).not("location", "is", null).limit(300);
    const want = parseAreaWant(c.desired_area, free);
    const moves = new Map<string, number>();
    for (const r of rows ?? []) {
      const l = r.location as { stations?: PropertyLocation["stations"]; ward?: string | null; area?: { code?: string } | null } | null;
      if (!l?.stations) continue;
      const { stationPoint } = await import("../app/lib/osaka-geo");
      const st = l.stations.find((s) => s.known && stationPoint(s.station));
      const p = st ? stationPoint(st.station) : null;
      const loc: PropertyLocation = { stations: l.stations, ward: l.ward ?? null, wardSource: null, point: p ? { lat: p.lat, lon: p.lon } : null, pointSource: p ? "station" : null };
      const after = matchArea(want, loc)?.code ?? "-";
      const key = `${l.area?.code ?? "-"} → ${after}`;
      moves.set(key, (moves.get(key) ?? 0) + 1);
    }
    if (moves.size) console.log(`    ③ ピックアップ ${rows?.length}行の札: ${[...moves].map(([k, n]) => `${k} ${n}`).join("／")}`);
    if (only || rel.length <= 20) {
      const { rentMarket } = await customerAreaAndRent(c);
      for (const f of rentMarket?.facts ?? []) console.log(`    ④ ${f}`);
      for (const s of rentMarket?.sentences ?? []) console.log(`    ④ 文: ${s}`);
    }
  }
})();
