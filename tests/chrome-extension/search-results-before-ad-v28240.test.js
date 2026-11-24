// 実行: node tests/chrome-extension/search-results-before-ad-v28240.test.js
// v2.8.240: 検索結果表示後だけAD／押下直後は結果待ち／条件→検索のAPIラグ削減
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const bd = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
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
ok("manifest ≥2.8.240", mf.version >= "2.8.240", mf.version);
ok("page ≥2.8.240", (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] >= "2.8.240");
ok("rules ≥2.8.240", (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] >= "2.8.240");

console.log("\n■ 押下≠結果完了");
ok("押下後 next=結果待ち", /nextMove = "検索結果の表示を待つ"/.test(ps) || /検索結果の表示を待つ/.test(ps));
ok("press payload confirmed:false", /pressed:\s*true[\s\S]{0,80}confirmed:\s*false|confirmed:\s*false[\s\S]{0,80}pressed:\s*true/.test(ps));
ok("search_results_ready 印", /search_results_ready/.test(ps));
ok("search_press_wait_results 印", /search_press_wait_results/.test(ps));
ok("_searchConfirmedLocal は screenOk", /screenOk === true/.test(ps) && /function _searchConfirmedLocal/.test(ps));
ok("旧一覧 tries≥3 でOKしない", /baselineHadList/.test(ps) && !/changed \|\| tries >= 3/.test(ps));

console.log("\n■ bulk: screenOk だけ kick");
ok("_isSearchConfirmGrasp が press_ok 単独拒否", /search_press_ok\|press_ok[\s\S]{0,80}return false/.test(bd) || /pressed === true && !g\.screenOk/.test(bd));
ok("押下のみ return（ADしない）", /search_press_wait_results/.test(bd) && /_pressedOnly/.test(bd));
ok("screenOk で kick", /customer_screen_grasp/.test(bd));

console.log("\n■ ラグ削減");
ok("fill_done が done を API待ちしない", /fill_done[\s\S]{0,280}function \(\) \{\}[\s\S]{0,80}done\(\)/.test(ps));

console.log("\n■ 決まり・F64・KEEP");
ok("RULES_DONE", /"search_results_before_ad_sort"/.test(ps));
ok("決まり", /id: "search_results_before_ad_sort"/.test(rules));
ok("F64症例", /ad_sort_before_search_results/.test(f64));
ok("KEEP search_results_ready", /search_results_ready/.test(sa));
ok("KEEP search_press_wait", /search_press_wait/.test(sa));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
