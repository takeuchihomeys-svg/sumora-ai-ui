/**
 * 2.8.183: 束・手順書の強制取込判定
 * ⚠ テストは chrome-extension/ の外に置く（Chrome は "_" 始まりのフォルダを拒否する）
 * node tests/chrome-extension/learn-refresh-gate-v28183.test.js
 */
"use strict";
var path = require("path");
var gate = require(path.join(__dirname, "../../chrome-extension/learn-refresh-gate.js"));
var pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
}

console.log("■ shouldForceLearnRefresh");
ok("更新直後は force", gate.shouldForceLearnRefresh({ axlx_learn_after_update: true }).force === true);
ok("needs_auto は force", gate.shouldForceLearnRefresh({ axlx_learn_needs_auto: true, axlx_learn_ver: "x" }).force === true);
ok("手順書無しは force", gate.shouldForceLearnRefresh({
  axlx_learn_ver: "v",
  axlx_learn_screen: { a: 1 },
  axlx_learn_link: { screen_solid: 5 },
  axlx_learn_next: { a: 1 },
  axlx_learn_points: { a: 1 },
}).reason === "playbook_missing");
ok("build_v6 は force", gate.shouldForceLearnRefresh({
  axlx_learn_ver: "v",
  axlx_learn_screen: { a: 1 },
  axlx_learn_link: { screen_solid: 5 },
  axlx_learn_next: { a: 1 },
  axlx_learn_points: { a: 1 },
  axlx_learn_playbook: { build_v: 6, rules: [{ id: "x" }], flow_series: [] },
}).reason === "playbook_build_old");
ok("build_v7+flow無しは force", gate.shouldForceLearnRefresh({
  axlx_learn_ver: "v",
  axlx_learn_screen: { a: 1 },
  axlx_learn_link: { screen_solid: 5 },
  axlx_learn_next: { a: 1 },
  axlx_learn_points: { a: 1 },
  axlx_learn_playbook: { build_v: 7, rules: [{ id: "x" }], flow_series: [] },
}).reason === "playbook_no_flow_series");
ok("揃っていれば force しない", gate.shouldForceLearnRefresh({
  axlx_learn_ver: "v",
  axlx_learn_screen: { a: 1 },
  axlx_learn_link: { screen_solid: 5 },
  axlx_learn_next: { a: 1 },
  axlx_learn_points: { a: 1 },
  axlx_learn_playbook: {
    build_v: 7,
    rules_v: "aaa11111",
    rules: [{ id: "x" }],
    flow_series: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }],
  },
}).force === false);
ok("サーバ rules_v ずれは force", gate.shouldForceLearnRefresh({
  axlx_learn_ver: "v",
  axlx_learn_screen: { a: 1 },
  axlx_learn_link: { screen_solid: 5 },
  axlx_learn_next: { a: 1 },
  axlx_learn_points: { a: 1 },
  axlx_learn_playbook: {
    build_v: 7,
    rules_v: "oldold01",
    rules: [{ id: "x" }],
    flow_series: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }],
  },
}, { serverRulesV: "newnew02" }).reason === "playbook_rules_v_stale");

console.log("■ modeOpenedForLearn");
ok("autoModeAt 新規", gate.modeOpenedForLearn("autoModeAt", 0, 123) === true);
ok("autoModeAt 同じ", gate.modeOpenedForLearn("autoModeAt", 123, 123) === false);
ok("aixMode ON", gate.modeOpenedForLearn("aixMode", false, true) === true);
ok("aixMode 既にON", gate.modeOpenedForLearn("aixMode", true, true) === false);

console.log("■ Chrome 予約名（拡張フォルダに _ 始まりを置かない）");
var fs = require("fs");
var extRoot = path.join(__dirname, "../../chrome-extension");
var bad = fs.readdirSync(extRoot).filter(function (n) {
  return n.charAt(0) === "_" && n !== "_locales" && n !== "_metadata";
});
ok("chrome-extension 直下に禁止の _* が無い", bad.length === 0, bad.join(","));

console.log("\n結果: ✓" + pass + " ✗" + fail);
process.exit(fail ? 1 : 0);
