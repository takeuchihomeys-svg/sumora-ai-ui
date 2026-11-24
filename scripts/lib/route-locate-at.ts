// scripts/lib/route-locate-at.ts — 番の時点（T）の申込までの地図の位置（audit-route-progress-takeuchi と backfill-apply-route で同じ当て方・純関数・DB/LLM なし）
// 2026-11-24 作業員A（#676）: audit-route-progress-takeuchi.ts の中から取り出した（中身は同じ）
import type { CustomerStateInput } from "../../app/lib/customer-state";
import { resolveCustomerState } from "../../app/lib/customer-state";
import { buildActionLedger } from "../../app/lib/action-ledger";
import { routeTypeOf } from "../../app/lib/brain-route-type";
import { isAckOnlyTurn } from "../../app/lib/ack-topic-scope";
import { sceneEvidenceForTurn } from "../../app/lib/brain-aix-feedback";
import { extractCircumstances, validCircumstances, holdFirstReason } from "../../app/lib/customer-circumstances";
import { locateApplyRoute, type ApplyRouteLocation } from "../../app/lib/apply-route-map";
import { matchSubstateOf } from "../../app/lib/turn-aims-after";
import { withRefinedNext, greetingSentTodayOf } from "../../app/lib/apply-route-next";
import { farMoveInTurn } from "../../app/lib/contact-promise";

export const POST_STATUSES = new Set(["applying", "application", "screening", "approved", "contract", "closed_won", "closed_lost"]);
const POST = POST_STATUSES;

export function cutAt(input: CustomerStateInput, t: number): CustomerStateInput {
  const le = (s: string | null | undefined) => !s || Date.parse(s) <= t;
  return {
    ...input, now: t,
    status: input.status && POST.has(input.status) ? null : input.status, isPostApply: null,
    messages: input.messages.filter((m) => le(m.createdAt)),
    aixRows: input.aixRows.filter((r) => le(r.sent_at ?? r.created_at)),
    recordedFacts: input.recordedFacts.filter((f) => le((f as { sent_at?: string | null }).sent_at ?? null)),
    // 2026-11-25 作業員A（#687・照らしの漏れ）: 番の時刻より後に「済み・流れた」に書き換わった予定は、番の時刻ではまだ予定（その日時が番より後なら scheduled に戻す）
    viewingHistory: input.viewingHistory.filter((v) => le(v.created_at ?? null)).map((v) => { const at = Date.parse(`${v.scheduled_date}T${String(v.scheduled_time ?? "23:59").slice(0, 5)}:00+09:00`); return Number.isFinite(at) && at > t && (v.status === "done" || v.status === "lapsed") ? { ...v, status: "scheduled", actual_date: null, viewing_report: null } : v; }),
    sentProperties: input.sentProperties.filter((s) => le(s.sent_at)),
    lineTasks: (input.lineTasks ?? []).filter((x) => le(x.created_at)),
    ledger: null,
  };
}

/** T（直前のお客様の連投の最後＋1秒）の地図の位置（audit-apply-route-map と同じ当て方） */
export function locateAt(input: CustomerStateInput, T: number, envV2: boolean, o: { farMoveIn?: boolean } = {}): { loc: ApplyRouteLocation; loc2: ApplyRouteLocation; loc3: ApplyRouteLocation; loc4: ApplyRouteLocation; rt: string | null; detail: string | null; turnText: string; sub1: string | null; sub2: string | null } {
  const cut = cutAt(input, T);
  const ledger = buildActionLedger({ recentAixRows: cut.aixRows, messages: cut.messages.map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.createdAt, isAix: m.isAix, lineMessageId: m.lineMessageId })), lineTasks: cut.lineTasks, recordedFacts: cut.recordedFacts, now: T });
  const state = resolveCustomerState({ ...cut, ledger });
  const newestFirst = [...cut.messages].reverse();
  const b: string[] = []; let img = false;
  for (const m of newestFirst) { if (m.sender !== "customer") break; const t = (m.text ?? "").trim(); if (/^\[画像\]/.test(t)) { img = true; continue; } if (t) b.push(t); }
  const turnText = b.reverse().join("\n");
  const prevStaff = newestFirst.find((m) => m.sender !== "customer")?.text ?? "";
  let ts = cut.messages.length; while (ts > 0 && cut.messages[ts - 1].sender === "customer") ts--;
  const turnStart = ts < cut.messages.length ? Date.parse(cut.messages[ts].createdAt) : T;
  const recentStaff: string[] = [];
  for (let j = ts - 1; j >= 0 && cut.messages[j].sender !== "customer"; j--) { if (turnStart - Date.parse(cut.messages[j].createdAt) > 72 * 3600_000) break; recentStaff.push(cut.messages[j].text ?? ""); }
  const scene = sceneEvidenceForTurn({ text: turnText, hasImage: img }, {
    sentPropertyCount: ledger.facts.propertiesSentCount,
    aixHistory: cut.aixRows.slice(-10).map((r) => ({ aix_type: r.aix_type, check_pattern: r.check_pattern ?? null })),
    recentMessages: cut.messages.slice(-15).map((m) => ({ sender: m.sender, text: m.text })),
  });
  const hold = holdFirstReason(validCircumstances(extractCircumstances(cut.messages.filter((m) => m.sender === "customer").map((m) => ({ text: m.text, createdAt: m.createdAt })), turnStart), T), T);
  const rt = routeTypeOf({ customerText: turnText, prevStaffText: prevStaff, ackOnly: !img && isAckOnlyTurn(turnText) });
  // 2026-11-23 #623（--far-move-in）: 入居時期が先を本番と同じ線（contact-promise.farMoveInTurn）で開く。条件の入居時期（property_customers.move_in_time）は
  //   今の値しか無く後から直した値が混ざるので渡さない（お客様の連投の言葉だけ＝本番より少し狭い）。月の言い方は番の時刻で読む
  const farMoveIn = o.farMoveIn ? !!farMoveInTurn({
    customerTurn: cut.messages.slice(ts).filter((m) => m.sender === "customer").map((m) => ({ text: m.text, at: m.createdAt })),
    conditionMoveIn: null, nowIso: new Date(T).toISOString(),
    staffHistory: cut.messages.slice(0, ts).filter((m) => m.sender !== "customer").reverse().map((m) => ({ text: m.text, at: m.createdAt })),
  }) : undefined;
  const loc = locateApplyRoute({ stage: state.stage, searching: state.searching, ledger: ledger.facts, routeType: rt, sceneId: scene?.scene ?? null, customerTurnText: turnText, recentStaffTexts: recentStaff, holdReason: hold, lastStaffAtIfStaffLast: null, nowMs: T, ...(farMoveIn !== undefined ? { farMoveIn } : {}) });
  void envV2;
  // 2026-11-23 #608: APPLY_ROUTE_NEXT_BY_TURN=on の時の次の一手（位置は同じ）
  const loc2 = withRefinedNext(loc, { routeType: rt, upcomingViewingYmd: state.upcomingViewing?.ymd ?? null, nowMs: T }, { APPLY_ROUTE_NEXT_BY_TURN: "on" });
  // 2026-11-23 作業員A: ④の段取りの後のお礼（APPLY_ROUTE_ACK_SETUP_NOT_TODAY=on）も当てた次の一手
  const loc3 = withRefinedNext(loc, { routeType: rt, upcomingViewingYmd: state.upcomingViewing?.ymd ?? null, nowMs: T }, { APPLY_ROUTE_NEXT_BY_TURN: "on", APPLY_ROUTE_ACK_SETUP_NOT_TODAY: "on" });
  // ②（APPLY_ROUTE_GREETING_SENT_SKIP=on）も足した次の一手（今日もう当日のご挨拶を送ったか＝番の時点の AIX の行）
  const loc4 = withRefinedNext(loc, { routeType: rt, upcomingViewingYmd: state.upcomingViewing?.ymd ?? null, greetingSentToday: greetingSentTodayOf(cut.aixRows, T), nowMs: T }, { APPLY_ROUTE_NEXT_BY_TURN: "on", APPLY_ROUTE_ACK_SETUP_NOT_TODAY: "on", APPLY_ROUTE_GREETING_SENT_SKIP: "on" });
  return { loc, loc2, loc3, loc4, rt, detail: state.stageDetail ?? null, turnText, sub1: matchSubstateOf(turnText, {})?.id ?? null, sub2: matchSubstateOf(turnText, { ROUTE_SUBSTATE_NET_V2: "on" })?.id ?? null };
}
