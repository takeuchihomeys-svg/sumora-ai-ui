// scripts/audit-guard-yield.ts — 守りの問題（係が自動で足す問題）で見つかった悪化を数える（作業員L・2026-11-24・読むだけ・LLM なし・DB なし）
//   係の済んだ依頼（exam-queue/done/*.json の guards）と、その組の答案（results/<label>(-pN).jsonl と base-merged）を比べ、
//   守りの問題ごとに compareProblem（worse＝悪化）を出す。守りを「使い回せる基準のある問題だけ・1組1問」にした時に見落とす悪化があるかを見る
// 実行: npx tsx scripts/audit-guard-yield.ts [--days=7] [--queue=<exam-queue の置き場>] [--dir=<results>]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { compareProblem, type RowLite } from "./lib/exam-brain";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const Q = arg("queue");
const R = arg("dir", join("scripts", "brain-exam", "results"));
const since = Date.now() - (Number(arg("days", "7")) || 7) * 86_400_000;
const rd = (x: string) => (existsSync(x) ? readFileSync(x, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as RowLite; } catch { return null; } }).filter((r): r is RowLite => !!r && !r.error) : []);
const out = { jobs: 0, guardProblems: 0, judged: 0, worse: [] as string[], better: 0, same: 0, guardReps: 0, targetReps: 0 };
const D = join(Q, "done");
for (const f of readdirSync(D).filter((x) => x.endsWith(".json"))) {
  const p = join(D, f);
  if (statSync(p).mtimeMs < since) continue;
  let j: { label?: string; guards?: string[]; only?: string; runner?: string };
  try { j = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
  if (j.runner && j.runner !== "brain-exam") continue;
  const guards = j.guards ?? [];
  if (!guards.length || !j.label) continue;
  out.jobs++;
  // 組の答案は label か label-pN（分けた時）
  const files = readdirSync(R).filter((x) => (x === `${j.label}.jsonl` || new RegExp(`^${j.label!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-p\\d+\\.jsonl$`).test(x)));
  for (const cf of files) {
    const label = cf.replace(/\.jsonl$/, "");
    const cur = rd(join(R, cf)), base = rd(join(R, `${label}.base-merged.jsonl`));
    for (const id of guards) {
      const c = cur.filter((r) => r.id === id), b = base.filter((r) => r.id === id);
      if (!c.length) continue;
      out.guardProblems++; out.guardReps += c.length;
      if (!b.length) continue;
      out.judged++;
      const cmp = compareProblem(c, b).cmp;
      if (cmp === "worse") out.worse.push(`${label}:${id}`); else if (cmp === "better") out.better++; else out.same++;
    }
    out.targetReps += cur.filter((r) => !guards.includes(r.id)).length;
  }
}
console.log(JSON.stringify({ ...out, guardRepShare: +(out.guardReps / Math.max(1, out.guardReps + out.targetReps)).toFixed(3) }, null, 1));
