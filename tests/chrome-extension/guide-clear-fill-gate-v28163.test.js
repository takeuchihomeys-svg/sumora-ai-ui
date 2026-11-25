// 2.8.163（2026-11-22 竹内さん「外すときもこの仕組みで理解／入れ忘れ外し忘れをなくす」）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let pass = 0, fail = 0;
function ok(name, c, extra) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + String(extra).slice(0, 240) : "")); }
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

console.log("■ 2.8.163 外す・入れるの手順表×画面関所");
{
  const man = JSON.parse(read("manifest.json"));
  const ps = read("page-script.js");
  const sa = read("search-audit.js");
  ok("manifest ≥2.8.163", verGe(man.version, "2.8.163"), man.version);
  ok("_AXLX_PAGE_VER ≥2.8.163", verGe((ps.match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1], "2.8.163"));
  ok("_guideLikeDiffGrasp がある", /function _guideLikeDiffGrasp\(cond\)/.test(ps));
  ok("_guideLikeClearGrasp がある", /function _guideLikeClearGrasp\(cond\)/.test(ps));
  ok("_guideLikeFillGate がある", /function _guideLikeFillGate\(cond/.test(ps));
  ok("外す前に guide_clear_grasp", /_guideLikeClearGrasp\(cond\)/.test(ps) && /guide_clear_grasp/.test(ps));
  ok("検索前に guide_fill_gate", /_guideLikeFillGate\(/.test(ps) && /guide_fill_gate/.test(ps));
  ok("同種でも先に外す（2.8.220: placeSt>0 なら clearStations）", /clearStations: placeSt > 0/.test(ps) && /sameKindMustClear/.test(ps));
  ok("_AXLX_RULES_DONE に guide_clear_fill_gate", /"guide_clear_fill_gate"/.test(ps));
  ok("search-audit に guide_clear_grasp", /guide_clear_grasp/.test(sa) && /guide_fill_gate/.test(sa));
}

console.log("\n結果: pass=" + pass + " fail=" + fail);
process.exit(fail ? 1 : 0);
