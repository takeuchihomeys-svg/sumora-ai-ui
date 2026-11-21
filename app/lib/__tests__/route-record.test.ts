// 申込までの地図の駅を残す口と段の語の寄せ（作業員M 2026-11-21・台帳 #467）
// 実行: npx tsx app/lib/__tests__/route-record.test.ts
import { applyRouteRecordOn, stationOf } from "../route-record";
import { ROUTE_NODES } from "../apply-route-map";
import { buildCustomerPlan } from "../customer-plan";
import { routeToBriefOn, routeBriefSection, routeAimNoteForWriter, PLANT_TO_FACT } from "../route-record";
import { matchSubstateOf } from "../turn-aims-after";
import { buildConductorBrief, briefSectionsForRole, conductorBriefDigest } from "../conductor-brief";
import { briefLineForRole } from "../compose-brief-roles";
export {};
let passed = 0, failed = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`, extra ?? ""); } };

t("既定 on・=off で止まる", applyRouteRecordOn({}) && applyRouteRecordOn({ APPLY_ROUTE_RECORD: "on" }) && !applyRouteRecordOn({ APPLY_ROUTE_RECORD: "off" }) && !applyRouteRecordOn({ APPLY_ROUTE_RECORD: " OFF " }));
t("ブレインの駅が正", JSON.stringify(stationOf({ applyRouteNode: "viewed", status: "proposing" })) === JSON.stringify({ node: "viewed", from: "apply_route" }));
t("駅が無ければ状態の語から", JSON.stringify(stationOf({ status: "viewing" })) === JSON.stringify({ node: "viewing_arrange", from: "status" }));
t("状態が寄せられなければ checkpoint_stage", JSON.stringify(stationOf({ status: "zzz", checkpointStage: "estimate" })) === JSON.stringify({ node: "estimate", from: "checkpoint_stage" }));
t("知らない語は null（推測で埋めない）", stationOf({ applyRouteNode: "nope", status: "lost" }).node === null);
const all = ["hearing","inquiry","new","first_reply","searching","pickup","proposing","interested","estimate","estimating","viewing","viewing_arrange","viewing_scheduled","viewed","apply_prep","applying","application","screening","contract","closed_won","won"];
const bad = all.filter((w) => { const n = stationOf({ status: w }).node; return !n || !Object.prototype.hasOwnProperty.call(ROUTE_NODES, n); });
t("寄せ先は全部地図の駅", bad.length === 0, bad);

const meta = { apply_route: { node: "interested", branch: "b1", next: "内覧に誘う", next_aix: [] }, turn_aims_after: { midAim: "内覧の日を決める", turnAim: "x" }, checkpoint_stage: "proposing" };
const p = buildCustomerPlan({ meta, status: "searching", prev: null, nowIso: "2026-11-21T01:00:00Z" })!;
t("計画は地図の駅を読む", p.station.node === "interested" && p.station.node_from === "apply_route" && p.station.branch === "b1" && p.station.status === "searching", p.station);
t("計画の狙いは turn_aims が無ければ turn_aims_after", p.aims.mid_aim === "内覧の日を決める", p.aims);
const p2 = buildCustomerPlan({ meta: { checkpoint_stage: "viewed" }, status: null, prev: null, nowIso: "2026-11-21T01:00:00Z" })!;
t("駅が無い時は段の語から寄せる", p2.station.node === "viewed" && p2.station.node_from === "checkpoint_stage", p2.station);

// ── #467 の (1): 地図 → 統括の指示書（ROUTE_TO_BRIEF）──
t("ROUTE_TO_BRIEF は既定 off", !routeToBriefOn({}) && routeToBriefOn({ ROUTE_TO_BRIEF: "on" }));
t("仕込みの型→事実の id（ask_send は渡さない）", PLANT_TO_FACT.scarcity === "one_room_only" && PLANT_TO_FACT.hold_before_viewing === "hold_by_apply" && PLANT_TO_FACT.ask_send === null);
const vd = matchSubstateOf("内覧は土曜日の午後でお願いします");
t("網: 内覧の日時→viewing_dates", vd?.id === "viewing_dates", vd?.id);
t("網: 最短の入居は作らない（q065）", matchSubstateOf("最短でいつ頃入居できますか") === null);
const rs = routeBriefSection({ apply_route: { node: "viewing_arrange", branch: null, next: "日時を決める", substate: "viewing_dates" } }, { ROUTE_SUBSTATE_ALLOW: "all" })!;
t("駅と合う状態は使う（目的・中期・長期・仕込み・深さ）", !!rs.substate?.usable && rs.turn_aim === "日時を決める" && !!rs.mid_aim && !!rs.long_aim && rs.plants.join(",") === "one_room_only,hold_by_apply" && rs.depth === 2 && !!rs.depth_why, rs);
const rsx = routeBriefSection({ apply_route: { node: "hearing", branch: null, substate: "viewing_dates" } }, { ROUTE_SUBSTATE_ALLOW: "all" })!;
t("駅と合わない状態は記録だけ（使わない）", rsx.substate?.at_match === false && rsx.substate?.usable === false && rsx.turn_aim === null && rsx.plants.length === 0, rsx);
const rsf = routeBriefSection({ apply_route: { node: "viewing_arrange", substate: "viewing_no_view_doubt" } }, { ROUTE_SUBSTATE_ALLOW: "all" })!;
t("例が少ない状態は ROUTE_SUBSTATE_FEW=on の時だけ", rsf.substate?.usable === false && routeBriefSection({ apply_route: { node: "viewing_arrange", substate: "viewing_no_view_doubt" } }, { ROUTE_SUBSTATE_FEW: "on", ROUTE_SUBSTATE_ALLOW: "all" })!.substate?.usable === true);
t("ROUTE_SUBSTATE_DENY で外す", routeBriefSection({ apply_route: { node: "viewing_arrange", substate: "viewing_dates" } }, { ROUTE_SUBSTATE_DENY: "x,viewing_dates", ROUTE_SUBSTATE_ALLOW: "all" })!.substate?.usable === false);
t("既定は当たる状態だけ（11/21 夜の測る半分・2版の網は別の既定）", routeBriefSection({ apply_route: { node: "viewing_arrange", substate: "viewing_dates" } }, {})!.substate?.usable === false && routeBriefSection({ apply_route: { node: "apply_prep", substate: "apply_intent" } }, {})!.substate?.usable === true && routeBriefSection({ apply_route: { node: "proposing", branch: "screening_concern", substate: "apply_screening_worry" } }, {})!.substate?.usable === false && routeBriefSection({ apply_route: { node: "hearing", substate: "hearing_many_conditions" } }, { ROUTE_SUBSTATE_NET_V2: "on" })!.substate?.usable === true && routeBriefSection({ apply_route: { node: "hearing", substate: "hearing_many_conditions" } }, {})!.substate?.usable === false);
t("ROUTE_SUBSTATE_ALLOW で置き換える", routeBriefSection({ apply_route: { node: "viewing_arrange", substate: "viewing_dates" } }, { ROUTE_SUBSTATE_ALLOW: "viewing_dates" })!.substate?.usable === true && routeBriefSection({ apply_route: { node: "apply_prep", substate: "apply_intent" } }, { ROUTE_SUBSTATE_ALLOW: "viewing_dates" })!.substate?.usable === false);
t("apply_route が無ければ null", routeBriefSection({}) === null && routeBriefSection(null) === null);
t("書き手への塊（使える時だけ）", routeAimNoteForWriter({ route: rs }).includes("日時を決める") && routeAimNoteForWriter({ route: rsx }) === "" && routeAimNoteForWriter(null) === "");

const bm = { apply_route: { node: "viewing_arrange", branch: null, next: "x", next_aix: [], substate: "viewing_dates" } };
delete process.env.ROUTE_TO_BRIEF;
const bOff = buildConductorBrief(bm);
process.env.ROUTE_TO_BRIEF = "on"; process.env.ROUTE_SUBSTATE_ALLOW = "all";
const bOn = buildConductorBrief(bm);
delete process.env.ROUTE_TO_BRIEF;
t("off の時は指示書に route が無い", bOff.route === undefined && bOff.aim.keyPointFrom === undefined);
t("on: route の欄と空いている要点・中期を埋める", !!bOn.route && bOn.aim.keyPoint === "日時を決める" && bOn.aim.keyPointFrom === "route" && bOn.aim.midFrom === "route" && !bOn.notYet.includes("key_point") && !bOn.notYet.includes("mid"), { aim: bOn.aim, notYet: bOn.notYet });
const bJb = (() => { process.env.ROUTE_TO_BRIEF = "on"; process.env.ROUTE_SUBSTATE_ALLOW = "all"; const b = buildConductorBrief({ ...bm, judge_basis: { purpose: "answer", key_point: "元の要点" }, turn_aims_after: { midAim: "元の中期" } }); delete process.env.ROUTE_TO_BRIEF; return b; })();
t("on: 判断の根拠・turn_aims の値は上書きしない", bJb.aim.keyPoint === "元の要点" && bJb.aim.keyPointFrom === undefined && bJb.aim.mid === "元の中期" && bJb.aim.midFrom === undefined, bJb.aim);
t("役目の対応: route は締め・つなぎ・AIX の2通目に渡る", briefSectionsForRole("aix2").includes("route") && briefSectionsForRole("bridge").includes("route"));
t("ブレインの層の要約には route を入れない", (conductorBriefDigest(bOn) ?? "") === (conductorBriefDigest(bOff) ?? "").replace(/未:\d+/, `未:${bOn.notYet.length}`));
t("書き手の1行に地図の状態が出る（on の時だけ）", (briefLineForRole({ conductor_brief: bOn }, "bridge") ?? "").includes("地図の状態: 内覧の日時") && !(briefLineForRole({ conductor_brief: bOff }, "bridge") ?? "").includes("地図の状態"), briefLineForRole({ conductor_brief: bOn }, "bridge"));

t("使える状態には言い回しの型と潜在の4つ（11/21 夜の割り当て）", (rs.phrasing?.point_how.length ?? 0) > 0 && (rs.phrasing?.want.length ?? 0) > 0 && rsx.phrasing === null, rs.phrasing);
console.log(`\nroute-record: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
