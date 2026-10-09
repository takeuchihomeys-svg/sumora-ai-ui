// scripts/audit-r11-replay-table.ts — 11巡目: YUMA の再生（scripts/yuma-r11-replay.ts の書き出し）を「小場面 × 差の型」で版ごとに採点する（読むだけ・LLM なし）
//   正解＝竹内さんの手打ち（再生の rec.staff・名前は YUMA に伏せた物）。小場面は再生のブレイン（rec.brain）で reply-scene-brain → reply-subscene
// 実行: npx tsx scripts/audit-r11-replay-table.ts <jsonl> [--versions=before,after] [--min=2] [--sub=prod]（prod＝本番の小場面 rec.sub を使う）
import { readFileSync } from "node:fs";
import { resolveReplySceneBrainFirst } from "../app/lib/reply-scene-brain";
import { subSceneOf } from "../app/lib/reply-subscene";
import { printTable, buildTable, type TablePair } from "./lib/r11-table";
import { diffTexts } from "../app/lib/text-diff-types";

const args = process.argv.slice(2);
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const FILE = args.find((a) => !a.startsWith("--"))!;
const VERSIONS = arg("versions", "before,after").split(",");
const MIN = Number(arg("min", "2"));
type Rec = { id: string; customer?: string[]; prevStaff?: string; staff?: string; brain?: { intent?: string | null; q?: string[]; cond?: string | null; scope?: string | null; hes?: string | null; action?: string | null }; [k: string]: unknown };
const recs = readFileSync(FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec).filter((r) => r.staff && r.customer?.length);
const subOf = (r: Rec) => {
  const text = (r.customer ?? []).join("\n");
  const b = r.brain;
  const s = resolveReplySceneBrainFirst({ customerText: text, brain: b ? { fresh: true, intent: b.intent ?? null, questions: b.q ?? [], conditionChangeType: b.cond ?? null, conditionChangeScope: b.scope ?? null, hesitancy: b.hes ?? null, action: b.action ?? null } : null });
  return subSceneOf({ customerText: text, prevStaffText: r.prevStaff ?? "", scene: s.scene });
};
const byV: Record<string, TablePair[]> = {};
for (const v of VERSIONS) byV[v] = [];
for (const r of recs) {
  const sub = subOf(r);
  // 両方の版がそろった番だけ（前後を同じ番で比べる）
  if (!VERSIONS.every((v) => typeof r[`draft_${v}`] === "string" && (r[`draft_${v}`] as string).trim())) continue;
  for (const v of VERSIONS) byV[v].push({ sub, draft: r[`draft_${v}`] as string, staff: r.staff!, id: r.id });
}
for (const v of VERSIONS) printTable(`版 ${v}（${FILE}）`, byV[v], MIN);
// 前後の差（小場面ごとの近い・似ている度）
if (VERSIONS.length === 2) {
  const [a, b] = VERSIONS.map((v) => buildTable(byV[v]));
  console.log(`\n■ 前後（${VERSIONS.join("→")}）: 全体 近い ${a.all.near}→${b.all.near}/${a.all.n}・完全 ${a.all.same}→${b.all.same}・似 ${a.all.sim.toFixed(3)}→${b.all.sim.toFixed(3)}`);
  for (const ra of a.rows) { const rb = b.rows.find((x) => x.sub === ra.sub)!; if (ra.n >= MIN && (ra.near !== rb.near || Math.abs(ra.sim - rb.sim) >= 0.05)) console.log(`  ${ra.sub} n=${ra.n} 近い ${ra.near}→${rb.near}・似 ${ra.sim.toFixed(2)}→${rb.sim.toFixed(2)}`); }
  // 番ごとに大きく変わった物（目で読む）
  const big = byV[VERSIONS[0]].map((p, i) => ({ p, q: byV[VERSIONS[1]][i] })).map(({ p, q }) => ({ id: p.id, sub: p.sub, d: diffTexts(q.draft, q.staff).sim - diffTexts(p.draft, p.staff).sim, before: p.draft, after: q.draft, staff: p.staff }))
    .filter((x) => Math.abs(x.d) >= 0.2).sort((x, y) => x.d - y.d);
  console.log(`\n■ 番ごとに似ている度が 0.2 以上変わった ${big.length}番（悪くなった順）`);
  for (const x of big) console.log(`  ${x.d > 0 ? "+" : ""}${x.d.toFixed(2)} ${x.id} [${x.sub}]\n    前:${x.before.replace(/\n/g, "⏎").slice(0, 110)}\n    後:${x.after.replace(/\n/g, "⏎").slice(0, 110)}\n    竹:${x.staff.replace(/\n/g, "⏎").slice(0, 110)}`);
}
