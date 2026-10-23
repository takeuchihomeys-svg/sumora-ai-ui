// scripts/lib/exam-savings-io.ts — 節約の台帳（exam_savings）の材料を読む・見つけて書く・自動で戻すスイッチのファイル
//   読むだけ: llm_usage_logs（route script:brain-exam-*）・main の答えの置き場・台帳 ledger.jsonl・model-check.json・連携の帳簿。LLM なし・$0
//   書く: exam_savings（--write の時・試験の終わり）・owner_questions（質に関わる新しい案）・.claude/exam-cache/exam-brain/savings-auto.json
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SAFE_ACTIONS, applyAutoToEnv, detectSavings, externalFixNotes, planAutoApply, renderRunSavings, renderTopSavings, type AutoApplied, type AutoFile, type BaselineFileLite, type CoordEventLite,
  type LedgerLite, type ModelCheckLite, type SavingHit, type UsageRowLite,
} from "../../app/lib/exam-savings";
import { markAutoApplied, readOpenSavings, upsertSavingHits } from "../../app/lib/exam-savings-server";
import { BASELINE_DIR } from "./brain-exam-baseline";
import { EXAM_BRAIN_DIR, LEDGER_FILE, MODEL_CHECK_FILE } from "./exam-brain-io";
import { examPeakAt, nextCheapStart, FLASH_TYPE_MIN_N } from "./exam-brain";
import { readCoordEvents } from "./exam-coord";

export const SAVINGS_AUTO_FILE = join(EXAM_BRAIN_DIR, "savings-auto.json");

// ─── 読む ─────────────────────────────────────────────────────────────────
export async function readUsageRows(sb: SupabaseClient, since: Date, until?: Date, labels?: ReadonlyArray<string>): Promise<UsageRowLite[]> {
  const { altUsageUsd } = await import("../../app/lib/llm-price");
  const out: UsageRowLite[] = [];
  const want = labels?.length ? new Set(labels.map((l) => `script:brain-exam-${l}`)) : null;
  for (let from = 0; from < 300_000; from += 1000) {
    let q = sb.from("llm_usage_logs").select("route,action,model,created_at,input_uncached,cache_read,cache_write,output_tokens,max_tokens").gte("created_at", since.toISOString());
    q = want ? q.in("route", [...want]) : q.like("route", "script:brain-exam-%"); // 1回の試験はその回の route だけ読む（並んで流れる他の回は読まない）
    if (until) q = q.lt("created_at", until.toISOString());
    const { data, error } = await q.order("created_at", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`llm_usage_logs が読めない: ${error.message}`);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const route = String(r.route ?? "");
      if (want && !want.has(route)) continue;
      const model = String(r.model ?? "");
      out.push({ route, action: (r.action as string | null) ?? null, model, created_at: String(r.created_at ?? ""), input_uncached: Number(r.input_uncached ?? 0), cache_read: Number(r.cache_read ?? 0),
        output_tokens: Number(r.output_tokens ?? 0), max_tokens: (r.max_tokens as number | null) ?? null, usd: /deepseek/.test(model) ? altUsageUsd(r as never) : 0 });
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

type BRow = { path?: { code?: string | null } | null; score?: { pass?: boolean } | null; inputSame?: boolean | null };
type BFile = { id?: string; savedAt?: string; rows?: BRow[]; cost?: { real?: number; realUsd?: number } | null; pinnedFrom?: string | null };
const answerSig = (rows: ReadonlyArray<BRow>) => rows.map((r) => `${r.path?.code ?? ""}|${r.score?.pass ? 1 : 0}`).sort().join(";");
/** 前の版と答えが同じか（道の型・合否の並び。回の数が違えば前の多い方を同じ数だけ見る） */
export function sameAnswers(cur: ReadonlyArray<BRow>, prev: ReadonlyArray<BRow>): boolean | null {
  if (!cur.length || !prev.length) return null;
  const a = answerSig(cur), b = answerSig(prev);
  if (a === b) return true;
  const ca = new Set(cur.map((r) => r.path?.code ?? "")), pa = new Set(prev.map((r) => r.path?.code ?? ""));
  return ca.size === 1 && pa.size === 1 && [...ca][0] === [...pa][0] && cur.every((r) => !!r.score?.pass) === prev.every((r) => !!r.score?.pass) ? true : false;
}
/** main の答えの置き場で since 以降に書かれた問題ファイル（mtime で先に絞る） */
export function readBaselineSince(since: Date, dir = BASELINE_DIR): BaselineFileLite[] {
  const out: BaselineFileLite[] = [];
  let vs: string[] = [];
  try { vs = readdirSync(dir).filter((d) => d.startsWith("v-")); } catch { return out; }
  for (const v of vs) {
    const vd = join(dir, v);
    let names: string[] = [];
    try { if (statSync(vd).mtimeMs < since.getTime()) continue; names = readdirSync(vd).filter((f) => /^q.*\.json$/.test(f)); } catch { continue; }
    for (const n of names) {
      const f = join(vd, n);
      try {
        if (statSync(f).mtimeMs < since.getTime()) continue;
        const j = JSON.parse(readFileSync(f, "utf8")) as BFile;
        if (!j.savedAt || Date.parse(j.savedAt) < since.getTime()) continue;
        const rows = j.rows ?? [];
        let same: boolean | null = null;
        if (j.pinnedFrom) { try { same = sameAnswers(rows, (JSON.parse(readFileSync(join(dir, j.pinnedFrom, n), "utf8")) as BFile).rows ?? []); } catch { same = null; } }
        out.push({ version: v, id: j.id ?? n.replace(/\.json$/, ""), savedAt: j.savedAt, realUsd: Number(j.cost?.realUsd ?? 0), realCalls: Number(j.cost?.real ?? 0), pinnedFrom: j.pinnedFrom ?? null,
          sameAnswersAsPrev: same, allInputSame: rows.length > 0 && rows.every((r) => r.inputSame === true) });
      } catch { /* 読めないファイルは飛ばす */ }
    }
  }
  return out;
}
export function readLedgerSince(since: Date, labels?: ReadonlyArray<string>, file = LEDGER_FILE): LedgerLite[] {
  if (!existsSync(file)) return [];
  const want = labels?.length ? new Set(labels) : null;
  const t = since.getTime();
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { const x = JSON.parse(l) as LedgerLite; return Date.parse(x.at) >= t && (!want || want.has(x.label)) ? [x] : []; } catch { return []; }
  });
}
export function readModelCheckByType(file = MODEL_CHECK_FILE): ModelCheckLite {
  try { return ((JSON.parse(readFileSync(file, "utf8")) as { byType?: ModelCheckLite }).byType) ?? {}; } catch { return {}; }
}
/** ソース（試験の道具）にスイッチの名前があるか＝他の担当のスイッチが入ったか */
let srcMemo: string | null = null;
export function switchAvailable(name: string, root = process.cwd()): boolean {
  if (srcMemo === null) {
    const files = ["scripts/exam-brain.ts", "scripts/brain-exam.ts", ...(() => { try { return readdirSync(join(root, "scripts/lib")).filter((f) => f.endsWith(".ts") && !f.startsWith("exam-savings")).map((f) => `scripts/lib/${f}`); } catch { return []; } })()];
    srcMemo = files.map((f) => { try { return readFileSync(join(root, f), "utf8"); } catch { return ""; } }).join("\n");
  }
  return srcMemo.includes(name);
}

// ─── 自動で戻すスイッチ ──────────────────────────────────────────────────
export function readAutoFile(file = SAVINGS_AUTO_FILE): AutoFile {
  try { const j = JSON.parse(readFileSync(file, "utf8")) as AutoFile; return { applied: Array.isArray(j.applied) ? j.applied : [] }; } catch { return { applied: [] }; }
}
export function writeAutoFile(f: AutoFile, file = SAVINGS_AUTO_FILE): void { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, JSON.stringify(f, null, 1)); }
/** この回で人が決めたスイッチ（試験の終わりの「次から戻す」の対象からも外す） */
let startExplicit: Set<string> = new Set();
/** .env.local（--env-file）の KEY=値。読めない時は null（＝env は全部人が決めた扱い） */
export function readEnvFileValues(file = join(process.cwd(), ".env.local")): Record<string, string> | null {
  try {
    const out: Record<string, string> = {};
    for (const l of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l);
      if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
    return out;
  } catch { return null; }
}
/**
 * 人が決めた名前: 引数（--switch=・--input-diff= 等）＋ env にあって .env.local の値と違う（シェル・予約の子から渡した）スイッチ。
 *   査読 10/23: 自動で戻すのは .env.local に置き忘れた off だけ。シェルで EXAM_X=off と付けた回（on/off の比べ等）は触らない
 */
export function explicitSavingSwitches(env: Record<string, string | undefined>, argNames: ReadonlySet<string>, fileVals: Record<string, string> | null): Set<string> {
  const out = new Set(argNames);
  for (const a of SAFE_ACTIONS) { const v = env[a.env]; if (v === undefined) continue; if (!fileVals || fileVals[a.env] !== v) out.add(a.env); }
  return out;
}
/** 試験の始まり: 自動で戻すスイッチを env に当てる（人が引数・シェルで決めた名前は触らない） */
export function applySavingsAutoAtStart(env: Record<string, string | undefined>, argNames: ReadonlySet<string>, file = SAVINGS_AUTO_FILE): string[] {
  startExplicit = explicitSavingSwitches(env, argNames, readEnvFileValues());
  if (!existsSync(file)) return [];
  return applyAutoToEnv(env, readAutoFile(file), startExplicit);
}

// ─── 見つけて書く ─────────────────────────────────────────────────────────
export type DetectOpts = { since: Date; until?: Date; labels?: string[]; env?: Record<string, string | undefined>; write: boolean; mode: "add" | "set"; onceLabel?: string; autoApply?: boolean; nowIso?: string };
export async function detectAndRecord(sb: SupabaseClient, o: DetectOpts): Promise<{ text: string; hits: SavingHit[]; auto: AutoApplied[] }> {
  const nowIso = o.nowIso ?? new Date().toISOString();
  const usage = await readUsageRows(sb, o.since, o.until, o.labels);
  const ledger = readLedgerSince(o.since, o.labels);
  const baseline = o.labels?.length ? [] : readBaselineSince(o.since); // 1回の試験では main の作り直しは別の回（main-）の route＝その日の数え直しで見る
  const coord: CoordEventLite[] = readCoordEvents(o.since);
  const hits = detectSavings({ usage, baseline, ledger, modelCheckByType: readModelCheckByType(), coord, env: o.env, isPeak: (d) => examPeakAt(d), nextCheap: (d) => nextCheapStart(d), flashTypeMinN: FLASH_TYPE_MIN_N, available: (n) => switchAvailable(n), at: nowIso });
  let auto: AutoApplied[] = [];
  const notes: string[] = [];
  if (o.autoApply && o.env) {
    const prev = readAutoFile();
    auto = planAutoApply(hits, o.env, prev, nowIso, (n) => switchAvailable(n), startExplicit);
    if (auto.length && o.write && (o.env.EXAM_SAVINGS_AUTO ?? "").trim().toLowerCase() !== "off") writeAutoFile({ applied: [...prev.applied, ...auto] });
    else if (auto.length) notes.push(o.write ? "（EXAM_SAVINGS_AUTO=off＝自動で戻さない）" : "（下見＝自動で戻さない）");
  }
  let rows: Awaited<ReturnType<typeof upsertSavingHits>>["written"] = [];
  if (o.write) {
    try {
      const r = await upsertSavingHits(sb, hits, { nowIso, mode: o.mode, onceLabel: o.onceLabel });
      rows = r.written;
      if (auto.length && (o.env?.EXAM_SAVINGS_AUTO ?? "").trim().toLowerCase() !== "off") await markAutoApplied(sb, auto);
      notes.push(r.skipped ? `（${r.skipped}）` : `（台帳に ${r.rows}行${r.questions ? `・竹内さんへの質問 ${r.questions}` : ""}）`);
    } catch (e) { notes.push(`（台帳に書けない: ${String(e instanceof Error ? e.message : e).slice(0, 160)}）`); }
  } else notes.push("（下見・書いていない: --write で書く）");
  for (const n of externalFixNotes(rows, (x) => switchAvailable(x))) notes.push(`
  ↳ ${n}`);
  return { text: `${renderRunSavings(hits, auto, rows)}${notes.length ? `\n  ${notes.join("")}` : ""}`, hits, auto };
}
export async function topOpenSavingsText(sb: SupabaseClient, n = 5): Promise<string> {
  try { return renderTopSavings(await readOpenSavings(sb), n); } catch (e) { return `節約の台帳が読めない: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`; }
}
