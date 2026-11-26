// scripts/lib/__tests__/exam-snapshot-need.test.ts — 写しに要る行が有るか・届いた問題だけを比べる（2026-11-27 作業員A・#683）
//   実行: npx tsx scripts/lib/__tests__/exam-snapshot-need.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { snapshotHas, SNAPSHOT_NEED, reachGateOf } from "../exam-snapshot-need";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const led = { property_pickups: [{ ago: 30, row: { status: "pending" } }, { ago: 29, row: { status: "pending" } }], aix_usage_logs: [{ ago: 9, row: { aix_type: "property_check_result" } }] };
t("q472 の形: pending 2行と AIX の行があれば探す約束の流れは写しに有る", snapshotHas(SNAPSHOT_NEED.BRAIN_PICKUP_PROMISE_FLOW, led));
t("PICKUP_WHY_PENDING_MATCH は送った物件の AIX が要る（無ければ無い）", !snapshotHas(SNAPSHOT_NEED.PICKUP_WHY_PENDING_MATCH, led));
t("表が写っていない・ledger が無い", !snapshotHas(SNAPSHOT_NEED.SIP_JUDGE, led) && !snapshotHas(SNAPSHOT_NEED.AIX_STATE_CARD, null));
// 11/26 の晩の a-cpf: 13問のうち印が出たのは q203・q468 の2問 → 届かず
const cpf = reachGateOf("BRAIN_CHECK_PROMISE_FLOW", [{ id: "q203", marks: { check_promise_flow: 120 } }, { id: "q468", marks: { check_promise_flow: 98 } }, { id: "q090", marks: { now_fulfillable: 300 } }], ["q203", "q468", "q090", "q105", "q465"]);
t("a-cpf の形: 届いた 2問だけ・3問より少なければ届かず", cpf.verdict === "届かず" && cpf.reached.join() === "q203,q468" && cpf.notReached.includes("q090"));
t("印の無い部品は印なし・印を足した3部品は届かずか比べる", reachGateOf("UNKNOWN_SWITCH", [], ["q125"]).verdict === "印なし" && reachGateOf("ACK_PICKUP_AIX_PATH", [], ["q125"]).verdict === "届かず");
t("届いた問題が足りれば比べる", reachGateOf("AIX_BOUNDARY_LINE", ["q069", "q059", "q468"].map((id) => ({ id, marks: { aix_boundary: 133 } })), ["q069", "q059", "q468", "q467"]).verdict === "比べる");
{ const bc = readFileSync(join(__dirname, "..", "..", "..", "app", "lib", "brain-core.ts"), "utf8"); t("印の配線: 3部品とも on の時だけ付く印", bc.includes("if (ackPickupPathGiven) materialMarks.ack_pickup_path = 1") && bc.includes("rule6OpenPromiseOn() && !BRAIN_RULES_678_FACTS_ON && isAckOnlyTurn(") && bc.includes("materialMarks.route_next_by_turn = 1")); }
console.log(`exam-snapshot-need: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
