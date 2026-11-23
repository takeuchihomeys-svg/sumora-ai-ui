// scripts/audit-exam-waste.ts — 試験の費用のうち、on のスイッチが1つも効いていない回に払った分（読むだけ・LLM なし・作業員N2・2026-11-23・台帳 #462）
//   回ごとに作業員A の switchReachOf（scripts/lib/exam-switch-reach.ts・印と写しの材料）で on のスイッチの届きを出し、全部が「効いていない（印0・材料0）」の回の費用を足す。
//   費用は exam_runs.cost_usd（label で引く・軽い読み）。「確かめられない」（印が入る前・指示文が全問・対応表に無い）は無駄に数えない。
// 実行: npx tsx --env-file=.env.local scripts/audit-exam-waste.ts --since=2026-11-22T12:00Z [--until=...] [--dir=scripts/brain-exam/results] [--json]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { switchReachOf, onSwitchesOfMeta, REACH_JA, type ReachRow } from "./lib/exam-switch-reach";
import { wastedCostOf } from "./lib/exam-preflight-reach";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
(async () => {
  const dir = arg("dir", "scripts/brain-exam/results");
  const since = Date.parse(arg("since", new Date(Date.now() - 86_400_000).toISOString())), until = Date.parse(arg("until", new Date().toISOString()));
  const metas = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith(".meta.json")).map((f) => ({ label: f.replace(/\.meta\.json$/, ""), meta: JSON.parse(readFileSync(join(dir, f), "utf8")) as { startedAt?: string; head?: string; envFp?: { pairs?: Record<string, string> } } }))
    .filter((x) => { const t = Date.parse(x.meta.startedAt ?? ""); return t >= since && t < until && existsSync(join(dir, `${x.label}.jsonl`)); });
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const { data } = await sb.from("exam_runs").select("label,cost_usd").in("label", metas.map((m) => m.label)).limit(2000);
  const costOf = new Map(((data ?? []) as Array<{ label: string; cost_usd: number | null }>).map((r) => [r.label, Number(r.cost_usd ?? 0)]));
  const has = (head?: string) => (c: string) => { if (!head) return false; try { execSync(`git merge-base --is-ancestor ${c} ${head}`, { stdio: "ignore" }); return true; } catch { return false; } };
  const runs = metas.map((m) => {
    const on = onSwitchesOfMeta(m.meta);
    const rows: ReachRow[] = readFileSync(join(dir, `${m.label}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l) as { id: string; brain?: { material_marks?: Record<string, number> | null } | null; ledger?: { inserted?: Record<string, number> } | null }; return { id: r.id, marks: r.brain?.material_marks ?? null, ledger: r.ledger?.inserted ?? null }; });
    return { label: m.label, cost: costOf.get(m.label) ?? null, on, reach: on.length ? switchReachOf(on, rows, has(m.meta.head)) : [] };
  }).filter((r) => r.on.length);
  const w = wastedCostOf(runs);
  if (process.argv.includes("--json")) { console.log(JSON.stringify({ ...w, runs: runs.map((r) => ({ label: r.label, cost: r.cost, reach: r.reach.map((x) => ({ sw: x.sw, status: x.status })) })) })); return; }
  console.log(`# 試験の費用の無駄（スイッチ付きの回 ${runs.length}・費用 $${w.total}）: 全部効いていない ${w.runs.length}回 $${w.wasted}・一部効いていない ${w.partialRuns.length}回 $${w.partial}・全部確かめられない ${w.unverifiedRuns.length}回 $${w.unverified}`);
  for (const r of runs) console.log(`- ${r.label}（$${r.cost ?? "—"}）: ${r.reach.map((x) => `${x.sw} ${REACH_JA[x.status as keyof typeof REACH_JA]}`).join("／")}${w.runs.includes(r.label) ? "｜⚠ 全部効いていない" : ""}`);
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
