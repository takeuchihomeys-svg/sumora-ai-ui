/** v2.8.257: 駅外し後に止まらず外し続行 */
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..");
var ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
var rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");
var mf = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var n = 0, fail = 0;
function ok(name, cond) {
  n++;
  if (cond) console.log("  ✓ " + name);
  else { fail++; console.log("  ✗ " + name); }
}
ok("manifest ≥2.8.257", mf.version >= "2.8.257");
ok("page ver ≥2.8.257", (function () {
  var m = ps.match(/_AXLX_PAGE_VER = "([^"]+)"/);
  return m && m[1] >= "2.8.257";
})());
ok("station_clear_continue 印", /station_clear_continue/.test(ps));
ok("wrong_screen 待ち上限→force_try", /station_back_force_try/.test(ps) && /wrongN < 5/.test(ps));
ok("駅外し後 closed/unknown → reopen", /station_clear_reopen_after/.test(ps));
ok("残0なら done で次へ", /駅外し後・沿線残0→完了して次の外しへ/.test(ps));
ok("grasp: canBackLn だけで station_list", /canBackLn && !canGoSt\) kind = "station_list"/.test(ps));
ok("沈黙 leftover で place clear 1歩", /place_clear_advance/.test(ps) && /_advanceForcePlaceClearViaStationFirst/.test(ps));
ok("RULES_DONE", /station_clear_continue_after_stations/.test(ps));
ok("AUTO_RULES", /id: "station_clear_continue_after_stations"/.test(rules));
ok("REVIEWED ≥2.8.257", (function () {
  var m = rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/);
  return m && m[1] >= "2.8.257";
})());
console.log(n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
