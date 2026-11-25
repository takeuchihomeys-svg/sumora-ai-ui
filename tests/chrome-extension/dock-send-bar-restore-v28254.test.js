/** v2.8.254: 並べ替えtuckで拡張パネルを消さない／必ず戻す／estateで物件送る枠 */
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..");
var bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8");
var ub = fs.readFileSync(path.join(root, "chrome-extension/underbar.js"), "utf8");
var mf = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var n = 0, fail = 0;
function ok(name, cond) {
  n++;
  if (cond) console.log("  ✓ " + name);
  else { fail++; console.log("  ✗ " + name); }
}
ok("manifest ≥2.8.254", mf.version >= "2.8.254");
ok("_tuckGuidesForSort", /function _tuckGuidesForSort/.test(bd));
ok("_restoreGuidesAfterSort", /function _restoreGuidesAfterSort/.test(bd));
ok("tuckがaixlinx-全体セレクタを使わない", !/querySelectorAll\([^)]*\[id\^='aixlinx-'\]/.test(bd));
ok("finishSortでrestore", /_finishSort[\s\S]{0,200}_restoreGuidesAfterSort/.test(bd));
ok("estateで物件送る枠を出す", /method=estate[\s\S]{0,200}show/.test(bd) || /onEstate/.test(bd));
ok("underbar healExistingWrap", /_healExistingWrap/.test(ub));
ok("farFromDockで右へ戻す", /farFromDock/.test(ub));
ok("user-mini印", /data-axlx-user-mini/.test(ub));
console.log(n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
