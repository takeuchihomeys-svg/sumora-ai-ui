// app/lib/__tests__/rollout.test.ts — スイッチの段（off／yuma／pct／all・表が優先・悪化で1段下）
//   実行: npx tsx app/lib/__tests__/rollout.test.ts
import { parseStage, stageOf, stageOn, stepDown, stageText, bucketOf } from "../rollout";
import { YUMA_CONVERSATION_ID } from "../test-conversations";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const N = "BRAIN_X";
t("読み: pct:10", stageText(parseStage("pct:10")!) === "pct:10");
t("読み: pct:0 は yuma・pct:100 は all", stageText(parseStage("pct:0")!) === "yuma" && stageText(parseStage("pct:100")!) === "all");
t("読めない値は null", parseStage("maybe") === null);
t("互換: =on は all", stageOf(N, { BRAIN_X: "on" }).kind === "all");
t("無しは off", stageOf(N, {}).kind === "off");
t("_STAGE が =on より先", stageOf(N, { BRAIN_X: "on", BRAIN_X_STAGE: "yuma" }).kind === "yuma");
t("表が env より先", stageOf(N, { BRAIN_X_STAGE: "all" }, [{ switch_name: N, stage: "pct:10" }]).kind === "pct");
t("表の読めない値は無視して env", stageOf(N, { BRAIN_X_STAGE: "all" }, [{ switch_name: N, stage: "?" }]).kind === "all");
t("yuma: YUMA は on・お客様は off", stageOn(N, YUMA_CONVERSATION_ID, { BRAIN_X_STAGE: "yuma" }) && !stageOn(N, "real-1", { BRAIN_X_STAGE: "yuma" }));
const ids = Array.from({ length: 2000 }, (_, i) => `conv-${i}`);
const on10 = ids.filter((c) => stageOn(N, c, { BRAIN_X_STAGE: "pct:10" })).length;
t(`pct:10 はおよそ1割（${on10}/2000）`, on10 > 140 && on10 < 260);
t("同じ会話はいつも同じ組", bucketOf("conv-7", N) === bucketOf("conv-7", N));
t("pct:10 で on の会話は pct:50 でも on", ids.filter((c) => stageOn(N, c, { BRAIN_X_STAGE: "pct:10" })).every((c) => stageOn(N, c, { BRAIN_X_STAGE: "pct:50" })));
t("スイッチが違えば組も違う（同じお客様ばかりに入らない）", ids.filter((c) => stageOn("A", c, { A_STAGE: "pct:10" }) && stageOn("B", c, { B_STAGE: "pct:10" })).length < on10 / 2);
t("1段下: all→pct:50→pct:10→yuma→off", ["all", "pct:50", "pct:10", "yuma"].map((s) => stageText(stepDown(parseStage(s)!))).join(",") === "pct:50,pct:10,yuma,off");
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
