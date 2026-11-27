// 実行: node tests/chrome-extension/clear-method-api-transition-v28229.test.js
// v2.8.229: 次タスク移行でAPI手順書の外し方把握＋検索と同型の永続
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const sa = fs.readFileSync(path.join(root, "search-audit.js"), "utf8");
const bd = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(__dirname, "../../app/lib/auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, d) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (d !== undefined ? "  " + String(d).slice(0, 140) : "")); }
}

console.log("\n■ 版");
ok("manifest ≥2.8.229", mf.version >= "2.8.229", mf.version);
// 2.8.313 版の固定をやめ「以上」を数で見る
const _patch = (re, s) => { const m = re.exec(s); return m ? parseInt(m[1], 10) : -1; };
ok("page ≥2.8.229", _patch(/_AXLX_PAGE_VER = "2\.8\.(\d+)"/, ps) >= 229);
ok("rules ≥2.8.229", _patch(/AUTO_RULES_REVIEWED_UP_TO = "2\.8\.(\d+)"/, rules) >= 229);

console.log("\n■ APIで外し方把握");
ok("_graspClearMethodFromPlaybook", /function _graspClearMethodFromPlaybook\(/.test(ps));
ok("extra_guides clear を読む", /extra_guides/.test(ps) && /id === "clear"/.test(ps));
ok("clear_method_api_grasp 印", /clear_method_api_grasp/.test(ps));
ok("clear_method_api_miss 印", /clear_method_api_miss/.test(ps));
ok("_loadLearnNext(true) で束を再読", /_loadLearnNext\(true\)/.test(ps));

console.log("\n■ 外し方理解台帳");
ok("_auditClearMethodLedger", /function _auditClearMethodLedger\(/.test(ps));
ok("clear_method_ledger / ok / gap", /clear_method_ledger/.test(ps) && /clear_method_ok/.test(ps) && /clear_method_gap/.test(ps));
ok("_noteClearMethod が外す済意図", /function _noteClearMethod[\s\S]{0,900}_noteIntentUnderstood\(k, "clear"/.test(ps));

console.log("\n■ 次タスク移行＝検索と同型");
ok("_persistTaskTransitionGrasped", /function _persistTaskTransitionGrasped\(/.test(ps));
ok("axlx_task_grasped_sync", /axlx_task_grasped_sync/.test(ps));
ok("axlx-task-grasped", /axlx-task-grasped/.test(ps) && /axlx-task-grasped/.test(bd));
ok("_graspBeforeNextTask", /function _graspBeforeNextTask\(/.test(ps));
ok("clear_then_fill で graspBeforeNext", /_graspBeforeNextTask(Then)?\("clear_then_fill"/.test(ps));
// 2.8.313: leftover dirty は _screenPollThenApiNext("clear_start", "leftover_dirty") → _graspBeforeNextTaskThen(phase) の形になった
ok("leftover dirty で graspBeforeNext", /_screenPollThenApiNext\("clear_start", "leftover_dirty"/.test(ps) && /function _screenPollThenApiNext[\s\S]*?_graspBeforeNextTaskThen\(\s*String\(phase/.test(ps));
ok("dl:task_transition_grasp", /task_transition_grasp/.test(bd));

console.log("\n■ 決まり・KEEP");
ok("決まり clear_method_api_grasp_transition", /id: "clear_method_api_grasp_transition"/.test(rules));
ok("RULES_DONE", /"clear_method_api_grasp_transition"/.test(ps));
const _kLine = (sa.match(/var KEEP_STEP = .*/) || [""])[0], _rLine = (sa.match(/var RULE_STEP = .*/) || [""])[0];
ok("KEEP/RULE に clear_method_api_|task_transition", /task_transition_grasp/.test(_kLine) && /clear_method_api_/.test(_rLine));
ok("PIN に task_transition|clear_method_api", /task_transition_grasp|clear_method_api_/.test(ps));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
