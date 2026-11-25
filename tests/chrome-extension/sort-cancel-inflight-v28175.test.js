// 2.8.175: 条件入力開始で飛行中の並べ替えカーソルも止める／alive 関所
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
var pu = read("pointer-ui.js");
var ps = read("page-script.js");

console.log("■ 2.8.175 飛行中並べ替えカーソル中断");
ok("manifest ≥2.8.175", verGe(man.version, "2.8.175"), man.version);
ok("_AXLX_PAGE_VER ≥2.8.175", verGe((ps.match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1], "2.8.175"));
ok("pointer cancelMove", /cancelMove:\s*function/.test(pu));
ok("abort が cancelMove を呼ぶ", /_abortAdSort[\s\S]{0,400}?cancelMove/.test(bd));
ok("_sortOnce が aliveFn を受ける", /function _sortOnce\(done, aliveFn\)/.test(bd));
ok("hover 着地前に alive 確認", /moved === false \|\| !alive\(\)/.test(bd));
ok("press 着地前に alive 確認", /function go = function \(\) \{\s*if \(!alive\(\)\)/.test(bd) || /var go = function \(\) \{\s*if \(!alive\(\)\)/.test(bd));
ok("step も alive で止める", /setTimeout\(function \(\) \{\s*if \(!alive\(\)\) \{ done\(false\); return; \}/.test(bd));

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
