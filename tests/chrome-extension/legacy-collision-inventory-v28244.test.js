/**
 * v2.8.244: 昔経路×新関所の衝突インベントリ（回帰防止）
 * 竹内さん「ぶつかっていた昔の経路ほかにないか徹底調査」
 */
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..");
var ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
var bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8");
var ct = fs.readFileSync(path.join(root, "chrome-extension/content.js"), "utf8");
var mf = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");
var n = 0, fail = 0;
function ok(name, cond, detail) {
  n++;
  if (cond) console.log("  ✓ " + name);
  else { fail++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
}

console.log("\n■ 版");
ok("manifest ≥2.8.244", mf.version >= "2.8.244", mf.version);
ok("page ≥2.8.244", (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] >= "2.8.244");

console.log("\n■ A. AD関所の衝突（screenOk無しで進まない）");
ok("A1 finishGate(true)でもscreenOk必須", /okGate && String\(why[\s\S]{0,200}_isSearchConfirmGrasp/.test(bd));
ok("A2 armed_rows を確認扱いにしない", /armed_rows[\s\S]{0,40}return false/.test(bd) || /armed_rows\|armed_list\|sync_pending/.test(bd));
ok("A3 why武装印は拒否リスト", /armed_rows\|armed_list\|sync_pending\|pending_armed\|list_visible/.test(bd));
ok("A4 human_search alone で確認しない", /human_search\|armed_rows\|sync_pending/.test(bd) === false || /return false;\s*\n\s*\}/.test(bd.slice(bd.indexOf("function _isSearchConfirmGrasp"))));
ok("A5 legacy_claude_path でADしない", !/"legacy_claude_path"/.test(bd));
ok("A6 page側もarmed拒否", /armed_rows\|armed_list\|sync_pending/.test(ps));

console.log("\n■ B. 薄い上書き・古いgrasp（既修正の回帰）");
ok("B1 content薄い上書き禁止", /薄いオブジェクトを新規に書かない|薄い上書き/.test(ct));
ok("B2 invalidate stale", /function _invalidateStaleSearchGrasp/.test(ps));
ok("B3 foundation 入口", /function _enforceAutoFoundation/.test(ps));

console.log("\n■ C. 沈黙・計リセット（既修正の回帰）");
ok("C1 武装keep", /silence_watch_keep/.test(ps));
ok("C2 強制flush", /function _forceAuditStepsFlush/.test(ps));

console.log("\n■ D. 武装・行ありの旧呼び出しは廃止（2.8.249）");
ok("D1 finishGate(true,armed_rows) 無し", !/finishGate\(\s*true\s*,\s*"armed_rows"\)/.test(bd));
ok("D2 finishGate(true,list_visible) 無し", !/finishGate\(\s*true\s*,\s*"list_visible"\)/.test(bd));
ok("D3 finishGate(true,sync_pending) 無し", !/finishGate\(\s*true\s*,\s*"sync_pending"\)/.test(bd));
ok("D4 finishGate(true,pending_armed) 無し", !/finishGate\(\s*true\s*,\s*"pending_armed"\)/.test(bd));
ok("D5 armed_wait_screen で待つ", /armed_wait_screen/.test(bd));
ok("D6 list_wait_screen で待つ", /list_wait_screen/.test(bd));

console.log("\n■ E. 統括Proが名指しした穴（配線の有無）");
ok("E1 F55反映印 learn_reflect", /learn_reflect_ok|learn_reflect_gate/.test(ps));
ok("E2 F45完了段 flow_done", /flow_done_/.test(ps));
ok("E3 細分化drive", /flow_subdivide_drive/.test(ps));
ok("E4 決まり legacy since≥244", /id: "legacy_ad_requires_screen_ok"[\s\S]{0,300}since: "2\.8\.244"/.test(rules));

console.log("\n" + n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
