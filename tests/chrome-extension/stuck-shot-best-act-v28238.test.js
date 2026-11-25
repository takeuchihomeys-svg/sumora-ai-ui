// 実行: node tests/chrome-extension/stuck-shot-best-act-v28238.test.js
// v2.8.238: 詰まり時スクショ→原因→拡張が最善次手
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const hlr = fs.readFileSync(path.join(root, "human-learn-record.js"), "utf8");
const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
const sa = fs.readFileSync(path.join(root, "search-audit.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(__dirname, "../../app/lib/auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, d) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (d !== undefined ? "  " + String(d).slice(0, 160) : "")); }
}

console.log("\n■ 版");
ok("manifest ≥2.8.238", mf.version >= "2.8.238", mf.version);
ok("page ≥2.8.238", (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] >= "2.8.238");
ok("rules ≥2.8.238", (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] >= "2.8.238");

console.log("\n■ スクショ＋最善次手");
ok("_requestStuckShot", /function _requestStuckShot\(/.test(ps));
ok("_actBestNextFromStuck", /function _actBestNextFromStuck\(/.test(ps));
ok("切れ時にスクショ依頼", /_screenPollThenApiNext[\s\S]{0,400}_requestStuckShot|_requestStuckShot\(d/.test(ps));
ok("切れ時に最善次手", /_screenPollThenApiNext[\s\S]{0,900}_actBestNextFromStuck/.test(ps));
ok("回復したら再試行", /stuck_recover_retry/.test(ps) && /stuckRecoveredOnce/.test(ps));
ok("hlr が stuck shot を撮る", /axlx-stuck-shot-req/.test(hlr) && /shootAfter\("stuck_/.test(hlr));
ok("bg がタブ前出し", /axlx-stuck-focus-tab/.test(bg));

console.log("\n■ 決まり");
ok("RULES_DONE", /"stuck_shot_then_best_act"/.test(ps));
ok("決まり", /id: "stuck_shot_then_best_act"/.test(rules));
ok("KEEP stuck_shot_req", /stuck_shot_req/.test(sa));
ok("KEEP stuck_best_act", /stuck_best_act/.test(sa));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
