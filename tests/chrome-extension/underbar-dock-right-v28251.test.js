/** v2.8.251: リアプロ右ドック消失対策 */
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..");
var ub = fs.readFileSync(path.join(root, "chrome-extension/underbar.js"), "utf8");
var mf = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var n = 0, fail = 0;
function ok(name, cond) {
  n++;
  if (cond) console.log("  ✓ " + name);
  else { fail++; console.log("  ✗ " + name); }
}
ok("manifest ≥2.8.251", mf.version >= "2.8.251");
ok("_defaultDockX", /function _defaultDockX\(/.test(ub));
ok("snapDockRightIfLost", /_snapDockRightIfLost/.test(ub));
ok("左すぎで右へ戻す", /tooLeft/.test(ub) && /posX = dock/.test(ub));
ok("dblclickで位置も右ドック", /dblclick[\s\S]{0,200}_defaultDockX/.test(ub));
console.log(n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
