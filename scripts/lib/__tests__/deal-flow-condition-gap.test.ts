// 申込したのに条件の時刻が無い件の分け（#728・作業員L 11/25）
import assert from "node:assert/strict";
import { conditionGapOf } from "../deal-flow";

const c = (sender: string, text: string) => ({ sender, text, at: "" });
assert.equal(conditionGapOf([c("customer", "梅田駅周辺で家賃7万以内、1Kを探してます"), c("staff", "承知致しました")]).kind, "first_msg_conditions");
assert.equal(conditionGapOf([c("customer", "こんにちは"), c("staff", "ご希望の条件をお聞かせ下さい"), c("customer", "難波駅 6万")]).kind, "staff_hand_asked");
assert.equal(conditionGapOf([c("customer", "こんにちは"), c("staff", "はい"), c("customer", "天王寺駅で5万くらい")]).kind, "later_customer_conditions");
assert.equal(conditionGapOf([c("customer", "この物件 https://suumo.jp/x")]).kind, "brought_property");
assert.equal(conditionGapOf([c("customer", "こんにちは"), c("staff", "はい")]).kind, "no_conditions_seen");
console.log("deal-flow-condition-gap ok 5");
import { handAskedConditionAts, conditionHandAskEnabled } from "../../../app/lib/deal-outcome";
const ms = [
  { sender: "staff", text: "ご希望の条件をお聞かせ下さい", createdAt: "a" },
  { sender: "staff", text: "ご希望の条件をお聞かせ下さい", createdAt: "b", isAix: true },
  { sender: "customer", text: "ご予算は", createdAt: "c" },
];
assert.deepEqual(handAskedConditionAts(ms), ["a"]);
assert.equal(conditionHandAskEnabled({}), false);
assert.equal(conditionHandAskEnabled({ DEAL_CONDITION_HAND_ASK: "on" }), true);
console.log("deal-outcome hand-ask ok 3");
