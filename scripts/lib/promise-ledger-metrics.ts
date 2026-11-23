// scripts/lib/promise-ledger-metrics.ts — 行動台帳（sent_facts）の約束の、開いている数・期日超え・72時間で果たした割合（純関数・LLM なし・DB なし）
//
// 2026-11-23 作業員L（台帳 #519・統括役の頼み・土台「約束」の本番の数字）
//   約束 … status=promised で PROMISE_OF_DONE にある種類（確認・物件のピックアップ・見積）
//   閉じた … detail.closed_by がある（promise-close-link が結んだ）か、後に同じ種類の done の行がある
//   期日 … promise-drop-watch.promiseDeadlineMs（文の期限の言葉・無ければ72時間・「出来次第」は期限にしない）
//   数の名前（作業員N と決めた: foundation:promise:*・found: は作業員P の地図の土台の葉の形なので使わない）: foundation:promise:open（開いている約束の数）・foundation:promise:overdue_rate（開いている約束のうち期日超えの %）
//     ・foundation:promise:kept_72h（72〜144時間前にした約束のうち、72時間の内に閉じた %）
import { PROMISE_OF_DONE } from "../../app/lib/promise-close-link";
import { promiseDueFromText } from "../../app/lib/promise-due-text";
import { confirmReportAnswers } from "../../app/lib/promise-calendar";
import { promiseDeadlineMs, promiseFulfilledBy, promiseClosedConversation, type PdMsg, type PdSent, type PromiseKindName } from "../../app/lib/promise-drop-watch";

export type FactRow = { conversation_id: string; kind: string; status: string; sent_at: string; evidence?: string | null; detail?: { closed_by?: unknown; sentence?: string; dueText?: string | null; object?: string | null; checkPattern?: string | null } | null };
const DONE_OF: Record<string, string> = Object.fromEntries(Object.entries(PROMISE_OF_DONE).map(([done, p]) => [p, done]));
const H = 36e5;

export type PromiseState = { conv: string; kind: string; at: string; closedAt: string | null; deadlineMs: number; text?: string; evidence?: string; closedBy?: string; excluded?: boolean };
/** 会話ごとの行 → 約束ごとの状態 */
// 2026-11-23 作業員L（台帳 #655）: 確認の約束を「後の確認の報告なら要件を問わず」閉じていた（7f73dc32「内覧可否」← 募集状況の報告・2cb0feb7「退去」← 入居時期の報告）。
//   o.confirmObject（既定 false＝今と同じ）の時は、確認の約束は要件の合う確認の報告でだけ閉じる（カレンダーと同じ照らし・promise-calendar.confirmReportAnswers）
export function promiseStatesOf(rows: ReadonlyArray<FactRow>, o: { confirmObject?: boolean } = {}): PromiseState[] {
  const byConv = new Map<string, FactRow[]>();
  for (const r of rows) byConv.set(r.conversation_id, [...(byConv.get(r.conversation_id) ?? []), r]);
  const out: PromiseState[] = [];
  for (const [conv, rs] of byConv) {
    const sorted = [...rs].sort((a, b) => a.sent_at.localeCompare(b.sent_at));
    for (const p of sorted) {
      if (p.status !== "promised" || !DONE_OF[p.kind]) continue;
      const done = sorted.find((d) => d.status === "done" && d.kind === DONE_OF[p.kind] && d.sent_at > p.sent_at
        && (!o.confirmObject || p.kind !== "confirmation_promised" || confirmReportAnswers(p.detail?.object, { object: d.detail?.object ?? null, checkPattern: d.detail?.checkPattern ?? null })));
      const closedAt = p.detail?.closed_by ? (done?.sent_at ?? p.sent_at) : done?.sent_at ?? null;
      const text = String(p.detail?.sentence ?? p.evidence ?? "");
      // 期日を読む文（dueText・LEDGER_PROMISE_DUE_TEXT=on の行だけ）があればそちらで（「12月17日に…」「12月中旬ごろになりましたら」を落とさない・2026-11-23 作業員L）
      const dl = p.detail?.dueText ? promiseDueFromText(p.detail.dueText, Date.parse(p.sent_at)).ms : promiseDeadlineMs(text, Date.parse(p.sent_at)).ms;
      out.push({ conv, kind: p.kind, at: p.sent_at, closedAt, deadlineMs: dl, text, evidence: String(p.evidence ?? "") });
    }
  }
  return out;
}

// ─── --wide-close（2026-11-23 作業員L・統括役が承認した②の直し・既定は使わない＝今の数と同じ・LLM なし） ───
//   期日超え 25件を1件ずつ見た時の「果たしている／数え方」12件を、会話の発言と送付から閉じる:
//   ・確認の約束 … 約束の見張り（promise-drop-watch.promiseFulfilledBy）の印に加え、こちらの手打ちの報告の言い回し
//                   （お待たせ致しました／確認(が)出来ました／許可をいただき／経過の報告「繋がらない」）
//   ・ピックアップ … お客様に届いた物件の送付（sent_properties・line_group は読む側で外す）と見張りの手打ちの印
//   ・見積 … 見張りの印に加え、確認の結果が「募集に出ていない」（会話の中で・物件の名前までは結ばない）
//   ・会話が閉じた … 見張りと同じ（申込以降・お客様が他で決めた・こちらが締めた）
//   ・「新着で募集に出次第」は期日の無い約束（開いたまま・期日超えに数えない）。「出来次第」は期日の言葉でないだけで期日はある（72時間）
export const WIDE_CHECK_REPORT_RE = /お待たせ(?:致し|いたし)ました|確認(?:が)?(?:出来|でき)ました|許可を(?:いただき|頂き)|繋がら(?:ない|ず)|つながら(?:ない|ず)/;
export const WIDE_NOT_LISTED_RE = /募集に出ていない|募集(?:が)?(?:終了|停止)(?:して|となって|になって|しており|でした)|募集中のお部屋(?:は)?ございませんでした/;
export { PROMISE_OPEN_ENDED_RE as WIDE_OPEN_ENDED_RE } from "../../app/lib/promise-drop-watch"; // 2026-11-23 #660: 見張り・B1 と同じ決め方（1か所に）
import { PROMISE_OPEN_ENDED_RE as WIDE_OPEN_ENDED_RE } from "../../app/lib/promise-drop-watch";
/** 約束の文そのものを「後の発言」に数えないための間（sent_facts の時刻と発言の時刻の差） */
const SELF_GAP_MS = 60_000;
const WATCH_KIND: Record<string, PromiseKindName> = { confirmation_promised: "check", pickup_declared: "pickup", estimate_declared: "estimate" };
export type WideEvidence = { status: string | null; msgs: ReadonlyArray<PdMsg>; sent: ReadonlyArray<PdSent> };
export type WideCloseReason = "watch" | "check_report" | "not_listed" | "closed_conv" | "open_ended";
/** 1つの開いている約束を、会話の発言・送付で閉じる（閉じなければ null・「出次第」は open_ended＝期日を無くす） */
export function wideCloseOf(p: PromiseState, ev: WideEvidence): { reason: WideCloseReason; at: string | null } | null {
  const k = WATCH_KIND[p.kind];
  if (!k) return null;
  const t0 = Date.parse(p.at) + SELF_GAP_MS;
  const after = (m: PdMsg) => Date.parse(m.created_at) > t0;
  const norm = (m: PdMsg) => String(m.text ?? "").normalize("NFKC");
  const f = promiseFulfilledBy({ at: new Date(t0).toISOString(), kind: k }, { msgs: ev.msgs, aix: [], sent: ev.sent });
  if (f && f !== "n/a") return { reason: "watch", at: f.at };
  if (k === "check") {
    const m = ev.msgs.find((x) => x.sender === "staff" && !x.is_aix_generated && after(x) && WIDE_CHECK_REPORT_RE.test(norm(x)));
    if (m) return { reason: "check_report", at: m.created_at };
  }
  if (k === "estimate") {
    const m = ev.msgs.find((x) => x.sender === "staff" && after(x) && WIDE_NOT_LISTED_RE.test(norm(x)));
    if (m) return { reason: "not_listed", at: m.created_at };
  }
  if (promiseClosedConversation(ev.status, ev.msgs, new Date(t0).toISOString())) return { reason: "closed_conv", at: null };
  if ([p.text, p.evidence].some((t) => WIDE_OPEN_ENDED_RE.test(String(t ?? "").normalize("NFKC")))) return { reason: "open_ended", at: null };
  return null;
}
/** 開いている約束に wideCloseOf を当てた写し（閉じた物は closedAt・closedBy、「出次第」は期日を無限に）と、理由ごとの数 */
export function widenPromiseStates(ps: ReadonlyArray<PromiseState>, evOf: (conv: string) => WideEvidence | undefined): { states: PromiseState[]; byReason: Record<WideCloseReason, number> } {
  const byReason: Record<WideCloseReason, number> = { watch: 0, check_report: 0, not_listed: 0, closed_conv: 0, open_ended: 0 };
  const states = ps.map((p) => {
    if (p.closedAt) return p;
    const ev = evOf(p.conv);
    const w = ev ? wideCloseOf(p, ev) : null;
    if (!w) return p;
    byReason[w.reason]++;
    if (w.reason === "open_ended") return { ...p, deadlineMs: Number.POSITIVE_INFINITY, closedBy: "open_ended" };
    // 会話が閉じた約束は数から外す（閉じた時刻が無い・72時間の内に果たした数に入れない）
    if (w.reason === "closed_conv") return { ...p, excluded: true, closedBy: w.reason };
    return { ...p, closedAt: w.at, closedBy: w.reason };
  });
  return { states, byReason };
}

export type PromiseLedgerSummary = { open: number; overdue: number; madeWindow: number; keptWindow: number };
/** 今開いている約束・期日超え・72〜144時間前にした約束のうち72時間の内に閉じた数 */
export function summarizePromises(all: ReadonlyArray<PromiseState>, nowMs: number): PromiseLedgerSummary {
  const ps = all.filter((p) => !p.excluded);
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
