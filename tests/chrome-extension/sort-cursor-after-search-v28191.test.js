/**
 * 2.8.191: 検索押下トリガー → 1秒以降の人間ランダム → 並べ替えへカーソル
 *   #1588: search_to_sort 後に sort_* が0・_autoPdfSig 固着を塞ぐ
 */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..", "chrome-extension");
const page = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const bulk = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
const man = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const rules = fs.readFileSync(
  path.join(__dirname, "..", "..", "app", "lib", "auto-procedure-rules.ts"),
  "utf8"
);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function semverOk(v, min) {
  const a = String(v).split(".").map(Number);
  const b = String(min).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}
assert(semverOk(man.version, "2.8.191"), "manifest >= 2.8.191 got " + man.version);
assert(/_AXLX_PAGE_VER = "2\.8\.\d+"/.test(page), "page ver");
assert(page.includes("search_to_sort_cursor"), "RULES_DONE has search_to_sort_cursor");
assert(bulk.includes("_scheduleSortCursorAfterSearch"), "schedule fn");
assert(bulk.includes("_humanWaitAfterSearchMs"), "human wait >=1s");
assert(bulk.includes("sort_cursor_wait"), "live wait stamp");
assert(bulk.includes("sort_cursor_go"), "live go stamp");
assert(bulk.includes("fromSortCursor"), "fromSortCursor path");
assert(bulk.includes("look_cancel_new_fill"), "look cancel path");
assert(bulk.includes('try { _autoPdfSig = ""; } catch (_) {}'), "clear sig on cancel");
assert(bulk.includes("maybe_afterSearch"), "afterSearch → schedule");
assert(bulk.includes("case_c_sync"), "Case C sync");
assert(bulk.includes("_scheduleSortCursorAfterSearch(_fromSync ? \"case_c_sync\" : \"case_c\")"), "Case C uses schedule");
assert(rules.includes('id: "search_to_sort_cursor"'), "rule in auto-procedure-rules");
assert(rules.includes("_scheduleSortCursorAfterSearch"), "rule marker");
const audit = fs.readFileSync(path.join(root, "search-audit.js"), "utf8");
assert(audit.includes("dl:after_search"), "RULE_STEP keeps dl:after_search");
assert(audit.includes("dl:search_armed"), "RULE_STEP keeps dl:search_armed");
console.log("sort-cursor-after-search-v28191: OK");
