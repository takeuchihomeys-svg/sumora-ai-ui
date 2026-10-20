// scripts/lib/brain-exam-baseline.ts — ブレインの試験の「前」（main の版）の結果を、版と構成ごとに問題単位で取っておき使い回す
//
// 2026-10-15 竹内「テストの時 API 使いすぎてる。もっと質高く重点的に API も節約してテストを回す」
//   直す前と後を比べる時、「前」は main の同じ commit・同じ構成（試験に効く環境変数・層・台帳・下書き・回数）なら何度回しても同じ物を測る。
//   → <倉庫の根>/.claude/exam-cache/brain-exam-baseline/<commit>-<構成の hash>/<問題>.json に問題ごとの答案を置き、同じ問題（中身の hash も同じ）は回さずに使う。
//     無い問題だけ main の作業ツリー（.claude/worktrees/brain-exam-main）で回して足す。置き場は .gitignore（答案に伏せた会話が入る）。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./llm-cassette";
import { atomicWriteJson } from "./exam-shared-file";

/** 置き場（全部の作業ツリーで共有＝他の担当が回した main の「前」も使える）。<倉庫の根>/.claude/exam-cache/brain-exam-baseline（EXAM_CACHE_DIR で変える） */
export const BASELINE_DIR = join(examCacheRoot(), "brain-exam-baseline");

/** 試験の結果に効く環境変数（名前の形）。鍵・秘密は入れない */
export const EXAM_ENV_RE = /^(?:BRAIN_|TWO_STAGE_|SEARCH_|TURN_|NEXT_PUBLIC_SEARCH_|AIX_|CONFIRM_|REPEAT_|FINAL_CHECK_|PICKUP_|VIEWING_|EXHAUSTED_|ROOM_PHOTO_|CONTRACT_|LLM_TEST_|DEEPSEEK_MODEL$|CLAUDE_\w*MODEL|CLAUDE_SONNET55_ACTIONS$|LLM_ALT_|REPLY_|EXAM_JUDGE_TIER$|EXAM_JUDGE_FLASH_MODEL$)/;
const SECRET_RE = /KEY|SECRET|TOKEN|PASSWORD/;
/** 構成から外す物（試験の道具の置き場・線のファイル等＝答えに効かない） */
// 2026-10-20 判定の段（EXAM_JUDGE_TIER）は答案の合否を変え得る＝構成に入れる（付けない時は今までと同じ hash）
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
/**
 * 問題の中身の hash（spec を直したら別物）。2026-10-15 ③: 作った時刻（builtAt）は外す＝作業ツリーごとに作り直しても同じ中身なら同じ hash
 *   （旧は builtAt 込み＝作業ツリーごとに違い、他の担当の「前」を使い回せなかった。旧の hash は legacyProblemHash で読む）
 */
export function problemHash(p: unknown): string {
  if (p && typeof p === "object" && !Array.isArray(p) && "builtAt" in (p as Record<string, unknown>)) {
    const rest = { ...(p as Record<string, unknown>) }; delete rest.builtAt;
    return sha(JSON.stringify(rest)).slice(0, 12);
  }
  return sha(JSON.stringify(p)).slice(0, 12);
}
/** 旧の hash（builtAt 込み）。前に取り置いた物を読むためだけ */
export function legacyProblemHash(p: unknown): string { return sha(JSON.stringify(p)).slice(0, 12); }

export function baselineDirOf(commit: string, cfgHash: string, root = BASELINE_DIR): string { return join(root, `${commit.slice(0, 10)}-${cfgHash}`); }
/** 2026-10-15 ②: main の版の鍵（試験に効く所の中身・exam-scope.examVersionKey）ごとの置き場。commit が違っても中身が同じなら同じ置き場 */
export function baselineDirOfVersion(versionKey: string, cfgHash: string, root = BASELINE_DIR): string { return join(root, `v-${versionKey}-${cfgHash}`); }

export type BaselineFile<R> = {
  id: string; problemHash: string; commit: string; config: ExamConfig; savedAt: string; fromLabel: string; rows: R[]; cost?: { real: number; realUsd: number; replayed: number; replayUsd: number } | null;
  /** 2026-10-15 ②: 版の鍵（v- の置き場の時） */ versionKey?: string;
  /** 2026-10-15 ④: 揺れる問題だけ繰り返した（--repeat-flaky）＝回が repeat より少なくても揃っている */ complete?: boolean;
  /** 2026-10-20: 答えを出した main の段ごとの鍵（exam-scope.examStageKeys）。main が進んでもこの段の鍵が同じなら持ち越す */ stageKeys?: { brain: string; draft: string } | null;
  /** 2026-10-20: 前の main の置き場から持ち越した（元の置き場の名前） */ carriedFrom?: string;
};

// ─── 2026-10-20 前の main の答えの持ち越し（main の変更がその問題の段に効かない時） ─────────────
/** 置き場の構成の段 → 見る鍵。ブレインだけ（stage=brain）はブレインの鍵、それ以外（draft・auto・diff）は下書きまで入った鍵（安全側） */
export function relevantStageOf(cfg: ExamConfig | null | undefined): "brain" | "draft" { return cfg?.args?.stage === "brain" ? "brain" : "draft"; }
/**
 * 今の置き場に無い問題の答えを、同じ構成の別の置き場（前の main）から探す: 同じ問題（hash）・期限の内・失敗の回が無い・回が揃う・
 *   その段の鍵（keyOf）が今の main と同じ。いくつもあれば一番新しい物。keyOf が null（鍵が分からない）物は使わない（安全側）
 */
export function findCarryOver<R extends { rep: number; error?: string }>(cands: Array<BaselineFile<R> & { dir?: string }>, p: { hash: string; alt?: string[] }, want: { key: string; keyOf: (b: BaselineFile<R>) => string | null }, repeat: number, o: { acceptComplete?: boolean; maxAgeMs?: number | null; now?: number } = {}): (BaselineFile<R> & { dir?: string }) | null {
  const now = o.now ?? Date.now();
  const ok = cands.filter((b) => {
    if (!sameProblem(b, p)) return false;
    const t = Date.parse(String(b.savedAt ?? ""));
    if (o.maxAgeMs && o.maxAgeMs > 0 && (!Number.isFinite(t) || now - t > o.maxAgeMs)) return false;
    if (b.rows.some((r) => r.error)) return false;
    const reps = new Set(b.rows.map((r) => r.rep));
    if (!(o.acceptComplete && b.complete && reps.has(1)) && !Array.from({ length: repeat }, (_, i) => i + 1).every((k) => reps.has(k))) return false;
    return want.keyOf(b) === want.key;
  });
  return ok.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))[0] ?? null;
}
/** 同じ構成（-<構成の hash>）の他の置き場の名前（今の置き場は除く） */
export function siblingDirs(names: string[], cfgHash: string, cur: string): string[] { return names.filter((n) => n.endsWith(`-${cfgHash}`) && n !== cur); }

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
  // 2026-10-15 ③: 他の担当と同時に書いても壊れないよう一時ファイル → rename
  if (!existsSync(join(dir, "config.json"))) atomicWriteJson(join(dir, "config.json"), { commit: b.commit, versionKey: b.versionKey ?? null, config: b.config }, true);
  atomicWriteJson(join(dir, `${b.id}.json`), b);
}

/** 取り置きの問題 hash が今の問題と同じか（新しい hash か旧の hash のどちらか） */
export function sameProblem(b: { problemHash: string }, p: { hash: string; alt?: string[] }): boolean { return b.problemHash === p.hash || !!p.alt?.includes(b.problemHash); }
/**
 * 使い回せる問題と回す問題を分ける（同じ問題 hash・回の数が足りる・失敗の回が無い）。
 * 2026-10-15 ④ acceptComplete: 揺れる問題だけ繰り返した取り置き（complete の印・1回目あり）は回が repeat より少なくても揃っている
 */
export function planBaseline<R extends { rep: number; error?: string }>(problems: Array<{ id: string; hash: string; alt?: string[] }>, cached: Map<string, BaselineFile<R>>, repeat: number, o: { acceptComplete?: boolean; maxAgeMs?: number | null; now?: number } = {}): { reuse: string[]; run: string[]; stale: string[]; expired: string[] } {
  const reuse: string[] = [], run: string[] = [], stale: string[] = [], expired: string[] = [];
  const now = o.now ?? Date.now();
  for (const p of problems) {
    const b = cached.get(p.id);
    if (!b) { run.push(p.id); continue; }
    if (!sameProblem(b, p)) { run.push(p.id); stale.push(p.id); continue; }
    // 2026-10-16 比べる相手の答えに期限: DB の中身・モデル側の変化は鍵に入らない → savedAt が古ければ流し直す（savedAt が読めない物も古いとみる）
    if (o.maxAgeMs && o.maxAgeMs > 0) { const t = Date.parse(String(b.savedAt ?? "")); if (!Number.isFinite(t) || now - t > o.maxAgeMs) { run.push(p.id); expired.push(p.id); continue; } }
    const ok = new Set(b.rows.filter((r) => !r.error).map((r) => r.rep));
    if (o.acceptComplete && b.complete && ok.has(1) && !b.rows.some((r) => r.error)) { reuse.push(p.id); continue; }
    if (Array.from({ length: repeat }, (_, i) => i + 1).every((k) => ok.has(k))) reuse.push(p.id); else run.push(p.id);
  }
  return { reuse, run, stale, expired };
}
/**
 * 2026-10-16 比べる相手（main の取り置き）の期限（日）。--baseline-max-age=<日|off> → EXAM_BASELINE_MAX_AGE_DAYS → 既定 7日。0・off で期限なし（旧の動き）
 */
export const BASELINE_MAX_AGE_DAYS_DEFAULT = 7;
export function baselineMaxAgeMs(argVal: string | undefined, env: Record<string, string | undefined> = process.env): number | null {
  const v = String(argVal || env.EXAM_BASELINE_MAX_AGE_DAYS || "").trim().toLowerCase();
  if (v === "off" || v === "0") return null;
  const d = v ? Number(v) : BASELINE_MAX_AGE_DAYS_DEFAULT;
  return (Number.isFinite(d) && d > 0 ? d : BASELINE_MAX_AGE_DAYS_DEFAULT) * 86_400_000;
}
/** 版の置き場に無い問題を、旧の置き場（同じ commit の <commit>-<構成>）から足す（前に取り置いた物を捨てない） */
export function mergeBaselines<R>(primary: Map<string, BaselineFile<R>>, ...legacy: Array<Map<string, BaselineFile<R>>>): Map<string, BaselineFile<R>> {
  const m = new Map(primary);
  for (const l of legacy) for (const [id, b] of l) if (!m.has(id)) m.set(id, b);
  return m;
}

/**
 * 引数から「前」（main の版）を回す時に渡さない物を外す（label・only・types・per-type・baseline・report は子が自分で決める）。
 * 2026-10-15 ①: --stage=diff は子（main の作業ツリー）で決めると main との差が無い＝いつも brain になる → 親で決めた段（resolvedStage）に置き換える
 */
export function childArgs(args: string[], o: { resolvedStage?: string } = {}): string[] {
  return args.filter((a) => !/^--(?:label|only|types|only-type|per-type|baseline|baseline-ref|baseline-refresh|baseline-dry|baseline-key|baseline-max-age|baseline-defer|baseline-limit|select|select-n|select-q|link-kb|report)(?:=|$)/.test(a))
    .map((a) => (a === "--stage=diff" && o.resolvedStage ? `--stage=${o.resolvedStage}` : a));
}
