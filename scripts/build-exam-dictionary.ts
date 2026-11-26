// scripts/build-exam-dictionary.ts — 台帳 #803「試験の辞書」を作る（ファイルと手元の結果だけ・DB なし・LLM なし・費用0）
// 2026-11-27 作業員L（竹内さん 11/27・統括役の割り振り）: problems.json（問題の定義・写し）・SWITCH_REACH（要る材料）・learned-reach.json（前の on の回の覚え）・
//   brain-exam-flake（揺れ）・results の ledger.inserted（前の回の材料）を1つの表 <exam-cache>/exam-dictionary.json に。計算は scripts/lib/exam-dictionary.ts
//   --eval で、前の7晩の係の結果（exam-queue/results/*.json の試験の組）に辞書を当てて、外れた問題の数・浮いた費用・比べられる問題の数・見落とし（外した問題に確かな悪化）を出す。
// 実行: npx tsx scripts/build-exam-dictionary.ts [--cwd=<作業ツリー>] [--eval] [--days=7] [--dry]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import { SWITCH_REACH } from "./lib/exam-switch-reach";
import { loadLearnedReach } from "./lib/exam-learned-reach";
import { readObs } from "./lib/exam-flake";
import { readPriorLedger } from "./lib/exam-preflight-reach";
import { buildDictionary, dictEval, type DictProblemIn, type ExamDictionary } from "./lib/exam-dictionary";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
export const EXAM_DICTIONARY_FILE = () => join(examCacheRoot(), "exam-dictionary.json");
export function loadExamDictionary(file = EXAM_DICTIONARY_FILE()): ExamDictionary | null {
  try { const j = JSON.parse(readFileSync(file, "utf8")) as ExamDictionary; return j?.v === 1 && j.problems && j.switches ? j : null; } catch { return null; }
}
/** 係の結果のファイル（exam-queue/results/*.json）から前の days 日の試験の組 */
export function nightJobsOf(dir: string, days: number, nowMs = Date.now()) {
  const out: Array<{ label: string; switches: string[]; ids: string[]; guards: string[]; usd: number; signal: string[] }> = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f.endsWith(".reps.json")) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as { label?: string; switch?: string; only?: string; guards?: string[]; usd?: string | number; at?: string; worseSure?: Array<{ id: string }> | null; runner?: string };
      if (!j.only || !j.switch || j.runner === "cmd" || j.runner === "tsc" || j.runner === "tsc-remote") continue;
      if (!j.at || nowMs - Date.parse(j.at) > days * 864e5) continue;
      const usd = typeof j.usd === "number" ? j.usd : Number(String(j.usd ?? "").replace(/[^0-9.]/g, "")) || 0;
      out.push({ label: String(j.label ?? f), switches: [...new Set(String(j.switch).match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [])], ids: String(j.only).split(",").filter(Boolean), guards: j.guards ?? [], usd, signal: (j.worseSure ?? []).map((x) => x.id) });
    } catch { /* 壊れたファイルは飛ばす */ }
  }
  return out;
}

if (require.main === module) {
  const cwd = arg("cwd", process.cwd());
  const raw = JSON.parse(readFileSync(join(cwd, "scripts", "brain-exam", "problems.json"), "utf8"));
  const probs = (Array.isArray(raw) ? raw : raw.problems ?? Object.values(raw)) as DictProblemIn[];
  const prior = readPriorLedger(join(cwd, "scripts", "brain-exam", "results"), new Set(probs.map((p) => p.id)));
  const learned = loadLearnedReach(join(examCacheRoot(), "learned-reach.json"));
  const d = buildDictionary({
    problems: probs, reach: SWITCH_REACH as Record<string, { needs?: string[] }>, learned: (learned?.switches ?? null) as never,
    obsOf: (id) => { try { return readObs(id).map((o) => ({ sig: o.sig, at: o.at, independent: o.independent, model: o.model, codeKey: o.codeKey })); } catch { return []; } },
    priorOf: (id) => prior.get(id) ?? null,
  });
  const P = Object.values(d.problems), S = Object.values(d.switches);
  console.log(`試験の辞書: 問題 ${P.length}（揺れの大きい ${P.filter((p) => p.flake.flaky).length}・観測なし ${P.filter((p) => !p.flake.n).length}）・スイッチ ${S.length}（試験できない＝先に写し ${S.filter((s) => !s.testable).length}・要る材料の行なし ${S.filter((s) => !s.needs.length).length}）`);
  for (const s of S.filter((x) => !x.testable)) console.log(`  ⚠ ${s.sw}: ${s.why}`);
  if (process.argv.includes("--eval")) {
    const jobs = nightJobsOf(join(examCacheRoot(), "exam-queue", "results"), Number(arg("days", "7")) || 7);
    const e = dictEval(d, jobs);
    console.log(`物差し（前の${arg("days", "7")}晩の試験の組 ${e.jobs}）: 辞書で外れた問題 ${e.dropped}・浮いた費用 $${e.savedUsd.toFixed(2)}・比べられる問題（守りでない・揺れの小さい）${e.comparableBefore}→${e.comparableAfter}・外した問題の確かな悪化（見落とし）${e.missedSignals}${e.untestableJobs.length ? `・試験できないスイッチの組 ${e.untestableJobs.length}（${e.untestableJobs.slice(0, 5).join(",")}）` : ""}`);
  }
  if (!process.argv.includes("--dry")) { writeFileSync(EXAM_DICTIONARY_FILE(), JSON.stringify(d)); console.log(`書いた: ${EXAM_DICTIONARY_FILE()}`); }
}
