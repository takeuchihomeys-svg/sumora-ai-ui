// 2.8.166: 一覧・次ページ・次客受け渡しも手順表×画面照合
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + String(extra).slice(0, 300) : "")); }
}
function verGe(v, want) {
  const a = String(v || "").split(".").map(Number);
  const b = String(want || "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

const bd = read("bulk-dl.js");
const ps = read("page-script.js");
const sa = read("search-audit.js");
const man = JSON.parse(read("manifest.json"));
const rules = fs.readFileSync(path.join(__dirname, "..", "..", "app", "lib", "auto-procedure-rules.ts"), "utf8");

console.log("■ 2.8.166 一覧・次ページ・次客も手順表×画面照合");
ok("manifest ≥2.8.166", verGe(man.version, "2.8.166"), man.version);
ok("_AXLX_PAGE_VER ≥2.8.166", verGe((ps.match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1], "2.8.166"));
ok("_guideLikeListFlowGrasp がある", /function _guideLikeListFlowGrasp/.test(bd));
ok("list_start で照合", /list_start/.test(bd));
ok("before_next で照合", /before_next/.test(bd));
ok("after_next で照合", /after_next/.test(bd));
ok("handoff で受け渡し", /handoff/.test(bd) && /handoff_grasp/.test(bd));
ok("AD後に list_start", /sort_done[\s\S]{0,400}?list_start/.test(bd) || /list_start[\s\S]{0,200}?go\(\)/.test(bd));
ok("次客で list_handoff_seen", /list_handoff_seen/.test(ps));
ok("_AXLX_RULES_DONE に guide_list_next_flow", /"guide_list_next_flow"/.test(ps));
ok("決まり guide_list_next_flow", /id: "guide_list_next_flow"/.test(rules));
ok("search-audit に list_flow_", /dl:list_flow_/.test(sa));
ok("search-audit に list_handoff_seen", /list_handoff_seen/.test(sa));

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
