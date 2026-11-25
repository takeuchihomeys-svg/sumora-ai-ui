// 実行: node tests/chrome-extension/silence-stale-wiring-v28241.test.js
// v2.8.241: 沈黙監視配線＋古いgrasp無効化
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const ct = fs.readFileSync(path.join(root, "content.js"), "utf8");
const bd = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
const sa = fs.readFileSync(path.join(root, "search-audit.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(__dirname, "../../app/lib/auto-procedure-rules.ts"), "utf8");
const f64 = fs.readFileSync(path.join(__dirname, "../../app/lib/root-cause-improve-loop.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, d) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (d !== undefined ? "  " + String(d).slice(0, 180) : "")); }
}

console.log("\n■ 版");
ok("manifest ≥2.8.241", mf.version >= "2.8.241", mf.version);
ok("page ≥2.8.241", (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] >= "2.8.241");
ok("rules ≥2.8.241", (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] >= "2.8.241");

console.log("\n■ 沈黙監視配線");
ok("_armFillSilenceWatch", /function _armFillSilenceWatch\(/.test(ps));
ok("fill_start で武装", /fill_start[\s\S]{0,200}_armFillSilenceWatch|_armFillSilenceWatch\("fill_start"\)/.test(ps));
ok("now_action 全段で武装", /clear\|fill\|search\|sort\|list/.test(ps) && /_armFillSilenceWatch/.test(ps));
ok("沈黙で screenPoll", /silence_watch[\s\S]{0,80}_screenPollThenApiNext|_screenPollThenApiNext\("silence_watch"/.test(ps));
ok("escalate→notifyDone", /silence_stuck[\s\S]{0,120}notifyDone|notifyDone\([\s\S]{0,80}silence_stuck/.test(ps));
ok("heartbeat/force flush", /_forceAuditStepsFlush\("silence_tick|silence_tick_pre"\)|_emitFillProgressHeartbeat\("silence_tick"\)/.test(ps));

console.log("\n■ 古いデータ無効化");
ok("_invalidateStaleSearchGrasp", /function _invalidateStaleSearchGrasp\(/.test(ps));
ok("_readFreshSearchGrasp", /function _readFreshSearchGrasp\(/.test(ps));
ok("fill_start で invalidate/foundation", /_enforceAutoFoundation\("fill_start"\)|_invalidateStaleSearchGrasp\("fill_start"\)/.test(ps));
ok("old_ver / cid / stripped", /old_ver:|cid_mismatch|stripped_empty/.test(ps));
ok("content が薄い上書きしない", /薄いオブジェクトを新規に書かない|完全な印が無い時は薄い/.test(ct) || /flushWhy/.test(ct) && !/setItem\("axlx_search_grasped_sync", JSON\.stringify\(\{\s*at: Date\.now\(\), why:/.test(ct));
ok("bulk が clear を受ける", /axlx-search-grasped-clear/.test(bd));

console.log("\n■ 決まり・F64・KEEP");
ok("RULES_DONE silence", /"silence_stuck_watch_and_flush"/.test(ps));
ok("RULES_DONE stale", /"stale_grasp_invalidate_fresh_only"/.test(ps));
ok("決まり silence", /id: "silence_stuck_watch_and_flush"/.test(rules));
ok("決まり stale", /id: "stale_grasp_invalidate_fresh_only"/.test(rules));
ok("F64症例", /silence_hang_no_stuck_wiring/.test(f64));
ok("KEEP silence_watch_", /silence_watch_/.test(sa));
ok("KEEP stale_grasp_drop", /stale_grasp_drop/.test(sa));
ok("RULE_STEP dl:stale_grasp_drop", /dl:stale_grasp_drop/.test(sa));
ok("決まり kb silence", /d2f56bec|4e466a5c/.test(rules));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
