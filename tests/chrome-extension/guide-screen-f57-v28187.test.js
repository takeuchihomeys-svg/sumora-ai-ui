/**
 * 2.8.187: F57 手順書×画面照会の細部完了仕組み
 * node tests/chrome-extension/guide-screen-f57-v28187.test.js
 */
"use strict";
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "../..");
var page = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
var bulk = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8");
var bg = fs.readFileSync(path.join(root, "chrome-extension/background.js"), "utf8");
var man = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var lib = fs.readFileSync(path.join(root, "app/lib/guide-screen-grasp.ts"), "utf8");
var found = fs.readFileSync(path.join(root, "app/lib/learn-foundation-audit.ts"), "utf8");
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

console.log("■ 2.8.187 F57 手順書×画面 細部完了仕組み");
ok("manifest ≥2.8.187", verGe(man.version, "2.8.187"), man.version);
ok("guide-screen-grasp 純関数", /auditGuideScreenGrasp/.test(lib) && /improve_complete/.test(lib));
ok("F57_guide_screen_grasp 土台", /F57_guide_screen_grasp/.test(found));
ok("駅スキップ印", /_guideLikeStationSkip/.test(page) && /guide_phase_station_skip/.test(page));
ok("地域スキップ印", /_guideLikeAreaSkip/.test(page));
ok("guide_detail_ledger", /guide_detail_ledger/.test(page));
ok("next_flow ライブ", /_liveDlStep\(\"next_flow_grasp\"/.test(bulk));
ok("スタッフ監査開けたまま（186維持）", /_keepAuditOpenAfterFill/.test(bg));
ok("__tests__ 無し", !fs.existsSync(path.join(root, "chrome-extension/__tests__")));

console.log("\n結果: ✓" + pass + " ✗" + fail);
process.exit(fail ? 1 : 0);
