/**
 * 2.8.194→2.8.243: 旧 legacy_claude_path は screenOk 関所と衝突するため廃止。
 *   検索後並べ替え本線は残すが、結果確認（screenOk）必須。
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
assert(semverOk(man.version, "2.8.243"), "manifest >= 2.8.243 got " + man.version);
assert(/_AXLX_PAGE_VER = "2\.8\.\d+"/.test(page), "page ver");
assert(bulk.includes("legacy_blocked_no_screen"), "legacy blocked stamp");
assert(bulk.includes("screen_ok_path"), "screen ok path");
assert(!/"legacy_claude_path"/.test(bulk), "old legacy AD path removed");
assert(bulk.includes("_isCondModalLabelsOpen"), "labels-only modal");
assert(bulk.includes("list_without_screen"), "list without screenOk blocked");
assert(bulk.includes("armed_rows"), "armed+rows without modal block");
assert(bulk.includes("sort_screen_ok") || page.includes("sort_screen_ok"), "screen_ok atom");
assert(bulk.includes("_isCondModalLabelsOpen() || _isFillBusy()"), "sortOnce uses labels");
assert(page.includes("legacy_ad_requires_screen_ok"), "RULES_DONE");
assert(page.includes('"sort_screen_ok"'), "FLOW_MAP");
assert(rules.includes('id: "legacy_ad_requires_screen_ok"'), "rule");
assert(!rules.includes('id: "sort_legacy_claude_path"'), "old rule retired");
console.log("sort-legacy-claude-v28194: OK (243 screenOk gate)");
