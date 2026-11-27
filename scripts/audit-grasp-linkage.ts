// scripts/audit-grasp-linkage.ts — 「現状の把握」「進め方」の葉 × 出す側 の 持つ・使う・反映 と穴の順（手元の json だけ・DB なし・LLM なし・費用0）
// 2026-11-27 作業員L（竹内さん 11/27・統括役の割り振り）: 試験の問題（problems.json・竹内さん本人の番から作った写し）の ledger・pc と、
//   その問題の一番新しい main の答え（results/main-*.jsonl の brain.material_marks・判断の欄）を合わせて app/lib/grasp-linkage.graspCounts に当てる。
// 実行: npx tsx scripts/audit-grasp-linkage.ts [--cwd=<作業ツリー>] [--json=<出力>]
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { graspCounts, graspGapRank, GRASP_LEAF_JA, GRASP_GROUP, GRASP_SOURCES, type GraspLeaf, type GraspRow } from "../app/lib/grasp-linkage";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const cwd = arg("cwd", process.cwd());
const raw = JSON.parse(readFileSync(join(cwd, "scripts", "brain-exam", "problems.json"), "utf8"));
const probs = (Array.isArray(raw) ? raw : raw.problems ?? Object.values(raw)) as Array<{ id: string; ledger?: Record<string, unknown>; pc?: Record<string, unknown> }>;
const R = join(cwd, "scripts", "brain-exam", "results");
const latest = new Map<string, { t: number; marks: Record<string, unknown> | null; brain: Record<string, unknown> | null }>();
for (const f of readdirSync(R).filter((x) => /^main-.*\.jsonl$/.test(x))) {
  const t = statSync(join(R, f)).mtimeMs;
  for (const l of readFileSync(join(R, f), "utf8").split("\n")) {
    if (!l) continue;
    try { const r = JSON.parse(l) as { id?: string; error?: string; brain?: Record<string, unknown> | null }; if (!r.id || r.error || !r.brain) continue; const cur = latest.get(r.id); if (!cur || cur.t < t) latest.set(r.id, { t, marks: (r.brain.material_marks as Record<string, unknown>) ?? null, brain: r.brain }); } catch { /* 飛ばす */ }
  }
}
// 材料の印が残る答えだけ（印を出す前の版の答えでは「使う」が数えられない）
const rows: GraspRow[] = probs.filter((p) => latest.has(p.id) && latest.get(p.id)!.marks).map((p) => ({ id: p.id, ledger: p.ledger ?? null, pc: p.pc ?? null, marks: latest.get(p.id)!.marks, brain: latest.get(p.id)!.brain }));
const withMarks = rows.length;
const cs = graspCounts(rows);
const leaves = Object.keys(GRASP_LEAF_JA) as GraspLeaf[];
console.log(`# 葉 × 出す側（試験の問題 ${probs.length} のうち main の答えで材料の印が残る ${rows.length}）\n`);
console.log(`| 出す側 | 持つ | 使う（印） | ${leaves.map((l) => `${GRASP_LEAF_JA[l]}`).join(" | ")} |`);
console.log(`|---|---|---|${leaves.map(() => "---").join("|")}|`);
for (const c of cs) console.log(`| ${c.name} | ${c.has} | ${c.use == null ? "印なし" : c.use} | ${leaves.map((l) => (c.leaves.includes(l) ? `○${c.reflect[l] ?? 0}` : "")).join(" | ")} |`);
console.log("\n（升の ○N＝その出す側で読める葉・N＝持つ番のうち判断の欄にその葉が出た番）");
console.log(`葉の組: ${leaves.map((l) => `${GRASP_LEAF_JA[l]}＝${GRASP_GROUP[l]}`).join("・")}`);
const gaps = graspGapRank(cs);
console.log(`\n## 穴（記録はあるのに材料に入らない・印なし）上位5`);
for (const g of gaps.slice(0, 5)) console.log(`- ${g.name}: ${g.size}番（${g.kind}・葉 ${g.leaves.map((l) => GRASP_LEAF_JA[l]).join("・")}）`);
const out = arg("json", "");
if (out) writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), rows: rows.length, withMarks, counts: cs, gaps, sources: GRASP_SOURCES.map((s) => s.id) }, null, 1));
