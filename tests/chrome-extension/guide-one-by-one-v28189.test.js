/**
 * 2.8.189: 手順書×画面を1つずつ把握 → 検索後も止まらず並び替えへ
 */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..", "chrome-extension");
const page = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const bulk = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
const man = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(man.version >= "2.8.189", "manifest ≥2.8.189 今=" + man.version);
assert(/_AXLX_PAGE_VER = "2\.8\.\d+"/.test(page), "page ver present");
assert(page.includes("_fillCondForStamp"), "fillCond stamp");
assert(page.includes("window.__axlxFillCond = cond"), "set __axlxFillCond");
assert(page.includes("guide_plan_miss→画面で1つずつ"), "screen fallback one-by-one");
assert(page.includes("axlx-guide-live-flush"), "live flush after_search");
assert(page.includes("guide_phase_|flow_series_"), "PIN includes guide");
assert(content.includes("axlx-guide-live-flush"), "content listens flush");
assert(content.includes("axlx_pending_auto_send_sync"), "content sync arm");
assert(bulk.includes('_liveDlStep("after_search"'), "Case C after_search");
assert(bg.includes("dl:|page:"), "bg allows page: live steps");
assert(page.includes("axlx_pending_auto_send_sync"), "188 sync arm kept");
console.log("guide-one-by-one-v28189: OK");
