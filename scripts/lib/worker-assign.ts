// scripts/lib/worker-assign.ts — 朝の1枚の「作業員ごとの割り振り」（純関数・LLM なし・台帳 #473 の 作業員の割り振り）
// 2026-11-28 作業員L: self-improve は方針・外れ・組む・出すまで回していたが、組んだ物を誰が次に取るかが出ていなかった（統括役が毎回台帳を手で引いていた）。
//   選び方は統括役の決め（11/28）と同じ: 持ち主ごとに todo/building を priority の小さい順（同じなら building を先・古い id を先）。
//   併せて出す: 止まっている building（更新が3日より前）・次の手が空・持ち主が今いない名前のまま（currentOwnerOf で読み替えた先に数える）・
//   芯の直しの候補（coreFix の「→ 持ち主」）の宛先ごとの数。スイッチのある件は夜の試験が要る印（昼に渡すのはスイッチの無い件を先に）。
import { LIVE_WORKERS, currentOwnerOf } from "./live-owner";

export type AssignItem = { id: number; title: string | null; owner: string | null; stage: string; priority: number | null; updated_at: string | null; next_step: string | null; switch_name: string | null; blocker?: string | null };
export type WorkerPlan = {
  worker: string;
  open: number;
  next: AssignItem[];      // 次に取る順（上位）
  dayNext: AssignItem | null; // 昼に渡す1件（スイッチの無い・止め札の無い一番上）
  stale: AssignItem[];     // building なのに更新が3日より前
  noNext: number;          // 次の手が空
  renamed: number;         // 台帳の持ち主が今いない名前のまま
  coreFix: number;         // 芯の直しの候補の宛先
};
const STALE_MS = 3 * 86_400_000;
const OPEN = new Set(["todo", "building"]);

export function orderForPick(a: AssignItem, b: AssignItem): number {
  const pa = a.priority ?? 99, pb = b.priority ?? 99;
  if (pa !== pb) return pa - pb;
  if (a.stage !== b.stage) return a.stage === "building" ? -1 : 1;
  return a.id - b.id;
}

/** coreFix の行（「… → 作業員L」）から宛先を読む。読めなければ null */
export function coreFixOwner(line: string): string | null {
  const m = /→\s*(.+)$/.exec(line);
  if (!m) return null;
  return currentOwnerOf(m[1]);
}

export function workerPlans(items: readonly AssignItem[], coreFix: readonly string[], nowMs: number, top = 3): WorkerPlan[] {
  const workers = [...LIVE_WORKERS, "統括役"];
  const by = new Map<string, WorkerPlan>(workers.map((w) => [w, { worker: w, open: 0, next: [], dayNext: null, stale: [], noNext: 0, renamed: 0, coreFix: 0 }]));
  const all: Record<string, AssignItem[]> = {};
  for (const it of items) {
    if (!OPEN.has(it.stage)) continue;
    const raw = (it.owner ?? "").trim();
    const w = raw ? currentOwnerOf(raw) : "統括役";
    const p = by.get(w) ?? by.get("統括役")!;
    p.open++;
    (all[p.worker] ??= []).push(it);
    if (raw && !LIVE_WORKERS.includes(raw) && raw !== "統括役") p.renamed++;
    if (!(it.next_step ?? "").trim()) p.noNext++;
    if (it.stage === "building" && it.updated_at && nowMs - Date.parse(it.updated_at) > STALE_MS) p.stale.push(it);
  }
  for (const line of coreFix) { const w = coreFixOwner(line); const p = w ? by.get(w) : null; if (p) p.coreFix++; }
  for (const p of by.values()) {
    const sorted = (all[p.worker] ?? []).sort(orderForPick);
    p.next = sorted.slice(0, top);
    p.dayNext = sorted.find((x) => !x.switch_name && !(x.blocker ?? "").trim()) ?? null;
    p.stale.sort((a, b) => Date.parse(a.updated_at!) - Date.parse(b.updated_at!));
  }
  return [...by.values()].filter((p) => p.open || p.coreFix);
}

const short = (s: string | null, n = 40) => { const t = (s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const itemJa = (x: AssignItem) => `#${x.id}${x.stage === "building" ? "（building）" : ""}${x.switch_name ? "［夜の試験］" : ""} ${short(x.title)}`;

export function workerPlanLines(plans: readonly WorkerPlan[], nowMs: number): string[] {
  if (!plans.length) return [];
  const out = ["### 作業員ごとの割り振り（台帳 todo/building・priority の小さい順・LLM なし）"];
  for (const p of plans) {
    const flags = [p.stale.length ? `止まっている ${p.stale.length}` : "", p.noNext ? `次の手が空 ${p.noNext}` : "", p.renamed ? `持ち主が今いない名前 ${p.renamed}` : "", p.coreFix ? `芯の直しの宛先 ${p.coreFix}` : ""].filter(Boolean).join("・");
    out.push(`- ${p.worker}（開いている ${p.open}${flags ? `・${flags}` : ""}）`);
    if (p.next.length) out.push(`  - 次: ${p.next.map(itemJa).join(" ／ ")}`);
    if (p.dayNext && p.dayNext.id !== p.next[0]?.id) out.push(`  - 昼に渡すなら: ${itemJa(p.dayNext)}`);
    if (p.stale.length) out.push(`  - 止まっている: ${p.stale.slice(0, 3).map((x) => `#${x.id}（${Math.floor((nowMs - Date.parse(x.updated_at!)) / 86_400_000)}日）`).join("・")}`);
  }
  return out;
}
