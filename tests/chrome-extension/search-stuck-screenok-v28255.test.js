/** v2.8.255: 検索後 screenOk 待ち固着 → 次客へ進まないボトルネック */
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..");
var bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8");
var ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
var mf = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var n = 0, fail = 0;
function ok(name, cond) {
  n++;
  if (cond) console.log("  ✓ " + name);
  else { fail++; console.log("  ✗ " + name); }
}
ok("manifest ≥2.8.255", mf.version >= "2.8.255");
ok("page alreadyResult（既に結果）", /alreadyResult/.test(ps));
ok("_inferScreenOkFromDom", /function _inferScreenOkFromDom/.test(bd));
ok("_armScreenOkWatchdog", /function _armScreenOkWatchdog/.test(bd));
ok("search-armed で silence＋watchdog", /_armPipelineSilence\("search_armed"\)/.test(bd) && /_armScreenOkWatchdog\("search_armed"\)/.test(bd));
ok("silence で dom_infer", /silence_dom_infer|dom_infer→sort/.test(bd));
ok("press_wait で watchdog", /_armScreenOkWatchdog\("press_wait"\)/.test(bd));
ok("armed_wait で watchdog", /_armScreenOkWatchdog\("armed_wait"\)/.test(bd));
console.log(n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
