/**
 * 2.8.315 実測 #1659→#1661（2026-11-27 竹内さん）:
 *   ① 並べ替え見出しを文字で探す時、拡張自身のパネル（𝑅.さん／並べ替え最中）を掴まない（_isOwnUiEl）
 *   ② 裏が起き直した後の見張りが、検索後の並べ替え→一覧→PDFの途中の前客を「放置」とみなして次客へ進めない
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..", "..");
const rd = (p) => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
const bd = rd("chrome-extension/bulk-dl.js");
const bg = rd("chrome-extension/background.js");
const ps = rd("chrome-extension/page-script.js");
const rules = rd("app/lib/auto-procedure-rules.ts");
const man = JSON.parse(rd("chrome-extension/manifest.json"));

let pass = 0, fail = 0;
function ok(name, c, extra) { if (c) pass++; else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 220))); } }
function semverOk(v, min) {
  const a = String(v).split(".").map(Number), b = String(min).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) > (b[i] || 0)) return true; if ((a[i] || 0) < (b[i] || 0)) return false; }
  return true;
}

console.log("\n■ 版");
ok("manifest ≥2.8.315", semverOk(man.version, "2.8.315"), man.version);
ok("page ≥2.8.315", semverOk((ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1], "2.8.315"));
ok("rules ≥2.8.315", semverOk((rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1], "2.8.315"));

console.log("\n■ ① 自分の画面を並べ替えの候補にしない");
const i0 = bd.indexOf("function _isOwnUiEl(el) {");
ok("_isOwnUiEl がある", i0 > 0);
const fnSrc = bd.slice(i0, bd.indexOf("\n  }\n", i0) + 5);
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fnSrc + "\nthis._isOwnUiEl = _isOwnUiEl;", ctx);
const mk = (hit) => ({ closest: (sel) => (hit && sel.indexOf("[id^='aixlinx-']") >= 0 && sel.indexOf("[id^='axlx-']") >= 0 ? {} : null) });
ok("自分の画面の中 → true", ctx._isOwnUiEl(mk(true)) === true);
ok("ページの要素 → false", ctx._isOwnUiEl(mk(false)) === false);
ok("null → false", ctx._isOwnUiEl(null) === false);
ok("closest が無くても落ちない", ctx._isOwnUiEl({}) === false);
const headSrc = bd.slice(bd.indexOf("function _findSortHeadEl() {"), bd.indexOf("function _findSortHeadEl() {") + 600);
ok("_findSortHeadEl の vis が自分の画面を外す", /_isOwnUiEl\(el\)/.test(headSrc));
const aimSrc = bd.slice(bd.indexOf("function _findSortHeadByAim(aim) {"), bd.indexOf("function _findSortHeadByAim(aim) {") + 700);
ok("_findSortHeadByAim の vis も外す", /_isOwnUiEl\(el\)/.test(aimSrc));
ok("_sortOnce の visible も外す", /var visible = function \(el\) \{ try \{ return !!el && !_isOwnUiEl\(el\)/.test(bd));

console.log("\n■ ② 裏の再起動後の見張り");
const w0 = bg.indexOf("var _swWdRun = function (_swTry) {");
ok("_swWdRun がある", w0 > 0);
const wSrc = bg.slice(w0, w0 + 4200);
ok("鍵(axlx_pipeline_job)を見る", /axlx_pipeline_job/.test(wSrc) && /_pipelineJobLive\(_wdJob\)/.test(wSrc));
ok("検索後の印(axlx_pending_auto_send)を見る", /axlx_pending_auto_send/.test(wSrc));
ok("同じ客の鍵・印だけを見る", /_wdJob\.customerId \|\| ""\) === _wdCid/.test(wSrc) && /_wdPa\.customerId \|\| ""\) === _wdCid/.test(wSrc));
ok("待つ間は60秒ごとに見直す", /_swWdGapMs = 60000;[\s\S]{0,60}_swWdRun\(_swTry \+ 1\); \}, _swWdGapMs\)/.test(wSrc));
ok("永久には待たない（回数上限）", /_swTry < 40/.test(wSrc));
ok("待つ間は beatAt を更新しない（見張りが消えない）", !/_bulkQueueSave\(\{\}\)/.test(wSrc.slice(0, wSrc.indexOf("_bulkKick(\"batch_done_sw_watchdog\""))));
ok("待たない時は従来どおり kick する", /_bulkKick\("batch_done_sw_watchdog"/.test(wSrc));
ok("最初の起動は 90 秒後に _swWdRun(0)", /setTimeout\(function \(\) \{ _swWdRun\(0\); \}, 90000\)/.test(bg));

console.log("\n■ ③ 決まり");
ok("rules に sort_skip_own_ui", /id: "sort_skip_own_ui"/.test(rules));
ok("rules に sw_restart_wait_post_search_flow", /id: "sw_restart_wait_post_search_flow"/.test(rules));
ok("page-script の _AXLX_RULES_DONE に両方", /"sort_skip_own_ui"/.test(ps) && /"sw_restart_wait_post_search_flow"/.test(ps));

console.log("\n" + (fail ? "✗ " + fail + " 件失敗" : "✓ 全部通過") + "（" + pass + " 項目）");
process.exit(fail ? 1 : 0);
