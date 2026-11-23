// 申込までの地図の道筋（app/lib/route-path.ts）
// 実行: npx tsx app/lib/__tests__/route-path.test.ts（全 PASS で exit 0）
import { routePathOf, routePathCheck, routePathBrainLine, PATH_MAIN, routePathToBriefOn, applyRoutePathLineOn } from "../route-path";
import { MAIN_ROUTE, buildApplyRouteBrainText, locateApplyRoute } from "../apply-route-map";
import { routeBriefSection } from "../route-record";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };

ok("本線の順は apply-route-map と同じ", JSON.stringify(PATH_MAIN) === JSON.stringify(MAIN_ROUTE));
ok("既定 off", !routePathToBriefOn({}) && !applyRoutePathLineOn({}) && routePathToBriefOn({ ROUTE_PATH_TO_BRIEF: "on" }) && applyRoutePathLineOn({ APPLY_ROUTE_PATH_LINE: "on" }));
const est = routePathOf({ node: "estimate", branch: null, wayBack: null })!;
ok("見積の駅: 残りは内覧調整から申込まで・中期は次の2駅", est.remaining[0] === "viewing_arrange" && est.remaining.at(-1) === "applying" && est.mid === "内覧調整→内覧予定へ" && est.wayBackTo === null, est);
const br = routePathOf({ node: "proposing", branch: "brought_property", wayBack: { to: "interested", how: "募集中なら御見積書へ" } })!;
ok("分かれ道: 戻り先から残り・中期は戻る", br.remaining[0] === "interested" && br.wayBackTo === "interested" && br.mid.includes("戻る"), br);
ok("位置が無ければ null", routePathOf(null) === null && routePathOf({ node: null, branch: null }) === null);
// 確かめ
ok("返信は留まる", routePathCheck(null, est).verdict === "stay");
ok("物件確認した は駅を動かさない", routePathCheck("property_check_result/available", est).verdict === "stay");
ok("見積→内覧調整は道の上", routePathCheck("viewing_invite", est).verdict === "on_path");
ok("見積→物件を送るは遠回り", routePathCheck("property_send", est).verdict === "detour");
ok("分かれ道の戻り先へ向かう一手は道の上", routePathCheck("property_recommendation", routePathOf({ node: "pickup", branch: "condition_change", wayBack: { to: "proposing", how: "x" } })).verdict === "on_path");
ok("分かれ道の戻り先を飛ばして申込へは戻れない", routePathCheck("application_push", br).verdict === "no_way_back");
ok("新着待ちで物件を送るは行き止まり", routePathCheck("property_send", routePathOf({ node: "proposing", branch: "new_arrival_wait", wayBack: { to: "proposing", how: "x" } })).verdict === "dead_end");
ok("位置が無ければ分からない", routePathCheck("property_send", null).verdict === "unknown");
// 材料の1行
const line = routePathBrainLine(est, "最大限割引の御見積書で答える", ["estimate_sheet"]);
ok("道筋の言い方: 本線の次の駅・その先・一手の例・一手はブレイン", line.includes("本線の次の駅は内覧調整") && line.includes("一手の例") && line.includes("あなたが会話から決める"), line);
ok("分かれ道の言い方", routePathBrainLine(br, null).startsWith("道筋: 分かれ道から本線の気に入った物件ありへ戻り"));

// 配線: ブレインの材料の1行（APPLY_ROUTE_PATH_LINE）と統括の指示書の route（ROUTE_PATH_TO_BRIEF）
{
  const loc = locateApplyRoute({ stage: "estimate_sent", ledger: { propertiesSentCount: 3, pickupPromisedUnfulfilled: false, estimateSent: true, conditionAsked: true }, nowMs: Date.parse("2026-10-20T03:00:00Z") });
  const offText = buildApplyRouteBrainText(loc);
  process.env.APPLY_ROUTE_PATH_LINE = "on";
  const onText = buildApplyRouteBrainText(loc);
  delete process.env.APPLY_ROUTE_PATH_LINE;
  ok("off は今の1行（次の一手の候補）のまま", offText.includes("申込へ向けた次の一手の候補") && !offText.includes("道筋:") && buildApplyRouteBrainText(loc) === offText);
  ok("on は道筋の言い方に替わる（次の一手の候補の1行は出さない）", onText.includes("道筋: 本線の次の駅は") && !onText.includes("申込へ向けた次の一手の候補"), onText);
  const meta = { apply_route: { node: "estimate", branch: null, next: "御見積書", substate: null }, reply_mode: "aix", action: "property_send" };
  const off = routeBriefSection(meta, {})!, on = routeBriefSection(meta, { ROUTE_PATH_TO_BRIEF: "on" })!;
  ok("指示書: off は次の一手を入れ道筋は無い", off.next === "御見積書" && off.path === undefined);
  ok("指示書: on は次の一手を入れず、道筋と確かめの印（見積→物件を送る＝遠回り）", on.next === null && on.path?.remaining[0] === "viewing_arrange" && on.path_check?.verdict === "detour", on);
}

console.log(`route-path: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
