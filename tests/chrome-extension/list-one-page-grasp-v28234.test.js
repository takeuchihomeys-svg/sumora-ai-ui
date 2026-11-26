// 実行: node tests/chrome-extension/list-one-page-grasp-v28234.test.js
// v2.8.234: 1ページのみ把握 → 次ページで止まらず物件済→外す
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const bd = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
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
ok("manifest ≥2.8.234", mf.version >= "2.8.234", mf.version);
ok("page ≥2.8.234", (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] >= "2.8.234");
ok("rules ≥2.8.234", (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] >= "2.8.234");

console.log("\n■ 1ページ把握");
ok("_readPagerState がある", /function _readPagerState\(/.test(bd));
ok("onlyOnePage", /onlyOnePage/.test(bd));
ok("1ページなら _findNextPageEl null", /onlyOnePage\) return null/.test(bd) || /if \(pst0\.onlyOnePage\) return null/.test(bd));
ok("onclick無しの次をスキップ", /onclick無し/.test(bd));
ok("list_page_one_only 印", /list_page_one_only/.test(bd) && /list_page_one_only/.test(ps));
ok("list_no_next_advance 印", /list_no_next_advance/.test(bd));
ok("before_next で外すへ", /物件取得完了→外す/.test(bd));
// 2.8.248 以降: 次無し／1ページのみは _sendBatchDone 一本化（その中で _guideLikeListFlowGrasp("handoff") → _stampSeriesToNextCustomer）
ok("次無し後に handoff", /_guideLikeListFlowGrasp\("before_next", function \(g\) \{[\s\S]{0,900}"list_page_one_only"[\s\S]{0,900}_sendBatchDone\(/.test(bd)
  && /function _sendBatchDone\([^)]*\) \{[\s\S]{0,500}_guideLikeListFlowGrasp\("handoff"[\s\S]{0,300}_stampSeriesToNextCustomer\(/.test(bd));
ok("RULES_DONE", /"list_one_page_grasp_advance"/.test(ps));
ok("決まり list_one_page_grasp_advance", /id: "list_one_page_grasp_advance"/.test(rules));
ok("marker _readPagerState", /marker: "_readPagerState"/.test(rules));

console.log("\n■ パネル拒否・監査");
ok("パネルで次ページ拒否", /次ページ拒否・1ページのみ/.test(bd));
ok("_guardNextMove が1ページを見る", /list_page_one_only[\s\S]{0,80}物件取得完了→外す/.test(ps) || /onlyOnePage[\s\S]{0,120}物件取得完了→外す/.test(ps));
ok("KEEP/RULE に list_page_one_only", /list_page_one_only/.test(sa));

console.log("\n■ F64 症例");
ok("stuck_next_page_on_single_page", /stuck_next_page_on_single_page/.test(rc));
ok("検証印 list_page_one_only", /list_page_one_only/.test(rc));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
