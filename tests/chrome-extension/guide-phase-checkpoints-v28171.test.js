// 2.8.171: 駅・地域・場所のあと・検索前も手順表×画面を1つずつ照合
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
var ps = read("page-script.js");
var sa = read("search-audit.js");
var rules = fs.readFileSync(path.join(__dirname, "..", "..", "app", "lib", "auto-procedure-rules.ts"), "utf8");

console.log("■ 2.8.173 手順表×画面：外し後・駅後・地域後・場所後・検索前を1つずつ");
ok("manifest ≥2.8.173", verGe(man.version, "2.8.173"), man.version);
ok("_AXLX_PAGE_VER ≥2.8.173", verGe((ps.match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1], "2.8.173"));
ok("地域フォールバックでも after_area", /_guideLikePhaseCheck\("after_area"[\s\S]{0,200}?所在地フォールバック/.test(ps));
ok("_guideLikePhaseCheck がある", /function _guideLikePhaseCheck/.test(ps));
ok("_guideLikeAfterClearCheck がある", /function _guideLikeAfterClearCheck/.test(ps));
ok("きれい確認後に after_clear", /_guideLikeAfterClearCheck\(cond/.test(ps));
ok("after_station 関所", /_guideLikePhaseCheck\("after_station"/.test(ps));
ok("after_area 関所", /_guideLikePhaseCheck\("after_area"/.test(ps));
ok("after_place 関所", /_guideLikePhaseCheck\("after_place"/.test(ps));
ok("before_search 関所", /_guideLikePhaseCheck\("before_search"/.test(ps));
ok("1つずつ印 guide_phase_one", /guide_phase_one/.test(ps));
ok("致命で止める guide_phase_block", /guide_phase_block/.test(ps));
ok("_AXLX_RULES_DONE に guide_phase_checkpoints", /"guide_phase_checkpoints"/.test(ps));
ok("決まり since ≥2.8.171", /id: "guide_phase_checkpoints"[\s\S]{0,600}?since: "2\.8\.17[1-9]"/.test(rules));
ok("search-audit に guide_phase_", /guide_phase_/.test(sa));
ok("_PIN に guide_phase_", /guide_phase_/.test(ps));

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
