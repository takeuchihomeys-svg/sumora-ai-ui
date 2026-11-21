// 申込までの地図の駅を残す口と段の語の寄せ（作業員M 2026-11-21・台帳 #467）
// 実行: npx tsx app/lib/__tests__/route-record.test.ts
import { applyRouteRecordOn, stationOf } from "../route-record";
import { ROUTE_NODES } from "../apply-route-map";
import { buildCustomerPlan } from "../customer-plan";
export {};
let passed = 0, failed = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`, extra ?? ""); } };

t("既定 off・on で動く", !applyRouteRecordOn({}) && applyRouteRecordOn({ APPLY_ROUTE_RECORD: "on" }) && !applyRouteRecordOn({ APPLY_ROUTE_RECORD: "shadow" }));
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

console.log(`\nroute-record: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
