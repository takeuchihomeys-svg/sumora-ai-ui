// 2.8.160（2026-11-22 DB実測: 玉造・今里・鶴橋・布施で station_no_route・沿線0本）
// 駅名はあるのに route_ids=[] で届いた時、地図から沿線を埋めてから選ぶ。
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

console.log("■ 2.8.160 駅名→沿線を地図で補完（station_no_route 抜け）");
{
  const man = JSON.parse(read("manifest.json"));
  const ps = read("page-script.js");
  const pj = read("popup.js");
  ok("manifest ≥2.8.160", verGe(man.version, "2.8.160"), man.version);
  ok("_AXLX_PAGE_VER ≥2.8.160", verGe((ps.match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1], "2.8.160"));
  ok("page-script に _fillRouteIdsFromStationMap", /function _fillRouteIdsFromStationMap\(cond\)/.test(ps));
  ok("止める前に地図から埋める", /_fillRouteIdsFromStationMap\(cond\)/.test(ps) && /station_route_from_map/.test(ps));
  ok("地図で埋めたあと hasRoutes を更新", /hasRoutes = !!\(cond\.route_ids && cond\.route_ids\.length\)/.test(ps));
  ok("地図0本の時だけ station_no_route", /station_no_route/.test(ps));
  ok("popup も駅名から沿線を補完", /駅名から沿線を補完/.test(pj) && /getHubLines\(st\)/.test(pj));
  ok("地図に4駅がある（玉造・今里・鶴橋・布施）", (() => {
    const m = read("popup-maps.js");
    return ["玉造", "今里", "鶴橋", "布施"].every((s) => m.includes('"' + s + '":'));
  })());
}

console.log("\n結果: pass=" + pass + " fail=" + fail);
process.exit(fail ? 1 : 0);
