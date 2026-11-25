/** v2.8.261: 検索後固着回復＋版表示＋steps flush */
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..");
var bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8");
var rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");
var ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
var mf = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var n = 0, fail = 0;
function ok(name, cond) {
  n++;
  if (cond) console.log("  ✓ " + name);
  else { fail++; console.log("  ✗ " + name); }
}
ok("manifest ≥2.8.261", mf.version >= "2.8.261");
ok("estate_stuck_recover", /estate_stuck_recover/.test(bd));
ok("bulk_alive 印", /bulk_alive/.test(bd));
ok("axlx-bar-ver 版表示", /axlx-bar-ver/.test(bd));
ok("kick on stuck", /_kickSortAfterSearch\("estate_stuck_recover"\)/.test(bd));
ok("force flush", /__axlxForceAuditStepsFlush\("estate_stuck"\)/.test(bd));
ok("RULES_DONE", /estate_stuck_recover_after_search/.test(ps));
ok("AUTO_RULES", /id: "estate_stuck_recover_after_search"/.test(rules));
ok("REVIEWED ≥2.8.261", (function () {
  var m = rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/);
  return m && m[1] >= "2.8.261";
})());
console.log(n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
