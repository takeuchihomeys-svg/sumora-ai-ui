// scripts/lib/exam-night.ts — 夜の試験の段取り（main の取り置きを差分だけ・予約を1本ずつ・古い鍵を脇へ）
//
// 2026-10-22 竹内さんの決まり「試験のブレインは見つけたら直す」（KB 08daffdd）。10/22 の夜の問題:
//   ・--warm-main が 166問を作り直して約 $5・約 11時間かかり、夜のタスク（SumoraExamNight・IgnoreNew）を塞いで比べの予約が遅れた。
//     しかも 0:29 に始めた取り置きの途中（2:19）で main が進み、作った答えは古い main の物になった（その後 444e108 でまた作り直し）
//   ・10/18 の止まった実行の条件の行の控え（.brain-exam-…-pc-backup.json）が残って、他の実行が待ち続けた
// ここは決め方（純関数）と、ファイルの読み書きの小さな口だけ。単体テスト scripts/lib/__tests__/exam-night.test.ts
import { existsSync, readdirSync, renameSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// ─── ① main の取り置きを差分だけ ─────────────────────────────────────────────
/** n 問ずつに分ける（間で時間・main の進み・上限を見る） */
export function chunksOf<T>(xs: T[], n: number): T[][] {
  const k = Math.max(1, Math.floor(n) || 1);
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += k) out.push(xs.slice(i, i + k));
  return out;
}
type PlanRow = { id: string; rep: number; error?: string; inputSame?: boolean };
/**
 * 下見（AI を呼ばない・前の main の答えの控えだけで新しい main の入力を組む）の結果から、問題を分ける。
 *   same＝全部の回の入力が前の main と同じで、答案が全部の回ぶんできた（その答えを新しい main の取り置きにする・呼ばない）
 *   changed＝どこかの回の入力が違う／控えが無い回がある／失敗した（本当に呼ぶ）
 */
export function splitByPlan(ids: string[], rows: PlanRow[], repsOf: (id: string) => number): { same: string[]; changed: string[] } {
  const same: string[] = [], changed: string[] = [];
  for (const id of ids) {
    const rs = rows.filter((r) => r.id === id);
    const want = Math.max(1, repsOf(id));
    const reps = new Set(rs.filter((r) => !r.error && r.inputSame).map((r) => r.rep));
    const ok = rs.length > 0 && !rs.some((r) => r.error || !r.inputSame) && [...Array(want).keys()].every((k) => reps.has(k + 1));
    (ok ? same : changed).push(id);
  }
  return { same, changed };
}
/** 次の塊を回してよいか（時間の予算・回す数の上限・main が進んだ） */
export function chunkGate(o: { startMs: number; nowMs: number; budgetMs: number | null; limitLeft: number | null; mainMoved: string | null }): { go: boolean; why: "budget" | "limit" | "main-moved" | null; text: string } {
  if (o.mainMoved) return { go: false, why: "main-moved", text: `main が進んだ（${o.mainMoved}）→ 古い main の答えを作り続けない` };
  if (o.budgetMs !== null && o.nowMs - o.startMs >= o.budgetMs) return { go: false, why: "budget", text: `時間の予算 ${Math.round(o.budgetMs / 60_000)}分を使い切った → 残りは次の回（間に他の予約を流す）` };
  if (o.limitLeft !== null && o.limitLeft <= 0) return { go: false, why: "limit", text: "回す数の上限（1日の上限の残り）に届いた → 残りは次の夜中" };
  return { go: true, why: null, text: "" };
}
/** 予算（分）の読み方: 空＝null（無し）・0 以下や off も無し */
export function budgetMsOf(v: string | undefined | null): number | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s || s === "off") return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n * 60_000 : null;
}
/**
 * 入力が違う問題を本当に回す見込み（$）: 前の main の答えの費用（回していたら・1回あたり）× 回す回数。無ければ1問1回 unit。
 *   費用の記録は「全部の回の合計」なので前の回数で割る
 */
export function estimateRunUsd(ids: string[], o: { prevCost: (id: string) => { usd: number; reps: number } | null; reps: (id: string) => number; unitUsd: number }): number {
  let s = 0;
  for (const id of ids) {
    const c = o.prevCost(id);
    const per = c && c.reps > 0 && c.usd > 0 ? c.usd / c.reps : o.unitUsd;
    s += per * Math.max(1, o.reps(id));
  }
  return s;
}

// ─── ⑤ 予約を1本ずつ（比べを先・取り置きは後で1本だけ） ─────────────────────────
export type QItem = { label: string; argv: string[]; at: string; createdAt: string; estUsd: number; cwd: string; file: string };
const isWarm = (x: QItem) => x.argv.includes("--warm-main");
/** 取り置きの中でも、版ごとの自動の物（--types・--stage を絞らない＝全部の問題の main の答え） */
const isWholeWarm = (x: QItem) => isWarm(x) && !x.argv.some((a) => /^--(types|stage|only)=/.test(a));
const vkOfWarm = (x: QItem) => x.argv.find((a) => a.startsWith("--warm-vk="))?.slice("--warm-vk=".length) ?? (/^warm-auto-([0-9a-f]+)$/.exec(x.label)?.[1] ?? null);
/**
 * 流す順: 比べ（取り置き以外）を先に作った順 → 取り置きは最後に1本だけ。
 *   取り置きは何本予約されていても子の中で「今の main」を作る（版の鍵はその時の origin/main から出す）＝同じ物を何本も流さない。
 *   今の main の版の物があればそれを、無ければ一番新しい物を残し、他は捨てる（理由を出す）。
 *   比べは自分の分の main の答えを自分で作る（同じ版の置き場に入る）＝後の取り置きはそれを使い回せる。
 */
export function orderQueue(due: QItem[], o: { currentVk: string | null }): { run: QItem[]; drop: Array<{ item: QItem; why: string }> } {
  const cmp = due.filter((x) => !isWarm(x)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const partWarm = due.filter((x) => isWarm(x) && !isWholeWarm(x)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const whole = due.filter(isWholeWarm);
  const drop: Array<{ item: QItem; why: string }> = [];
  let keep: QItem | null = null;
  if (whole.length) {
    keep = (o.currentVk ? whole.find((x) => vkOfWarm(x) === o.currentVk) : null) ?? [...whole].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    for (const x of whole) if (x !== keep) {
      const vk = vkOfWarm(x);
      drop.push({ item: x, why: vk && o.currentVk && vk !== o.currentVk ? `古い main の版（${vk}）の取り置き＝今の main は版 ${o.currentVk}（子は今の main を作るので ${keep.label} 1本で足りる）` : `同じ取り置きが他にもある（${keep.label} 1本で足りる）` });
    }
  }
  return { run: [...cmp, ...partWarm, ...(keep ? [keep] : [])], drop };
}
/** 予約1本の上限（分）: 取り置きは予算で自分で切るので長め・比べは既定 240分（EXAM_QUEUE_ITEM_MAX_MIN・off で無し） */
export function itemHardMs(env: Record<string, string | undefined>): number | null {
  const v = budgetMsOf(env.EXAM_QUEUE_ITEM_MAX_MIN ?? "240");
  return v;
}
/** 夜の1回の上限（分）: 過ぎたら次の予約は始めない（次の回＝30分後のタスクが続きを流す）。既定 300分（EXAM_QUEUE_MAX_MIN・off で無し） */
export function queueTotalMs(env: Record<string, string | undefined>): number | null {
  return budgetMsOf(env.EXAM_QUEUE_MAX_MIN ?? "300");
}

// ─── ⑤ 古い鍵・控えを脇へ（消さない） ────────────────────────────────────────
/** 条件の行の控え（.brain-exam-<label>-<会話>-pc-backup.json）から label と pid を読む */
export function backupOwnerOf(name: string, body: string): { label: string | null; pid: number | null } {
  const m = /^\.brain-exam-(.+)-(yuma\d*|yuma)-pc-backup\.json$/i.exec(name);
  let pid: number | null = null;
  try { const j = JSON.parse(body) as { pid?: unknown }; if (typeof j.pid === "number" && j.pid > 0) pid = j.pid; } catch { /* 古い形（pid なし） */ }
  return { label: m ? m[1] : null, pid };
}
/**
 * 古い控えか: 空は対象外（使っていない印）。pid があって止まっていれば古い（10分より新しい物は書きかけの恐れで見送り）。
 *   pid が無い古い形は、N 時間（既定 6）より古く、同じ label の試験が動いていない時だけ古い。
 */
export function staleVerdict(o: { size: number; mtimeMs: number; nowMs: number; maxAgeMs: number; pid: number | null; pidAlive: (pid: number) => boolean; labelLive: boolean }): { stale: boolean; why: string } {
  if (o.size <= 0) return { stale: false, why: "空（使っていない）" };
  const ageMs = o.nowMs - o.mtimeMs, h = (ageMs / 3600_000).toFixed(1);
  if (o.pid !== null) {
    if (o.pidAlive(o.pid)) return { stale: false, why: `持ち主 pid ${o.pid} が動いている` };
    if (ageMs < 10 * 60_000) return { stale: false, why: "持ち主は止まったが10分以内（書きかけの恐れ）" };
    return { stale: true, why: `持ち主 pid ${o.pid} が止まっている（${h}時間前）` };
  }
  if (o.labelLive) return { stale: false, why: "同じ label の試験が動いている" };
  if (ageMs < o.maxAgeMs) return { stale: false, why: `${h}時間前（${(o.maxAgeMs / 3600_000).toFixed(0)}時間まで待つ）` };
  return { stale: true, why: `${h}時間前で、同じ label の試験が動いていない` };
}
export const staleNameOf = (file: string, now: Date) => `${file}.stale-${new Date(now.getTime() + 9 * 3600_000).toISOString().replace(/[-:T]/g, "").slice(0, 12)}`;
export function staleMaxAgeMs(env: Record<string, string | undefined>): number {
  const v = Number(String(env.EXAM_STALE_LOCK_HOURS ?? "").trim() || "6");
  return (Number.isFinite(v) && v > 0 ? v : 6) * 3600_000;
}
export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
/** 動いている試験の label（node の命令行の --label=…）。読めなければ null（＝安全側: pid の無い控えは脇へ寄せない） */
export function liveExamLabels(): Set<string> | null {
  try {
    const out = process.platform === "win32"
      ? execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.CommandLine }"], { stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }).toString()
      : execFileSync("ps", ["-eo", "args"], { stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).toString();
    const s = new Set<string>();
    for (const m of out.matchAll(/--label=("?)([^\s"]+)\1/g)) s.add(m[2]);
    return s;
  } catch { return null; }
}
/**
 * dirs の scripts/.replay-out にある古い控えを <名前>.stale-<JST の時刻> に寄せる（消さない・中身は残る）。寄せた物を返す。
 *   live: 動いている試験の label（呼ぶ側が1回だけ読んで渡す）。null＝読めない＝pid の無い古い形は寄せない
 */
export function sweepStaleBackups(dirs: string[], o: { now?: Date; env?: Record<string, string | undefined>; live?: Set<string> | null; alive?: (pid: number) => boolean; log?: (s: string) => void } = {}): string[] {
  const now = o.now ?? new Date(), env = o.env ?? process.env, maxAgeMs = staleMaxAgeMs(env), alive = o.alive ?? pidAlive, log = o.log ?? ((s: string) => console.warn(s));
  let live = o.live;
  const moved: string[] = [];
  for (const d of [...new Set(dirs)]) {
    if (!existsSync(d)) continue;
    let names: string[] = [];
    try { names = readdirSync(d).filter((n) => /^\.brain-exam-.+-pc-backup\.json$/.test(n)); } catch { continue; }
    for (const n of names) {
      const f = join(d, n);
      let size = 0, mtimeMs = 0, body = "";
      try { const st = statSync(f); size = st.size; mtimeMs = st.mtimeMs; if (size > 0) body = readFileSync(f, "utf8"); } catch { continue; }
      if (!body.trim()) continue;
      const own = backupOwnerOf(n, body);
      if (own.pid === null && live === undefined) live = liveExamLabels();
      const labelLive = own.pid === null ? (live === null || live === undefined ? true : !!own.label && live.has(own.label)) : false;
      const v = staleVerdict({ size, mtimeMs, nowMs: now.getTime(), maxAgeMs, pid: own.pid, pidAlive: alive, labelLive });
      if (!v.stale) continue;
      const to = staleNameOf(f, now);
      try { renameSync(f, to); moved.push(to); log(`🔓 古い条件の行の控えを脇へ寄せた（消していない）: ${f} → ${to}（${v.why}・中身は元の条件の行＝必要なら手で戻せる）`); }
      catch (e) { log(`  ⚠ 古い控えを寄せられない（${f}）: ${String(e).slice(0, 120)}`); }
    }
  }
  return moved;
}
