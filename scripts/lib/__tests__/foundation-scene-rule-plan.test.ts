// npx tsx scripts/lib/__tests__/foundation-scene-rule-plan.test.ts
// 2026-11-23 作業員N2（台帳 #505）: 場面の決まりの空きを、どの台本で数えるか
import assert from "node:assert/strict";
import { sceneRulePlanOf } from "../foundation-scene-rule-plan";
const p = sceneRulePlanOf([
  { id: "n.asks", name: "要件", owner: "作業員M", emptyScenes: ["considering", "conditions"] },
  { id: "n.appeal", name: "訴求", owner: "作業員K2", emptyScenes: ["conditions"] },
  { id: "n.flex", name: "臨機応変", owner: "作業員N", emptyScenes: ["ack"] },
  { id: "n.trust", name: "信頼", owner: "作業員N", emptyScenes: [] },
], { days: 60, outDir: "x" });
assert.equal(p.length, 3, "空きの無い土台は出さない");
assert.ok(p[0].cmd!.includes("--kb-scenes=返信:検討中・一時保留,返信:条件提示"));
assert.ok(p[1].cmd!.includes("--scenes=conditions") && p[1].cmd!.some((c) => c.startsWith("--kb-json=x/n.appeal")));
assert.equal(p[2].cmd, null, "形を数える台本の無い土台は持ち主に返す");
console.log("foundation-scene-rule-plan: ok");
