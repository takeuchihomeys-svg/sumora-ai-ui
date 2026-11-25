/**
 * 外す把握が入れる並みに細かいこと（決定論・DOM無し）
 * npx tsx app/lib/__tests__/clear-detail-grasp.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLAYBOOK_EXTRA_GUIDES, PLAYBOOK_BUILD_V } from "../action-playbook";
import { AUTO_RULES } from "../auto-procedure-rules";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const page = readFileSync(join(process.cwd(), "chrome-extension/page-script.js"), "utf8");

assert(PLAYBOOK_BUILD_V >= 11, "build_v11");
const clear = PLAYBOOK_EXTRA_GUIDES.find((g) => g.id === "clear");
assert(!!clear, "clear guide");
assert((clear!.steps.length || 0) >= 5, "clear steps >=5");
assert(clear!.steps.some((t) => /名前付き|1つずつ言う/.test(t)), "named grasp step");
assert(clear!.rules.includes("clear_detail_grasp"), "rule clear_detail_grasp on guide");
assert(clear!.rules.includes("clear_then_fill_gate"), "rule clear_then_fill_gate on guide");

assert(AUTO_RULES.some((r) => r.id === "clear_detail_grasp"), "AUTO_RULES has clear_detail_grasp");
assert(page.includes("function _listLeftoverNamedItems"), "_listLeftoverNamedItems");
assert(page.includes("_guideLikeClearGrasp(cond)"), "clear grasp wired in _doReset");
assert(page.includes("guide_clear_detail"), "guide_clear_detail mark");
assert(page.includes("外す前 "), "guide_phase_one before clear");
assert(/区残|駅残|間取残|控え:/.test(page), "named leftover prefixes");

console.log("clear-detail-grasp.test OK");
