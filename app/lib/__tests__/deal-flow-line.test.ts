// 台帳 #728 ③（作業員L 11/26）: 成約データの1行（入口の統括・ブレインの地図の申込準備の手前の駅）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dealFlowIntakeLine, dealFlowPreApplyLine, conductorDealFlowLineOn, dealFlowPreApplyLineOn } from "../deal-flow-line";

assert.equal(conductorDealFlowLineOn({}), false);
assert.equal(dealFlowPreApplyLineOn({}), false);
assert.equal(dealFlowIntakeLine(null), "");
assert.equal(dealFlowIntakeLine("won"), "", "表に無い駅は空");
const p = dealFlowIntakeLine("proposing");
assert.ok(p.includes("31%（109/351）") && p.includes("見積 37"), p);
assert.ok(!/日/.test(p.replace(/内覧の日時/g, "")), "日数は出さない（A の station_state と重ねない）");
assert.ok(dealFlowIntakeLine("viewed").includes("手打ちの返信 109/146"), "申込準備の手前は直前の一手を添える");
assert.equal(dealFlowPreApplyLine("proposing"), "", "ブレインの地図の行は申込準備の手前の駅だけ");
assert.ok(dealFlowPreApplyLine("apply_prep").includes("手打ちの返信"));
assert.ok(p.length < 120, `短く: ${p.length}`);
const core = readFileSync(join(__dirname, "../brain-core.ts"), "utf8");
assert.ok(/df\.conductorDealFlowLineOn\(\) \|\| isPostApplyStatus\(convStatus\)\) return ""/.test(core), "入口の材料は on・申込前だけ");
assert.ok(/materialBlocks\.push\(\{ key: "deal_flow_pre_apply"/.test(core), "並べ替えの控え");
const NV = { APPLY_ROUTE_NO_VIEWING_PATH: "on" };
assert.ok(!dealFlowIntakeLine("viewed", NV).includes("手打ちの返信") && dealFlowIntakeLine("viewed", NV).includes("65%"), "内覧なしの道が on なら添えだけ出さない");
assert.equal(dealFlowPreApplyLine("apply_prep", NV), "");
console.log("deal-flow-line ok 15");
