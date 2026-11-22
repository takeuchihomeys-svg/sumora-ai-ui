// 申込までの地図の次の一手を番で選び直す（APPLY_ROUTE_NEXT_BY_TURN）と、番ごとの駅の記録（ROUTE_DIGEST）（作業員R 2026-11-23・台帳 #608）
// 実行: npx tsx app/lib/__tests__/apply-route-next.test.ts
import { applyRouteNextByTurnOn, refineRouteNextStep, withRefinedNext, daysUntilYmd, ROUTE_ORDER, routeDigestOn, routeDigestOf } from "../apply-route-next";
import { MAIN_ROUTE, locateApplyRoute, applyRouteBrainTextIfEnabled, ROUTE_NODES, type ApplyRouteSignals } from "../apply-route-map";
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
  t("既定 off", !routeDigestOn({}) && routeDigestOn({ ROUTE_DIGEST: "on" }));
  t("1語の形", routeDigestOf(meta, {}) === "proposing|considering|proposing_considering|v1" && routeDigestOf(meta, { ROUTE_SUBSTATE_NET_V2: "on" })?.endsWith("|v2") === true);
  t("駅が無ければ null", routeDigestOf({ apply_route: { node: null, branch: null } }, {}) === null && routeDigestOf({}, {}) === null);
  const off = brainDecisionDigestExtra(meta as Record<string, unknown>, {}) as Record<string, unknown>;
  const on = brainDecisionDigestExtra(meta as Record<string, unknown>, { ROUTE_DIGEST: "on" }) as Record<string, unknown>;
  t("off の digest に ar が無い", !("ar" in off));
  t("on の digest に ar・ほかの欄は同じ", on.ar === "proposing|considering|proposing_considering|v1" && JSON.stringify({ ...on, ar: undefined }) === JSON.stringify({ ...off, ar: undefined }));
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
