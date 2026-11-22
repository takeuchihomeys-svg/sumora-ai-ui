// scripts/lib/promise-ledger-metrics.ts — 行動台帳（sent_facts）の約束の、開いている数・期日超え・72時間で果たした割合（純関数・LLM なし・DB なし）
//
// 2026-11-23 作業員L（台帳 #519・統括役の頼み・土台「約束」の本番の数字）
//   約束 … status=promised で PROMISE_OF_DONE にある種類（確認・物件のピックアップ・見積）
//   閉じた … detail.closed_by がある（promise-close-link が結んだ）か、後に同じ種類の done の行がある
//   期日 … promise-drop-watch.promiseDeadlineMs（文の期限の言葉・無ければ72時間・「出来次第」は期限にしない）
//   数の名前（作業員N と決めた: foundation:promise:*・found: は作業員P の地図の土台の葉の形なので使わない）: foundation:promise:open（開いている約束の数）・foundation:promise:overdue_rate（開いている約束のうち期日超えの %）
//     ・foundation:promise:kept_72h（72〜144時間前にした約束のうち、72時間の内に閉じた %）
import { PROMISE_OF_DONE } from "../../app/lib/promise-close-link";
import { promiseDeadlineMs } from "../../app/lib/promise-drop-watch";

export type FactRow = { conversation_id: string; kind: string; status: string; sent_at: string; evidence?: string | null; detail?: { closed_by?: unknown; sentence?: string } | null };
const DONE_OF: Record<string, string> = Object.fromEntries(Object.entries(PROMISE_OF_DONE).map(([done, p]) => [p, done]));
const H = 36e5;

export type PromiseState = { conv: string; kind: string; at: string; closedAt: string | null; deadlineMs: number };
/** 会話ごとの行 → 約束ごとの状態 */
export function promiseStatesOf(rows: ReadonlyArray<FactRow>): PromiseState[] {
  const byConv = new Map<string, FactRow[]>();
  for (const r of rows) byConv.set(r.conversation_id, [...(byConv.get(r.conversation_id) ?? []), r]);
  const out: PromiseState[] = [];
  for (const [conv, rs] of byConv) {
    const sorted = [...rs].sort((a, b) => a.sent_at.localeCompare(b.sent_at));
    for (const p of sorted) {
      if (p.status !== "promised" || !DONE_OF[p.kind]) continue;
      const done = sorted.find((d) => d.status === "done" && d.kind === DONE_OF[p.kind] && d.sent_at > p.sent_at);
      const closedAt = p.detail?.closed_by ? (done?.sent_at ?? p.sent_at) : done?.sent_at ?? null;
      const text = String(p.detail?.sentence ?? p.evidence ?? "");
      out.push({ conv, kind: p.kind, at: p.sent_at, closedAt, deadlineMs: promiseDeadlineMs(text, Date.parse(p.sent_at)).ms });
    }
  }
  return out;
}

export type PromiseLedgerSummary = { open: number; overdue: number; madeWindow: number; keptWindow: number };
/** 今開いている約束・期日超え・72〜144時間前にした約束のうち72時間の内に閉じた数 */
export function summarizePromises(ps: ReadonlyArray<PromiseState>, nowMs: number): PromiseLedgerSummary {
  const open = ps.filter((p) => !p.closedAt);
  const overdue = open.filter((p) => nowMs > p.deadlineMs);
  const made = ps.filter((p) => { const t = Date.parse(p.at); return t <= nowMs - 72 * H && t > nowMs - 144 * H; });
  const kept = made.filter((p) => p.closedAt && Date.parse(p.closedAt) - Date.parse(p.at) <= 72 * H);
  return { open: open.length, overdue: overdue.length, madeWindow: made.length, keptWindow: kept.length };
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
/** quality_daily に書ける行（作業員N2 が書く） */
export function promiseMetricRows(s: PromiseLedgerSummary): Array<{ metric: string; scope: string; value: number | null; n: number; detail: Record<string, unknown> }> {
  return [
    { metric: "foundation:promise:open", scope: "all", value: s.open, n: s.open, detail: {} },
    { metric: "foundation:promise:overdue_rate", scope: "all", value: pct(s.overdue, s.open), n: s.open, detail: { overdue: s.overdue } },
    { metric: "foundation:promise:kept_72h", scope: "all", value: pct(s.keptWindow, s.madeWindow), n: s.madeWindow, detail: { kept: s.keptWindow } },
  ];
}
