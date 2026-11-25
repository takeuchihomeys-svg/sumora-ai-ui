// 実行: node tests/chrome-extension/task-api-refresh-before-next-v28230.test.js
// v2.8.230: 次タスク前にAPI束取込＋関所（検索と同型）・弱い段の強化
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const sa = fs.readFileSync(path.join(root, "search-audit.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(__dirname, "../../app/lib/auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, d) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (d !== undefined ? "  " + String(d).slice(0, 140) : "")); }
}

console.log("\n■ 版");
ok("manifest ≥2.8.230", mf.version >= "2.8.230", mf.version);
ok("page ≥2.8.230", /_AXLX_PAGE_VER = "2\.8\.(230|231|232)"/.test(ps));
ok("rules ≥2.8.230", /AUTO_RULES_REVIEWED_UP_TO = "2\.8\.(230|231|232)"/.test(rules));

console.log("\n■ API取込関所（検索と同型）");
ok("_graspBeforeNextTaskThen", /function _graspBeforeNextTaskThen\(/.test(ps));
ok("_requestLearnRefresh を呼ぶ", /_graspBeforeNextTaskThen[\s\S]{0,1600}_requestLearnRefresh\(/.test(ps));
ok("task_api_refresh 印", /task_api_refresh/.test(ps));
ok("task_transition_gate 印", /task_transition_gate/.test(ps));
ok("task_transition_gate_weak 印", /task_transition_gate_weak/.test(ps));
ok("_recentTaskTransitionGrasped", /function _recentTaskTransitionGrasped\(/.test(ps));

console.log("\n■ clear_then_fill が Then 関所");
ok("clear_then_fill で Then", /_graspBeforeNextTaskThen\("clear_then_fill"/.test(ps));
ok("Then のあと callback", /_graspBeforeNextTaskThen\("clear_then_fill"[\s\S]{0,200}setTimeout\(callback/.test(ps));

console.log("\n■ 弱い段の強化");
ok("leftover dirty Then", /leftover_dirty外し開始/.test(ps) && /_graspBeforeNextTaskThen\("clear"/.test(ps));
ok("place_done Then", /_graspBeforeNextTaskThen\("place_done"/.test(ps));
ok("conditions_done Then", /_graspBeforeNextTaskThen\("conditions_done"/.test(ps));
ok("fill_start Then", /_graspBeforeNextTaskThen\("fill_start"/.test(ps));
ok("fill_done Then", /_graspBeforeNextTaskThen\("fill_done"/.test(ps));
ok("handoff Then", /_graspBeforeNextTaskThen\("handoff"/.test(ps));

console.log("\n■ 決まり・KEEP");
ok("決まり task_api_refresh_before_next", /id: "task_api_refresh_before_next"/.test(rules));
ok("RULES_DONE", /"task_api_refresh_before_next"/.test(ps));
ok("KEEP に task_transition_gate|task_api_refresh", /KEEP_STEP[\s\S]{0,2000}task_transition_gate/.test(sa) && /task_api_refresh/.test(sa));
ok("PIN に task_transition_gate|task_api_refresh", /task_transition_gate/.test(ps) && /task_api_refresh/.test(ps));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
