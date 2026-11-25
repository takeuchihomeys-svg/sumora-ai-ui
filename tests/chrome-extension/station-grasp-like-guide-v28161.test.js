// 2.8.161（2026-11-22 竹内さん「通常モードだと駅ちゃんと把握して光っているのに、自動・AIXは駅が弱い」）
// 自動も primary_stations / primary_route_ids を先にそろえてから沿線→駅を選ぶ。
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

console.log("■ 2.8.161 自動も通常案内と同じ指定駅把握");
{
  const man = JSON.parse(read("manifest.json"));
  const ps = read("page-script.js");
  const sa = read("search-audit.js");
  ok("manifest ≥2.8.161", verGe(man.version, "2.8.161"), man.version);
  ok("_AXLX_PAGE_VER ≥2.8.161", verGe((ps.match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1], "2.8.161"));
  ok("_applyGuideLikeStationGrasp がある", /function _applyGuideLikeStationGrasp\(cond\)/.test(ps));
  ok("fillRealpro 入口で案内並み把握を呼ぶ", /_applyGuideLikeStationGrasp\(cond\)/.test(ps));
  ok("fill 開始で __axlxFillCond を残す", /window\.__axlxFillCond = cond/.test(ps));
  ok("駅押しは primary_stations を先に", /primary_stations/.test(ps) && /selectStationsByName/.test(ps));
  ok("点検印 station_grasp_like_guide", /station_grasp_like_guide/.test(ps));
  ok("_AXLX_RULES_DONE に station_grasp_like_guide", /"station_grasp_like_guide"/.test(ps));
  ok("_PIN に station_grasp_like_guide", /station_grasp_like_guide/.test((ps.match(/var _PIN = \/([^/]+)\//) || [])[1] || ""));
  ok("search-audit KEEP/RULE に駅把握の段", /station_grasp_like_guide/.test(sa) && /station_route_from_map/.test(sa));
  ok("popup は primary_stations を送る", /primary_stations:\s*primary_stations\.slice\(\)/.test(read("popup.js")));
}

console.log("\n結果: pass=" + pass + " fail=" + fail);
process.exit(fail ? 1 : 0);
