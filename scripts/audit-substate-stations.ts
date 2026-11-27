// scripts/audit-substate-stations.ts — 細かい状態の一致（状態の置き場の駅と、その番の駅が合うか）を手元の照らしの json で数える（#804・2026-11-27 作業員A）
//   LLM も DB も使わない。json は audit-route-progress-takeuchi.ts --json の出力（sub1・node・branch・sentBefore）。
//   数えるもの: 今（網のまま）／SUBSTATE_CONTEXT（前提で落とす）／＋出てよい駅を複数（SUBSTATE_MULTI_STATION）の一致。--show で外れと新しく当たった番を出す
//   実行: npx tsx scripts/audit-substate-stations.ts <json> [--show]
import { readFileSync } from "node:fs";
import { SUBSTATES } from "../app/lib/apply-route-substate";
import { SUBSTATE_NEEDS } from "../app/lib/substate-context";
import { substateStationsOf } from "../app/lib/apply-route-substate";

type Row = { conv: string; at: string; node: string | null; branch: string | null; act: string | null; sub1: string | null; sentBefore?: Record<string, unknown> };
const path = process.argv.find((a) => a.endsWith(".json"))!;
const show = process.argv.includes("--show");
const rows = (JSON.parse(readFileSync(path, "utf8")) as Row[]).filter((r) => r.sub1);
const atOf = (id: string) => SUBSTATES.find((s) => s.id === id)?.at ?? null;
const ctxOf = (r: Row) => ({ estimateSent: !!r.sentBefore?.estimate_sheet, propertiesSent: !!(r.sentBefore?.property_send || r.sentBefore?.property_recommendation) });
const here = (r: Row, st: readonly string[]) => st.some((s) => s === r.node || s === r.branch);
let base = 0, ctxN = 0, ctxHit = 0, multiHit = 0;
const miss = new Map<string, number>(); const newly: Row[] = [];
for (const r of rows) {
  const at = atOf(r.sub1!); const hitBase = !!at && here(r, [at]);
  if (hitBase) base++;
  const dropped = (SUBSTATE_NEEDS[r.sub1!] ?? []).some((k) => !ctxOf(r)[k]);
  if (dropped) continue;
  ctxN++; if (hitBase) ctxHit++;
  const multi = here(r, substateStationsOf(r.sub1!, { SUBSTATE_MULTI_STATION: "on" }));
  if (multi) multiHit++;
  if (multi && !hitBase) newly.push(r);
  if (!multi) { const k = `${r.sub1}（置き場 ${at}）× 駅 ${r.node}${r.branch ? `/${r.branch}` : ""}`; miss.set(k, (miss.get(k) ?? 0) + 1); }
}
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");
console.log(JSON.stringify({ 状態のある番: rows.length, 今の一致: `${base}/${rows.length}（${pct(base, rows.length)}）`, 前提つき: `${ctxHit}/${ctxN}（${pct(ctxHit, ctxN)}）`, 出てよい駅を複数: `${multiHit}/${ctxN}（${pct(multiHit, ctxN)}）`, 新しく当たった番: newly.length }));
if (show) {
  console.log("残る外れ（状態×駅・多い順）:"); for (const [k, n] of [...miss].sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${k}`);
  console.log("新しく当たった番（竹内さんの一手と並べる）:"); for (const r of newly) console.log(`  ${r.conv} ${r.at.slice(0, 16)} ${r.sub1} @ ${r.node}${r.branch ? `/${r.branch}` : ""} → 一手 ${r.act}`);
}
