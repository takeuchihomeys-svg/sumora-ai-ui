/**
 * 2.8.185: 検索完了→並べ替え→AD→高→低（画像赤丸）強化
 * node tests/chrome-extension/ad-sort-hilo-v28185.test.js
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

console.log("■ 2.8.185 AD高→低／検索→並べ替え");
ok("manifest ≥2.8.185", verGe(man.version, "2.8.185"), man.version);
ok("search_to_sort 印", /search_to_sort/.test(bulk));
ok("waitHiToLo ポーリング", /waitHiToLo/.test(bulk) && /maxTries = 8/.test(bulk));
ok("高・低 文言ゆれ", /高・低/.test(bulk) && /高⇒低/.test(bulk));
ok("学習 aim 暖め", /__axlxSortHiloAim|sort_aim_warm/.test(bulk));
ok("sort_detail は listChrome 除外", /span\.sort_detail[\s\S]{0,80}return false/.test(bulk));
// 2.8.186 以降は _keepAuditOpenAfterFill()（自動／AIX／スタッフ）で閉じない（_autoModeChosen はその中身）
ok("自動中は human_search_done で閉じない",
  /if \(_humanRun && _keepAuditOpenAfterFill\(\)\) _humanRun = false/.test(bg)
  && /function _keepAuditOpenAfterFill\(\)\s*\{\s*return !!\(_autoModeChosen/.test(bg));
ok("__tests__ が拡張直下に無い", !fs.existsSync(path.join(root, "chrome-extension/__tests__")));

console.log("\n結果: ✓" + pass + " ✗" + fail);
process.exit(fail ? 1 : 0);
