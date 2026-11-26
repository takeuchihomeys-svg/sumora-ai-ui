// 2026-11-26 作業員L: 見積書ツールの割引・見積の後のお客様の反応をブレインの材料に（BRAIN_ESTIMATE_DISCOUNT・BRAIN_ESTIMATE_REACTION・既定 off）
import assert from "node:assert/strict";
import { estimateRecordsBlock, estimateDiscountOn, estimateReactionOn, estimateReactionLine, reactionKindsOf } from "../estimate-records-block";

const rows = [{ property_name: "Aハイツ", room_no: "301", initial_cost_yen: 250000, discount_yen: 30000, created_at: "2026-11-20T03:00:00Z" }];
assert.equal(estimateDiscountOn({}), false);
assert.equal(estimateReactionOn({}), false);
assert.ok(!estimateRecordsBlock(rows, 6, {}).includes("割引"), "off は今と同じ");
assert.ok(estimateRecordsBlock(rows, 6, { BRAIN_ESTIMATE_DISCOUNT: "on" }).includes("割引 30,000円"));
assert.deepEqual(reactionKindsOf("家族と相談してから決めます"), ["家族と相談"]);
const now = Date.parse("2026-11-23T03:00:00Z");
assert.equal(estimateReactionLine("2026-11-20T03:00:00Z", [], now), "【見積の後のお客様】11/20の見積の後、まだ返事なし（3日）");
assert.ok(estimateReactionLine("2026-11-20T03:00:00Z", [{ sender: "customer", text: "礼金もう少し安くなりますか？", created_at: "2026-11-21T00:00:00Z" }], now).includes("費用の質問"));
assert.equal(estimateReactionLine("2026-11-20T03:00:00Z", [{ sender: "customer", text: "了解です", created_at: "2026-11-21T00:00:00Z" }], now), "", "型の無い通だけなら出さない");
console.log("estimate-records-discount ok 9");
