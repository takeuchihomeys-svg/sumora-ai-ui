// app/lib/__tests__/cond-pickup-promise.test.ts — 条件の番の最初の一手（2026-11-06 作業員4）
import { condPickupRules, condPickupPromiseOn, firstCondPickupOn, COND_PICKUP_PROMISE_RULE, FIRST_COND_PICKUP_RULE, firstCondMaterialLine } from "../cond-pickup-promise";
import { pickupConditionsReady } from "../hearing-form";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean) => { if (ok) pass++; else { fail++; console.log(`  NG ${n}`); } };
t("既定 off（行なし）", condPickupRules({}) === "" && !condPickupPromiseOn({}) && !firstCondPickupOn({}));
t("① だけ on", condPickupRules({ BRAIN_COND_PICKUP_PROMISE: "on" }) === COND_PICKUP_PROMISE_RULE);
t("② だけ on", condPickupRules({ BRAIN_FIRST_COND_PICKUP: "on" }) === FIRST_COND_PICKUP_RULE);
t("両方 on は2行", condPickupRules({ BRAIN_COND_PICKUP_PROMISE: "on", BRAIN_FIRST_COND_PICKUP: "on" }).split("\n").length === 2);
t("中身: 送れる物件が材料にある時だけ物件送付・竹内さんの言い方", COND_PICKUP_PROMISE_RULE.includes("送れる物件が材料") && COND_PICKUP_PROMISE_RULE.includes("ピックアップしてお送りさせて頂きます"));
t("中身②: 数え方は hearing-form の1か所（ここでは数えない）・材料の【初回の条件】に従う", FIRST_COND_PICKUP_RULE.includes("pickupConditionsReady") && FIRST_COND_PICKUP_RULE.includes("【初回の条件】") && FIRST_COND_PICKUP_RULE.includes("2段:pickup"));
t("材料の1行: そろっている／足りない物", firstCondMaterialLine({ ready: true }).includes("そろっている") && firstCondMaterialLine({ ready: false, missing: ["area", "rent"] }).includes("エリア・家賃") && firstCondMaterialLine(null) === "");
t("配線: pickupConditionsReady の答えをそのまま1行に", firstCondMaterialLine(pickupConditionsReady(null, ["難波で家賃7万以内の1Kを探しています"])).length > 0);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
