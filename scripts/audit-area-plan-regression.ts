// 2026-10-02 ⑯ エリアの読み（出やすい・1本・乗り換えなし）を変えた後の当て直し（読むだけ・LLM なし・行は書き換えない）
// 実行: npx tsx --env-file=.env.local scripts/audit-area-plan-regression.ts
//   保存済みの property_pickups.location（交通・区）に、今の parseAreaWant＋matchArea を当て直し、エリアの札の前後と点の増減を数える。
//   「悪くなった」＝点が下がった行。スタッフが送った行（status=sent）は別に数える。
import { createClient } from "@supabase/supabase-js";
import { parseAreaWant, matchArea, type PropertyLocation } from "../app/lib/area-want";
import { stationPoint } from "../app/lib/osaka-geo";
import { REASON_POINTS } from "../app/lib/property-brain";
// --before=<file>: 変える前の area-want と比べる（例: git show 047a5749~1:app/lib/area-want.ts > app/lib/_area-want-before.ts で一時に置き --before=../app/lib/_area-want-before.ts・終わったら消す）。無ければ保存済みの札と比べる
const beforeArg = (process.argv.find((a) => a.startsWith("--before=")) ?? "").split("=")[1] || null;

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pts = (c: string | null | undefined) => (c ? (REASON_POINTS as Record<string, number>)[c] ?? 0 : 0);

(async () => {
  const old = beforeArg ? await import(beforeArg) : null;
  const rows: Array<{ property_customer_id: string; status: string | null; location: unknown }> = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data } = await db.from("property_pickups").select("property_customer_id, status, location").not("location", "is", null).range(from, from + 999);
    if (!data?.length) break;
    rows.push(...(data as typeof rows));
    if (data.length < 1000) break;
  }
  const ids = [...new Set(rows.map((r) => r.property_customer_id).filter(Boolean))];
  const custs = new Map<string, { desired_area: string | null; preferences: string | null; other_requests: string | null }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db.from("property_customers").select("id, desired_area, preferences, other_requests").in("id", ids.slice(i, i + 200));
    for (const c of data ?? []) custs.set(c.id, c);
  }
  const moves = new Map<string, number>();
  let same = 0, better = 0, worse = 0, sentWorse = 0, total = 0;
  const worseEx: string[] = [];
  const changedCustomers = new Set<string>();
  for (const r of rows) {
    const c = custs.get(r.property_customer_id);
    const l = r.location as { stations?: PropertyLocation["stations"]; ward?: string | null; area?: { code?: string } | null } | null;
    if (!c || !l?.stations) continue;
    const st = l.stations.find((s) => s.known && stationPoint(s.station));
    const p = st ? stationPoint(st.station) : null;
    const loc: PropertyLocation = { stations: l.stations, ward: l.ward ?? null, wardSource: null, point: p ? { lat: p.lat, lon: p.lon } : null, pointSource: p ? "station" : null };
    const want = parseAreaWant(c.desired_area, [c.preferences, c.other_requests].filter(Boolean).join("\n"));
    const before = old ? (old.matchArea(old.parseAreaWant(c.desired_area, [c.preferences, c.other_requests].filter(Boolean).join("\n")), loc)?.code ?? null) : (l.area?.code ?? null);
    const after = matchArea(want, loc)?.code ?? null;
    total++;
    if (before === after) { same++; continue; }
    changedCustomers.add(r.property_customer_id);
    const key = `${before ?? "-"} → ${after ?? "-"}`;
    moves.set(key, (moves.get(key) ?? 0) + 1);
    const d = pts(after) - pts(before);
    if (d > 0) better++;
    else if (d < 0) { worse++; if (r.status === "sent") sentWorse++; if (worseEx.length < 15) worseEx.push(`${String(c.desired_area).slice(0, 40)}｜${key}（${d}）`); }
  }
  console.log(`■ 当て直し: ${total}行（${ids.length}人）・同じ ${same}・変わった ${total - same}（${changedCustomers.size}人）・点が上がった ${better}・下がった ${worse}（うちスタッフが送った行 ${sentWorse}）`);
  for (const [k, n] of [...moves].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${k}: ${n}`);
  if (worseEx.length) { console.log("■ 下がった例"); for (const e of worseEx) console.log(`  ${e}`); }
})();
