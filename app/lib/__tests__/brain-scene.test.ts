// app/lib/__tests__/brain-scene.test.ts — 3巡目（10/07）ブレインの材料を場面で絞る（実行: npx tsx app/lib/__tests__/brain-scene.test.ts）
import { sceneActionRules, keepBrainMaterial, brainSceneMaterialsEnabled, BRAIN_SCENE_ACTIONS } from "../brain-scene";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const rows = Array.from({ length: 30 }, (_, i) => ({ action_type: i % 3 === 0 ? "estimate_sheet" : i % 3 === 1 ? "viewing_invite" : "property_send", i }));
t("off は先頭15行そのまま", sceneActionRules(rows, "cost", false).map((r) => r.i).join() === rows.slice(0, 15).map((r) => r.i).join());
t("初期費用の場面は見積書のルールだけ（上位15行まで）", sceneActionRules(rows, "cost", true).every((r) => BRAIN_SCENE_ACTIONS.cost!.includes(r.action_type)));
t("その他は全部", sceneActionRules(rows, "other", true).length === 15);
t("場面の AIX が1行も無ければ元のまま（壊れない側）", sceneActionRules([{ action_type: "x" }], "cost", true).length === 1);
t("短いお礼は成約パターン・ナレッジを入れない", !keepBrainMaterial("ack", "winning", true) && !keepBrainMaterial("ack", "ragKnowledge", true));
t("検討中は全部入れる", keepBrainMaterial("considering", "winning", true) && keepBrainMaterial("considering", "contractExamples", true));
t("off なら全部入れる", keepBrainMaterial("ack", "winning", false));
t("既定は off（本番は今まで通り）", !brainSceneMaterialsEnabled({}) && brainSceneMaterialsEnabled({ BRAIN_SCENE_MATERIALS: "on" }) && brainSceneMaterialsEnabled({}, "on") && !brainSceneMaterialsEnabled({ BRAIN_SCENE_MATERIALS: "on" }, "off"));
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
