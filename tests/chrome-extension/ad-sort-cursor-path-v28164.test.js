// 2.8.164（2026-11-22 竹内さん）
// AD並び替え: 並べ替え→ADへカーソル移動（人間の動き）／URL直・一覧AD列取り違え禁止
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

console.log("■ 2.8.164 AD並び替え＝並べ替えからカーソル移動（直接URL禁止）");
ok("manifest ≥2.8.164", verGe(man.version, "2.8.164"), man.version);
ok("_AXLX_PAGE_VER ≥2.8.164", verGe((read("page-script.js").match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1], "2.8.164"));
ok("findNear がある（メニュー近傍）", /var findNear = function/.test(bd));
ok("ホバー座標が要素の真ん中（clientX:1 禁止）", /clientX: c\.x/.test(bd) && !/clientX: 1, clientY: 1/.test(bd));
ok("① 並べ替えへカーソル", /① 並べ替えへカーソルを動かします/.test(bd));
ok("② 並べ替えから AD へ", /② 並べ替えから AD へカーソルを動かします/.test(bd));
ok("③ 高→低へカーソルして押す", /③ 高→低へカーソルを動かして押します/.test(bd));
ok("AD は findNear below", /findNear\(\["AD"/.test(bd) && /"below"/.test(bd));
ok("高→低は findHiToLoNear", /findHiToLoNear/.test(bd));
ok("URL直書きしない", !/location\.href\s*=\s*_adLink/.test(bd) && !/location\.href\s*=\s*_u\.toString/.test(bd));
ok("失敗印は sort_failed（dl:sort_）", /_liveDlStep\("sort_failed"/.test(bd));
ok("決まり ad_sort_hover since ≥2.8.164", /id: "ad_sort_hover"[\s\S]{0,500}?since: "2\.8\.16[4-9]"/.test(rules));

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
