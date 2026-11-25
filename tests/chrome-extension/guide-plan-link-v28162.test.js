// 2.8.162（2026-11-22 竹内さん「通常は把握が強い／自動はまばら。通常のように連携」）
// 通常の光る把握＝手順表＋画面の今。自動にも同じ手順表を載せる。
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

console.log("■ 2.8.162 通常と同じ手順表を自動に連携");
{
  const man = JSON.parse(read("manifest.json"));
  const ps = read("page-script.js");
  const cj = read("content.js");
  const sa = read("search-audit.js");
  ok("manifest ≥2.8.162", verGe(man.version, "2.8.162"), man.version);
  ok("_AXLX_PAGE_VER ≥2.8.162", verGe((ps.match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1], "2.8.162"));
  ok("web_accessible に realpro-guide-plan.js", /realpro-guide-plan\.js/.test(JSON.stringify(man.web_accessible_resources)));
  ok("content が guide-plan を page に注入", /realpro-guide-plan\.js/.test(cj) && /通常の光る把握/.test(cj));
  ok("_guideLikeFormGrasp がある", /function _guideLikeFormGrasp\(cond\)/.test(ps));
  ok("fill で手順表把握を呼ぶ", /_guideLikeFormGrasp\(cond\)/.test(ps));
  ok("指定未完了で駅だけ先押し", /station_primary_only/.test(ps) && /primaryPending/.test(ps));
  ok("指定未完了で沿線だけ先押し", /line_primary_only/.test(ps));
  ok("station_scene が primaryPending を見る", /primaryPending/.test(ps) && /指定未完/.test(ps));
  ok("_AXLX_RULES_DONE に guide_plan_link", /"guide_plan_link"/.test(ps));
  ok("search-audit に guide_plan_linked", /guide_plan_linked/.test(sa));
}

console.log("\n結果: pass=" + pass + " fail=" + fail);
process.exit(fail ? 1 : 0);
