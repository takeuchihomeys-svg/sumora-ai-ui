// scripts/lib/brain-self-review-io.ts — ブレインの自己点検の読み書き（試験の台帳・答案・録音・毎日拾った弱い所・置き場・その日の費用）
//
// 決め方は scripts/lib/brain-self-review.ts（純関数）。ここは手元のファイルだけ（DB は入口で読むだけ）。
// 置き場（全部の作業ツリーで共有・.gitignore・伏せた文が入る）: <倉庫の根>/.claude/exam-cache/self-review/
//   <JST の日付>/explanations.jsonl … 1件ずつの説明（伏せた材料の抜粋は入れない・行番号と引用だけ）
//   <JST の日付>/proposals.json      … 束ねた直しの案（竹内さんに見せる元）
//   <JST の日付>/report.md・latest.md（根）… 竹内さんに見せる一覧
//   cassette-index.json               … 録音の索引（問題・回・名札・時刻だけ。中身は入れない）
// その日の費用: <倉庫の根>/.claude/exam-cache/local-llm-spend.jsonl（DB の llm_usage_logs に書かない LLM の費用。試験のブレインの1日の上限に足す）
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { examCacheRoot, DEFAULT_CASSETTE_DIR, type CassetteEntry } from "./llm-cassette";
import { atomicWriteJson } from "./exam-shared-file";
import { jstDayStart } from "./exam-brain";

export const SELF_REVIEW_DIR = join(examCacheRoot(), "self-review");
export const LOCAL_SPEND_FILE = join(examCacheRoot(), "local-llm-spend.jsonl");
export const jstDate = (ms = Date.now()) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

// ─── その日の費用（DB に書かない LLM の分） ───────────────────────────────
export type LocalSpend = { at: string; tool: string; usd: number; calls: number; model?: string; cacheHit?: number; cacheMiss?: number; out?: number; label?: string };
export function appendLocalSpend(s: LocalSpend, file = LOCAL_SPEND_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(s) + "\n");
}
/** 今日（JST）の DB の外の LLM の費用（tool ごとの和も） */
export function readLocalSpendToday(now = new Date(), file = LOCAL_SPEND_FILE): { usd: number; byTool: Record<string, number> } {
  if (!existsSync(file)) return { usd: 0, byTool: {} };
  const since = jstDayStart(now).getTime();
  let usd = 0; const byTool: Record<string, number> = {};
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try { const s = JSON.parse(l) as LocalSpend; if (Date.parse(s.at) >= since && Number.isFinite(s.usd)) { usd += s.usd; byTool[s.tool] = (byTool[s.tool] ?? 0) + s.usd; } } catch { /* 壊れた行は飛ばす */ }
  }
  return { usd, byTool };
}

// ─── 録音の索引（問題・回・名札・時刻） ─────────────────────────────────
export type CassetteIndexRow = { f: string; size: number; action: string | null; problem: string | null; rep: string | null; ats: string[]; draft: boolean; len: number };
export function buildCassetteIndex(dir = DEFAULT_CASSETTE_DIR, indexFile = join(SELF_REVIEW_DIR, "cassette-index.json")): CassetteIndexRow[] {
  const old = new Map<string, CassetteIndexRow>();
  if (existsSync(indexFile)) { try { for (const r of JSON.parse(readFileSync(indexFile, "utf8")) as CassetteIndexRow[]) old.set(r.f, r); } catch { /* 作り直す */ } }
  const out: CassetteIndexRow[] = [];
  if (!existsSync(dir)) return out;
  for (const sub of readdirSync(dir)) {
    const p = join(dir, sub);
    let files: string[] = [];
    try { if (!statSync(p).isDirectory()) continue; files = readdirSync(p).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      const rel = `${sub}/${f}`;
      let size = 0; try { size = statSync(join(p, f)).size; } catch { continue; }
      const o = old.get(rel);
      if (o && o.size === size) { out.push(o); continue; }
      try {
        const e = JSON.parse(readFileSync(join(p, f), "utf8")) as CassetteEntry;
        const draft = e.action === null && /"stream":true/.test(e.normBody) && e.normBody.length > 40_000;
        out.push({ f: rel, size, action: e.action, problem: e.tag?.problem ?? null, rep: e.tag?.rep ?? null, ats: (e.responses ?? []).map((r) => r.at), draft, len: e.normBody.length });
      } catch { /* 壊れた録音は飛ばす */ }
    }
  }
  atomicWriteJson(indexFile, out);
  return out;
}
/** 今の発言の判断（turn_contract を出す）は brain_fresh。無ければ全体の分析 brain_full */
const BRAIN_ACTIONS = ["brain_fresh", "brain_fresh_claude", "brain_full"];
/**
 * その回（問題・回）の答えを出した録音: 同じ回の札（tag.rep）の録音で、答えの時刻が row.at（＋2分）以前の一番新しい物。
 *   同じ要求を再生した回（--repeat の n 回目）は札が1回目のまま n 番目の答え＝札が違う録音は n 番目の答えの時刻で見る
 */
export function pickEntry(idx: ReadonlyArray<CassetteIndexRow>, o: { problem: string; rep: string | number | null; at: string; kind: "brain" | "draft" }): CassetteIndexRow | null {
  const lim = Date.parse(o.at) + 120_000;
  const rep = o.rep === null || o.rep === undefined ? null : String(o.rep);
  const acts: Array<string | null> = o.kind === "brain" ? BRAIN_ACTIONS : [null];
  for (const act of acts) {
    for (const pass of ["same", "other"] as const) {
      let best: CassetteIndexRow | null = null, bestT = -Infinity;
      for (const r of idx) {
        if (r.problem !== o.problem) continue;
        if (o.kind === "brain" ? r.action !== act : !r.draft) continue;
        const same = !rep || !r.rep || r.rep === rep;
        if ((pass === "same") !== same) continue;
        const a = same ? r.ats[0] : r.ats[Number(rep) - 1];
        if (!a) continue;
        const t = Date.parse(a);
        if (t <= lim && t > bestT) { bestT = t; best = r; }
      }
      if (best) return best;
    }
  }
  return null;
}
export function readCassette(rel: string, dir = DEFAULT_CASSETTE_DIR): CassetteEntry | null {
  try { return JSON.parse(readFileSync(join(dir, rel), "utf8")) as CassetteEntry; } catch { return null; }
}
/** 録音の要求 → 文（system と messages の text を順に。cache_control などは捨てる） */
export function requestText(e: CassetteEntry): { system: string; user: string } {
  let b: Record<string, unknown> = {};
  try { b = JSON.parse(e.normBody) as Record<string, unknown>; } catch { return { system: "", user: e.normBody }; }
  const textOf = (c: unknown): string => typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === "object" && "text" in x ? String((x as { text?: unknown }).text ?? "") : "")).join("\n") : "";
  const msgs = Array.isArray(b.messages) ? b.messages as Array<{ role?: string; content?: unknown }> : [];
  const sysMsgs = msgs.filter((m) => m.role === "system").map((m) => textOf(m.content));
  return { system: [textOf(b.system), ...sysMsgs].filter(Boolean).join("\n"), user: msgs.filter((m) => m.role !== "system").map((m) => textOf(m.content)).join("\n") };
}

// ─── 試験の答案（台帳・使い回しの置き場・作業ツリーの results） ──────────────────
export type Row = Record<string, unknown> & { id: string; rep?: number; label?: string; at?: string; score?: { pass?: boolean } };
export const repoRoot = () => resolve(examCacheRoot(), "..", "..");
/** label の答案のファイル（今の作業ツリー → 倉庫の根 → 他の作業ツリー の順で最初に見つかった物） */
export function findResultsFile(label: string, extraDirs: string[] = []): string | null {
  const root = repoRoot();
  const dirs = [...extraDirs, join(process.cwd(), "scripts/brain-exam/results"), join(root, "scripts/brain-exam/results")];
  const wt = join(root, ".claude", "worktrees");
  if (existsSync(wt)) for (const d of readdirSync(wt)) dirs.push(join(wt, d, "scripts/brain-exam/results"));
  for (const d of dirs) { const f = d.endsWith(".jsonl") ? d : join(d, `${label}.jsonl`); if (existsSync(f) && (d.endsWith(".jsonl") || f.endsWith(`${label}.jsonl`))) return f; }
  return null;
}
export function readRowsFile(f: string): Row[] {
  return readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Row]; } catch { return []; } });
}
/** 使い回しの置き場の答案（その label の物・無ければ一番新しい物） */
export function reuseRows(id: string, label: string | null, dir = join(examCacheRoot(), "exam-brain", "results")): Row[] {
  const d = join(dir, id);
  if (!/^[\w-]+$/.test(id) || !existsSync(d)) return [];
  const es = readdirSync(d).filter((f) => f.endsWith(".json")).flatMap((f) => { try { return [JSON.parse(readFileSync(join(d, f), "utf8")) as { label: string; savedAt: string; rows: Row[] }]; } catch { return []; } });
  const hit = es.find((e) => e.label === label) ?? es.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt))[0];
  return hit?.rows ?? [];
}

// ─── 毎日拾った弱い所 ─────────────────────────────────────────────────
export type Spot = { key: string; bucket: string; scene: string; type: string; typeJa: string; n: number; takeuchi: number; kb: string[]; examples: Array<{ convHash: string; at: string; sim: number; customer: string; draft: string; sent: string; llm: { kind: string; note: string } | null }> };
export function latestWeakSpots(dir = join(examCacheRoot(), "edited-turns")): { day: string; spots: Spot[] } | null {
  if (!existsSync(dir)) return null;
  const days = readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && existsSync(join(dir, d, "weak-spots.json"))).sort();
  const day = days[days.length - 1];
  if (!day) return null;
  try { return { day, spots: (JSON.parse(readFileSync(join(dir, day, "weak-spots.json"), "utf8")) as { spots?: Spot[] }).spots ?? [] }; } catch { return null; }
}

// ─── 置き場 ──────────────────────────────────────────────────────────
export function dayDir(day: string): string { const d = join(SELF_REVIEW_DIR, day); mkdirSync(d, { recursive: true }); return d; }
export function appendJsonl(file: string, rows: unknown[]): void { if (!rows.length) return; mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); }
export function readJsonl<T>(file: string): T[] { if (!existsSync(file)) return []; return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } }); }
