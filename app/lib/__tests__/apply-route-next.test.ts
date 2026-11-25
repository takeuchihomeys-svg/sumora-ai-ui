// 申込までの地図の次の一手を番で選び直す（APPLY_ROUTE_NEXT_BY_TURN）と、番ごとの駅の記録（ROUTE_DIGEST）（作業員R 2026-11-23・台帳 #608）
// 実行: npx tsx app/lib/__tests__/apply-route-next.test.ts
import { greetingSentTodayOf } from "../apply-route-next";
import { applyRouteNextByTurnOn, refineRouteNextStep, withRefinedNext, daysUntilYmd, ROUTE_ORDER, routeDigestOn, routeDigestOf, lapsedViewingBranchOn, lapsedViewingOpens } from "../apply-route-next";
import { MAIN_ROUTE, locateApplyRoute, applyRouteBrainTextIfEnabled, ROUTE_NODES, buildApplyRouteBrainText, type ApplyRouteSignals } from "../apply-route-map";
import { brainDecisionDigestExtra } from "../brain-decision-ledger";
export {};
let passed = 0, failed = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`, extra ?? ""); } };
const ON = { APPLY_ROUTE_NEXT_BY_TURN: "on" };
const NOW = Date.parse("2026-10-20T03:00:00Z"); // JST 10/20 12:00
const base = (o: Partial<ApplyRouteSignals>): ApplyRouteSignals => ({ stage: "proposing", ledger: { propertiesSentCount: 3, pickupPromisedUnfulfilled: false, estimateSent: false, conditionAsked: true }, nowMs: NOW, ...o });

console.log("■ スイッチと順");
t("既定 off", !applyRouteNextByTurnOn({}) && applyRouteNextByTurnOn(ON) && !applyRouteNextByTurnOn({ APPLY_ROUTE_NEXT_BY_TURN: "off" }));
t("ROUTE_ORDER は MAIN_ROUTE と同じ", JSON.stringify(ROUTE_ORDER) === JSON.stringify(MAIN_ROUTE));
t("日数（JST）: 当日0・翌日1・前日-1・読めない null", daysUntilYmd("2026-10-20", NOW) === 0 && daysUntilYmd("2026-10-21", NOW) === 1 && daysUntilYmd("2026-10-19", NOW) === -1 && daysUntilYmd(null, NOW) === null && daysUntilYmd("10/20", NOW) === null);

console.log("■ off は1バイトも変えない");
for (const s of [base({ routeType: "cost_question" }), base({ stage: "viewing_scheduled", routeType: "other_question", upcomingViewingYmd: "2026-10-25" }), base({ routeType: "equipment_question" })]) {
  const a = applyRouteBrainTextIfEnabled(s, {}).text, b = applyRouteBrainTextIfEnabled(s, { APPLY_ROUTE_NEXT_BY_TURN: "off" }).text;
  const loc = locateApplyRoute(s);
  t(`off の文が今と同じ（${s.stage}/${s.routeType}）`, a === b && withRefinedNext(loc, { routeType: s.routeType }, {}) === loc);
}

console.log("■ ① 費用を聞かれた＝食いつき（f7ed2a87）");
{
  const loc = locateApplyRoute(base({ routeType: "cost_question" }));
  t("提案中の地図は確認の結果（今の表）", loc.node === "proposing" && loc.next?.aix[0] === "property_check_result");
  const r = refineRouteNextStep(loc, { routeType: "cost_question" });
  t("提案中の費用の問い→御見積書", r?.rule === "cost_estimate" && r.next.aix[0] === "estimate_sheet");
  const r2 = refineRouteNextStep(locateApplyRoute(base({ stage: "interested", routeType: "estimate_request" })), { routeType: "estimate_request" });
  t("気に入った物件ありの見積の依頼→御見積書", r2?.rule === "cost_estimate");
  t("費用でない問いは①に当たらない", refineRouteNextStep(loc, { routeType: "considering" }) === null);
}
console.log("■ ② 持ち込みの費用は確認が先（9de893ed）");
{
  const loc = locateApplyRoute(base({ routeType: "brought_property" }));
  t("持ち込みの分かれ道", loc.branch === "brought_property");
  const r = refineRouteNextStep({ ...loc }, { routeType: "cost_question" });
  t("持ち込み×費用→確認の結果と御見積書の2つ", r?.rule === "brought_cost" && r.next.aix.join() === "property_check_result,estimate_sheet");
}
console.log("■ ③ 審査の相談");
{
  const liked = locateApplyRoute(base({ stage: "interested", routeType: "screening_question" }));
  t("気に入った物件あり×審査の相談→申込のご案内が先", liked.branch === "screening_concern" && refineRouteNextStep(liked, { routeType: "screening_question" })?.next.aix[0] === "application_push");
  const early = locateApplyRoute(base({ stage: "searching", routeType: "screening_question", ledger: { propertiesSentCount: 0, pickupPromisedUnfulfilled: false, estimateSent: false, conditionAsked: true } }));
  t("物件がまだの審査の相談は今の表のまま", early.branch === "screening_concern" && refineRouteNextStep(early, { routeType: "screening_question" }) === null);
}
console.log("■ ④ 内覧予定の当日のご挨拶は内覧の日だけ");
{
  const loc = locateApplyRoute(base({ stage: "viewing_scheduled", routeType: "other_question" }));
  t("地図は当日のご挨拶（今の表）", loc.next?.aix[0] === "greeting_viewing");
  t("5日前の問い→返信（AIX なし）", refineRouteNextStep(loc, { routeType: "other_question", upcomingViewingYmd: "2026-10-25", nowMs: NOW })?.rule === "viewing_not_today");
  t("前日→今の表のまま", refineRouteNextStep(loc, { routeType: "ack_other", upcomingViewingYmd: "2026-10-21", nowMs: NOW }) === null);
  t("当日→今の表のまま", refineRouteNextStep(loc, { routeType: "ack_other", upcomingViewingYmd: "2026-10-20", nowMs: NOW }) === null);
  t("日が過ぎた→感想・再調整", refineRouteNextStep(loc, { routeType: "ack_other", upcomingViewingYmd: "2026-10-18", nowMs: NOW })?.rule === "viewing_passed");
  t("当日の連絡（着いた）は日が先でも今の表", refineRouteNextStep(loc, { routeType: "arrived", upcomingViewingYmd: "2026-10-25", nowMs: NOW }) === null);
  t("日が分からない→今の表のまま", refineRouteNextStep(loc, { routeType: "other_question", upcomingViewingYmd: null, nowMs: NOW }) === null);
  // 2026-11-23 作業員A: 段取りの後のお礼（APPLY_ROUTE_ACK_SETUP_NOT_TODAY・既定 off）
  const AS = { APPLY_ROUTE_ACK_SETUP_NOT_TODAY: "on" };
  const ack = (ymd: string, env?: Record<string, string>) => refineRouteNextStep(loc, { routeType: "ack_after_viewing_setup", upcomingViewingYmd: ymd, nowMs: NOW }, env);
  t("段取りの後のお礼は既定 off で今の表のまま（3日前でも）", ack("2026-10-23") === null && ack("2026-10-23", {}) === null);
  t("on: 2日以上前の段取りの後のお礼→受けだけ（AIX なし）", ack("2026-10-23", AS)?.rule === "ack_setup_not_today" && ack("2026-10-22", AS)?.next.aix.length === 0);
  t("on でも前日・当日・日が過ぎた・日が分からない番は今の表のまま", ack("2026-10-21", AS) === null && ack("2026-10-20", AS) === null && ack("2026-10-18", AS) === null && refineRouteNextStep(loc, { routeType: "ack_after_viewing_setup", upcomingViewingYmd: null, nowMs: NOW }, AS) === null);
  t("on でも段取りの後のお礼でない番は④のまま", refineRouteNextStep(loc, { routeType: "other_question", upcomingViewingYmd: "2026-10-25", nowMs: NOW }, AS)?.rule === "viewing_not_today");
  // ② 当日のご挨拶をもう送った（APPLY_ROUTE_GREETING_SENT_SKIP・既定 off）
  const GS = { APPLY_ROUTE_GREETING_SENT_SKIP: "on" };
  const today = (env?: Record<string, string>, sent = true, rt: string = "other_question") => refineRouteNextStep(loc, { routeType: rt as never, upcomingViewingYmd: "2026-10-20", greetingSentToday: sent, nowMs: NOW }, env);
  t("② 既定 off: 送った後の当日の問いも今の表のまま", today() === null && today({}) === null);
  t("② on: 今日もうご挨拶を送った当日の問い→ご挨拶を外す", today(GS)?.rule === "greeting_sent_today" && today(GS)?.next.aix.length === 0);
  t("② on でも送っていない・着いた連絡は今の表のまま", today(GS, false) === null && today(GS, true, "arrived") === null);
  t("② 送ったかの読み（JST の今日の greeting_viewing だけ）", greetingSentTodayOf([{ aix_type: "greeting_viewing", sent_at: "2026-10-19T23:30:00Z" }], NOW) && !greetingSentTodayOf([{ aix_type: "greeting_viewing", sent_at: "2026-10-19T14:00:00Z" }], NOW) && !greetingSentTodayOf([{ aix_type: "meeting_place", sent_at: "2026-10-20T01:00:00Z" }], NOW) && !greetingSentTodayOf([{ aix_type: "greeting_viewing", sent_at: "2026-10-20T05:00:00Z" }], NOW));
  t("withRefinedNext: APPLY_ROUTE_NEXT_BY_TURN が off なら細かいスイッチだけ on でも変えない", withRefinedNext(loc, { routeType: "ack_after_viewing_setup", upcomingViewingYmd: "2026-10-23", nowMs: NOW }, AS) === loc
    && withRefinedNext(loc, { routeType: "ack_after_viewing_setup", upcomingViewingYmd: "2026-10-23", nowMs: NOW }, { ...ON, ...AS }).evidence.includes("次の一手を番で選び直し:ack_setup_not_today"));
}
console.log("■ ⑤ 答えが先は入れない（監査で止めた・竹内さんは問いの番でも次の一手を置く）");
{
  const loc = locateApplyRoute(base({ stage: "viewing_arranging", routeType: "equipment_question" }));
  t("内覧調整×設備の問い→今の表のまま（内覧のご案内）", refineRouteNextStep(loc, { routeType: "equipment_question" }) === null && loc.next?.aix[0] === ROUTE_NODES.viewing_arrange.next.aix[0]);
  t("提案中×その他の問い→今の表のまま", refineRouteNextStep(locateApplyRoute(base({ routeType: "other_question" })), { routeType: "other_question" }) === null);
  t("内覧の段取りの後のお礼は5日前でも当日のご挨拶のまま", refineRouteNextStep(locateApplyRoute(base({ stage: "viewing_scheduled", routeType: "ack_after_viewing_setup" })), { routeType: "ack_after_viewing_setup", upcomingViewingYmd: "2026-10-25", nowMs: NOW }) === null);
}
console.log("■ on の文と根拠");
{
  const s = base({ routeType: "cost_question" });
  const on = applyRouteBrainTextIfEnabled(s, ON), off = applyRouteBrainTextIfEnabled(s, {});
  t("on の文は御見積書の候補", on.text.includes("estimate_sheet") && !off.text.includes("estimate_sheet") && on.text.length <= 600);
  t("on の根拠に選び直しの印", !!on.loc?.evidence.some((e) => e.startsWith("次の一手を番で選び直し:cost_estimate")));
  t("位置（駅・分かれ道）は変えない", on.loc?.node === off.loc?.node && on.loc?.branch === off.loc?.branch);
}
console.log("■ ROUTE_DIGEST（番ごとの駅の記録）");
{
  const meta = { apply_route: { node: "proposing", branch: "considering", next: "x", next_aix: [], substate: "proposing_considering" } };
  t("既定 on（=off で止める）", routeDigestOn({}) && routeDigestOn({ ROUTE_DIGEST: "on" }) && !routeDigestOn({ ROUTE_DIGEST: "off" }));
  t("1語の形", routeDigestOf(meta, {}) === "proposing|considering|proposing_considering|v1" && routeDigestOf(meta, { ROUTE_SUBSTATE_NET_V2: "on" })?.endsWith("|v2") === true);
  t("駅が無ければ null", routeDigestOf({ apply_route: { node: null, branch: null } }, {}) === null && routeDigestOf({}, {}) === null);
  const off = brainDecisionDigestExtra(meta as Record<string, unknown>, { ROUTE_DIGEST: "off" }) as Record<string, unknown>;
  const on = brainDecisionDigestExtra(meta as Record<string, unknown>, {}) as Record<string, unknown>;
  t("off の digest に ar が無い", !("ar" in off));
  t("on の digest に ar・ほかの欄は同じ", on.ar === "proposing|considering|proposing_considering|v1" && JSON.stringify({ ...on, ar: undefined }) === JSON.stringify({ ...off, ar: undefined }));
}
console.log("■ 内覧が流れた（VIEWING_LAPSED_BRANCH・#621）");
{
  const LON = { VIEWING_LAPSED_BRANCH: "on" };
  const s = base({ stage: "viewed", routeType: "ack_other", viewingUnconfirmed: true });
  t("既定 off", !lapsedViewingBranchOn({}) && lapsedViewingBranchOn(LON));
  const off = applyRouteBrainTextIfEnabled(s, {});
  t("off は内覧後のまま（申込で抑える）・文は今と同じ", off.loc?.branch === null && off.loc?.next?.aix[0] === "application_push" && off.text === applyRouteBrainTextIfEnabled({ ...s, viewingUnconfirmed: undefined }, {}).text);
  const on = applyRouteBrainTextIfEnabled(s, LON);
  t("on は分かれ道 内覧が流れた・AIX の候補なし・戻り方は内覧調整", on.loc?.branch === "viewing_lapsed" && on.loc?.node === "viewed" && on.loc?.next?.aix.length === 0 && on.loc?.wayBack?.to === "viewing_arrange" && on.text.includes("内覧が流れた"));
  t("実施済み（未確認でない）は開かない", applyRouteBrainTextIfEnabled({ ...s, viewingUnconfirmed: false }, LON).loc?.branch === null);
  t("ほかの分かれ道（延期）が強い", applyRouteBrainTextIfEnabled({ ...s, routeType: "postpone_cancel" }, LON).loc?.branch === "postponed");
  t("内覧後でない駅は開かない", !lapsedViewingOpens({ node: "proposing", branch: null }, { viewingUnconfirmed: true }, LON));
  t("on の文も600字以内", on.text.length <= 600);
}
// 2026-11-25 作業員A（#728 成約データ・APPLY_ROUTE_NO_VIEWING_PATH）: 内覧なしの道
{
  const loc = { node: "estimate", branch: null, next: ROUTE_NODES.estimate.next } as never;
  const off = refineRouteNextStep(loc, { routeType: "apply_intent" } as never, {});
  const on = refineRouteNextStep(loc, { routeType: "apply_intent" } as never, { APPLY_ROUTE_NO_VIEWING_PATH: "on" });
  t("内覧なしの道: off は選び直さない・on は申込の意思で申込のご案内", (off === null || off.rule !== "no_viewing_apply") && on?.rule === "no_viewing_apply" && !!on?.next.aix.includes("application_push"));
  t("内覧なしの道: 申込の意思でない番は選ばない", refineRouteNextStep(loc, { routeType: "cost_question" } as never, { APPLY_ROUTE_NO_VIEWING_PATH: "on" })?.rule !== "no_viewing_apply");
  const prev = process.env.APPLY_ROUTE_NO_VIEWING_PATH;
  delete process.env.APPLY_ROUTE_NO_VIEWING_PATH; const t0 = buildApplyRouteBrainText({ node: "estimate", branch: null, next: ROUTE_NODES.estimate.next, aim: [] } as never);
  process.env.APPLY_ROUTE_NO_VIEWING_PATH = "on"; const t1 = buildApplyRouteBrainText({ node: "estimate", branch: null, next: ROUTE_NODES.estimate.next, aim: [] } as never);
  if (prev === undefined) delete process.env.APPLY_ROUTE_NO_VIEWING_PATH; else process.env.APPLY_ROUTE_NO_VIEWING_PATH = prev;
  t("内覧なしの道: 材料の1行は on の時だけ", !t0.includes("別の道") && t1.includes("別の道") && t1.includes("内覧"));
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
