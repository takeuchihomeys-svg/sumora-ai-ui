// 検索の点検の1回を読む（入れた値 ↔ 登録の条件・操作ごとの時刻・止まった時の様子）。読むだけ（書き込みなし・DeepSeek を呼ばない）
// 2026-09-27 竹内「2000回試すなど危ないやり方なのでやらない…もっと人間が試した形で試す」: 本物の検索1回の記録で確かめるための道具
// 実行: npx tsx --env-file=.env.local scripts/search-audit-timeline.ts --id=24
//       npx tsx --env-file=.env.local scripts/search-audit-timeline.ts --customer=509cd061-60cc-49a9-8c5a-4f356c4a5f88   （そのお客様の最新の1回）
import { createClient } from "@supabase/supabase-js";
import { runSearchAuditChecks, type AuditInput } from "../app/lib/search-audit-check";
import { auditTimeline, summarizeOps, humanGaps, type TimingOp } from "../app/lib/search-audit-timing";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? null;

(async () => {
  const id = arg("id"), cust = arg("customer");
  let q = sb.from("search_audits").select("*");
  q = id ? q.eq("id", Number(id)) : cust ? q.eq("property_customer_id", cust).order("id", { ascending: false }).limit(1) : q.order("id", { ascending: false }).limit(1);
  const { data, error } = await q;
  if (error) { console.error("読めない:", error.message); process.exit(1); }
  const r = (data ?? [])[0] as Record<string, any> | undefined;
  if (!r) { console.log("該当なし"); return; }
  console.log(`■ 点検 ${r.id}  ${r.created_at}  site=${r.site} trigger=${r.trigger} 広げて=${r.is_wide} 版=${r.ext_version} status=${r.status}`);
  const c = r.customer_snapshot ?? {}, i = r.intended ?? {}, f = r.filled?.form ?? null;
  console.log("\n■ 登録の条件（検索を始めた時の写し） ↔ 入れようとした値 ↔ 画面に入った値");
  const row = (label: string, a: unknown, b: unknown, x: unknown) => console.log(`  ${label.padEnd(6, "　")} 登録=${JSON.stringify(a ?? null)} ／ 入れようとした=${JSON.stringify(b ?? null)} ／ 入った=${f ? JSON.stringify(x ?? null) : "（読み戻しなし）"}`);
  row("エリア", c.desired_area, i.city_codes ?? i.station_names, f?.wards ?? f?.stations);
  row("間取り", c.floor_plan, i.floor_plan, f?.layouts);
  row("家賃", c.rent_max, i.rent_max, f?.rent_max);
  row("築年", c.building_age, i.building_age, f?.age);
  row("徒歩", c.walk_minutes, i.walk_minutes, f?.walk);
  row("こだわり", c.preferences, { pet_ok: i.pet_ok, shikirei_free: i.shikirei_free }, null);
  const v = runSearchAuditChecks(r as AuditInput);
  console.log(`\n■ 点検の札（今の決まりで付け直した物）: ${v.severity}`);
  for (const ch of v.checks) console.log(`  - ${ch.code}（${ch.severity}）${ch.title}: ${ch.detail}`);
  if (!v.checks.length) console.log("  （なし＝入れた値は登録の条件どおり）");

  const tl = auditTimeline(r.steps);
  console.log(`\n■ 段（時刻の順・始まりからの秒・前の段との間）`);
  for (const t of tl) console.log(`  +${(t.sinceBeginMs / 1000).toFixed(2).padStart(7)}s  ${t.gapMs == null ? "      " : `(${String(t.gapMs).padStart(5)}ms)`}  ${t.k}${t.d ? `  ${t.d}` : ""}`);
  const g = humanGaps(tl);
  console.log("\n■ 人の間を置く所の実際の間（ms）");
  for (const [k, xs] of Object.entries(g)) console.log(`  ${k}: ${xs.join(" / ")}`);
  const ops = (r.filled?.ops ?? []) as TimingOp[];
  const s = summarizeOps(ops);
  console.log(`\n■ クリックの列（${s.count}件）: 実際の間 ${s.waitMin}〜${s.waitMax}ms・${s.distinctWaits}通り・予定より遅れた最大 ${s.lateMax}ms・1秒超 ${s.lateOver1s}回`);
  for (const o of ops) console.log(`  t=${String(o.t).padStart(6)}ms  予定${String(o.p).padStart(4)}ms 実際${String(o.w).padStart(5)}ms  ${o.k}`);
  if (r.filled?.stall) console.log(`\n■ 止まった時の様子: ${JSON.stringify(r.filled.stall)}`);
})();
