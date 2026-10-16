// scripts/lib/exam-brain-io.ts — 試験のブレインの読み書き（問題・効くファイルの鍵・使い回しの置き場・台帳・予約・止まった実行の片付け）
//
// 2026-10-17 竹内さん 10/16「判断する所はブレインにまとめて、質を高く節約する」。決め方は scripts/lib/exam-brain.ts（純関数）、ここは手元のファイル・git・DB。
// 置き場（全部の作業ツリーで共有・.gitignore・答案に伏せた会話が入る）: <倉庫の根>/.claude/exam-cache/exam-brain/
//   results/<問題>/<鍵>.json … 問題ごとの今の結果（使い回し）／ledger.jsonl … 試験の台帳（問題×実行×版×前との比べ）／queue/<label>.json … 予約
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { examCacheRoot } from "./llm-cassette";
import { atomicWriteJson, atomicWriteText } from "./exam-shared-file";
import { BRAIN_ENTRIES, DRAFT_ENTRIES, TOOL_ENTRIES, reach, workingFiles } from "./exam-scope";
import { fillProblemsFromShared } from "./exam-problems-store";
import type { RowLite } from "./exam-brain";
import { NO_LINE_TEST_CONVERSATIONS, YUMA_CONVERSATION_ID } from "../../app/lib/test-conversations";

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

// ─── 4. 予約 ─────────────────────────────────────────────────────────
export type QueueItem = { label: string; argv: string[]; cwd: string; at: string; createdAt: string; estUsd: number };
export function enqueue(q: QueueItem): string { const f = join(QUEUE_DIR, `${q.label.replace(/[^\w.-]/g, "_")}.json`); atomicWriteJson(f, q, true); return f; }
export function readQueue(): Array<QueueItem & { file: string }> {
  if (!existsSync(QUEUE_DIR)) return [];
  return readdirSync(QUEUE_DIR).filter((f) => f.endsWith(".json")).flatMap((f) => { try { return [{ ...(JSON.parse(readFileSync(join(QUEUE_DIR, f), "utf8")) as QueueItem), file: join(QUEUE_DIR, f) }]; } catch { return []; } });
}
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
  if (pl.pcBackup) {
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
