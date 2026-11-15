// scripts/test-exam-prod-env.ts — 試験の env に本番のスイッチの組を下敷きに入れる（2026-11-15 作業員I・LLM/DB なし）
import assert from "node:assert/strict";
import { parseSwitchText, prodEnvWanted } from "./lib/exam-prod-env";
let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
t("K=V の並び → env（LLM_・EXAM_・AUTOMATION_・鍵らしい名前は入れない）", () => {
  const e = parseSwitchText("BRAIN_MESSAGE_PLAN=off\nCHECK_REQUEST_FOCUS=on\nLLM_TEST_MODE=x\nEXAM_MAX_USD=9\nAUTOMATION_RUN=on\nFOO_API_KEY=abc\nNOW_REGION=iad1\n\n=bad");
  assert.deepEqual(e, { BRAIN_MESSAGE_PLAN: "off", CHECK_REQUEST_FOCUS: "on", NOW_REGION: "iad1" });
});
t("入れるか: EXAM_PROD_ENV が一番強い → 依頼の印 → 係の設定（時刻から）", () => {
  assert.equal(prodEnvWanted({}), true, "既定 on");
  assert.equal(prodEnvWanted({ config: { prodEnv: "off" } }), false);
  assert.equal(prodEnvWanted({ config: { prodEnvFrom: "2026-11-15T13:00:00Z" }, nowMs: Date.parse("2026-11-15T12:00:00Z") }), false);
  assert.equal(prodEnvWanted({ jobProdEnv: true }), true);
  assert.equal(prodEnvWanted({ jobProdEnv: true, env: { EXAM_PROD_ENV: "off" } }), false);
  assert.equal(prodEnvWanted({ env: { EXAM_PROD_ENV: "on" } }), true);
  assert.equal(prodEnvWanted({ config: { prodEnv: "on" } }), true);
  assert.equal(prodEnvWanted({ config: { prodEnv: "on", prodEnvFrom: "2026-11-15T12:00:00Z" }, nowMs: Date.parse("2026-11-15T11:00:00Z") }), false);
  assert.equal(prodEnvWanted({ config: { prodEnv: "on", prodEnvFrom: "2026-11-15T12:00:00Z" }, nowMs: Date.parse("2026-11-15T13:00:00Z") }), true);
});
console.log(`全部 ${n} 件 ok`);
