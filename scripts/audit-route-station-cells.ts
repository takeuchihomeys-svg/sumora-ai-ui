// scripts/audit-route-station-cells.ts — 弱い駅を「駅 × 番の型 × 駅の中の状態」の升に分け、竹内さん本人の一手の多い方がある升だけを直しの候補に出す（読むだけ・LLM なし・DB なし・台帳 #650）
// 実行: npx tsx scripts/audit-route-station-cells.ts --json=<audit-route-progress-takeuchi の json> [--stations=estimate,viewing_scheduled,分:screening_concern,分:move_in_later] [--min=10]
// 2026-11-24 作業員A（統括役の頼み）。分け方は app/lib/route-station-cells.ts
import { readFileSync } from "node:fs";
import { stationCellsOf, stationCellSummary, CELL_MIN_N } from "../app/lib/route-station-cells";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const file = arg("json");
if (!file) { console.error("--json=<audit-route-progress-takeuchi の json> が要る"); process.exit(1); }
const rows = JSON.parse(readFileSync(file, "utf8"));
const stations = arg("stations", "estimate,viewing_scheduled,分:screening_concern,分:move_in_later").split(",");
const minN = Number(arg("min", String(CELL_MIN_N)));
for (const split of ["rt", "rt_sub", "rt_sent"] as const) {
  const cells = stationCellsOf(rows, stations, split, minN);
  console.log(`\n■ 升の分け: ${split === "rt" ? "駅 × 番の型" : split === "rt_sub" ? "駅 × 番の型 × 駅の中の状態" : "駅 × 番の型 × 送った物の段（sentBefore のある json だけ）"}（n の下限 ${minN}）`);
  for (const s of stationCellSummary(cells)) console.log(`  ${s.station}: 番 ${s.n}・升 ${s.cells}（直しの候補 ${s.candidate}・地図で合っている ${s.ok}・割れ ${s.split}・n 不足 ${s.nShort}）`);
  for (const c of cells.filter((x) => x.n >= Math.min(4, minN))) console.log(`    ${c.station}｜${c.rt}${split !== "rt" ? `｜${c.sub}` : ""}: n ${c.n}・地図と合う ${c.match}・竹内さんの多い方 ${c.top?.act ?? "-"} ${c.top?.rate ?? "-"}%・${c.verdict}${c.proposal ? `→案: 次の一手を ${c.proposal.act}` : ""}`);
}
