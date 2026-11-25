// 2.8.168: 同じ建物・2㎡以内は最安だけダウンロード（スタッフ自動押しでも）
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");
const RD = require(path.join(EXT, "room-dedupe.js"));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + String(extra).slice(0, 200) : "")); }
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

console.log("■ 2.8.168 同じ建物 2㎡以内は最安だけ（自動押し）");
ok("manifest ≥2.8.168", verGe(man.version, "2.8.168"), man.version);
ok("SAME_AREA_DIFF_SQM=2", RD.SAME_AREA_DIFF_SQM === 2);
ok("自動押しは forAuto:true", /_applyCheapestPerLayout\(state,\s*allowed,\s*\{\s*forAuto:\s*true\s*\}\)/.test(bd));
ok("スタッフ手選びは絞らない", /_staffModeOn && !forAuto/.test(bd));
ok("印に ≤2㎡", /auto_cheapest_skip[\s\S]{0,80}?≤2㎡/.test(bd) || /最安1件に\(≤2㎡\)/.test(bd));

const near = [
  { name: "棟", cells: ["1", "1LDK", "28.69㎡", "102000円"] },
  { name: "棟", cells: ["2", "1LDK", "28.69㎡", "99000円"] },
  { name: "棟", cells: ["3", "1LDK", "29.06㎡", "100000円"] },
];
const r = RD.cheapestPerBuildingLayoutSize(near);
ok("近接㎡は最安1件", r.keep.length === 1 && r.keep[0] === 1, r);

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
