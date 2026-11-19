// つなぎを決める所を1か所に（2026-11-15 作業員H・TSUNAGI_ONE_PLACE・既定 off）
// 実行: npx tsx app/lib/__tests__/tsunagi-one-place.test.ts
import { tsunagiOnePlaceOn, noViewingByDecision } from "../tsunagi-one-place";
import { replyDirectionWithNoViewing } from "../reply-direction-keep";
import { pickupDirectionAdjust, type TwoStageVerdict } from "../two-stage";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const on = { TSUNAGI_ONE_PLACE: "on" };
// 実物（試験 q428＝見張り 12496・q174）
const q428 = "他はないですか\n気になります";
const q174 = "そうなんですね、、(うるうる) 承知しました！ ありがとうございます！ 広くて綺麗ですね！✨一旦見てみたいです！ 場所が少し遠い気もしてて、もし他にも候補ありましたらお願いしたいです(ぺこり)";
const dir = "周辺のお部屋はこちらのみと答える返信にする";
const invite = { kind: "viewing" as const, level: "suggest" as const };
const none = { kind: "none" as const, level: "avoid" as const };
t("既定 off", !tsunagiOnePlaceOn({}) && tsunagiOnePlaceOn(on));
t("off は今まで通り（判定があっても網の答え）", noViewingByDecision(true, invite, {}) === true);
t("on・誘う判定 → 止めの一文を足さない", noViewingByDecision(true, invite, on) === false);
t("on・誘わない判定 → 網の答えのまま", noViewingByDecision(true, none, on) === true && noViewingByDecision(false, none, on) === false);
t("on・判定が無い番 → 網の答えのまま", noViewingByDecision(true, null, on) === true);
t("返信の方向: q428・誘う判定 → 足さない", replyDirectionWithNoViewing({ direction: dir, customerText: q428, appeal: invite }, on) === dir);
t("返信の方向: q174・誘わない判定 → 足す", (replyDirectionWithNoViewing({ direction: dir, customerText: q174, appeal: none }, on) ?? "").includes("内覧の依頼ではない"));
t("返信の方向: off は判定を見ない（q428 にも足す）", (replyDirectionWithNoViewing({ direction: dir, customerText: q428, appeal: invite }, {}) ?? "").includes("内覧の依頼ではない"));
const pv: TwoStageVerdict = { kind: "pickup", direction: "新しいご条件でお部屋をピックアップしてお送りすると約束する返信にする", keyTopic: "", source: "rule:two_stage_promise(pickup_unless_ack)" };
t("2段: on・誘う判定 → 足さない", pickupDirectionAdjust(pv, { customerText: q428, appeal: invite }, { ...on, PICKUP_DIRECTION_KEEP: "off" })?.direction === pv.direction);
t("2段: on・誘わない判定（q174）→ 足す", (pickupDirectionAdjust(pv, { customerText: q174, appeal: none }, { ...on, PICKUP_DIRECTION_KEEP: "off" })?.direction ?? "").includes("内覧の依頼ではない"));
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
// 11/18: 2段の尾（TWO_STAGE_ALSO_ANSWER_PLAIN）の止めの句も1か所の判定に従う
import("../two-stage").then(({ twoStageAlsoAnswer, TWO_STAGE_ALSO_ANSWER_PLAIN, TWO_STAGE_ALSO_ANSWER_PLAIN_INVITE_OK }) => {
  const ok = twoStageAlsoAnswer({}, { kind: "viewing", level: "suggest" }) === TWO_STAGE_ALSO_ANSWER_PLAIN
    && twoStageAlsoAnswer({ TSUNAGI_ONE_PLACE: "on" }, { kind: "viewing", level: "suggest" }) === TWO_STAGE_ALSO_ANSWER_PLAIN_INVITE_OK
    && twoStageAlsoAnswer({ TSUNAGI_ONE_PLACE: "on" }, { kind: "none", level: "avoid" }) === TWO_STAGE_ALSO_ANSWER_PLAIN
    && twoStageAlsoAnswer({ TSUNAGI_ONE_PLACE: "on" }) === TWO_STAGE_ALSO_ANSWER_PLAIN
    && !TWO_STAGE_ALSO_ANSWER_PLAIN_INVITE_OK.includes("内覧");
  console.log(ok ? "  OK  2段の尾: on・誘う判定だけ止めの句を外す" : "  NG  2段の尾");
  if (!ok) process.exit(1);
});
