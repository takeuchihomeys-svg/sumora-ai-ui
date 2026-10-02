// 2026-10-02 ⑯ 手順3: 「家賃と部屋の条件」の相場を、スタッフの実際の選択（正解・feedback_property_selection_label）で確かめる（読むだけ・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-market-gap-vs-staff.ts
//   売上サポの1回（batch）で、スタッフが送った物（status=sent）と送らなかった物を比べる:
//     ・相場（区×間取りの中央値）からの差 ・安い理由がお客様の希望に当たる（tradeoffHits）か
//     ・今の点の並びに「希望に当たる安い理由 1つにつき −N 点」を足すと、選んだ物が上に来るか（重みは変えない・当て直しだけ）
import { createClient } from "@supabase/supabase-js";
import { conditionMarket, explainGap, tradeoffHits, type CondObs, type TradeoffWants } from "../app/lib/rent-condition-market";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const unitKey = (name: string | null, room: string | null) =>
  String(name ?? "").normalize("NFKC").replace(/[\s・･()（）「」\[\]【】]/g, "").toLowerCase() + "#" + String(room ?? "").normalize("NFKC").replace(/[^0-9A-Za-z]/g, "");

async function all<T>(table: string, cols: string, f?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < 60000; from += 1000) {
    let q = db.from(table).select(cols).range(from, from + 999);
    if (f) q = f(q);
    const { data } = await q;
    if (!data?.length) break;
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

function wantsOf(c: any): TradeoffWants {
  const t = [c.preferences, c.other_requests, c.ng_points, c.structure_types, c.additional_conditions].filter(Boolean).join("\n").normalize("NFKC");
  return {
    newBuild: /築浅|新築/.test(t), maxAge: typeof c.building_age === "number" ? c.building_age : null,
    notWood: /木造\s*(?:NG|ng|不可|以外|避け|嫌)|木造は|鉄筋|RC|鉄骨/.test(t), soundproof: /防音|音が|騒音/.test(t),
    walkMax: typeof c.walk_minutes === "number" ? c.walk_minutes : null, minSqm: typeof c.floor_area_min === "number" ? c.floor_area_min : null,
    floor2: /2階以上|二階以上|1階(?:は|NG|不可|以外)/.test(t), autolock: /オートロック/.test(t), bathToilet: /バス.?トイレ別|風呂.?トイレ.?別|BT別/.test(t),
    washbasin: /独立洗面|洗面台/.test(t), deliveryBox: /宅配/.test(t),
  };
}

(async () => {
  const obs = await all<CondObs & { unit_key: string }>("rent_observations", "unit_key, ward, plan_group, rent_total, building_age, walk_minutes, floor, structure, area_sqm, equipment, usage_rank", (q) => q.eq("branch_id", "osaka"));
  const byKey = new Map(obs.map((o) => [o.unit_key, o]));
  const picks = await all<any>("property_pickups", "batch_id, property_customer_id, property_name, room_no, status, score", (q) => q.not("batch_id", "is", null));
  const custIds = [...new Set(picks.map((p) => p.property_customer_id).filter(Boolean))];
  const custs = new Map<string, any>();
  for (let i = 0; i < custIds.length; i += 200) {
    const { data } = await db.from("property_customers").select("id, preferences, other_requests, ng_points, structure_types, additional_conditions, building_age, walk_minutes, floor_area_min").in("id", custIds.slice(i, i + 200));
    for (const c of data ?? []) custs.set(c.id, c);
  }
  const marketCache = new Map<string, ReturnType<typeof conditionMarket>>();
  const marketFor = (o: CondObs) => {
    const k = `${o.ward}|${o.plan_group}`;
    if (!marketCache.has(k)) marketCache.set(k, conditionMarket(obs, o.ward ? [o.ward] : [], String(o.plan_group)));
    return marketCache.get(k)!;
  };
  const by = new Map<string, any[]>();
  for (const p of picks) { const a = by.get(p.batch_id) ?? []; a.push(p); by.set(p.batch_id, a); }
  const stat = { chosen: { n: 0, cheap: 0, hits: 0, gapSum: 0, gapN: 0, withGap: 0 }, other: { n: 0, cheap: 0, hits: 0, gapSum: 0, gapN: 0, withGap: 0 } };
  const penalties = [0, 3, 5, 8, 12];
  const top1 = new Map<number, number>(penalties.map((x) => [x, 0]));
  let chosenTotal = 0, batches = 0;
  const hitDims = new Map<string, { chosen: number; other: number }>();
  for (const [, rs] of by) {
    if (!rs.some((r) => r.status === "sent") || rs.length < 2) continue;
    batches++;
    const c = custs.get(rs[0].property_customer_id) ?? {};
    const w = wantsOf(c);
    const rows = rs.map((r) => {
      const o = byKey.get(unitKey(r.property_name, r.room_no));
      const gap = o ? explainGap(o, marketFor(o)) : null;
      const hits = o ? tradeoffHits(gap, o, w) : [];
      return { r, gap, hits, chosen: r.status === "sent" };
    });
    for (const x of rows) {
      const s = x.chosen ? stat.chosen : stat.other;
      s.n++;
      if (x.gap) { s.withGap++; s.gapSum += x.gap.gapYen; s.gapN++; if (x.gap.gapYen < 0) s.cheap++; }
      if (x.hits.length) s.hits++;
      for (const h of x.hits) { const d = hitDims.get(h.dim) ?? { chosen: 0, other: 0 }; if (x.chosen) d.chosen++; else d.other++; hitDims.set(h.dim, d); }
    }
    for (const pen of penalties) {
      const sc = rows.map((x) => (x.r.score ?? 0) - pen * x.hits.length);
      const max = Math.max(...sc);
      rows.forEach((x, i) => { if (x.chosen && sc[i] === max) top1.set(pen, (top1.get(pen) ?? 0) + 1); });
    }
    chosenTotal += rows.filter((x) => x.chosen).length;
  }
  const pc = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
  console.log(`■ 売上サポの回 ${batches}・選んだ物 ${stat.chosen.n}・選ばなかった物 ${stat.other.n}`);
  for (const [k, s] of Object.entries(stat)) {
    console.log(`  ${k === "chosen" ? "選んだ" : "選ばなかった"}: 相場と比べられる ${pc(s.withGap, s.n)}・相場より安い ${pc(s.cheap, s.withGap)}・差の平均 ${s.gapN ? Math.round(s.gapSum / s.gapN) : "-"}円・安い理由が希望に当たる ${pc(s.hits, s.n)}`);
  }
  console.log(`  希望に当たった安い理由（選んだ／選ばなかった）: ${[...hitDims].map(([d, v]) => `${d} ${v.chosen}/${v.other}`).join("・") || "なし"}`);
  console.log("■ 当て直し（今の点 − 希望に当たる安い理由1つにつき N 点）で、選んだ物が1位（同点含む）に入る率");
  for (const pen of penalties) console.log(`  N=${pen}: ${pc(top1.get(pen) ?? 0, chosenTotal)}`);
})();
