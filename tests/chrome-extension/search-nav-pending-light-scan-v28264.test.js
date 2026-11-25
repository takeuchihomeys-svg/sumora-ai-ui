/** v2.8.264: 検索の移動中は古い一覧で並べ替えない／画面の判定を軽くする／押下→表示の内訳を測る */
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..");
var bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8");
var ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
var sa = fs.readFileSync(path.join(root, "chrome-extension/search-audit.js"), "utf8");
var mf = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");
var n = 0, fail = 0;
function ok(name, cond) {
  n++;
  if (cond) console.log("  ✓ " + name);
  else { fail++; console.log("  ✗ " + name); }
}
function fnBody(src, name) {
  var i = src.indexOf("function " + name + "(");
  if (i < 0) return "";
  var j = src.indexOf("\n  function ", i + 10);
  return src.slice(i, j < 0 ? i + 6000 : j);
}

function vge(a, b) {
  var x = String(a || "").split(".").map(Number), y = String(b).split(".").map(Number);
  for (var i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return true;
}
console.log("\n■ 版 2.8.264 以上");
ok("manifest >= 2.8.264", vge(mf.version, "2.8.264"));
ok("page >= 2.8.264", vge((ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1], "2.8.264"));
ok("rules >= 2.8.264", vge((rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1], "2.8.264"));

console.log("\n■ 検索の移動中（サーバー応答待ち）は結果と認めない");
ok("bulk: beforeunload で移動中", /addEventListener\("beforeunload"[\s\S]{0,600}_navPendingAt = Date\.now\(\)/.test(bd));
ok("bulk: 検索押下20秒以内だけ", /Date\.now\(\) - pAt >= 20000\) return/.test(bd));
ok("bulk: 移動中は並べ替えタイマーを止める", /_navPendingAt = Date\.now\(\);[\s\S]{0,200}clearTimeout\(_sortCursorTimer\)/.test(bd));
ok("bulk: 関所の先頭で nav_pending", /function _pageDisplayedAfterThisSearch[\s\S]{0,120}_isNavPending\(\)/.test(bd));
ok("bulk: 予約の先頭で nav_pending（行の読み直しをしない）", /function _scheduleSortCursorAfterSearch[\s\S]{0,260}_isNavPending\(\)[\s\S]{0,200}return false/.test(bd));
ok("bulk: armed より後の beforeunload は消さない", /_navPendingAt && _navPendingAt < _pAt264/.test(bd));
ok("page: beforeunload で移動中", /addEventListener\("beforeunload"[\s\S]{0,500}__axlxNavPendingAt = Date\.now\(\)/.test(ps));
ok("page: 照合の先頭で移動中なら見ない", /tries\+\+;[\s\S]{0,200}_navPendingNow\(\)/.test(ps));

console.log("\n■ 古い一覧を2.8秒で通す保険を外す");
var gate = fnBody(bd, "_pageDisplayedAfterThisSearch");
ok("bulk: 2800ms の保険が無い", !/elapsed >= 2800/.test(gate));
ok("bulk: 同じページの保険は6秒", /elapsed >= 6000/.test(gate));
ok("bulk: 新しいページは読み込み完了まで待つ", /readyState !== "complete"[\s\S]{0,200}wait_load/.test(gate));
ok("bulk: ページの印で同じ/新しいを分ける", /axlx_search_press_doc/.test(gate) && /_AXLX_DOC_ID/.test(gate));
ok("page: 2800ms の保険が無い", !/elapsedPress >= 2800/.test(ps));
ok("page: 同じページ・移動なし・6秒", /sameDoc && !_navPendingNow\(\) && elapsedPress >= 6000/.test(ps));
ok("page: 押下基準にページの印", /doc: _axDocId/.test(ps));

console.log("\n■ 画面の判定を軽く（ページ全文を作らない）");
var lsr = fnBody(bd, "_looksLikeSearchResultRaw");
ok("bulk: _looksLikeSearchResult に1.5秒の控え", /_lsrCache\.at < 1500/.test(bd));
ok("bulk: body.textContent を使わない", lsr && !/document\.body\.textContent/.test(lsr));
ok("bulk: body.innerText を使わない", lsr && !/innerText/.test(lsr));
var brief = fnBody(bd, "_localScreenEvidenceBrief");
ok("bulk: 目印は700要素走査ではない", brief && !/i < 700/.test(brief));
ok("bulk: 目印は件数＋PDF", /棟/.test(brief) && /a\.print/.test(brief));
ok("bulk: _bodyHeadText は選択肢を読まない", /OPTION\|SELECT/.test(fnBody(bd, "_bodyHeadText")));
var ev = fnBody(ps, "_screenSearchResultEvidence");
ok("page: 証拠は文字ノードを辿る", /createTreeWalker/.test(ev));
ok("page: 900要素の textContent 走査が無い", !/i < 900/.test(ev));
ok("page: 大きな親は読まない", /childElementCount > 30/.test(ev) && /raw\.length > 400/.test(ev));
ok("bulk: 待ちの読み直しは60回で打ち切り", /_pageWaitN > 60/.test(bd) && /page_display_give_up/.test(bd));

console.log("\n■ 押下→表示の内訳を測る");
ok("bulk: nav_timing", /nav_timing/.test(bd) && /responseStart - nav\.requestStart/.test(bd));

console.log("\n■ 決まり・KEEP");
ok("RULES_DONE search_nav_pending_light_scan", /"search_nav_pending_light_scan"/.test(ps));
ok("決まり id", /id: "search_nav_pending_light_scan"/.test(rules));
ok("KEEP dl:page_nav_", /dl:page_nav_/.test(sa));
ok("KEEP dl:nav_timing", /dl:nav_timing/.test(sa));
ok("KEEP page:page_nav_", /page_displayed_\|page_nav_/.test(sa));
ok("page _PIN page_nav_", /page_displayed_\|page_nav_\|/.test(ps));

console.log("\n" + n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
