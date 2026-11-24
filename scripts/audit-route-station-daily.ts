// scripts/audit-route-station-daily.ts — 申込までの地図の駅ごとの毎朝の物差し・一番弱い駅の上位3つ・弱い駅の細分化（台帳 #687・読むだけ・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-route-station-daily.ts --from=<audit-route-progress-takeuchi の --json> [--days=60] [--write]
// 2026-11-25 作業員A（竹内さん 11/25 深夜「今どこかちゃんと把握して申込に向かって進んでいるのか・地図を細分化して強化」・統括役の頼み）
//   重い読み（竹内さん本人の番の60日の照らし）は夜に audit-route-progress-takeuchi --json で作り、ここはその json と今どこの読み違い（軽い読み）を合わせる。
//   計算は app/lib/route-station-daily.ts（駅ごとの here・progress・next・弱さ・細分化）。--write で quality_daily（route:station:<駅>:<物差し>・route:weak_station:<順位>）
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { stationMetricsOf, weakStations, weakStationCells, stationQualityRows, stationKey, type StationRow } from "../app/lib/route-station-daily";
import { ROUTE_NODES, ROUTE_BRANCHES } from "../app/lib/apply-route-map";
import { runMisreadMove } from "./audit-route-misread-move";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
const from = arg("from");
if (!from || !existsSync(from)) { console.error("--from=<audit-route-progress-takeuchi の json> が要る"); process.exit(1); }
const days = Number(arg("days") || 60);
const ja = (st: string) => (st.startsWith("分:") ? `分:${(ROUTE_BRANCHES as Record<string, { name: string }>)[st.slice(2)]?.name ?? st.slice(2)}` : (ROUTE_NODES as Record<string, { name: string }>)[st]?.name ?? st);
(async () => {
  const rows = JSON.parse(readFileSync(from, "utf8")) as StationRow[];
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const here = new Map<string, { n: number; miss: number }>();
  await runMisreadMove({ sb: sb as never, days, quiet: true, onOut: (xs) => { for (const x of xs) { if (x.kind === "unknown" || x.kind === "timed") continue; const k = stationKey(x.node, x.branch); const h = here.get(k) ?? { n: 0, miss: 0 }; h.n++; if (x.kind !== "match") h.miss++; here.set(k, h); } } });
  const ms = stationMetricsOf(rows, here);
  console.log(`■ 駅ごとの物差し（竹内さん本人の番 ${rows.length}・${days}日の今どこの照らし ${[...here.values()].reduce((s, h) => s + h.n, 0)}番）`);
  for (const m of ms) console.log(`  ${ja(m.station)}: 番 ${m.n}・次の一手が竹内さんと合う ${m.next ?? "—"}%・申込へ進めた ${m.progress ?? "—"}%・今どこの当たり ${m.here ?? "—"}%（${m.hereN}番）・弱さ ${m.weak}`);
  const weak = weakStations(ms);
  console.log(`\n■ 一番弱い駅（上位3つ）: ${weak.map((m, i) => `${i + 1}. ${ja(m.station)}（弱さ ${m.weak}・番 ${m.n}）`).join("　")}`);
  for (const c of weakStationCells(rows, weak.map((m) => m.station))) console.log(`  ${ja(c.station)}: ${c.wait ? "数を待つ（n≥10 で竹内さん本人の過半数の形がある升が無い）" : `直しの候補 ${c.candidates.join("・")}`}`);
  if (process.argv.includes("--write")) {
    const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const q = stationQualityRows(ms, day, "scripts/audit-route-station-daily.ts（作業員A・#687）");
    const { error } = await sb.from("quality_daily").upsert(q, { onConflict: "day,metric,scope" });
    if (error) throw error;
    console.log(`\nquality_daily に書いた: ${q.length}行（${day}）`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
