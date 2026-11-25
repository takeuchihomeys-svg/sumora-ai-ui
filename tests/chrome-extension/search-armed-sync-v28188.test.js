/**
 * 2.8.188: 検索 click 直前の同期印（sessionStorage）がコードに載っているか
 * （リロードで chrome.storage.session が間に合わない穴の回帰止め）
 */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..", "chrome-extension");
const page = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const bulk = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
const man = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(man.version >= "2.8.188", "manifest version >=2.8.188 got " + man.version);
assert(/_AXLX_PAGE_VER = "2\.8\.18[89]"/.test(page) || page.includes('_AXLX_PAGE_VER = "2.8.189"'), "page-script PAGE_VER 188+");
assert(page.includes("axlx_pending_auto_send_sync"), "page arm sync key");
assert(page.includes("axlx_search_grasped_sync"), "page grasp sync key");
assert(bulk.includes("axlx_pending_auto_send_sync"), "bulk pending sync");
assert(bulk.includes("axlx_search_grasped_sync"), "bulk grasp sync");
assert(bulk.includes("case_c_sync"), "Case C sync path");
assert(bulk.includes("sync_grasp") || bulk.includes("sync_pending"), "AD gate sync");
console.log("search-armed-sync-v28188: OK");
