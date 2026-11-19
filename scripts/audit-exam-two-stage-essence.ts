// scripts/audit-exam-two-stage-essence.ts — 読むだけ・LLM なし（2026-11-15 作業員H・統括役の頼み）
//   試験の答案（<作業ツリー>/scripts/brain-exam/results/*.jsonl・直近 N 日）から、2段（two_stage_promise）の書き換えが入った番を集め、
//   「ブレインの本質の道（essence）→ 書き換え後の道（path）→ 正解」で数える。
//   本質が正解で書き換えで外れた番＝書き換えが壊した番。書き換えの出所（decision_source の two_stage_promise(種類)）・場面の信号・依頼の route も並べる。
//   使い方: npx tsx scripts/audit-exam-two-stage-essence.ts [--days=14] [--dirs=<results の場所,…>]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "14"));
const ROOT = "C:/Users/竹内 悠馬/sumora-ai-ui/.claude/worktrees";
const DIRS = arg("dirs", `${ROOT}/exam-night/scripts/brain-exam/results,${ROOT}/lp-month/scripts/brain-exam/results`).split(",");
const since = Date.now() - DAYS * 86_400_000;
type R = { id: string; rep: number; label: string; at: string; brain?: { two_stage?: string | null; turn_contract?: { asks?: Array<{ route?: string; aix?: string; basis?: string; about?: string }> } }; path?: { code?: string; ok?: boolean }; essence?: { code?: string; ok?: boolean }; trace?: { decision_source_no_aix?: string | null; decision_source?: string | null; scene_evidence?: { candidate?: string; check_pattern?: string; reason?: string } | null } };
const seen = new Set<string>();
const rows: Array<{ id: string; src: string; essence: string; path: string; eOk: boolean; pOk: boolean; scene: string; asks: string }> = [];
for (const d of DIRS) {
  let files: string[] = [];
  try { files = readdirSync(d).filter((f) => f.endsWith(".jsonl") && !f.includes("base-merged") && !f.startsWith("main-")); } catch { continue; }
  for (const f of files) {
    const p = join(d, f);
    try { if (statSync(p).mtimeMs < since) continue; } catch { continue; }
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let r: R; try { r = JSON.parse(line); } catch { continue; }
      const src = String(r.trace?.decision_source_no_aix ?? r.trace?.decision_source ?? "");
      const m = src.match(/two_stage_promise\(([a-z_]+)\)/);
      if (!m || !r.essence || !r.path) continue;
      const key = `${r.label}|${r.id}|${r.rep}`; if (seen.has(key)) continue; seen.add(key);
      const se = r.trace?.scene_evidence;
      rows.push({ id: r.id, src: m[1], essence: r.essence.code ?? "", path: r.path.code ?? "", eOk: !!r.essence.ok, pOk: !!r.path.ok, scene: se ? `${se.candidate ?? ""}/${se.check_pattern ?? ""}/${se.reason ?? ""}` : "-", asks: (r.brain?.turn_contract?.asks ?? []).map((a) => `${a.route}:${a.aix ?? ""}:${a.basis ?? ""}`).join("|") });
    }
  }
}
const broke = rows.filter((r) => r.eOk && !r.pOk), fixed = rows.filter((r) => !r.eOk && r.pOk), both = rows.filter((r) => !r.eOk && !r.pOk), ok = rows.filter((r) => r.eOk && r.pOk);
console.log(`直近 ${DAYS} 日・2段の書き換えが入った答案 ${rows.length}（本質○→外れ＝書き換えが壊した ${broke.length}・本質×→当たり＝書き換えが直した ${fixed.length}・両方× ${both.length}・両方○ ${ok.length}）`);
const tab = (rs: typeof rows, by: (r: (typeof rows)[number]) => string) => { const m = new Map<string, number>(); for (const r of rs) m.set(by(r), (m.get(by(r)) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
console.log("\n■ 書き換えの種類ごと（壊した／直した／両方×／両方○）");
for (const k of [...new Set(rows.map((r) => r.src))]) console.log(`${k}\t${broke.filter((r) => r.src === k).length}／${fixed.filter((r) => r.src === k).length}／${both.filter((r) => r.src === k).length}／${ok.filter((r) => r.src === k).length}`);
console.log("\n■ 壊した番（問題・書き換え・本質→書き換え後・場面の信号・依頼の route）");
for (const [k, n] of tab(broke, (r) => `${r.id}\t${r.src}\t${r.essence} → ${r.path}\t${r.scene}`)) console.log(`${n}回\t${k}`);
console.log("\n■ 両方×の番（本質も外れ）");
for (const [k, n] of tab(both, (r) => `${r.id}\t${r.src}\t${r.essence} → ${r.path}`).slice(0, 25)) console.log(`${n}回\t${k}`);
