/**
 * 2.8.193: 強制は保険のみ。本線は関所細分化（main/reclassify/wait_*）
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
assert(semverOk(man.version, "2.8.193"), "manifest >= 2.8.193 got " + man.version);
assert(/_AXLX_PAGE_VER = "2\.8\.\d+"/.test(page), "page ver");
assert(bulk.includes("_gateSortCursorReady"), "gate fn");
assert(bulk.includes("sort_gate_main"), "main path stamp");
assert(bulk.includes("sort_gate_reclassify"), "reclassify stamp");
assert(bulk.includes("sort_gate_wait_modal"), "wait_modal stamp");
assert(bulk.includes("sort_gate_wait_fill"), "wait_fill stamp");
assert(bulk.includes("sort_cursor_insurance"), "insurance stamp");
assert(bulk.includes("_sortCursorInsuranceUsed"), "insurance once flag");
assert(bulk.includes("allowModalReclassify"), "reclassify opt");
assert(!bulk.includes('force ? "sort_cursor_force"'), "old force-as-primary removed");
assert(page.includes("sort_gate_main_insurance"), "RULES_DONE");
assert(page.includes('"sort_insurance"'), "FLOW_MAP insurance atom");
assert(page.includes('"sort_reclassify"'), "FLOW_MAP reclassify");
assert(rules.includes('id: "sort_gate_main_insurance"'), "rule");
assert(rules.includes("保険"), "rule text says 保険");
assert(rules.includes("_gateSortCursorReady"), "rule marker");
console.log("sort-gate-insurance-v28193: OK");
