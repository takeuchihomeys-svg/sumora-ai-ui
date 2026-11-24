/**
 * 2.8.195: お客さん検索を手順書×画面で把握 → 並べ替え本線
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
const grasp = fs.readFileSync(
  path.join(__dirname, "..", "..", "app", "lib", "guide-screen-grasp.ts"),
  "utf8"
);
const audit = fs.readFileSync(path.join(root, "search-audit.js"), "utf8");

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
assert(semverOk(man.version, "2.8.195"), "manifest >= 2.8.195 got " + man.version);
assert(/_AXLX_PAGE_VER = "2\.8\.\d+"/.test(page), "page ver");
assert(page.includes("_verifyCustomerSearchScreenGrasp"), "screen verify");
assert(page.includes("_screenSearchResultEvidence"), "screen evidence");
assert(page.includes("_playbookExpectsAfterSearch"), "playbook expect");
assert(page.includes("search_customer_grasp_intent"), "intent stamp");
assert(page.includes("search_customer_grasp_ok"), "ok stamp");
assert(page.includes("guide_phase_after_search_screen"), "screen phase");
assert(page.includes("search_customer_screen_grasp"), "RULES_DONE");
assert(page.includes('"search_customer_grasp"'), "FLOW_MAP atom");
assert(bulk.includes("customer_screen_grasp"), "bulk kick on screen");
assert(bulk.includes("search_customer_screen_ok"), "bulk stamp");
assert(bulk.includes("search_customer_bound"), "customer bind");
assert(rules.includes('id: "search_customer_screen_grasp"'), "rule");
assert(rules.includes("_verifyCustomerSearchScreenGrasp"), "rule marker");
assert(grasp.includes("search_customer_grasp_ok"), "F57 after_search");
assert(audit.includes("search_customer_grasp_"), "KEEP/RULE page stamps");
assert(audit.includes("dl:search_customer_"), "KEEP/RULE dl stamps");
console.log("search-customer-screen-grasp-v28195: OK");
