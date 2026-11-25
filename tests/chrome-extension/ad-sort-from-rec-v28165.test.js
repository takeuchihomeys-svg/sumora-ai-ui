// 2.8.165（2026-11-22）直近通常録画から AD 並び替えを把握して改善
// 録画: click 左の高→低｜span.sort_detail @0.15,0.47（ホバーは click に残らない）
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
const man = JSON.parse(read("manifest.json"));
const rules = fs.readFileSync(path.join(__dirname, "..", "..", "app", "lib", "auto-procedure-rules.ts"), "utf8");

console.log("■ 2.8.165 AD並び替え＝直近録画 span.sort_detail 最優先");
ok("manifest ≥2.8.165", verGe(man.version, "2.8.165"), man.version);
ok("_AXLX_PAGE_VER ≥2.8.165", verGe((read("page-script.js").match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1], "2.8.165"));
ok("findSortDetailByRec がある", /findSortDetailByRec/.test(bd));
ok("span.sort_detail を探す", /span\.sort_detail/.test(bd));
ok("byTextLoose がある（並べ替えの短い要素）", /byTextLoose/.test(bd));
ok("高→低は録画セレクタ最優先", /fromRec = findSortDetailByRec/.test(bd));
ok("点検に rec:sort_detail", /rec:sort_detail/.test(bd));
ok("決まり since ≥2.8.165", /id: "ad_sort_hover"[\s\S]{0,500}?since: "2\.8\.16[5-9]"/.test(rules));
ok("決まり marker findSortDetailByRec", /marker: "findSortDetailByRec"/.test(rules));

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
