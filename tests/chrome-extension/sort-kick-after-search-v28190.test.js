/**
 * 2.8.190+: 検索後に一覧で止まらず並び替えへ kick
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
function semverOk(v, min) {
  const a = String(v).split(".").map(Number);
  const b = String(min).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}

assert(semverOk(man.version, "2.8.190"), "manifest >= 2.8.190 got " + man.version);
assert(/_AXLX_PAGE_VER = "2\.8\.\d+"/.test(page), "page ver present");
assert(bulk.includes("_kickSortAfterSearch"), "kick fn");
assert(bulk.includes("_forceAutoForPending"), "force auto");
assert(bulk.includes("_hasSearchPendingSync"), "sync reader");
assert(bulk.includes("必ず／AJAX"), "arm always");
assert(bulk.includes("inject_rows"), "inject kick");
assert(bulk.includes("armed_poll"), "armed poll");
assert(bulk.includes('_forceAutoForPending(_fromSync ? "case_c_sync"'), "Case C force");
console.log("sort-kick-after-search-v28190: OK");
