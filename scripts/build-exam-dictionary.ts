// scripts/build-exam-dictionary.ts — 台帳 #803「試験の辞書」を作る（ファイルと手元の結果だけ・DB なし・LLM なし・費用0）
// 2026-11-27 作業員L（竹内さん 11/27・統括役の割り振り）: problems.json（問題の定義・写し）・SWITCH_REACH（要る材料）・learned-reach.json（前の on の回の覚え）・
//   brain-exam-flake（揺れ）・results の ledger.inserted（前の回の材料）を1つの表 <exam-cache>/exam-dictionary.json に。計算は scripts/lib/exam-dictionary.ts
//   --eval で、前の7晩の係の結果（exam-queue/results/*.json の試験の組）に辞書を当てて、外れた問題の数・浮いた費用・比べられる問題の数・見落とし（外した問題に確かな悪化）を出す。
// 実行: npx tsx scripts/build-exam-dictionary.ts [--cwd=<作業ツリー>] [--eval] [--days=7] [--dry]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import { SWITCH_REACH, onSwitchesOfMeta } from "./lib/exam-switch-reach";
import { SNAPSHOT_NEED, SWITCH_TARGET_MARK, snapshotHas } from "./lib/exam-snapshot-need";
import { loadLearnedReach } from "./lib/exam-learned-reach";
import { readObs } from "./lib/exam-flake";
import { readPriorLedger } from "./lib/exam-preflight-reach";
import { buildDictionary, dictEval, dictReachGate, inferSwitchMarks, type DictProblemIn, type ExamDictionary, type InferRun } from "./lib/exam-dictionary";

/** 2026-11-27 作業員L: 結果（results/*.jsonl）の行の材料の印（brain.material_marks の >0 の鍵）と、組ごとの on のスイッチ（meta の envFp）。main-* は off（前）の行 */
export function readRunsWithMarks(dir: string): { runs: Array<InferRun & { label: string; rowsFull: Array<{ id: string; marks: Record<string, unknown> }> }>; offMarks: Map<string, Set<string>> } {
  const runs: Array<InferRun & { label: string; rowsFull: Array<{ id: string; marks: Record<string, unknown> }> }> = [];
  const offMarks = new Map<string, Set<string>>();
  if (!existsSync(dir)) return { runs, offMarks };
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl") || f.includes(".base-merged")) continue;
    const label = f.replace(/\.jsonl$/, "");
    let txt = ""; try { txt = readFileSync(join(dir, f), "utf8"); } catch { continue; }
    const rowsFull: Array<{ id: string; marks: Record<string, unknown> }> = [];
    for (const l of txt.split("\n")) {
      if (!l.includes('"material_marks"')) continue;
      try { const r = JSON.parse(l) as { id?: string; error?: string; brain?: { material_marks?: Record<string, unknown> | null } | null }; if (r.id && !r.error && r.brain?.material_marks) rowsFull.push({ id: r.id, marks: r.brain.material_marks }); } catch { /* 飛ばす */ }
    }
    if (!rowsFull.length) continue;
    const keysOf = (m: Record<string, unknown>) => Object.entries(m).filter(([, v]) => Number(v) > 0).map(([k]) => k);
    if (label.startsWith("main-")) { for (const r of rowsFull) { const set = offMarks.get(r.id) ?? new Set<string>(); for (const k of keysOf(r.marks)) set.add(k); offMarks.set(r.id, set); } continue; }
    const meta = (() => { try { return JSON.parse(readFileSync(join(dir, `${label}.meta.json`), "utf8")); } catch { return null; } })();
    runs.push({ label, switches: onSwitchesOfMeta(meta), rows: rowsFull.map((r) => ({ id: r.id, marks: keysOf(r.marks) })), rowsFull });
  }
  return { runs, offMarks };
}

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
  const rr = readRunsWithMarks(join(cwd, "scripts", "brain-exam", "results"));
  // 2026-11-27: meta の on には本番のスイッチの組（下敷き・60個前後）が全部入る＝組ごとの「試したスイッチ」は係の依頼の switch の欄（無ければ 8割以上の組で on の物を引く）
  { const jobSw = new Map(nightJobsOf(join(examCacheRoot(), "exam-queue", "results"), 3650).map((j) => [j.label.replace(/-r$/, ""), j.switches]));
    const freq = new Map<string, number>(); for (const r of rr.runs) for (const sw of r.switches) freq.set(sw, (freq.get(sw) ?? 0) + 1);
    const common = new Set([...freq].filter(([, n]) => n >= rr.runs.length * 0.8).map(([k]) => k));
    for (const r of rr.runs) { const js = jobSw.get(r.label) ?? jobSw.get(r.label.replace(/-p\d+$/, "")); (r as { switches: readonly string[] }).switches = js && js.length ? js : r.switches.filter((x) => !common.has(x)); } }
  const EMPTY = new Set<string>();
  const inferred = inferSwitchMarks(rr.runs, (id) => rr.offMarks.get(id) ?? EMPTY);
  const handMarks: Record<string, string> = { ...Object.fromEntries(Object.entries(SWITCH_REACH as Record<string, { mark?: string }>).filter(([, v]) => v.mark).map(([k, v]) => [k, v.mark as string])), ...SWITCH_TARGET_MARK };
  const marksOfSw = (sw: string) => [...new Set([handMarks[sw], ...(inferred[sw] ?? []).map((m) => m.mark)].filter(Boolean) as string[])];
  const onRuns: Record<string, Record<string, boolean>> = {};
  for (const r of rr.runs) for (const sw of r.switches) { const ms = marksOfSw(sw); if (!ms.length) continue; const o = (onRuns[sw] ??= {}); for (const row of r.rows) o[row.id] = o[row.id] || ms.some((k) => row.marks.includes(k)); }
  const d = buildDictionary({
    problems: probs, reach: SWITCH_REACH as Record<string, { needs?: string[] }>, learned: (learned?.switches ?? null) as never,
    obsOf: (id) => { try { return readObs(id).map((o) => ({ sig: o.sig, at: o.at, independent: o.independent, model: o.model, codeKey: o.codeKey })); } catch { return []; } },
    priorOf: (id) => prior.get(id) ?? null,
    handMarks, inferred, onRuns,
    snapshotRule: (sw, ledger) => (SNAPSHOT_NEED[sw] ? snapshotHas(SNAPSHOT_NEED[sw], ledger) : null),
  });
  const P = Object.values(d.problems), S = Object.values(d.switches);
  console.log(`試験の辞書: 問題 ${P.length}（揺れの大きい ${P.filter((p) => p.flake.flaky).length}・観測なし ${P.filter((p) => !p.flake.n).length}）・スイッチ ${S.length}（試験できない＝先に写し ${S.filter((s) => !s.testable).length}・要る材料の行なし ${S.filter((s) => !s.needs.length).length}）`);
  for (const s of S.filter((x) => !x.testable)) console.log(`  ⚠ ${s.sw}: ${s.why}`);
  const withMarks = S.filter((x) => (x.marks ?? []).length);
  console.log(`材料の印: 印のあるスイッチ ${withMarks.length}（手 ${withMarks.filter((x) => x.marks!.some((m) => m.source === "手")).length}・推定だけ ${withMarks.filter((x) => x.marks!.every((m) => m.source === "推定")).length}）・写しの欄で決めた ${S.filter((x) => x.snapshotRule).length}・要る材料も印も写しの欄も無い ${S.filter((x) => !x.needs.length && !(x.marks ?? []).length && !x.snapshotRule).length}`);
  if (process.argv.includes("--eval")) {
    const jobs = nightJobsOf(join(examCacheRoot(), "exam-queue", "results"), Number(arg("days", "7")) || 7);
    const e = dictEval(d, jobs);
    // 届いたかの関所（A の案と同じ所）: その晩の組の on の行で、スイッチの印が出た問題が 3 未満＝「届かず」（結果を出さない）
    const rowsOf = new Map(rr.runs.map((r) => [r.label, r.rowsFull]));
    let gated = 0, compared = 0, noMark = 0; const gatedLabels: string[] = [];
    for (const j of jobs) { const rows = rowsOf.get(j.label) ?? []; const targets = j.ids.filter((x) => !j.guards.includes(x)); const vs = j.switches.map((sw) => dictReachGate(d, sw, rows, targets)); if (!vs.length || vs.every((v) => v.verdict === "印なし")) { noMark++; continue; } if (vs.some((v) => v.verdict === "比べる")) compared++; else { gated++; gatedLabels.push(j.label); } }
    console.log(`届いたかの関所（前の晩の組 ${jobs.length}）: 比べる ${compared}・届かず ${gated}${gatedLabels.length ? `（${gatedLabels.slice(0, 6).join(",")}）` : ""}・印なし ${noMark}`);
    console.log(`物差し（前の${arg("days", "7")}晩の試験の組 ${e.jobs}）: 辞書で外れた問題 ${e.dropped}・浮いた費用 $${e.savedUsd.toFixed(2)}・比べられる問題（守りでない・揺れの小さい）${e.comparableBefore}→${e.comparableAfter}・外した問題の確かな悪化（見落とし）${e.missedSignals}${e.untestableJobs.length ? `・試験できないスイッチの組 ${e.untestableJobs.length}（${e.untestableJobs.slice(0, 5).join(",")}）` : ""}`);
  }
  if (!process.argv.includes("--dry")) { writeFileSync(EXAM_DICTIONARY_FILE(), JSON.stringify(d)); console.log(`書いた: ${EXAM_DICTIONARY_FILE()}`); }
}
