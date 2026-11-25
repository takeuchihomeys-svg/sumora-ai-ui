// 実行: node tests/chrome-extension/one-task-complete-before-next-v28225.test.js
// v2.8.225: 1つずつタスク完了してから次へ（印だけの補完で進めない）
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
  else { fail++; console.log("  ✗ " + name + (d !== undefined ? "  " + String(d).slice(0, 120) : "")); }
}

console.log("\n■ 版");
ok("manifest ≥2.8.225", mf.version >= "2.8.225", mf.version);
ok("page ≥2.8.225", /_AXLX_PAGE_VER = "2\.8\.2(2[5-9]|[3-9]\d)"/.test(ps));
ok("rules ≥2.8.225", /AUTO_RULES_REVIEWED_UP_TO = "2\.8\.2(2[5-9]|[3-9]\d)"/.test(rules));

console.log("\n■ 関所（完了してから次へ）");
ok("印だけ補完を廃止", !/関所で補完[^」]/.test(ps) && !/_beforeOk\s*=\s*true;\s*\/\*\s*関所で補完/.test(ps));
ok("one_task_gate_block", /one_task_gate_block/.test(ps));
ok("未達なら guide_clear し直し", /one_task_gate_block[\s\S]{0,200}_guideLikeClearGrasp/.test(ps));
ok("再関所 _requireFlowSeriesUpTo", /clear_then_fill再関所/.test(ps));
ok("one_task_incomplete", /one_task_incomplete/.test(ps));
ok("one_task_done", /one_task_done/.test(ps));
ok("dirty+未達で redo", /関所未達\+dirty/.test(ps) || /関所未達\+dirty → _doReset/.test(ps));
ok("未達のまま clear_then_fill 完了扱いにしない", /!dirty && _beforeOk/.test(ps));

console.log("\n■ 既存の1つずつ関所も残る");
ok("_requireFlowSeriesUpTo", /function _requireFlowSeriesUpTo\(/.test(ps));
ok("guide_phase_block で致命停止", /guide_phase_block[\s\S]{0,80}notifyDone/.test(ps) || /guide_phase_block[\s\S]{0,120}return;/.test(ps));
ok("clear_then_fill_gate 決まり", /id: "clear_then_fill_gate"/.test(rules));
ok("flow_series_order_gate 決まり", /id: "flow_series_order_gate"/.test(rules));
ok("one_task_complete_before_next 決まり", /id: "one_task_complete_before_next"/.test(rules));
ok("RULES_DONE に載る", /"one_task_complete_before_next"/.test(ps));
ok("KEEP/RULE に one_task_", /KEEP_STEP[\s\S]{0,900}one_task_/.test(sa) && /RULE_STEP[\s\S]{0,900}one_task_/.test(sa));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
