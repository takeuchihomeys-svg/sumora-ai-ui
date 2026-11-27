// scripts/audit-linkage-gap-recount.ts — 連携の切れ目の一覧の升を本番の記録から毎晩数え直す（読むだけ・LLM なし・DB は --write の時だけ quality_daily に書く）
// 2026-11-26 作業員A（竹内さん 11/26「ここの部分ちゃんと仕組化していくように」）: 判断の記録の digest.mtk（材料の印のキー）で、升のつなぎが本番で実際に入った番の数を数える。
//   一覧（linkage-gap-matrix）で off・つないでいない の升なのに印が出た＝一覧が古い（直す）／on の升なのに印が0＝届いていない、を見張る
// 実行: npx tsx --env-file=.env.local scripts/audit-linkage-gap-recount.ts [--days=1] [--write]
import { createClient } from "@supabase/supabase-js";
import { LINKAGE_GAP_SOURCES } from "../app/lib/linkage-gap-matrix";

/** 升 → 材料の印のキー（判断の材料に入った時に material_marks に付く物） */
const CELL_MARK: Record<string, string> = { "pickup_select:brain": "pickup_why", "aix_state_card:brain": "aix_state_card", "brain_combo:combo": "chain_insight", "deal_data:brain": "deal_flow_pre_apply", "property_check:brain": "now_fulfillable", "image_read:brain": "pickup_why_sip", "f_mindset:combo": "mindset_station", "estimate_tool:intake": "intake_estimate" /* 2026-11-26 作業員L の #795（ROUTE_MINDSET_LINE・地図が気持ちを読む1行） */ };
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const since = new Date(Date.now() - Number(arg("days", "1")) * 864e5).toISOString();
  const { data, error } = await sb.from("brain_decision_logs").select("mtk:digest->>mtk").gte("created_at", since).limit(5000);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ mtk: string | null }>;
  const marked = rows.filter((r) => r.mtk).length;
  const out: Array<{ cell: string; state: string; seen: number }> = [];
  for (const [cell, mark] of Object.entries(CELL_MARK)) {
    const [src, sink] = cell.split(":");
    const st = (LINKAGE_GAP_SOURCES.find((s) => s.id === src)?.cells as Record<string, { state: string } | undefined> | undefined)?.[sink]?.state ?? "?";
    const seen = rows.filter((r) => String(r.mtk ?? "").split(",").includes(mark)).length;
    out.push({ cell, state: st, seen });
  }
  console.log(`■ 連携の升の数え直し（判断の記録 ${rows.length}・材料の印のある番 ${marked}）`);
  for (const o of out) console.log(`  ${o.cell}: 一覧 ${o.state}・本番で入った番 ${o.seen}${o.state !== "on" && o.seen > 0 ? "（一覧が古い＝on に直す）" : o.state === "on" && marked > 0 && o.seen === 0 ? "（on なのに届いていない）" : ""}`);
  if (process.argv.includes("--write")) {
    const day = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const qd = out.map((o) => ({ day, metric: `link:cell:${o.cell}`, scope: "all", value: o.seen, n: marked, detail: { listed: o.state }, source: "scripts/audit-linkage-gap-recount.ts（作業員A）" }));
    const { error: e2 } = await sb.from("quality_daily").upsert(qd, { onConflict: "day,metric,scope" });
    if (e2) throw new Error(e2.message);
    console.log(`書いた: quality_daily ${qd.length}行（${day}）`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
