/** v2.8.260: 物件送る枠をお客様パネルより上に・左余白不足は下へ */
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..");
var bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8");
var ub = fs.readFileSync(path.join(root, "chrome-extension/underbar.js"), "utf8");
var rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");
var ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
var mf = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var n = 0, fail = 0;
function ok(name, cond) {
  n++;
  if (cond) console.log("  ✓ " + name);
  else { fail++; console.log("  ✗ " + name); }
}
ok("manifest ≥2.8.260", mf.version >= "2.8.260");
ok("bar z-index 647", /z-index:2147483647/.test(bd) && /axlx-bar/.test(bd));
ok("wrap z-index 645", /2147483645/.test(ub));
ok("heal existing wrap z", /wrap→645|send_bar_zfix/.test(bd));
ok("bottom-left fallback", /bottom-left/.test(bd) && /roomLeft/.test(bd));
ok("send_bar_dock 印", /send_bar_dock/.test(bd));
ok("buried undrag", /send_bar_undrag/.test(bd));
ok("RULES_DONE", /send_bar_above_customer_panel/.test(ps));
ok("AUTO_RULES", /id: "send_bar_above_customer_panel"/.test(rules));
ok("REVIEWED ≥2.8.260", (function () {
  var m = rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/);
  return m && m[1] >= "2.8.260";
})());
console.log(n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
