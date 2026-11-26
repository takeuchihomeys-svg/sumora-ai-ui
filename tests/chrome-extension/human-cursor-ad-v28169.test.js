// 2.8.169: カーソル1本化＋ADは並べ替えメニューから（一覧列取り違え禁止）
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + String(extra).slice(0, 280) : "")); }
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
const pu = read("pointer-ui.js");
const man = JSON.parse(read("manifest.json"));
const rules = fs.readFileSync(path.join(__dirname, "..", "..", "app", "lib", "auto-procedure-rules.ts"), "utf8");

console.log("■ 2.8.169 人間の動き: カーソル1本＋ADメニュー把握");
ok("manifest ≥2.8.169", verGe(man.version, "2.8.169"), man.version);
ok("_AXLX_PAGE_VER ≥2.8.169", verGe((ps.match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1], "2.8.169"));
ok("forceOneCursor がある", /forceOneCursor:\s*function/.test(pu));
// 今の形: 押す直前に page-script の _humanPointerClick が pointer-ui の ensure() を呼び、
//   ensure() が余分な #axlx-fake-cursor を消して1つだけ使う（2026-11-17）・動かす度に _place が OS カーソルを隠す（_osHide(true)）。
//   forceOneCursor を押し前に直接呼ぶのは bulk-dl 側（AD前）に残っている。
ok("押し前にカーソル1本化（_humanPointerClick → ensure が余分を消す）",
  (function () {
    const a = ps.indexOf("function _humanPointerClick(");
    const b = a < 0 ? -1 : ps.indexOf("var _P = window.AxlxPointerUi;", a);
    // 次の function 宣言より前（＝この関数の中）で _P.ensure() を呼んでいる
    const nx = a < 0 ? -1 : ps.indexOf("\n  function ", a + 30);
    return b > a && (nx < 0 || b < nx) && /if \(_P && _P\.ensure\) \{\s*try \{ _P\.ensure\(\); \}/.test(ps.slice(b, b + 200));
  })() &&
  /function ensure\(\) \{[\s\S]{0,1500}?removeChild\(all\[xi\]\)/.test(pu) &&
  /_osHide\(true\);\s*_savePos\(x, y\)/.test(pu));
ok("AD前に forceOneCursor", /forceOneCursor/.test(bd));
ok("isListChrome で一覧列を捨てる", /isListChrome/.test(bd));
ok("sort_ad_wrong 印", /sort_ad_wrong/.test(bd));
ok("ページ全体 AD loose を使わない", !/byTextLoose\(\["AD順", "AD（広告費）", "AD"\]/.test(bd));
ok("findSortDetailByRec が anchor 付き", /findSortDetailByRec\(\[[^\]]+\],\s*adEl\)/.test(bd) || /findSortDetailByRec\([^\)]*adEl\)/.test(bd));
ok("決まり ad_sort since 2.8.169", /id: "ad_sort_hover"[\s\S]{0,400}?since: "2\.8\.169"/.test(rules));
ok("決まり marker findSortDetailByRec（一覧列は isListChrome）", /id: "ad_sort_hover"[\s\S]{0,400}?marker: "findSortDetailByRec"/.test(rules) && /isListChrome/.test(bd));

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
