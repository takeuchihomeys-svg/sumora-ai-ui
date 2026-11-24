// 実行: node tests/chrome-extension/continuous-series-next-grasp-v28235.test.js
// v2.8.235: 一連完了→次客 で loop_advance／who／next_move を必ず残す
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const bd = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
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
ok("manifest ≥2.8.235", mf.version >= "2.8.235", mf.version);
ok("page ≥2.8.235", (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] >= "2.8.235");
ok("rules ≥2.8.235", (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] >= "2.8.235");

console.log("\n■ bulk 一連→次客");
ok("_stampSeriesToNextCustomer", /function _stampSeriesToNextCustomer\(/.test(bd));
ok("sendBatchDone から stamp", /_sendBatchDone[\s\S]{0,400}_stampSeriesToNextCustomer/.test(bd));
ok("loop_advance 印", /_liveDlStep\(\s*"loop_advance"/.test(bd));
ok("loop_who_grasp 印", /_liveDlStep\(\s*"loop_who_grasp"/.test(bd));
ok("axlx-series-handoff", /axlx-series-handoff/.test(bd) && /axlx-series-handoff/.test(ps));
ok("RULES_DONE", /"continuous_series_next_grasp"/.test(ps));
ok("決まり continuous_series_next_grasp", /id: "continuous_series_next_grasp"/.test(rules));

console.log("\n■ page / bg");
ok("page が series-handoff 受信", /from !== "axlx-series-handoff"/.test(ps) || /from !== 'axlx-series-handoff'/.test(ps));
ok("page loop_advance on handoff", /axlx-series-handoff[\s\S]{0,1200}loop_advance/.test(ps) || /series_handoff[\s\S]{0,200}loop_advance/.test(ps));
ok("bg fill一連でも loop_advance", /fill一連完了→次へ/.test(bg) || /series_done[\s\S]{0,400}loop_advance/.test(bg));
ok("KEEP/RULE dl:loop_advance", /dl:loop_advance/.test(sa));

console.log("\n■ F64");
ok("症例 continuous_loop_advance_thin", /continuous_loop_advance_thin/.test(rc));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
