// 2.8.176: 条件モーダル検知は可視ラベル正本（body.innerText 先頭8000字に依存しない）
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..", "chrome-extension");
function read(n) { return fs.readFileSync(path.join(root, n), "utf8"); }
function verGe(a, b) {
  var x = String(a || "").split(".").map(Number), y = String(b || "").split(".").map(Number);
  for (var i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return true;
}
var passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { console.log("  ✓ " + name); passed++; }
  else { console.log("  ✗ " + name + (extra ? " — " + extra : "")); failed++; }
}
var man = JSON.parse(read("manifest.json"));
var bd = read("bulk-dl.js");
var ps = read("page-script.js");

console.log("■ 2.8.176 モーダル検知＝可視ラベル");
ok("manifest ≥2.8.176", verGe(man.version, "2.8.176"), man.version);
ok("_AXLX_PAGE_VER ≥2.8.176", verGe((ps.match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1], "2.8.176"));
ok("_visCount がある", /function _visCount\(sel\)/.test(bd));
// コメントに「旧は … slice(0, 8000)」と書いてよい。実行コードで body.innerText を 8000 で切って判定していないこと
ok("旧 body.innerText.slice(0, 8000) を実行で使っていない", !/bodyTx\s*=\s*String\(\(document\.body[\s\S]{0,80}slice\(0,\s*8000\)/.test(bd));
ok("可視 station だけで station 判定", /if \(stV > 0\) return "station"/.test(bd));
ok("可視 line だけで line 判定", /if \(lnV > 0\) return "line"/.test(bd));
ok("可視 city だけで area 判定", /if \(cityV > 0\) return "area"/.test(bd));
ok("並べ替え前に可視ラベルで再止め", /sort_blocked", "modal_or_fill_vis"/.test(bd));
ok("autofill 開始で _autoSendArmed=false", /_abortAdSort\("autofill_initiated"\)[\s\S]{0,200}?_autoSendArmed = false/.test(bd));
ok("根本コメント（8000字切れ）", /8000/.test(bd) && /可視/.test(bd));

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
