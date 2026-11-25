// 実行: node tests/chrome-extension/guide-phase-task-link-v28231.test.js
// v2.8.231: 手順書×画面照会 → task_now/done/next 連携
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const bd = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
const sa = fs.readFileSync(path.join(root, "search-audit.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(__dirname, "../../app/lib/auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, d) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (d !== undefined ? "  " + String(d).slice(0, 140) : "")); }
}

console.log("\n■ 版");
ok("manifest ≥2.8.231", mf.version >= "2.8.231", mf.version);
ok("page ≥2.8.231", /_AXLX_PAGE_VER = "2\.8\.(231|232)"/.test(ps));
ok("rules ≥2.8.231", /AUTO_RULES_REVIEWED_UP_TO = "2\.8\.(231|232)"/.test(rules));

console.log("\n■ 連携関数");
ok("_linkGuidePhaseToTask", /function _linkGuidePhaseToTask\(/.test(ps));
ok("window 公開", /__axlxLinkGuidePhaseToTask/.test(ps));
ok("__axlxPublishTaskGrasp", /__axlxPublishTaskGrasp/.test(ps));
ok("guide_task_link 印", /guide_task_link/.test(ps));

console.log("\n■ guide_phase → task 呼び出し");
ok("phaseCheck screen path", /screenFallback[\s\S]{0,400}__axlxLinkGuidePhaseToTask/.test(ps) || /画面把握[\s\S]{0,500}__axlxLinkGuidePhaseToTask/.test(ps));
ok("phaseCheck finish path", /focus1\.length[\s\S]{0,600}__axlxLinkGuidePhaseToTask/.test(ps));
ok("after_clear link", /__axlxLinkGuidePhaseToTask\("after_clear"/.test(ps));
ok("after_search link", /__axlxLinkGuidePhaseToTask\("after_search"/.test(ps));

console.log("\n■ bulk 一覧連携");
ok("list_flow → axlx-task-grasp", /_guideLikeListFlowGrasp[\s\S]{0,4000}axlx-task-grasp/.test(bd));
ok("dl:guide_task_link", /guide_task_link/.test(bd));

console.log("\n■ 決まり・KEEP");
ok("決まり guide_phase_task_link", /id: "guide_phase_task_link"/.test(rules));
ok("RULES_DONE", /"guide_phase_task_link"/.test(ps));
ok("KEEP/RULE guide_task_link", /guide_task_link/.test(sa));
ok("PIN guide_task_link", /guide_task_link/.test(ps));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
