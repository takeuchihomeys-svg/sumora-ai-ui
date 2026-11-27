// app/lib/__tests__/auto-gate-scene-stops.test.ts — 関所の穴を塞ぐ3つ（#812・どれも既定 off）と影の関所の最終チェックの読み（2026-11-27 作業員A）
//   実行: npx tsx app/lib/__tests__/auto-gate-scene-stops.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gateSceneStops } from "../auto-reply-policy";
import { watchFinalCheckState, SHADOW_GATE_VERSION } from "../shadow-auto-gate";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
t("既定 off: どの場面も止めない（自動送信の今の動きは変わらない）", gateSceneStops({ sceneKey: "対象外:申込以降" }, {}) === null && gateSceneStops({ sceneKey: null }, {}) === null);
t("申込以降の場面: on で止める", gateSceneStops({ sceneKey: "対象外:申込以降", finalCheckState: "ok" }, { AUTO_GATE_POSTAPPLY_SCENE: "on" }) === "post_apply_scene" && gateSceneStops({ sceneKey: "返信:質問", finalCheckState: "ok" }, { AUTO_GATE_POSTAPPLY_SCENE: "on" }) === null);
const allowEnv = { AUTO_GATE_SCENE_ALLOW: "on", AUTO_GATE_SCENE_ALLOW_LIST: "返信:短い了承・お礼、返信:検討中・一時保留" };
t("場面の許し: 一覧の場面だけ通す・場面が分からない番は止める", gateSceneStops({ sceneKey: "返信:短い了承・お礼" }, allowEnv) === null && gateSceneStops({ sceneKey: "返信:質問" }, allowEnv) === "scene_not_allowed" && gateSceneStops({ sceneKey: null }, allowEnv) === "scene_not_allowed");
t("場面の許し: 一覧が空なら全部止める（迷ったら人に残す）", gateSceneStops({ sceneKey: "返信:短い了承・お礼" }, { AUTO_GATE_SCENE_ALLOW: "on" }) === "scene_not_allowed");
t("最終チェックの証拠を渡さない呼び方: on で止める", gateSceneStops({ sceneKey: "x" }, { AUTO_GATE_REQUIRE_FC_STATE: "on" }) === "final_check_unknown" && gateSceneStops({ sceneKey: "x", finalCheckState: "ok" }, { AUTO_GATE_REQUIRE_FC_STATE: "on" }) === null);
t("段階でも読む（_STAGE=all）", gateSceneStops({ sceneKey: "対象外:申込以降" }, { AUTO_GATE_POSTAPPLY_SCENE_STAGE: "all" }) === "post_apply_scene");
// 影の関所: 見張りの写しは passes に改名して持つ（本物は passes_completed）
t("影: 写しの passes（3パス）で完走と読む", watchFinalCheckState({ ok: true, passes: ["rule_check", "anomaly_scan", "context_check"] }) === "ok" && watchFinalCheckState({ ok: true, passes: ["rule_check"] }) === "incomplete" && watchFinalCheckState(null) === "missing");
t("影: 本物の形（passes_completed）もそのまま", watchFinalCheckState({ passes_completed: ["rule_check", "anomaly_scan", "context_check"] }) === "ok");
t("影の版を上げた", SHADOW_GATE_VERSION === "sg-2026-11-27");
const disp = readFileSync(join(__dirname, "..", "..", "api", "cron", "auto-reply-dispatch", "route.ts"), "utf8");
t("配線: 送る経路は 場面の関所が on の時だけ場面のキーを作る（off は null）", disp.includes("sceneKey: stageOn(\"AUTO_GATE_SCENE_ALLOW\", null, process.env, [])") && disp.includes(": null,"));
console.log(`auto-gate-scene-stops: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
