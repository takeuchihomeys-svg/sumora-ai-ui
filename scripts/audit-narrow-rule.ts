// scripts/audit-narrow-rule.ts — 積む時の問題の絞り（exam-narrow）を前の晩までの組になぞる（作業員L・2026-11-24・読むだけ・LLM なし・DB なし）
//   組ごとに、on のスイッチ（meta.switches の on）・その回の写しの材料（答案の ledger.inserted＝積む前の「前の回の写し」の代わり）・前の基準の答え（base-merged）から
//   残す問題と外す問題を決め、外した問題の費用（組の費用を問題の回の数で割った分）と、外した問題の中の悪化（compareProblem＝worse）を数える
// 実行: npx tsx scripts/audit-narrow-rule.ts [--days=7] [--dir=scripts/brain-exam/results]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { compareProblem, type RowLite } from "./lib/exam-brain";
import { narrowProblems, baseMajorityOf } from "./lib/exam-narrow";
import type { PriorLedger } from "./lib/exam-preflight-reach";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const R = arg("dir", join("scripts", "brain-exam", "results"));
const since = Date.now() - (Number(arg("days", "7")) || 7) * 86_400_000;
type Row = RowLite & { ledger?: { inserted?: Record<string, number> } | null };
const rd = (x: string) => (existsSync(x) ? readFileSync(x, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as Row; } catch { return null; } }).filter((r): r is Row => !!r && !r.error) : []);
const out = { groups: 0, applied: 0, notApplied: {} as Record<string, number>, problems: 0, dropped: 0, usd: 0, droppedUsd: 0, worse: 0, missed: [] as string[] };
for (const f of readdirSync(R).filter((x) => x.endsWith(".base-merged.jsonl"))) {
  const bf = join(R, f);
  if (statSync(bf).mtimeMs < since) continue;
  const label = f.replace(".base-merged.jsonl", "");
  const cur = rd(join(R, `${label}.jsonl`)), base = rd(bf);
  if (!cur.length) continue;
  let meta: { switches?: Record<string, string> } = {}, cost: { total?: { realUsd?: number }; baseline?: { childUsd?: number } } = {};
  try { meta = JSON.parse(readFileSync(join(R, `${label}.meta.json`), "utf8")); } catch { /* */ }
  try { cost = JSON.parse(readFileSync(join(R, `${label}.cost.json`), "utf8")); } catch { /* */ }
  out.groups++;
  const on = Object.entries(meta.switches ?? {}).filter(([, v]) => String(v).toLowerCase() === "on").map(([k]) => k);
  const prior: PriorLedger = new Map();
  for (const r of cur) { const m = prior.get(r.id) ?? {}; for (const [k, v] of Object.entries(r.ledger?.inserted ?? {})) m[k] = Math.max(m[k] ?? 0, Number(v) || 0); prior.set(r.id, m); }
  const ids = [...new Set(cur.map((r) => r.id))];
  const res = narrowProblems({ ids, onSwitches: on, prior, base: baseMajorityOf(base) });
  const usd = (cost.total?.realUsd ?? 0) + (cost.baseline?.childUsd ?? 0);
  out.usd += usd; out.problems += ids.length;
  if (!res.applied) { out.notApplied[res.reason.replace(/（.*$/, "")] = (out.notApplied[res.reason.replace(/（.*$/, "")] ?? 0) + 1; }
  else out.applied++;
  const repsOf = (id: string) => cur.filter((r) => r.id === id).length;
  const allReps = ids.reduce((a, id) => a + repsOf(id), 0) || 1;
  out.dropped += res.drop.length;
  out.droppedUsd += (usd * res.drop.reduce((a, id) => a + repsOf(id), 0)) / allReps;
  for (const id of ids) {
    const b = base.filter((r) => r.id === id);
    if (!b.length) continue;
    if (compareProblem(cur.filter((r) => r.id === id), b).cmp === "worse") { out.worse++; if (res.drop.includes(id)) out.missed.push(`${label}:${id}`); }
  }
}
console.log(JSON.stringify({ ...out, usd: +out.usd.toFixed(2), droppedUsd: +out.droppedUsd.toFixed(2) }, null, 1));
