/**
 * v2.8.249: 一連・連携の旧経路パージ（統括Pro協力）
 *   armed_rows/list_visible 等で把握を汚して finishGate(true) していた残りを廃止
 */
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..");
var bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8");
var ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
var mf = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");
var f64 = fs.readFileSync(path.join(root, "app/lib/root-cause-improve-loop.ts"), "utf8");
var n = 0;
var fail = 0;
function ok(name, cond, detail) {
  n++;
  if (cond) console.log("  ✓ " + name);
  else {
    fail++;
    console.log("  ✗ " + name + (detail ? " — " + detail : ""));
  }
}

console.log("\n■ 版");
ok("manifest ≥2.8.249", mf.version >= "2.8.249", mf.version);
ok("page ≥2.8.249", (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] >= "2.8.249");
ok("rules ≥2.8.249", (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] >= "2.8.249");

console.log("\n■ 武装・行ありの旧AD入口を廃止");
ok("finishGate(true,armed_rows) 無し", !/finishGate\(\s*true\s*,\s*"armed_rows"\)/.test(bd));
ok("finishGate(true,armed_list) 無し", !/finishGate\(\s*true\s*,\s*"armed_list"\)/.test(bd));
ok("finishGate(true,list_visible) 無し", !/finishGate\(\s*true\s*,\s*"list_visible"\)/.test(bd));
ok("finishGate(true,sync_pending) 無し", !/finishGate\(\s*true\s*,\s*"sync_pending"\)/.test(bd));
ok("finishGate(true,pending_armed) 無し", !/finishGate\(\s*true\s*,\s*"pending_armed"\)/.test(bd));
ok("markGrasp(armed_rows) 無し", !/markGrasp\(\s*"armed_rows"\)/.test(bd));
ok("markGrasp(list_visible) 無し", !/markGrasp\(\s*"list_visible"\)/.test(bd));
ok("sync_pending_armed 上書き無し", !/why:\s*"sync_pending_armed"/.test(bd));
ok("pending_armed 上書き無し", !/why:\s*"pending_armed"/.test(bd));

console.log("\n■ 正本：screenOkだけ／無い時は待つ");
ok("mem も screenOk 必須", /recent\(_searchGraspedMem\) && _isSearchConfirmGrasp\(_searchGraspedMem\)/.test(bd));
ok("armed_wait_screen", /armed_wait_screen/.test(bd));
ok("list_wait_screen", /list_wait_screen/.test(bd));
ok("screen_ok_path 残存", /screen_ok_path/.test(bd));
ok("sort_legacy 刻まない", !/_stampSortFlowAtom\(\s*"sort_legacy"/.test(bd));
ok("claude_path 開始無し", !/finishGate\(\s*true\s*,\s*"legacy_claude/.test(bd));

console.log("\n■ 決まり・F64");
ok("決まり armed_grasp_no_overwrite", /id: "armed_grasp_no_overwrite"/.test(rules));
ok("RULES_DONE", /"armed_grasp_no_overwrite"/.test(ps));
ok("F64 armed_grasp_overwrite", /armed_grasp_overwrite/.test(f64));

console.log("\n" + n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
