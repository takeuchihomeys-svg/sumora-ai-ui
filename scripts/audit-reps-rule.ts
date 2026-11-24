// scripts/audit-reps-rule.ts — 回数の段取り（EXAM_REPS_ONE_IF_SAME）を、前の晩までの答案になぞって確かめる（作業員L・2026-11-24・読むだけ・LLM なし・DB なし）
//   各組（results/<label>.jsonl と <label>.base-merged.jsonl）で、問題ごとに「今の回をこの決め方で減らしたら」の回数と、
//   今の全部の回で悪化（compareProblem＝worse）だった問題が、減らした回でも悪化と出るか（見落としが無いか）を数える。
//   比べに「1回目が同じなら止める」だけの形（前の割れを見ない＝取らない形）も並べる
// 実行: npx tsx scripts/audit-reps-rule.ts [--days=7] [--dir=scripts/brain-exam/results]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { compareProblem, type RowLite } from "./lib/exam-brain";
import { firstSameAsUnanimousBase, passPathOf } from "./lib/exam-flake";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const R = arg("dir", join("scripts", "brain-exam", "results"));
const since = Date.now() - (Number(arg("days", "7")) || 7) * 86_400_000;
const rd = (x: string) => readFileSync(x, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as RowLite; } catch { return null; } }).filter((r): r is RowLite => !!r && !r.error);
const out = { labels: 0, problems: 0, worse: 0, reps: 0, ruleReps: 0, ruleMissed: [] as string[], naiveReps: 0, naiveMissed: [] as string[] };
for (const f of readdirSync(R).filter((x) => x.endsWith(".base-merged.jsonl"))) {
  const bf = join(R, f);
  if (statSync(bf).mtimeMs < since) continue;
  const label = f.replace(".base-merged.jsonl", "");
  const cf = join(R, `${label}.jsonl`);
  if (!existsSync(cf)) continue;
  const base = rd(bf), cur = rd(cf);
  out.labels++;
  for (const id of [...new Set(cur.map((r) => r.id))]) {
    const c = cur.filter((r) => r.id === id).sort((a, b) => a.rep - b.rep), b = base.filter((r) => r.id === id);
    if (!b.length) continue;
    out.problems++; out.reps += c.length;
    const full = compareProblem(c, b).cmp;
    if (full === "worse") out.worse++;
    const pp = c.map((r) => passPathOf(r as never));
    const keep = firstSameAsUnanimousBase(pp, b as never) ? c.slice(0, 1) : c;
    const bp = b.map((r) => passPathOf(r as never)), maj = (k: "pass" | "path") => bp.filter((x) => x[k]).length * 2 > bp.length;
    const naive = pp[0] && pp[0].pass === maj("pass") && pp[0].path === maj("path") ? c.slice(0, 1) : c;
    out.ruleReps += keep.length; out.naiveReps += naive.length;
    if (full === "worse" && compareProblem(keep, b).cmp !== "worse") out.ruleMissed.push(`${label}:${id}`);
    if (full === "worse" && compareProblem(naive, b).cmp !== "worse") out.naiveMissed.push(`${label}:${id}`);
  }
}
const pct = (a: number) => +((100 * (1 - a / Math.max(1, out.reps)))).toFixed(1);
console.log(JSON.stringify({ ...out, ruleCutPct: pct(out.ruleReps), naiveCutPct: pct(out.naiveReps) }, null, 1));
