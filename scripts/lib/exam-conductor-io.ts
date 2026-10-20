// scripts/lib/exam-conductor-io.ts — 試験のブレインの司令塔・読み手の読み書きと LLM（DeepSeek pro／flash）を呼ぶ所
//
// 決め方は scripts/lib/exam-conductor.ts（純関数）。ここは:
//   ① 今までの結果（使い回しの置き場 <倉庫の根>/.claude/exam-cache/exam-brain/results・揺れの記録）から問題ごとの一番新しい答案を読む
//   ② 直した中身（git の差分の要約・変えたファイル・設計知見の id）を作る（本文は伏せ字・個人の値がある行は捨てる）
//   ③ DeepSeek を呼ぶ（送る前に個人の値の網＝test-pii-guard の piiValueSignal／testPiiRefusal。引っかかったら送らない）。費用は local-llm-spend.jsonl に足す（1日の上限に数える）
//   ④ 計画・結果・外れの地図をファイルに残す（<倉庫の根>/.claude/exam-cache/exam-brain/conductor/）
// DB は読むだけ（設計知見の id の照合）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EXAM_BRAIN_DIR } from "./exam-brain-io";
import { FLAKE_DIR, type FlakeObs } from "./exam-flake";
import { pathFailedSig } from "./exam-rag-run";
import { decideStageFromDiff } from "./exam-scope";
import { maskExamText } from "./brain-exam-mask";
import { appendLocalSpend } from "./brain-self-review-io";
import { piiValueSignal, testPiiRefusal } from "../../app/lib/test-pii-guard";
import { isDeepseekPeakAt } from "../../app/lib/llm-price";
import { deepseekUsd, type MissMap, type ProblemLike, type RowLike, type ConductorPlan } from "./exam-conductor";

export const CONDUCTOR_DIR = join(EXAM_BRAIN_DIR, "conductor");
export const PRO_MODEL = "deepseek-v4-pro", FLASH_MODEL = "deepseek-flash";

// ─── ① 今までの結果 ─────────────────────────────────────────────────────
type ReuseFile = { id: string; savedAt: string; label: string; stage: string; model: string; rows: RowLike[] };
/** 問題の一番新しい答案（使い回しの置き場＝問題ごと・鍵ごとの JSON。無ければ揺れの記録の一番新しい回から道と合否だけ） */
export function latestRowsOf(p: ProblemLike, dir = join(EXAM_BRAIN_DIR, "results"), flakeDir = FLAKE_DIR): { rows: RowLike[]; at: string; source: string } | null {
  const d = join(dir, p.id);
  let best: ReuseFile | null = null;
  if (existsSync(d)) for (const f of readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    try { const j = JSON.parse(readFileSync(join(d, f), "utf8")) as ReuseFile; if (j?.rows?.length && (!best || j.savedAt > best.savedAt)) best = j; } catch { /* 壊れた物は飛ばす */ }
  }
  // 揺れの記録の方が新しければそちら（道と合否だけ）
  const fd = join(flakeDir, p.id);
  let obs: FlakeObs[] = [];
  if (existsSync(fd)) for (const f of readdirSync(fd)) { if (!f.endsWith(".jsonl") || f.startsWith("legacy-")) continue; try { for (const l of readFileSync(join(fd, f), "utf8").split("\n")) if (l.trim()) obs.push(JSON.parse(l) as FlakeObs); } catch { /* */ } }
  obs = obs.sort((a, b) => a.at.localeCompare(b.at));
  const lastObs = obs[obs.length - 1];
  if (best && (!lastObs || best.savedAt >= lastObs.at.slice(0, 19))) return { rows: refreshPath(p, best.rows), at: best.savedAt, source: `答案 ${best.label}（${best.stage}）` };
  if (lastObs) {
    const rs = obs.filter((o) => o.label === lastObs.label);
    return { rows: rs.map((o) => ({ id: p.id, rep: o.rep, path: { code: o.pathSig, ok: !pathFailedSig(o.sig.split("|下書き")[0], p as never) }, score: { pass: !/\|✕/.test(o.sig.split("|下書き")[0]) } })), at: lastObs.at, source: `揺れの記録 ${lastObs.label}（道と合否だけ）` };
  }
  if (best) return { rows: refreshPath(p, best.rows), at: best.savedAt, source: `答案 ${best.label}（${best.stage}）` };
  return null;
}
/** 道の合否は今の正解（spec）で付け直す（古い答案は前の正解で採点されている） */
export function refreshPath(p: ProblemLike, rows: RowLike[]): RowLike[] {
  return rows.map((r) => { if (!r.path?.code) return r; const ok = !pathFailedSig(String(r.path.code), p as never); return { ...r, path: { ...r.path, ok }, score: ok ? r.score : { ...(r.score ?? {}), pass: false } }; });
}
/**
 * 本番に入れた版（main）の答案: brain-exam-baseline の main の版の鍵（main-head.json の versionKey）の置き場を先に・無ければ古い版の一番新しい物。
 *   それも無ければ latestRowsOf（作業の結果）。外れの型の地図は既定でこちら（＝今の main の弱い所）
 */
export function mainRowsOf(p: ProblemLike, baseDir = join(EXAM_BRAIN_DIR, "..", "brain-exam-baseline")): { rows: RowLike[]; at: string; source: string } | null {
  let head = "";
  try { head = String((JSON.parse(readFileSync(join(baseDir, "main-head.json"), "utf8")) as { versionKey?: string }).versionKey ?? ""); } catch { /* */ }
  let best: { rows: RowLike[]; at: string; source: string; cur: boolean } | null = null;
  if (existsSync(baseDir)) for (const d of readdirSync(baseDir)) {
    if (!d.startsWith("v-")) continue;
    const f = join(baseDir, d, `${p.id}.json`);
    if (!existsSync(f)) continue;
    try {
      const j = JSON.parse(readFileSync(f, "utf8")) as { savedAt: string; rows: RowLike[]; fromLabel?: string };
      if (!j.rows?.length) continue;
      const cur = !!head && d.startsWith(`v-${head}-`);
      if (!best || (cur && !best.cur) || (cur === best.cur && j.savedAt > best.at)) best = { rows: j.rows, at: j.savedAt, source: `main ${cur ? "今の版" : "古い版"} ${d}`, cur };
    } catch { /* */ }
  }
  return best ? { rows: refreshPath(p, best.rows), at: best.at, source: best.source } : latestRowsOf(p);
}
export function saveMissMap(m: MissMap, name: string): string {
  mkdirSync(CONDUCTOR_DIR, { recursive: true });
  const f = join(CONDUCTOR_DIR, `missmap-${name}.json`);
  writeFileSync(f, JSON.stringify(m, null, 1));
  return f;
}
export function readMissMap(name: string): MissMap | null { try { return JSON.parse(readFileSync(join(CONDUCTOR_DIR, `missmap-${name}.json`), "utf8")) as MissMap; } catch { return null; } }

// ─── ② 直した中身 ─────────────────────────────────────────────────────
export type DiffMaterial = { base: string | null; cls: string; note: string; files: Array<{ file: string; cls: string; why: string }>; commits: string[]; kbIds: string[]; diffText: string; dropped: number };
const git = (a: string[], cwd: string) => { try { return execFileSync("git", a, { cwd, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).toString(); } catch { return ""; } };
/** 1行ずつ伏せて、個人の値が残る行は捨てる（DeepSeek に渡す前の網） */
export function safeLines(text: string): { text: string; dropped: number } {
  let dropped = 0;
  const out: string[] = [];
  for (const l of String(text ?? "").split("\n")) { const m = maskExamText(l, null); if (piiValueSignal(m)) { dropped++; continue; } out.push(m); }
  return { text: out.join("\n"), dropped };
}
export async function diffMaterial(sb: SupabaseClient | null, cwd = ".", o: { maxChars?: number; range?: string } = {}): Promise<DiffMaterial> {
  const d = decideStageFromDiff(cwd);
  const base = o.range ? o.range.split("..")[0] : d.base;
  const files = d.files.map((f) => ({ file: f.file, cls: f.cls, why: f.why }));
  const commits = base ? git(["log", "--format=%s%n%b%x1e", `${base}..${o.range?.split("..")[1] ?? "HEAD"}`], cwd).split("\x1e").map((s) => s.trim()).filter(Boolean) : [];
  const codeFiles = files.map((f) => f.file).filter((f) => /\.(ts|tsx|js|mjs|json|sql)$/.test(f) && !/package-lock|\.cassette|results\//.test(f));
  const raw = base && codeFiles.length ? git(["diff", "-U0", o.range ?? base, "--", ...codeFiles], cwd) : "";
  // 足した・消した行と、ファイルの見出しだけ（＋の行を先に）
  const lines = raw.split("\n").filter((l) => /^(\+\+\+|[+-](?![+-]))/.test(l)).map((l) => l.slice(0, 220));
  const s = safeLines(lines.join("\n"));
  const max = o.maxChars ?? 6000;
  const diffText = s.text.length > max ? `${s.text.slice(0, max)}\n…（${s.text.length - max}字を省いた）` : s.text;
  // 設計知見の id（差分・コミットの文に書かれた8字の16進＝本物の知見の id だけ）
  let kbIds: string[] = [];
  const cand = [...new Set([...`${raw}\n${commits.join("\n")}`.matchAll(/\b([0-9a-f]{8})\b/g)].map((m) => m[1]))];
  if (sb && cand.length) {
    try {
      const { loadKbRows } = await import("./exam-rag-store");
      const ids = new Set((await loadKbRows(sb)).map((r) => r.id.slice(0, 8)));
      kbIds = cand.filter((c) => ids.has(c));
    } catch { kbIds = []; }
  }
  const cm = safeLines(commits.join("\n\x1f\n"));
  return { base, cls: d.cls, note: d.note, files, commits: cm.text.split("\n\x1f\n").map((x) => x.trim()).filter(Boolean), kbIds, diffText, dropped: s.dropped + cm.dropped };
}

// ─── ③ DeepSeek を呼ぶ（個人の値の網つき） ────────────────────────────────
export type LlmTally = { calls: number; usd: number; refused: number; failed: number; byRole: Record<string, { calls: number; usd: number }> };
export const newTally = (): LlmTally => ({ calls: 0, usd: 0, refused: 0, failed: 0, byRole: {} });
/** 試験の入口（setupLlmTest）を通した時は使用量が llm_usage_logs に入る＝手元の記録（local-llm-spend.jsonl）には足さない（1日の上限で二重に数えない） */
let LOCAL_SPEND = true;
export function setLocalSpendRecording(on: boolean): void { LOCAL_SPEND = on; }
export async function callConductorLlm(role: "conductor" | "diff-reader" | "triage", model: string, system: string, user: string, tally: LlmTally, o: { maxTokens?: number } = {}): Promise<string | null> {
  const body = `${system}\n${user}`;
  const sig = piiValueSignal(body);
  const refuse = testPiiRefusal(process.env, body, `試験の${role}`);
  if (sig || refuse) { tally.refused++; console.warn(`⛔ ${role}: 送る本文に個人の値（${sig ?? "テストの網"}）→ 送らない`); return null; }
  const { callDeepSeek } = await import("../../app/lib/vision-alt-provider");
  const r = await callDeepSeek(system, user, { model, maxTokens: o.maxTokens ?? 1200, thinking: false, temperature: 0, timeoutMs: 120_000 });
  if (!r) { tally.failed++; return null; }
  const usd = deepseekUsd(model, r.usage, isDeepseekPeakAt(new Date()));
  tally.calls++; tally.usd += usd;
  const b = tally.byRole[role] ?? { calls: 0, usd: 0 }; b.calls++; b.usd += usd; tally.byRole[role] = b;
  if (LOCAL_SPEND) try { appendLocalSpend({ at: new Date().toISOString(), tool: `exam-conductor-${role}`, usd, calls: 1 }); } catch { /* 記録の失敗で止めない */ }
  return r.text;
}

// ─── ④ 計画・結果のファイル ───────────────────────────────────────────
export type SavedPlan = { label: string; at: string; head: string; conv: string; plan: ConductorPlan; candidates: number; material: { cls: string; files: number; kbIds: string[]; reading: unknown }; llm: LlmTally; ragNote: string };
export function savePlan(p: SavedPlan): string {
  mkdirSync(CONDUCTOR_DIR, { recursive: true });
  const f = join(CONDUCTOR_DIR, `${p.label}.plan.json`);
  writeFileSync(f, JSON.stringify(p, null, 1));
  writeFileSync(join(CONDUCTOR_DIR, "latest-plan.txt"), f);
  return f;
}
export function loadPlan(fileOrLabel?: string): SavedPlan | null {
  try {
    let f = fileOrLabel && fileOrLabel !== "true" ? fileOrLabel : readFileSync(join(CONDUCTOR_DIR, "latest-plan.txt"), "utf8").trim();
    if (!f.endsWith(".json")) f = join(CONDUCTOR_DIR, `${f}.plan.json`);
    return JSON.parse(readFileSync(f, "utf8")) as SavedPlan;
  } catch { return null; }
}
export type SavedResult = { label: string; at: string; planLabel: string; compare: unknown; next: Array<{ id: string; why: string }>; triage: unknown; llm: LlmTally };
export function saveResult(r: SavedResult): string {
  mkdirSync(CONDUCTOR_DIR, { recursive: true });
  const f = join(CONDUCTOR_DIR, `${r.label}.result.json`);
  writeFileSync(f, JSON.stringify(r, null, 1));
  writeFileSync(join(CONDUCTOR_DIR, "latest-result.txt"), f);
  return f;
}
export function loadLatestResult(): SavedResult | null { try { return JSON.parse(readFileSync(readFileSync(join(CONDUCTOR_DIR, "latest-result.txt"), "utf8").trim(), "utf8")) as SavedResult; } catch { return null; } }
