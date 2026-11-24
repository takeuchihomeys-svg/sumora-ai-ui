/**
 * 2.8.192: 左サイド「所在地」誤検知で並べ替え待ちが永遠 defer しない
 */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..", "chrome-extension");
const page = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const bulk = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
const man = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const grasp = fs.readFileSync(
  path.join(__dirname, "..", "..", "app", "lib", "guide-screen-grasp.ts"),
  "utf8"
);
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
assert(semverOk(man.version, "2.8.192"), "manifest >= 2.8.192 got " + man.version);
assert(/_AXLX_PAGE_VER = "2\.8\.\d+"/.test(page), "page ver");
assert(bulk.includes("_hasSortHeadVisible"), "sort head helper");
assert(bulk.includes("所在地の設定|地域の設定へ戻る"), "no bare 所在地 modal text");
assert(!/所在地\|市区郡\|詳細地域\|確定してリスト/.test(bulk), "old false-positive regex removed");
assert(bulk.includes("_stampSortFlowAtom"), "flow atoms");
assert(bulk.includes("after_search_rows"), "atom after_search_rows");
assert(page.includes("list_modal_not_sidebar"), "RULES_DONE");
assert(page.includes("axlx-bulk-flow-atom"), "page receives bulk atoms");
assert(page.includes('"sort_wait"'), "FLOW_MAP has sort_wait");
assert(rules.includes('id: "list_modal_not_sidebar"'), "rule");
assert(grasp.includes("dl:sort_cursor_go"), "grasp needs go not only wait");
assert(grasp.includes("dl:sort_menu"), "grasp sort needs menu");
assert(!/re: \/dl:sort_\|/.test(grasp), "grasp sort no longer matches all dl:sort_");
console.log("sort-modal-sidebar-v28192: OK");
