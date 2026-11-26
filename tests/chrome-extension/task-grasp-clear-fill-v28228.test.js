// 実行: node tests/chrome-extension/task-grasp-clear-fill-v28228.test.js
// v2.8.228: 外す（間取り含む）・入れるを1つずつ task_now/done/next で把握し完了してから次へ
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const sa = fs.readFileSync(path.join(root, "search-audit.js"), "utf8");
const bp = fs.readFileSync(path.join(root, "bulk-panel-grasp.js"), "utf8");
const bd = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(__dirname, "../../app/lib/auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, d) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (d !== undefined ? "  " + String(d).slice(0, 140) : "")); }
}

console.log("\n■ 版");
ok("manifest ≥2.8.228", mf.version >= "2.8.228", mf.version);
ok("page ≥2.8.228", /_AXLX_PAGE_VER = "2\.8\.2(2[8-9]|[3-9]\d)"/.test(ps) || /_AXLX_PAGE_VER = "2\.8\.[3-9]/.test(ps));
ok("rules ≥2.8.228", /AUTO_RULES_REVIEWED_UP_TO = "2\.8\.2(2[8-9]|[3-9]\d)"/.test(rules) || /AUTO_RULES_REVIEWED_UP_TO = "2\.8\.[3-9]/.test(rules));

console.log("\n■ task_grasp（いま／完了／次）");
ok("_publishTaskGrasp", /function _publishTaskGrasp\(/.test(ps));
ok("_clearItemLabel 間取外", /間取外:/.test(ps) && /function _clearItemLabel\(/.test(ps));
ok("task_now / task_done / task_next 印", /task_now/.test(ps) && /task_done/.test(ps) && /task_next/.test(ps));
ok("axlx-task-grasp", /axlx-task-grasp/.test(ps) && /axlx-task-grasp/.test(bd));
ok("RULES_DONE に載る", /"task_grasp_now_done_next"/.test(ps));
ok("決まり task_grasp_now_done_next", /id: "task_grasp_now_done_next"/.test(rules));

console.log("\n■ 外す1つずつ（間取り含む）");
ok("clear で _publishTaskGrasp", /_clearChecksOneByOne[\s\S]{0,1200}_publishTaskGrasp/.test(ps));
ok("間取り clear_stage で把握", /room_layout_id[\s\S]{0,80}"間取り"/.test(ps) && /を1つずつ外す/.test(ps));
ok("間取り外し完了印", /"間取り"[\s\S]{0,200}外し完了/.test(ps) || /stageJa \|\| name\) \+ "外し完了"/.test(ps));
ok("clear_one_by_one 決まり残", /id: "clear_one_by_one"/.test(rules));

console.log("\n■ 入れる1つずつも同型");
ok("fill で _publishTaskGrasp", /_runBasicOneByOne[\s\S]{0,900}_publishTaskGrasp/.test(ps));
ok("入れる: ラベル", /入れる:/.test(ps));
ok("入れ完了:", /入れ完了:/.test(ps));

console.log("\n■ パネル・KEEP");
ok("panel taskNow", /taskNow/.test(bp));
// 2.8.313: KEEP_STEP／RULE_STEP は段の名前が増えて 1200 字の窓では届かない。定義の行ごと（var KEEP_STEP = ... ;）に task_now・task_done・task_next が入っているかを見る
const _stepLine = (nm) => (sa.split("\n").find((l) => new RegExp("^\\s*var " + nm + " = ").test(l)) || "");
ok("KEEP/RULE に task_", /task_now/.test(_stepLine("KEEP_STEP")) && /task_now/.test(_stepLine("RULE_STEP")) && /task_done/.test(_stepLine("KEEP_STEP")) && /task_done/.test(_stepLine("RULE_STEP")) && /task_next/.test(_stepLine("KEEP_STEP")) && /task_next/.test(_stepLine("RULE_STEP")));
ok("PIN に task_", /task_now\|task_done\|task_next/.test(ps));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
