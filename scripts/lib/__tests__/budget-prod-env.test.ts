// 毎朝の1枚の使用額は本番のスイッチの組で読む（作業員L 11/25）
import assert from "node:assert/strict";
import { budgetEnvFrom } from "../budget-prod-env";

const a = budgetEnvFrom({ LLM_BUDGET_ROUTE: "off", CLAUDE_SPEND_BASE_USD: "10", OTHER: "x" }, { BRAIN_X: "on" });
assert.equal(a.from, "prod");
assert.equal(a.env.LLM_BUDGET_ROUTE, undefined);
assert.equal(a.env.CLAUDE_SPEND_BASE_USD, undefined);
assert.equal(a.env.OTHER, "x");
assert.deepEqual(a.dropped, ["CLAUDE_SPEND_BASE_USD", "LLM_BUDGET_ROUTE"]);
const b = budgetEnvFrom({ LLM_BUDGET_ROUTE: "off" }, { LLM_BUDGET_ROUTE: "shadow" });
assert.equal(b.env.LLM_BUDGET_ROUTE, "shadow");
const c = budgetEnvFrom({ LLM_BUDGET_ROUTE: "off" }, null);
assert.equal(c.from, "local");
assert.equal(c.env.LLM_BUDGET_ROUTE, "off");
console.log("budget-prod-env ok 3");
