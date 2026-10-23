// scripts/lib/exam-brain-io.ts — 試験のブレインの読み書き（問題・効くファイルの鍵・使い回しの置き場・台帳・予約・止まった実行の片付け）
//
// 2026-10-17 竹内さん 10/16「判断する所はブレインにまとめて、質を高く節約する」。決め方は scripts/lib/exam-brain.ts（純関数）、ここは手元のファイル・git・DB。
// 置き場（全部の作業ツリーで共有・.gitignore・答案に伏せた会話が入る）: <倉庫の根>/.claude/exam-cache/exam-brain/
//   results/<問題>/<鍵>.json … 問題ごとの今の結果（使い回し）／ledger.jsonl … 試験の台帳（問題×実行×版×前との比べ）／queue/<label>.json … 予約
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { examCacheRoot } from "./llm-cassette";
import { atomicWriteJson, atomicWriteText, updateJsonFile } from "./exam-shared-file";
import { BRAIN_ENTRIES, DRAFT_ENTRIES, TOOL_ENTRIES, reach, workingFiles } from "./exam-scope";
import { fillProblemsFromShared } from "./exam-problems-store";
import { CONV_CTX_FIELDS, jstDayStart, type ConvCtx, type DbPart, type RowLite, type SmallRecord, type WarmLog } from "./exam-brain";
import { NO_LINE_TEST_CONVERSATIONS, YUMA_CONVERSATION_ID } from "../../app/lib/test-conversations";
import { contentPartsOf, dbContentReads, dbFpMode, readDbContentFingerprint, type DbFpMode } from "./exam-db-fp";

export const EXAM_BRAIN_DIR = join(examCacheRoot(), "exam-brain");
export const REUSE_DIR = join(EXAM_BRAIN_DIR, "results");
export const LEDGER_FILE = join(EXAM_BRAIN_DIR, "ledger.jsonl");
export const QUEUE_DIR = join(EXAM_BRAIN_DIR, "queue");
export const MODEL_CHECK_FILE = join(EXAM_BRAIN_DIR, "model-check.json");
export const SPEC_FILE = "scripts/brain-exam/spec.json";
export const PROBLEMS_FILE = "scripts/brain-exam/problems.json";
export const RESULTS_DIR = "scripts/brain-exam/results";

// ─── 問題 ─────────────────────────────────────────────────────────────
export type AnyProblem = Record<string, unknown> & { id: string; type: string; tags?: string[]; accept?: string[]; stage?: string; addedAt?: string };
/** spec.json の問題（中身は手元の problems.json か共有の置き場）。手元の problems.json は書き直さない（書くのは brain-exam.ts） */
export function loadExamProblems(cwd = "."): { spec: AnyProblem[]; full: Map<string, AnyProblem> } {
  const spec = JSON.parse(readFileSync(join(cwd, SPEC_FILE), "utf8")) as AnyProblem[];
  const local = existsSync(join(cwd, PROBLEMS_FILE)) ? JSON.parse(readFileSync(join(cwd, PROBLEMS_FILE), "utf8")) as AnyProblem[] : [];
  const r = fillProblemsFromShared<AnyProblem>(spec, local, { addMissing: () => true });
  return { spec, full: new Map(r.problems.map((p) => [p.id, p])) };
}

// ─── 効くファイルの中身の鍵（今の作業ツリー） ───────────────────────────────
/** 作業ツリーのファイルの blob（git hash-object・改行の変換も git と同じ）。読めない物は "-" */
function blobsOf(paths: string[], cwd: string): Map<string, string> {
  const m = new Map<string, string>();
  if (!paths.length) return m;
  try {
    const out = execFileSync("git", ["hash-object", "--stdin-paths"], { cwd, input: paths.join("\n") + "\n", maxBuffer: 64 * 1024 * 1024 }).toString().trim().split("\n");
    paths.forEach((p, i) => m.set(p, out[i] ?? "-"));
  } catch { for (const p of paths) m.set(p, "-"); }
  return m;
}
const CONFIG_FILES = ["package.json", "package-lock.json", "tsconfig.json", "next.config.ts", "next.config.js", "next.config.mjs"];
const keyOf = (paths: Set<string>, blobs: Map<string, string>) => createHash("sha256").update([...paths].sort().map((p) => `${p} ${blobs.get(p) ?? "-"}`).join("\n")).digest("hex").slice(0, 12);
/**
 * 段ごとの「効くファイルの中身の鍵」: brain＝ブレインの入口から辿れる app・設定／draft＝それに下書きの入口から辿れる物／tool＝試験の道具（scripts/brain-exam*・scripts/lib・問題の決まり）。
 *   問題の結果の使い回しの鍵に使う（同じ鍵＝同じコードが答えを出す）
 */
export function workingScopeKeys(cwd = "."): { brain: string; draft: string; tool: string } {
  const files = workingFiles(cwd);
  const brain = new Set([...reach(BRAIN_ENTRIES, files)].filter((f) => f.startsWith("app/") || f.startsWith("lib/")));
  const draft = new Set([...brain, ...[...reach(DRAFT_ENTRIES, files)].filter((f) => f.startsWith("app/") || f.startsWith("lib/"))]);
  const tool = new Set([...reach(TOOL_ENTRIES, files)].filter((f) => f.startsWith("scripts/")));
  for (const f of ["scripts/brain-exam/stage-by-type.json"]) if (existsSync(join(cwd, f))) tool.add(f);
  const cfg = CONFIG_FILES.filter((f) => existsSync(join(cwd, f)));
  for (const f of cfg) { brain.add(f); draft.add(f); }
  const blobs = blobsOf([...new Set([...brain, ...draft, ...tool])], cwd);
  return { brain: keyOf(brain, blobs), draft: keyOf(draft, blobs), tool: keyOf(tool, blobs) };
}

// ─── 6. DB の表の指紋（使い回しの鍵に足す・読むだけ） ─────────────────────────────
/**
 * ブレイン（brain）と下書き（draft＝generate-reply）が毎回読む、会話に依らない表（知見・決まり・手本・統計・地図）。
 *   2026-10-17 コードから確かめた（BRAIN_ENTRIES・DRAFT_ENTRIES から辿れる app/lib・app/api の .from("…")・.rpc("match_…") の表）。
 *   入れない物: 会話ごとの表（messages・conversations・property_customers・viewings・brain_decision_logs 等＝試験が自分で入れる・会話で絞る）・
 *   書くだけの記録（llm_usage_logs・*_logs の書き込み・embedding_cache・llm_warm_prefixes）・中身が答えに効かない設定（hanbancyo_settings の通知先）。
 *   ts＝最終の時刻の欄（無い表は件数だけ）・counts＝中身の変化を拾う絞った件数・hash＝小さい表は欄の中身の hash（置き換えの編集も拾う）
 *   使う回数・最後に使った時刻（used_count・last_used_at・use_count・win_rate 等）は本番で毎回変わる＝指紋に入れない
 */
export type DbTableSpec = { table: string; stages: Array<"brain" | "draft">; ts?: "updated_at" | "created_at"; counts?: Record<string, [string, "eq" | "neq", string | number | boolean]>; hash?: { cols: string[]; order: string[] } };
export const DB_FINGERPRINT_TABLES: DbTableSpec[] = [
  // 知見（ブレインの原則・当てはめの型・RAG の match_reply_knowledge）。updated_at が無い＝作った時刻＋絞った件数（昇格・却下・合流の削除を拾う）
  { table: "ai_reply_knowledge", stages: ["brain", "draft"], ts: "created_at", counts: { principle: ["category", "eq", "principle"], applying: ["category", "eq", "applying_pattern"], rejected: ["hypothesis_status", "eq", "rejected"], imp10: ["importance", "eq", 10] } },
  { table: "ai_prompt_rules", stages: ["brain", "draft"], ts: "updated_at", counts: { active: ["is_active", "eq", true] } },
  { table: "ai_reply_examples", stages: ["brain", "draft"], ts: "created_at", counts: { starred: ["is_starred", "eq", true] } },
  { table: "trigger_action_rules", stages: ["brain", "draft"], ts: "updated_at" },
  { table: "aix_action_attribution", stages: ["brain", "draft"], hash: { cols: ["action_type", "win_rate", "usage_count"], order: ["action_type"] } },
  { table: "aix_transition_stats", stages: ["brain", "draft"], hash: { cols: ["from_aix_type", "to_aix_type", "count"], order: ["from_aix_type", "to_aix_type"] } },
  { table: "brain_aix_feedback", stages: ["brain", "draft"], ts: "updated_at" },
  { table: "brain_meta_insights", stages: ["brain", "draft"], ts: "updated_at" },
  { table: "templates", stages: ["brain", "draft"], hash: { cols: ["id", "category", "label", "text", "sort_order"], order: ["id"] } },
  { table: "winning_patterns", stages: ["brain", "draft"], ts: "updated_at" },
  { table: "property_search_knowledge", stages: ["brain", "draft"], ts: "updated_at" },
  { table: "rent_observations", stages: ["brain", "draft"] },
  { table: "region_map", stages: ["brain", "draft"], ts: "created_at" },
  { table: "station_map", stages: ["brain", "draft"], ts: "created_at" },
  { table: "line_stations", stages: ["brain", "draft"] },
  // 下書き（generate-reply）だけが読む表
  { table: "adaptation_improvement_rules", stages: ["draft"], hash: { cols: ["id", "category", "rule_text", "confidence", "example_count", "is_active"], order: ["id"] } },
  { table: "ai_prompts", stages: ["draft"], ts: "updated_at" },
  { table: "phrase_dictionary", stages: ["draft"], ts: "created_at", counts: { active: ["is_active", "eq", true] } },
  { table: "template_selection_logs", stages: ["draft"], ts: "created_at" },
];
export const dbTablesOf = (stage: "brain" | "draft", specs = DB_FINGERPRINT_TABLES) => specs.filter((s) => s.stages.includes(stage)).map((s) => s.table);
/** 表ごとの指紋を1回読む（並べて・読むだけ・費用0）。読めない表は ok=false（その表を読む段は使い回さない） */
export async function readDbFingerprint(sb: SupabaseClient, specs = DB_FINGERPRINT_TABLES): Promise<DbPart[]> {
  const HASH_MAX = 2000;
  return Promise.all(specs.map(async (s): Promise<DbPart> => {
    try {
      const parts: string[] = [];
      const c = await sb.from(s.table).select("*", { count: "exact", head: true });
      if (c.error || c.count === null) return { table: s.table, ok: false, sig: "", why: c.error?.message ?? "件数が読めない" };
      parts.push(`n=${c.count}`);
      for (const [name, [col, op, val]] of Object.entries(s.counts ?? {})) {
        const q = sb.from(s.table).select("*", { count: "exact", head: true });
        const r = await (op === "eq" ? q.eq(col, val) : q.neq(col, val));
        if (r.error || r.count === null) return { table: s.table, ok: false, sig: "", why: `${name}: ${r.error?.message ?? "件数が読めない"}` };
        parts.push(`${name}=${r.count}`);
      }
      if (s.ts) {
        const r = await sb.from(s.table).select(s.ts).order(s.ts, { ascending: false, nullsFirst: false }).limit(1);
        if (r.error) return { table: s.table, ok: false, sig: "", why: `${s.ts}: ${r.error.message}` };
        parts.push(`${s.ts}=${String(((r.data ?? [])[0] as Record<string, unknown> | undefined)?.[s.ts] ?? "-")}`);
      }
      if (s.hash) {
        if (c.count > HASH_MAX) return { table: s.table, ok: false, sig: "", why: `中身の hash の上限 ${HASH_MAX} 行を超えた（${c.count}）` };
        let q = sb.from(s.table).select(s.hash.cols.join(","));
        for (const o of s.hash.order) q = q.order(o, { ascending: true });
        const r = await q.range(0, HASH_MAX - 1);
        if (r.error) return { table: s.table, ok: false, sig: "", why: `中身: ${r.error.message}` };
        parts.push(`h=${createHash("sha256").update(JSON.stringify(r.data ?? [])).digest("hex").slice(0, 12)}`);
      }
      return { table: s.table, ok: true, sig: parts.join(";") };
    } catch (e) { return { table: s.table, ok: false, sig: "", why: String(e instanceof Error ? e.message : e).slice(0, 120) }; }
  }));
}

/**
 * 2026-10-18: 既定は中身の指紋（scripts/lib/exam-db-fp.ts・試験が実際に読む行の中身だけ・時刻は入れない）。EXAM_DB_FP=fine＝上の旧の指紋。
 *   段が見る部分の名前は形で違う（中身＝「表#b／表#d」・旧＝表の名前）＝形を替えると鍵も替わる（混ざらない）
 */
export async function readDbFingerprintFor(sb: SupabaseClient, mode: DbFpMode = dbFpMode()): Promise<DbPart[]> {
  return mode === "fine" ? readDbFingerprint(sb) : readDbContentFingerprint(sb);
}
/** o.rent=false＝相場の材料を読まない問題（中身の形だけ・exam-db-fp.ts problemReadsRent） */
export function dbPartsOf(stage: "brain" | "draft", mode: DbFpMode = dbFpMode(), o: { rent?: boolean } = {}): string[] {
  return mode === "fine" ? dbTablesOf(stage) : contentPartsOf(stage, dbContentReads(), o);
}

// ─── 6. 使い回しの置き場 ───────────────────────────────────────────────
export type ReuseEntry = { id: string; key: string; savedAt: string; label: string; stage: "brain" | "draft"; model: string; rows: RowLite[] };
const safeId = (id: string) => /^[\w-]+$/.test(id) ? id : null;
export function readReuse(id: string, key: string, dir = REUSE_DIR): ReuseEntry | null {
  const s = safeId(id); if (!s) return null;
  const f = join(dir, s, `${key}.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")) as ReuseEntry; } catch { return null; }
}
export function writeReuse(e: ReuseEntry, dir = REUSE_DIR): void {
  const s = safeId(e.id); if (!s) return;
  atomicWriteJson(join(dir, s, `${e.key}.json`), e);
}

// ─── 9. 台帳 ─────────────────────────────────────────────────────────
export type LedgerLine = {
  at: string; label: string; id: string; type: string; stage: "brain" | "draft"; model: string; head: string; scopeKey: string; base: string | null;
  reps: number; codes: string[]; pathOk: boolean; pass: boolean; cmp: string; cmpWhy: string; flake: string; reused: boolean;
  /** 揺れか本当の変化か（前と違った問題だけ）: real＝確かめの回でも同じ向き／flake＝揺れる問題・回で割れた／unconfirmed＝1回だけ */
  verdict?: "real" | "flake" | "unconfirmed" | null;
  /** 2026-10-21 既定と違うスイッチ（NAME=値,…）。無い＝既定 */
  envFp?: string;
};
export function appendLedger(lines: LedgerLine[], file = LEDGER_FILE): void {
  if (!lines.length) return;
  mkdirSync(EXAM_BRAIN_DIR, { recursive: true });
  appendFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
export function readLedger(file = LEDGER_FILE): LedgerLine[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as LedgerLine]; } catch { return []; } });
}

// ─── 結果のファイル ─────────────────────────────────────────────────────
export function readRows(label: string, cwd = "."): Array<RowLite & Record<string, unknown>> {
  const f = join(cwd, RESULTS_DIR, `${label}.jsonl`);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}
export function readCost(label: string, cwd = "."): { realUsd: number; real: number; replayed: number; judgeUsd: number; judgeCalls: number } | null {
  const f = join(cwd, RESULTS_DIR, `${label}.cost.json`);
  if (!existsSync(f)) return null;
  try {
    const c = JSON.parse(readFileSync(f, "utf8")) as { total?: { realUsd?: number; real?: number; replayed?: number }; judge?: { usd?: number; calls?: number } };
    return { realUsd: c.total?.realUsd ?? 0, real: c.total?.real ?? 0, replayed: c.total?.replayed ?? 0, judgeUsd: c.judge?.usd ?? 0, judgeCalls: c.judge?.calls ?? 0 };
  } catch { return null; }
}

// ─── 毎日拾った弱い所（scripts/edited-turn-miner.ts の weak-spots.json） ──────────
/** 一番新しい弱い所の候補の知見に紐付く問題（固定の紐付け＋近さ 0.6 以上の上位2問・竹内さんの番がある所か数3以上だけ・最大 max 問） */
export function weakSpotProblems(links: Record<string, Array<{ kbId: string; kind: string; score: number }>>, o: { dir?: string; max?: number } = {}): Record<string, string[]> {
  const dir = o.dir ?? join(examCacheRoot(), "edited-turns");
  if (!existsSync(dir)) return {};
  const days = readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const last = days[days.length - 1];
  if (!last) return {};
  let spots: Array<{ kb?: string[]; n?: number; takeuchi?: number }> = [];
  try { spots = (JSON.parse(readFileSync(join(dir, last, "weak-spots.json"), "utf8")) as { spots?: typeof spots }).spots ?? []; } catch { return {}; }
  const out: Record<string, string[]> = {};
  const max = o.max ?? 8;
  for (const s of spots.filter((x) => (x.takeuchi ?? 0) > 0 || (x.n ?? 0) >= 3)) {
    for (const kb of s.kb ?? []) {
      const cand = Object.entries(links).flatMap(([pid, ls]) => ls.filter((l) => l.kbId.startsWith(kb) && (l.kind === "fixed" || l.score >= 0.6)).map((l) => ({ pid, score: l.kind === "fixed" ? 2 : l.score })))
        .sort((a, b) => b.score - a.score).slice(0, 2);
      for (const c of cand) { if (Object.keys(out).length >= max && !out[c.pid]) continue; out[c.pid] = [...new Set([...(out[c.pid] ?? []), kb])]; }
    }
  }
  return out;
}

// ─── 10/17 ① 小さな確かめの記録（同じ版の小さな確かめが通ったら次は仕上げ） ───────────────
export const PHASE_LOG_FILE = join(EXAM_BRAIN_DIR, "phase-log.jsonl");
export function readPhaseLog(file = PHASE_LOG_FILE): SmallRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as SmallRecord]; } catch { return []; } });
}
export function appendPhaseLog(r: SmallRecord, file = PHASE_LOG_FILE): void { mkdirSync(EXAM_BRAIN_DIR, { recursive: true }); appendFileSync(file, JSON.stringify(r) + "\n"); }

// ─── 10/17 ② 今日（JST）の試験の費用（試験 env＝env != production の DeepSeek＋Claude・読むだけ） ─────────
export async function readDailySpend(sb: SupabaseClient, now = new Date()): Promise<{ usd: number; rows: number; since: string }> {
  const { altUsageUsd, claudeUsageUsd } = await import("../../app/lib/llm-price");
  const since = jstDayStart(now).toISOString();
  let usd = 0, rows = 0;
  for (let from = 0; from < 200_000; from += 1000) {
    const { data, error } = await sb.from("llm_usage_logs").select("model,env,input_uncached,cache_read,cache_write,cache_write_5m,cache_write_1h,output_tokens,created_at").gte("created_at", since).neq("env", "production").order("created_at", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`llm_usage_logs が読めない: ${error.message}`);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const m = String(r.model ?? "");
      if (/claude/.test(m)) { usd += claudeUsageUsd(r as never); rows++; } else if (/deepseek/.test(m)) { usd += altUsageUsd(r as never); rows++; }
    }
    if (!data || data.length < 1000) break;
  }
  // 2026-10-18: DB に書かない LLM の費用（ブレインの自己点検 等・local-llm-spend.jsonl）も同じ1日の上限に数える
  try { const { readLocalSpendToday } = await import("./brain-self-review-io"); usd += readLocalSpendToday(now).usd; } catch { /* 読めない時は DB の分だけ */ }
  return { usd, rows, since };
}

// ─── 10/17 ③ 試験の会話の効く所（会話の違いが答えに効くか・読むだけ） ─────────────────────
async function readOneConvCtx(sb: SupabaseClient, name: string, id: string, pcId: string | null): Promise<ConvCtx> {
  try {
    const { data: conv, error: e1 } = await sb.from("conversations").select(["property_customer_id", ...CONV_CTX_FIELDS.conversations].join(",")).eq("id", id).maybeSingle();
    if (e1 || !conv) return { name, ok: false, conv: null, pc: null, gaps: {}, why: e1?.message ?? "会話の行が無い" };
    const pid = pcId || ((conv as unknown as Record<string, unknown>).property_customer_id as string | null);
    let pc: Record<string, unknown> | null = null;
    if (pid) { const r = await sb.from("property_customers").select(CONV_CTX_FIELDS.property_customers.join(",")).eq("id", pid).maybeSingle(); if (r.error) return { name, ok: false, conv: null, pc: null, gaps: {}, why: r.error.message }; pc = (r.data ?? null) as Record<string, unknown> | null; }
    const gaps: Record<string, number> = {};
    for (const t of CONV_CTX_FIELDS.gapTables) { const r = await sb.from(t).select("id", { count: "exact", head: true }).eq("conversation_id", id); if (r.error || r.count === null) return { name, ok: false, conv: null, pc: null, gaps: {}, why: `${t}: ${r.error?.message ?? "件数が読めない"}` }; gaps[t] = r.count; }
    const c = { ...(conv as unknown as Record<string, unknown>) }; delete c.property_customer_id;
    return { name, ok: true, conv: c, pc, gaps };
  } catch (e) { return { name, ok: false, conv: null, pc: null, gaps: {}, why: String(e instanceof Error ? e.message : e).slice(0, 120) }; }
}
/** 今の会話（--conv・無ければ YUMA）と試験の会話 YUMA2〜5 の効く所 */
export async function readConvContexts(sb: SupabaseClient, convName: string): Promise<{ cur: ConvCtx; all: ConvCtx[] }> {
  const all = await Promise.all(NO_LINE_TEST_CONVERSATIONS.map((c) => readOneConvCtx(sb, c.name, c.id, c.propertyCustomerId)));
  const n = (convName || "YUMA").trim().toUpperCase();
  const hit = all.find((c) => c.name === n);
  if (hit) return { cur: hit, all };
  const r = resolveExamConversation(n === "AUTO" ? "YUMA2" : n, { allowYuma: true });
  // --conv=auto は空いている会話を brain-exam が選ぶ＝どれになるか分からない → YUMA2〜5 が全部同じ時だけ "-"（convKeyOf で全部と比べる）
  const cur = r ? (all.find((c) => c.name === r.name) ?? await readOneConvCtx(sb, r.name, r.id, r.propertyCustomerId || null)) : { name: n, ok: false, conv: null, pc: null, gaps: {}, why: "試験の会話でない" };
  return { cur, all };
}

// ─── 4. 予約 ─────────────────────────────────────────────────────────
export type QueueItem = { label: string; argv: string[]; cwd: string; at: string; createdAt: string; estUsd: number };
// 2026-10-23 査読: 手で書いた予約の JSON で cwd の「\」が抜けた物（"C:Users竹内 悠馬sumora-ai-ui..."）が --run-queue で黙って捨てられていた。
//   予約は必ずこの enqueue で書く（JSON.stringify・cwd は path.resolve）。読めない予約は onBad で知らせる（黙って飛ばさない・消さない）
export function enqueue(q: QueueItem): string { const f = join(QUEUE_DIR, `${q.label.replace(/[^\w.-]/g, "_")}.json`); atomicWriteJson(f, { ...q, cwd: resolve(q.cwd) }, true); return f; }
export function readQueue(o: { onBad?: (file: string, why: string) => void } = {}): Array<QueueItem & { file: string }> {
  if (!existsSync(QUEUE_DIR)) return [];
  return readdirSync(QUEUE_DIR).filter((f) => f.endsWith(".json")).flatMap((f) => {
    const file = join(QUEUE_DIR, f);
    try {
      const q = JSON.parse(readFileSync(file, "utf8")) as Partial<QueueItem>;
      if (!q || typeof q.label !== "string" || !Array.isArray(q.argv) || typeof q.cwd !== "string" || typeof q.at !== "string") { o.onBad?.(file, "形が違う（label・argv・cwd・at が要る）"); return []; }
      return [{ ...q, createdAt: typeof q.createdAt === "string" ? q.createdAt : q.at, estUsd: Number(q.estUsd) || 0, file } as QueueItem & { file: string }];
    } catch (e) { o.onBad?.(file, `JSON が読めない: ${String(e instanceof Error ? e.message : e).slice(0, 100)}`); return []; }
  });
}
/** 予約の cwd が「\」の抜けた形（"C:Users..."＝ドライブの後に区切りが無い）か */
export const cwdLooksStripped = (cwd: string) => /^[A-Za-z]:[^\\/]/.test(cwd);
export function dequeue(file: string): void { try { unlinkSync(file); } catch { /* */ } }

// ─── 止まった実行の残りの片付け（試験の会話 YUMA* の bexam- 行だけ） ───────────────
export type CleanupPlan = {
  conv: { id: string; name: string; propertyCustomerId: string }; label: string; dir: string;
  pcBackup: { file: string; id: string; row: Record<string, unknown> } | null;
  ledger: { file: string; ids: Record<string, string[]> } | null;
  floor: { file: string; lock: string | null } | null;
  leaseLock: { file: string; pid: number | null; alive: boolean } | null;
  runAlive: boolean; runPid: number | null;
};
const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException)?.code === "EPERM"; } };
/** 試験の会話（YUMA2〜YUMA5・--allow-yuma の時だけ YUMA）を名前か id で */
export function resolveExamConversation(name: string, o: { allowYuma?: boolean } = {}): { id: string; name: string; propertyCustomerId: string } | null {
  const n = name.trim().toUpperCase();
  const c = NO_LINE_TEST_CONVERSATIONS.find((x) => x.name === n || x.id === name.trim());
  if (c) return { id: c.id, name: c.name, propertyCustomerId: c.propertyCustomerId };
  if (o.allowYuma && (n === "YUMA" || name.trim() === YUMA_CONVERSATION_ID)) return { id: YUMA_CONVERSATION_ID, name: "YUMA", propertyCustomerId: "" };
  return null;
}
/** この会話の鍵を持つ生きている実行（全部の作業ツリーの scripts/.replay-out/.test-conv-<名>.lock） */
export function liveLeaseOf(name: string, extraDir?: string): { file: string; pid: number | null; alive: boolean } | null {
  let root = "";
  try { root = join(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim(), ".."); } catch { /* */ }
  const dirs = new Set<string>(extraDir ? [extraDir] : []);
  if (root) {
    dirs.add(join(root, "scripts", ".replay-out"));
    const wt = join(root, ".claude", "worktrees");
    if (existsSync(wt)) for (const d of readdirSync(wt)) dirs.add(join(wt, d, "scripts", ".replay-out"));
  }
  let seen: { file: string; pid: number | null; alive: boolean } | null = null;
  for (const d of dirs) {
    const f = join(d, `.test-conv-${name.toUpperCase()}.lock`);
    let t = ""; try { t = readFileSync(f, "utf8").trim(); } catch { continue; }
    if (!t) continue;
    let pid: number | null = null; try { pid = (JSON.parse(t) as { pid?: number }).pid ?? null; } catch { /* */ }
    const a = alive(pid);
    if (a) return { file: f, pid, alive: true };
    seen = seen ?? { file: f, pid, alive: false };
  }
  return seen;
}
/** 片付けの計画（読むだけ）。dir は止まった実行の作業ツリーの scripts/.replay-out */
export function planCleanup(convName: string, label: string, dir: string, o: { allowYuma?: boolean } = {}): CleanupPlan {
  const conv = resolveExamConversation(convName, o);
  if (!conv) throw new Error(`試験の会話ではない（YUMA2〜YUMA5 だけ）: ${convName}`);
  const tag = conv.name.toLowerCase();
  const rd = (f: string) => { try { return readFileSync(f, "utf8").trim(); } catch { return ""; } };
  const pcF = join(dir, `.brain-exam-${label}-${tag}-pc-backup.json`);
  const pcT = rd(pcF);
  const pcBackup = pcT ? { file: pcF, ...(JSON.parse(pcT) as { id: string; row: Record<string, unknown> }) } : null;
  const ledF = join(dir, `.brain-exam-${label}-ledger-ids.json`);
  const ledT = rd(ledF);
  const ledIds = ledT ? JSON.parse(ledT) as Record<string, string[]> : {};
  const ledger = Object.values(ledIds).some((x) => x.length) ? { file: ledF, ids: ledIds } : null;
  const floorF = join(dir, `brain-exam-floor-${label}-${tag}.json`);
  const lockT = rd(`${floorF}.lock`);
  const runPid = lockT ? (JSON.parse(lockT) as { pid?: number }).pid ?? null : null;
  const floor = existsSync(floorF) ? { file: floorF, lock: lockT ? `${floorF}.lock` : null } : null;
  // 鍵は作業ツリーごとの scripts/.replay-out にある＝全部の作業ツリーを見る（どこかの生きている実行がこの会話を使っていれば通は消さない）
  const leaseLock = liveLeaseOf(conv.name, dir);
  return { conv, label, dir, pcBackup, ledger, floor, leaseLock, runAlive: alive(runPid), runPid };
}
/** 片付けを流す（apply=false は数えるだけ）。本番の会話には触らない: 会話は試験の会話だけ・条件の行は会話の行の id と同じ時だけ・台帳と通は conversation_id で絞る */
export async function runCleanup(sb: SupabaseClient, pl: CleanupPlan, apply: boolean, log: (s: string) => void = console.log): Promise<{ messages: number; ledger: Record<string, number>; pc: boolean }> {
  if (pl.runAlive) throw new Error(`止まった実行がまだ生きている（pid ${pl.runPid}）→ 片付けない`);
  const out = { messages: 0, ledger: {} as Record<string, number>, pc: false };
  const { data: convRow } = await sb.from("conversations").select("id, property_customer_id").eq("id", pl.conv.id).maybeSingle();
  if (!convRow) throw new Error(`会話 ${pl.conv.name} が DB に無い`);
  // ① 条件の行（控えの id が会話の行の id と同じ時だけ戻す）
  // 2026-10-17 確かめる人: 止まった実行の線の鍵が無くても、他の生きている実行がこの会話を使っていれば条件の行は戻さない（その実行の写しを上書きする）
  if (pl.pcBackup && pl.leaseLock?.alive) log(`  ⚠ ${pl.conv.name} を他の実行（pid ${pl.leaseLock.pid}）が使っている → 条件の行は戻さない（止まってから片付け直す）`);
  else if (pl.pcBackup) {
    if (pl.pcBackup.id !== convRow.property_customer_id) throw new Error(`条件の行の控えの id（${pl.pcBackup.id}）が ${pl.conv.name} の行（${convRow.property_customer_id}）と違う → 戻さない`);
    log(`  条件の行 ${pl.pcBackup.id.slice(0, 8)}: 控えの ${Object.keys(pl.pcBackup.row).length}欄 を戻す`);
    if (apply) {
      const r = await sb.from("property_customers").update(pl.pcBackup.row).eq("id", pl.pcBackup.id);
      if (r.error) throw new Error(`条件の行を戻せない: ${r.error.message}`);
      atomicWriteText(pl.pcBackup.file, "");
      out.pc = true;
    }
  }
  // ② 台帳の写し（自分の id かつ この会話の行だけ）
  if (pl.ledger) {
    const left: Record<string, string[]> = {};
    for (const [t, ids] of Object.entries(pl.ledger.ids)) {
      if (!ids.length) continue;
      const { data } = await sb.from(t).select("id").in("id", ids).eq("conversation_id", pl.conv.id);
      const hit = ((data ?? []) as Array<{ id: string | number }>).map((x) => String(x.id));
      out.ledger[t] = hit.length;
      log(`  台帳 ${t}: 控え ${ids.length}・この会話の行 ${hit.length} を消す`);
      if (apply && hit.length) { const r = await sb.from(t).delete().in("id", hit).eq("conversation_id", pl.conv.id); if (r.error) { log(`  ⛔ ${t}: ${r.error.message}`); left[t] = ids; } }
    }
    if (apply) atomicWriteText(pl.ledger.file, JSON.stringify(left));
  }
  // ③ 試験の通（bexam- の印の行だけ）。他の実行がこの会話の鍵を持っていれば消さない
  if (pl.leaseLock?.alive) log(`  ⚠ ${pl.conv.name} を他の実行（pid ${pl.leaseLock.pid}）が使っている → 通は消さない`);
  else {
    const { count } = await sb.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", pl.conv.id).like("line_message_id", "bexam-%");
    out.messages = count ?? 0;
    log(`  ${pl.conv.name} の試験の通（line_message_id が bexam-）: ${out.messages}通 を消す`);
    if (apply && out.messages) {
      const r = await sb.from("messages").delete().eq("conversation_id", pl.conv.id).like("line_message_id", "bexam-%");
      if (r.error) throw new Error(`通を消せない: ${r.error.message}`);
    }
  }
  // ④ 線のファイル・鍵（空にする＝次の実行が読まない）
  if (pl.floor && apply) { atomicWriteText(pl.floor.file, "{}"); if (pl.floor.lock) atomicWriteText(pl.floor.lock, ""); }
  return out;
}

// ─── 10/20 COST① main の取り置きの記録 ─────────────────────────────────────────
export const WARM_LOG_FILE = join(EXAM_BRAIN_DIR, "warm-log.json");
export function readWarmLog(file = WARM_LOG_FILE): WarmLog { try { return JSON.parse(readFileSync(file, "utf8")) as WarmLog; } catch { return {}; } }
export function writeWarmLog(vk: string, e: WarmLog[string], file = WARM_LOG_FILE): void {
  mkdirSync(EXAM_BRAIN_DIR, { recursive: true });
  updateJsonFile<WarmLog>(file, () => ({}), (cur) => ({ ...cur, [vk]: e }));
}
