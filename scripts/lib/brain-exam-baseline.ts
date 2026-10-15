// scripts/lib/brain-exam-baseline.ts — ブレインの試験の「前」（main の版）の結果を、版と構成ごとに問題単位で取っておき使い回す
//
// 2026-10-15 竹内「テストの時 API 使いすぎてる。もっと質高く重点的に API も節約してテストを回す」
//   直す前と後を比べる時、「前」は main の同じ commit・同じ構成（試験に効く環境変数・層・台帳・下書き・回数）なら何度回しても同じ物を測る。
//   → <倉庫の根>/.claude/exam-cache/brain-exam-baseline/<commit>-<構成の hash>/<問題>.json に問題ごとの答案を置き、同じ問題（中身の hash も同じ）は回さずに使う。
//     無い問題だけ main の作業ツリー（.claude/worktrees/brain-exam-main）で回して足す。置き場は .gitignore（答案に伏せた会話が入る）。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./llm-cassette";

/** 置き場（全部の作業ツリーで共有＝他の担当が回した main の「前」も使える）。<倉庫の根>/.claude/exam-cache/brain-exam-baseline（EXAM_CACHE_DIR で変える） */
export const BASELINE_DIR = join(examCacheRoot(), "brain-exam-baseline");

/** 試験の結果に効く環境変数（名前の形）。鍵・秘密は入れない */
export const EXAM_ENV_RE = /^(?:BRAIN_|TWO_STAGE_|SEARCH_|TURN_|NEXT_PUBLIC_SEARCH_|AIX_|CONFIRM_|REPEAT_|FINAL_CHECK_|PICKUP_|VIEWING_|EXHAUSTED_|ROOM_PHOTO_|CONTRACT_|LLM_TEST_|DEEPSEEK_MODEL$|CLAUDE_\w*MODEL|CLAUDE_SONNET55_ACTIONS$|LLM_ALT_|REPLY_)/;
const SECRET_RE = /KEY|SECRET|TOKEN|PASSWORD/;
/** 構成から外す物（試験の道具の置き場・線のファイル等＝答えに効かない） */
const IGNORE_ENV = new Set(["BRAIN_EXAM_BASELINE_CHILD", "BRAIN_JUDGE_EXAMPLES_EXCLUDE_CONV", "LLM_ALT_DEEPSEEK_KEY"]);

export type ExamConfig = { args: Record<string, string | boolean | number | null>; env: Record<string, string> };

/** 構成（答えに効く物だけ）。args は呼ぶ側が渡す（層・台帳・下書き・回数・判定の回数・自動の手がかり・出し切りの決まり） */
export function examConfig(env: Record<string, string | undefined>, args: ExamConfig["args"]): ExamConfig {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || !EXAM_ENV_RE.test(k) || SECRET_RE.test(k) || IGNORE_ENV.has(k)) continue;
    e[k] = v;
  }
  // 試しの材料（BRAIN_EXAM_INJECT_FILE）はファイルの中身で
  if (e.BRAIN_EXAM_INJECT_FILE) { try { e.BRAIN_EXAM_INJECT_FILE = sha(readFileSync(e.BRAIN_EXAM_INJECT_FILE, "utf8")).slice(0, 12); } catch { /* */ } }
  return { args: Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))), env: Object.fromEntries(Object.entries(e).sort(([a], [b]) => a.localeCompare(b))) };
}
export function sha(s: string): string { return createHash("sha256").update(s).digest("hex"); }
export function configHash(c: ExamConfig): string { return sha(JSON.stringify(c)).slice(0, 10); }
/** 問題の中身の hash（spec を直したら別物） */
export function problemHash(p: unknown): string { return sha(JSON.stringify(p)).slice(0, 12); }

export function baselineDirOf(commit: string, cfgHash: string, root = BASELINE_DIR): string { return join(root, `${commit.slice(0, 10)}-${cfgHash}`); }

export type BaselineFile<R> = { id: string; problemHash: string; commit: string; config: ExamConfig; savedAt: string; fromLabel: string; rows: R[]; cost?: { real: number; realUsd: number; replayed: number; replayUsd: number } | null };

export function loadBaseline<R>(dir: string): Map<string, BaselineFile<R>> {
  const m = new Map<string, BaselineFile<R>>();
  if (!existsSync(dir)) return m;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json") && x !== "config.json")) {
    try { const b = JSON.parse(readFileSync(join(dir, f), "utf8")) as BaselineFile<R>; m.set(b.id, b); } catch { /* 壊れた物は無い物として回し直す */ }
  }
  return m;
}
export function saveBaseline<R>(dir: string, b: BaselineFile<R>): void {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, "config.json"))) writeFileSync(join(dir, "config.json"), JSON.stringify({ commit: b.commit, config: b.config }, null, 1));
  writeFileSync(join(dir, `${b.id}.json`), JSON.stringify(b));
}

/** 使い回せる問題と回す問題を分ける（同じ問題 hash・回の数が足りる・失敗の回が無い） */
export function planBaseline<R extends { rep: number; error?: string }>(problems: Array<{ id: string; hash: string }>, cached: Map<string, BaselineFile<R>>, repeat: number): { reuse: string[]; run: string[]; stale: string[] } {
  const reuse: string[] = [], run: string[] = [], stale: string[] = [];
  for (const p of problems) {
    const b = cached.get(p.id);
    if (!b) { run.push(p.id); continue; }
    if (b.problemHash !== p.hash) { run.push(p.id); stale.push(p.id); continue; }
    const ok = new Set(b.rows.filter((r) => !r.error).map((r) => r.rep));
    if (Array.from({ length: repeat }, (_, i) => i + 1).every((k) => ok.has(k))) reuse.push(p.id); else run.push(p.id);
  }
  return { reuse, run, stale };
}

/** 引数から「前」（main の版）を回す時に渡さない物を外す（label・only・types・per-type・baseline・report は子が自分で決める） */
export function childArgs(args: string[]): string[] {
  return args.filter((a) => !/^--(?:label|only|types|only-type|per-type|baseline|baseline-ref|baseline-refresh|baseline-dry|report)(?:=|$)/.test(a));
}
