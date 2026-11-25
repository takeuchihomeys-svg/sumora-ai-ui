/**
 * 拡張が一連の順番を徹底理解する（2.8.210）
 * npx tsx app/lib/__tests__/flow-series-order-gate.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTO_RULES, AUTO_RULES_REVIEWED_UP_TO } from "../auto-procedure-rules";
import { PLAYBOOK_FLOW_SERIES } from "../action-playbook";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}

const page = readFileSync(join(process.cwd(), "chrome-extension/page-script.js"), "utf8");
const man = JSON.parse(readFileSync(join(process.cwd(), "chrome-extension/manifest.json"), "utf8"));

assert(man.version >= "2.8.210", "manifest >=2.8.210 今=" + man.version);
assert(/_AXLX_PAGE_VER = "2\.8\.2(1[0-9]|2[0-9])"/.test(page), "page ver ≥2.8.210");
assert(AUTO_RULES_REVIEWED_UP_TO >= "2.8.210", "rules reviewed");
assert(AUTO_RULES.some((r) => r.id === "flow_series_order_gate"), "rule exists");
assert(page.includes("flow_series_order_gate"), "RULES_DONE has gate");

assert(page.includes("function _graspFlowSeriesOrder"), "_graspFlowSeriesOrder");
assert(page.includes("function _requireFlowSeriesUpTo"), "_requireFlowSeriesUpTo");
assert(page.includes("_AX_FLOW_SERIES_FALLBACK"), "fallback series");
assert(page.includes('_auditStepP(\n          "flow_series_plan"') || page.includes('"flow_series_plan"'), "plan mark");
assert(page.includes('"flow_series_order"'), "order mark");
assert(page.includes("_flowSeriesResetReached"), "reset on next customer");
assert(page.includes('_graspFlowSeriesOrder("外し前")'), "call before clear");
assert(/_noteFlowSeriesAt\(\s*"before_clear"/.test(page), "before_clear noted");
assert(page.includes('_requireFlowSeriesUpTo("before_clear"'), "gate before fill");
assert(page.includes("before_clear=Y") || page.includes("before_clear=N"), "playbook_seen shows before_clear");

// フォールバック先頭が手順書と同じ before_clear
assert(PLAYBOOK_FLOW_SERIES[0].id === "before_clear", "playbook starts before_clear");
assert(page.indexOf('"before_clear"') < page.indexOf('"after_clear"'), "fallback/order mentions before before after");

console.log("flow-series-order-gate.test OK");
