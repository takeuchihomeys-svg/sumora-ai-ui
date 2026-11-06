// 2段のピックアップの約束にブレインの依頼の中身を残す（2026-11-06 作業員9・q011・q174・PICKUP_DIRECTION_BRAIN_ASK）
// 実行: npx tsx app/lib/__tests__/pickup-direction-brain-ask.test.ts
import { pickupDirectionWithBrainAsk, pickupDirectionBrainAskOn, type TwoStageVerdict } from "../two-stage";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const ON = { PICKUP_DIRECTION_BRAIN_ASK: "on" };
const pickup: TwoStageVerdict = { kind: "pickup", direction: "お客様の今の発言に先に一言で応え、新しいご条件でお部屋をピックアップしてお送りすると約束する返信にする", keyTopic: "", source: "rule:two_stage_promise(pickup_unless_ack)" };
const check: TwoStageVerdict = { kind: "check", direction: "募集状況を確認する約束", keyTopic: "", source: "rule:two_stage_promise(check)" };
const q011 = "トイレに扉がある・大国町・本町・堺筋本町の条件を復唱し、新条件で物件をピックアップして送る旨を返信する";
const q174 = "Luxe難波WEST 403を内覧候補として残しつつ、桜川駅・芦原橋駅エリアで新着物件を再検索してピックアップをお送りする";

t("既定 off", pickupDirectionBrainAskOn({}) === false);
t("off は2段の文のまま", pickupDirectionWithBrainAsk(pickup, q011, {}) === pickup.direction);
const a = pickupDirectionWithBrainAsk(pickup, q011, ON) ?? "";
t("on: q011 の条件が入る", a.startsWith(pickup.direction) && a.includes("トイレに扉") && a.includes("堺筋本町"), a);
t("on: 送るのは後で AIX・内覧を足さないを添える", a.includes("後で AIX") && a.includes("内覧"), a);
const b = pickupDirectionWithBrainAsk({ ...pickup, source: "rule:two_stage_promise(pickup)" }, q174, ON) ?? "";
t("on: (pickup) でも q174 のエリアが入る", b.includes("桜川駅・芦原橋駅"), b);
t("check の約束には足さない", pickupDirectionWithBrainAsk(check, q011, ON) === check.direction);
t("ブレインの文が空なら足さない", pickupDirectionWithBrainAsk(pickup, null, ON) === pickup.direction && pickupDirectionWithBrainAsk(pickup, "  ", ON) === pickup.direction);
t("同じ文なら重ねない", pickupDirectionWithBrainAsk(pickup, pickup.direction, ON) === pickup.direction);
t("null の判定は null", pickupDirectionWithBrainAsk(null, q011, ON) === null);
const long = "あ".repeat(300);
t("長いブレインの文は 140字で切る", (pickupDirectionWithBrainAsk(pickup, long, ON) ?? "").includes("あ".repeat(140) + "…"));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
