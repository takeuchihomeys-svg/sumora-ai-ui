// 実行: node tests/chrome-extension/search-before-sort-next-guard-v28233.test.js
// v2.8.233: 検索確認前は next＝並べ替えを拒否（根本関所・表面文言直し禁止）
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const bd = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
const sa = fs.readFileSync(path.join(root, "search-audit.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(__dirname, "../../app/lib/auto-procedure-rules.ts"), "utf8");
const rc = fs.readFileSync(path.join(__dirname, "../../app/lib/root-cause-improve-loop.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, d) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (d !== undefined ? "  " + String(d).slice(0, 160) : "")); }
}

console.log("\n■ 版");
ok("manifest ≥2.8.233", mf.version >= "2.8.233", mf.version);
ok("page ≥2.8.233", (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] >= "2.8.233");
ok("rules ≥2.8.233", (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] >= "2.8.233");

console.log("\n■ 根本関所（検索前並べ替え拒否）");
ok("_guardNextMove がある", /function _guardNextMove\(/.test(ps));
ok("_taskNextForPhase がある", /function _taskNextForPhase\(/.test(ps));
ok("_searchConfirmedLocal がある", /function _searchConfirmedLocal\(/.test(ps));
ok("conditions_done → 検索を押す", /conditions_done:\s*"検索を押す"/.test(ps));
ok("並べ替え拒否→検索を押す", /並べ替え[\s\S]{0,120}検索を押す/.test(ps) && /next_move_premature_block/.test(ps));
ok("persist で forcedNext", /forcedNext|_taskNextForPhase\(phase\)/.test(ps));
ok("_publishTaskGrasp で guard", /_publishTaskGrasp[\s\S]{0,200}_guardNextMove/.test(ps) || /nextT = _guardNextMove/.test(ps));
ok("_linkGuidePhaseToTask で guard", /_guardNextMove\(nextBy\[phase\]/.test(ps));
ok("RULES_DONE に search_before_sort_next_guard", /"search_before_sort_next_guard"/.test(ps));
ok("決まり search_before_sort_next_guard", /id: "search_before_sort_next_guard"/.test(rules));
ok("marker _guardNextMove", /marker: "_guardNextMove"/.test(rules));

console.log("\n■ bulk / 監査残し");
ok("bulk が premature_block", /next_move_premature_block/.test(bd));
ok("KEEP に next_move_premature_block", /next_move_premature_block/.test(sa));
ok("RULE に next_move_premature_block", /RULE_STEP[\s\S]{0,800}next_move_premature_block/.test(sa));

console.log("\n■ F64 根本改善ループ配線");
ok("root-cause-improve-loop がある", /evaluateRootCauseImproveLoop/.test(rc));
ok("症例 sort_announce_before_search", /sort_announce_before_search/.test(rc));
ok("表面直し禁止 surface_only", /surface_only/.test(rc));
ok("検証印 next_move_premature_block", /next_move_premature_block/.test(rc));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
