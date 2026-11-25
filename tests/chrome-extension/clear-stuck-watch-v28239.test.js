// 実行: node tests/chrome-extension/clear-stuck-watch-v28239.test.js
// v2.8.239: 外し途中停止でも画面照会・スクショ・最善次手を活用
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const sa = fs.readFileSync(path.join(root, "search-audit.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(__dirname, "../../app/lib/auto-procedure-rules.ts"), "utf8");
const f64 = fs.readFileSync(path.join(__dirname, "../../app/lib/root-cause-improve-loop.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, d) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (d !== undefined ? "  " + String(d).slice(0, 160) : "")); }
}

console.log("\n■ 版");
ok("manifest ≥2.8.239", mf.version >= "2.8.239", mf.version);
ok("page ≥2.8.239", (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] >= "2.8.239");
ok("rules ≥2.8.239", (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] >= "2.8.239");

console.log("\n■ 根本（誤診・誤セレクタ）");
ok("残カウント station_id[]", /name="station_id\[\]"/.test(ps) && /name="route_id\[\]"/.test(ps) && /leftoverN = document\.querySelectorAll/.test(ps));
ok("誤名 station_code を診断で使わない", !/station_code\[\]":checked, input\[name="line_id\[\]"/.test(ps));
ok("clearFillCtx 優先", /clearFillCtx && hasSearch/.test(ps) || /clear_fill_ctx/.test(ps));
ok("_isClearOrFillContext", /function _isClearOrFillContext\(/.test(ps));

console.log("\n■ 外し監視＋改善活用");
ok("_armClearStuckWatch", /function _armClearStuckWatch\(/.test(ps));
ok("_disarmClearStuckWatch", /function _disarmClearStuckWatch\(/.test(ps));
ok("clear で監視武装", /clear\|fill\|search\|sort\|list/.test(ps) && /_armFillSilenceWatch|_armClearStuckWatch/.test(ps));
ok("notifyDone で監視解除", /notifyDone[\s\S]{0,350}_disarmClearStuckWatch/.test(ps));
ok("外し開始で即照会", /clear_start[\s\S]{0,40}leftover_dirty|_screenPollThenApiNext\("clear_start"/.test(ps));
ok("list 外し中は空振りしない", /list_open_conds_clear|list_nudge_clear/.test(ps));
ok("search_form 外し中に次手", /form_nudge_clear|form_open_folded/.test(ps));

console.log("\n■ 決まり・F64・KEEP");
ok("RULES_DONE", /"clear_stuck_watch_use_improvements"/.test(ps));
ok("決まり", /id: "clear_stuck_watch_use_improvements"/.test(rules));
ok("F64症例", /clear_mid_stuck_improvements_unused/.test(f64));
ok("KEEP clear_watch_", /clear_watch_/.test(sa));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
