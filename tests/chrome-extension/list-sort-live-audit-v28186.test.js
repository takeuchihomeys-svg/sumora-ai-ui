/**
 * 2.8.186: スタッフでも監査を開けたまま／並べ替え・一覧印をライブで監査へ
 * node tests/chrome-extension/list-sort-live-audit-v28186.test.js
 */
"use strict";
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "../..");
var bulk = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8");
var bg = fs.readFileSync(path.join(root, "chrome-extension/background.js"), "utf8");
var man = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
}
function verGe(a, b) {
  var pa = String(a).split(".").map(Number);
  var pb = String(b).split(".").map(Number);
  for (var i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return true;
}

console.log("■ 2.8.186 一覧・並べ替えライブ監査／スタッフ早期クローズ止め");
ok("manifest ≥2.8.186", verGe(man.version, "2.8.186"), man.version);
ok("_staffModeChosen がある", /_staffModeChosen/.test(bg));
ok("_keepAuditOpenAfterFill がある", /_keepAuditOpenAfterFill/.test(bg));
ok("スタッフでも fill 後に閉じない", /_keepAuditOpenAfterFill\(\)\s*_humanRun = false/.test(bg) || /_keepAuditOpenAfterFill\(\)\)\s*_humanRun = false/.test(bg));
ok("axlx-audit-live-step 受信", /axlx-audit-live-step/.test(bg));
ok("_liveDlStep がある", /function _liveDlStep/.test(bulk));
ok("search_to_sort がライブ", /_liveDlStep\(\"search_to_sort\"/.test(bulk));
ok("list_flow がライブ", /_liveDlStep\(\"list_flow_grasp\"/.test(bulk));
ok("並べ替え前に list_start 照合", /並べ替え前に一覧[\s\S]{0,200}_guideLikeListFlowGrasp\(\"list_start\"/.test(bulk));
ok("__tests__ が拡張直下に無い", !fs.existsSync(path.join(root, "chrome-extension/__tests__")));

console.log("\n結果: ✓" + pass + " ✗" + fail);
process.exit(fail ? 1 : 0);
