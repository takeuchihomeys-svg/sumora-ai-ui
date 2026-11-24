/** v2.8.259: 並べ替え見出し — wait_head／表スクロール禁止／回復探索 */
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..");
var bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8");
var ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
var rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");
var mf = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var n = 0, fail = 0;
function ok(name, cond) {
  n++;
  if (cond) console.log("  ✓ " + name);
  else { fail++; console.log("  ✗ " + name); }
}
ok("manifest ≥2.8.259", mf.version >= "2.8.259");
ok("sort_gate_wait_head", /sort_gate_wait_head/.test(bd));
ok("wait_head path", /path: "wait_head"/.test(bd));
ok("sort_head_scroll0 再探索", /sort_head_scroll0/.test(bd));
ok("sort_head_recover 印", /sort_head_recover/.test(bd));
ok("sort_panel_clear 退避", /sort_panel_clear/.test(bd) && /sort_panel_restore/.test(bd));
ok("sort_head_point 保険", /sort_head_point/.test(bd));
ok("dom_synth aim", /dom_synth/.test(bd));
ok("棟戸 under 候補", /reTooriOnly/.test(bd) && /①b/.test(bd));
// 実行コード: querySelector(main_table)+scrollIntoView が _sortOnce 内に無い
var sortOnce = bd.slice(bd.indexOf("function _sortOnce"), bd.indexOf("function _startAutoPressRun"));
ok("見出し前の table scrollIntoView 実行なし", !(/querySelector\([^\)]*main_table[^\)]*\)[\s\S]{0,120}scrollIntoView/.test(sortOnce)));
ok("page evidence 棟戸 head", /div\.under, \.under/.test(ps) && /2\.8\.259/.test(ps));
ok("RULES_DONE", /sort_head_recover_no_table_scroll/.test(ps));
ok("AUTO_RULES", /id: "sort_head_recover_no_table_scroll"/.test(rules));
ok("REVIEWED ≥2.8.259", (function () {
  var m = rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/);
  return m && m[1] >= "2.8.259";
})());
console.log(n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
