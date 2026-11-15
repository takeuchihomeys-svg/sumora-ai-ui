// 感想の番の「内覧の一文を足さない」を迷いの語がある時だけに（2026-11-15 作業員H・NO_VIEWING_HESITATION_ONLY・既定 off）
// 実行: npx tsx app/lib/__tests__/look-hesitation.test.ts
import { noViewingHesitationOnlyOn, noViewingNoteAllowed } from "../look-hesitation";
import { replyDirectionWithNoViewing } from "../reply-direction-keep";
import { pickupDirectionAdjust, type TwoStageVerdict } from "../two-stage";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
// 実物（試験 q174・q428 の会話の本文）
const q174 = "そうなんですね、、(うるうる) 承知しました！ ありがとうございます！ 広くて綺麗ですね！✨一旦見てみたいです！ 場所が少し遠い気もしてて、もし他にも候補ありましたらお願いしたいです(ぺこり)";
const q428 = "他はないですか\n気になります";
const on = { NO_VIEWING_HESITATION_ONLY: "on" };
const dir = "周辺のお部屋はこちらのみと答える返信にする";
t("既定 off（=on の時だけ）", !noViewingHesitationOnlyOn({}) && noViewingHesitationOnlyOn(on));
t("off は今まで通り（q428 にも足す）", noViewingNoteAllowed(q428, {}) && (replyDirectionWithNoViewing({ direction: dir, customerText: q428 }, {}) ?? "").includes("内覧の依頼ではない"));
t("on・q174（遠い気もして）→ 足す", noViewingNoteAllowed(q174, on) && (replyDirectionWithNoViewing({ direction: dir, customerText: q174 }, on) ?? "").includes("内覧の依頼ではない"));
t("on・q428（迷いの語なし）→ 足さない＝竹内さんの誘いを止めない", replyDirectionWithNoViewing({ direction: dir, customerText: q428 }, on) === dir);
const pv: TwoStageVerdict = { kind: "pickup", direction: "新しいご条件でお部屋をピックアップしてお送りすると約束する返信にする", keyTopic: "", source: "rule:two_stage_promise(pickup_unless_ack)" };
t("2段 on・q174 → 足す", (pickupDirectionAdjust(pv, { customerText: q174 }, { ...on, PICKUP_DIRECTION_KEEP: "off" })?.direction ?? "").includes("内覧の依頼ではない"));
t("2段 on・q428 → 足さない", pickupDirectionAdjust(pv, { customerText: q428 }, { ...on, PICKUP_DIRECTION_KEEP: "off" })?.direction === pv.direction);
t("2段 off・q428 → 今まで通り足す", (pickupDirectionAdjust(pv, { customerText: q428 }, { PICKUP_DIRECTION_KEEP: "off" })?.direction ?? "").includes("内覧の依頼ではない"));
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
