/**
 * 2.8.317 竹内さん（2026-11-27）ループの簡素化（lag-grace-v28316 を置き換え）:
 *   ① リセット＝押して 30〜34秒待つだけ（空の読み戻し・写真・猶予なし）。最初の客・前客リセット済みの客は入れる前に押さない
 *   ② 次客の条件は毎回 API から読み直す（最大3回・印 customer_api_reload）
 *   ③ 検索を押す前の見直し 9〜12秒（search_review_wait）
 *   ④ 並べ替えは検索確認から 40〜50秒・押した後の猶予 15〜20秒・カーソルが途切れたら1回だけ動かし直す
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
const sa = rd("chrome-extension/search-audit.js");
const man = JSON.parse(rd("chrome-extension/manifest.json"));

let pass = 0, fail = 0;
function ok(name, c, extra) { if (c) pass++; else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 220))); } }
function range(src, startNeedle, endNeedle) { const i = src.indexOf(startNeedle); if (i < 0) return ""; const j = endNeedle ? src.indexOf(endNeedle, i + startNeedle.length) : -1; return src.slice(i, j > 0 ? j : i + 6000); }

console.log("\n■ 版（2.8.317 以降・5か所が同じ）");
const mv = man.version;
ok("manifest ≥2.8.317", mv.localeCompare("2.8.317", undefined, { numeric: true }) >= 0, mv);
ok("page = manifest", ps.indexOf('_AXLX_PAGE_VER = "' + mv + '"') >= 0);
ok("itandi page = manifest", rd("chrome-extension/itandi-page-script.js").indexOf('_AXLX_ITANDI_PAGE_VER = "' + mv + '"') >= 0);
ok("rules = manifest", rules.indexOf('AUTO_RULES_REVIEWED_UP_TO = "' + mv + '"') >= 0);
ok("itandi rules = manifest", rd("app/lib/auto-itandi-rules.ts").indexOf('ITANDI_RULES_REVIEWED_UP_TO = "' + mv + '"') >= 0);

console.log("\n■ ④ 並べ替えの猶予 15〜20秒（実行して範囲を確かめる）");
const i0 = bd.indexOf("function _lagGraceMs() {");
ok("bulk-dl に _lagGraceMs がある", i0 > 0);
const fnSrc = bd.slice(i0, bd.indexOf("\n  }\n", i0) + 5);
const ctx = { Math: Object.create(Math) };
vm.createContext(ctx);
vm.runInContext("var LAG_GRACE_MIN_MS = 15000, LAG_GRACE_MAX_MS = 20000;\n" + fnSrc + "\nthis._lagGraceMs = _lagGraceMs;", ctx);
let mn = Infinity, mx = -Infinity; const seen = new Set();
for (let i = 0; i < 2000; i++) { const v = ctx._lagGraceMs(); mn = Math.min(mn, v); mx = Math.max(mx, v); seen.add(v); }
ok("猶予は 15000 以上", mn >= 15000, mn);
ok("猶予は 20000 未満", mx < 20000, mx);
ok("毎回揺れる", seen.size > 50, seen.size);
ok("定数は 15000／20000", /var LAG_GRACE_MIN_MS = 15000;/.test(bd) && /var LAG_GRACE_MAX_MS = 20000;/.test(bd));
const sortIdx = bd.indexOf("sort_lag_grace");
ok("並べ替えの後に sort_lag_grace を残す", sortIdx > 0);
ok("step の待ちは 1200 + 猶予", /step\(1200 \+ _lagG, function \(\) \{ done\(true\); \}\);/.test(bd.slice(Math.max(0, sortIdx - 400), sortIdx + 300)));
ok("background に猶予の関数は無い（リセット後に猶予を置かない）", bg.indexOf("function _lagGraceMs()") < 0 && bg.indexOf('_stamp("reset_lag_grace"') < 0);

console.log("\n■ ④ 検索確認から並べ替えまで 40〜50秒（待ちは1本）");
ok("定数 40000／50000", /SORT_AFTER_SEARCH_MIN_MS = 40000/.test(bd) && /SORT_AFTER_SEARCH_MAX_MS = 50000/.test(bd));
{
  const j = bd.indexOf("function _humanWaitAfterSearchMs() {");
  const src = bd.slice(j, bd.indexOf("\n  }\n", j) + 5);
  const c2 = { self: { AxlxHumanWait: { logNormalDelay: () => 30000 } }, Math: Object.create(Math) };
  vm.createContext(c2);
  vm.runInContext("var SORT_AFTER_SEARCH_MIN_MS = 40000, SORT_AFTER_SEARCH_MAX_MS = 50000;\n" + src + "\nthis.f = _humanWaitAfterSearchMs;", c2);
  let a = Infinity, b = -Infinity;
  for (let i = 0; i < 500; i++) { const v = c2.f(); a = Math.min(a, v); b = Math.max(b, v); }
  ok("人の間が短い値を返しても 40秒以上", a >= 40000, a);
  c2.self.AxlxHumanWait.logNormalDelay = () => 99000;
  let b2 = 0; for (let i = 0; i < 100; i++) b2 = Math.max(b2, c2.f());
  ok("人の間が99秒を返しても 50秒以下", b2 <= 50000, b2);
}

console.log("\n■ ④ カーソルが途切れたら1回だけ動かし直す（moveToElRetry）");
{
  const j = bd.indexOf("var moveToElRetry = function (el, cb)");
  ok("moveToElRetry がある", j > 0);
  const seg = bd.slice(j, j + 2500);
  ok("0.4〜0.9秒あけて1回だけ", /400\s*\+\s*Math\.floor\(Math\.random\(\)\s*\*\s*500\)/.test(seg) || /400.{0,40}900/.test(seg), seg.slice(0, 300));
  ok("点検に sort_mouse_retry を残す", /sort_mouse_retry/.test(seg));
  ok("hover と press が通す", (bd.match(/moveToElRetry\(el, function/g) || []).length >= 2);
}

console.log("\n■ ③ 検索を押す前の見直し 9〜12秒");
{
  const j = ps.indexOf("function _searchReviewMs() {");
  ok("_searchReviewMs がある", j > 0);
  const src = ps.slice(j, ps.indexOf("\n  }\n", j) + 5);
  const c3 = { window: { AxlxHumanWait: { logNormalDelay: () => 3000 } }, Math: Object.create(Math) };
  vm.createContext(c3);
  vm.runInContext(src + "\nthis.f = _searchReviewMs;", c3);
  let a = Infinity, b = -Infinity;
  for (let i = 0; i < 500; i++) { const v = c3.f(); a = Math.min(a, v); b = Math.max(b, v); }
  ok("短い値が来ても 9秒以上", a >= 9000, a);
  c3.window.AxlxHumanWait.logNormalDelay = () => 60000;
  ok("長い値が来ても 12秒以下", c3.f() <= 12000);
  c3.window.AxlxHumanWait = null;
  let a2 = Infinity, b2 = -Infinity;
  for (let i = 0; i < 500; i++) { const v = c3.f(); a2 = Math.min(a2, v); b2 = Math.max(b2, v); }
  ok("人の間が無くても 9〜12秒", a2 >= 9000 && b2 <= 12000, [a2, b2]);
  ok("見直しの待ちに使う（_lookMs = _searchReviewMs()）", /var _lookMs = _searchReviewMs\(\);/.test(ps));
  ok("点検に page:search_review_wait を残す", /_auditStepP\('search_review_wait'/.test(ps));
  ok("待っている間の二重の呼び出しは今すぐ押さない（予約済みの窓 30秒）", /_nowMs - _lookAt < 30000/.test(ps));
  ok("search-audit が保持する", /page:search_review_wait/.test(sa));
}

console.log("\n■ ① リセット＝押して待つだけ");
{
  const seg = range(bg, "async function _postSendResetRealpro", "async function _resetWithInsurance") || bg.slice(bg.indexOf("async function _postSendResetRealpro"), bg.indexOf("async function _postSendResetRealpro") + 12000);
  ok("reset_settled を残す", /_stamp\("reset_settled"/.test(bg));
  ok("押して待ったら空とみなす（assumedEmpty）", /assumedEmpty: true/.test(bg));
  ok("読み戻しは『きれい』印のための1回・最大1.5秒", /maxMs:1500/.test(bg.replace(/\s/g, "")));
  ok("空の読み戻しの繰り返し（RESET_VERIFY_TOTAL_MS）は無い", bg.indexOf("RESET_VERIFY_TOTAL_MS") < 0);
  ok("リセット後の写真の間（RESET_SHOT_GAP_MIN_MS）は無い", bg.indexOf("RESET_SHOT_GAP_MIN_MS") < 0);
  ok("30〜34秒の待ちは残る（reset_wait）", /_stamp\("reset_wait"/.test(bg));
  ok("search-audit が reset_settled を保持", /reset_settled/.test(sa));
}
console.log("\n■ ① 最初の客・前客リセット済みの客は入れる前にリセットしない");
{
  ok("最初の客は見送る", /_bi === _startIndex && !_resume/.test(bg) && /この一括の最初の客はリセットしない/.test(bg));
  ok("前客のリセットが済んでいれば見送る", /前客のリセットが済んでいる（空とみなしてそのまま入れる）/.test(bg) && /String\(_lp0\.cid\) === String\(_prevT0\.id\)/.test(bg));
  ok("見送りは reset_before_fill に残す", /"見送り=" \+ _skipPreFill/.test(bg));
  ok("見送らない時は従来どおり _resetBeforeFill", /await _resetBeforeFill\(_bc, _bulkAudit/.test(bg));
}
console.log("\n■ ② 次客の条件を毎回APIから読み直す");
{
  const j = bg.indexOf("async function _refreshCustomerBeforeSearch(");
  ok("_refreshCustomerBeforeSearch がある", j > 0);
  const seg = bg.slice(j, j + 4500);
  ok("最大3回", /_attempt\s*<\s*3|attempt\s*<\s*3|<= 3|< 3/.test(seg), seg.slice(0, 200));
  ok("2秒・4秒あけて再試行", /2000/.test(seg) && /4000/.test(seg));
  ok("結果を _lastCustomerReload に残す", /_lastCustomerReload\s*=/.test(bg));
  ok("_batchAutofill が customer_api_reload を残す", /_auditStep\([^;]*"customer_api_reload"/.test(bg) || /"customer_api_reload"/.test(bg));
  ok("検索の前（一括の次客）にも呼ぶ（series_handoff_order の marker）", /customer = await _refreshCustomerBeforeSearch\(customer, site\);/.test(bg));
}

console.log("\n■ 規則・手順書");
ok("lag_grace_after_reset は廃止", rules.indexOf('id: "lag_grace_after_reset"') < 0 && ps.indexOf('"lag_grace_after_reset"') < 0);
for (const id of ["sort_mouse_retry", "search_review_wait", "first_customer_no_reset", "next_customer_api_reload"]) {
  ok("規則 " + id, rules.indexOf('id: "' + id + '"') > 0 && ps.indexOf('"' + id + '"') > 0);
}
ok("並べ替えの猶予の確認は dl:sort_lag_grace", /mustHaveAny: \["dl:sort_lag_grace"\]/.test(rules));
ok("次客のAPI読み直しは『かなり重要』と書く", /かなり重要/.test(rules) && /かなり重要/.test(rd("app/lib/action-playbook.ts")));
ok("手順書 build_v ≥24", /PLAYBOOK_BUILD_V = (2[4-9]|[3-9]\d)/.test(rd("app/lib/action-playbook.ts")));

console.log("\n" + (fail === 0 ? "✓ 全部通過" : "✗ " + fail + " 件失敗") + "（" + (pass + fail) + " 項目）");
if (fail) process.exitCode = 1;
