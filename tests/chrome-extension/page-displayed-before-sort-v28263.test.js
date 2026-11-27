/** v2.8.263: 検索結果ページ表示後だけ並べ替え／先に並べ替えない／検索見直しラグ短縮 */
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

console.log("\n■ 版 2.8.263");
ok("manifest ≥2.8.263", mf.version >= "2.8.263");
ok("page ≥2.8.263", (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] >= "2.8.263");
ok("rules ≥2.8.263", (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] >= "2.8.263");

console.log("\n■ 押下基準＋結果ページ関所");
ok("_captureSearchPressBaseline", /function _captureSearchPressBaseline/.test(ps));
ok("armed で基準保存", /_captureSearchPressBaseline[\s\S]{0,80}search_armed|_armPropertyPathBeforeSearch[\s\S]{0,200}_captureSearchPressBaseline/.test(ps));
ok("changedFromPress", /changedFromPress/.test(ps));
ok("押下直後700ms拒否", /elapsedPress < 700/.test(ps));
ok("_pageDisplayedAfterThisSearch", /function _pageDisplayedAfterThisSearch/.test(bd));
ok("page_display_wait 印", /page_display_wait/.test(bd));
ok("page_displayed_ok 印", /page_displayed_ok/.test(bd));
ok("sort_gate_need_page", /sort_gate_need_page/.test(bd));
ok("armed で旧screenOk破棄", /search_armed_wait_page|旧screenOk破棄/.test(bd));
ok("armed で並べ替え中断", /_abortAdSort\("search_armed_new"\)/.test(bd));
ok("文言は結果ページ表示済", /検索結果ページ表示済/.test(bd));
ok("armed_poll 2.2秒以降", /armed_poll_page[\s\S]{0,80}2200|_kickSortAfterSearch\("armed_poll_page"\)[\s\S]{0,40}2200/.test(bd));

console.log("\n■ 検索見直しラグ短縮");
ok("search_look 9〜12秒帯（2.8.317）", /var _lookMs = _searchReviewMs\(\)/.test(ps));

console.log("\n■ 決まり・KEEP");
ok("RULES_DONE page_displayed_before_sort", /"page_displayed_before_sort"/.test(ps));
ok("決まり id", /id: "page_displayed_before_sort"/.test(rules));
ok("結果確定後に押下基準を消す（bulk）", /removeItem\("axlx_search_press_baseline"\)/.test(bd));
ok("結果確定後に押下基準を消す（page）", /removeItem\("axlx_search_press_baseline"\)/.test(ps));
ok("KEEP page_display_", /page_display_/.test(sa));
ok("KEEP search_press_baseline", /search_press_baseline/.test(sa));

console.log("\n" + n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
