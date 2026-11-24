// 2.8.177: 確定してリストへ／入れた／検索把握→AD／外す を手順書×画面で1つずつ
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
var bd = read("bulk-dl.js");
var rules = fs.readFileSync(path.join(__dirname, "..", "..", "app", "lib", "auto-procedure-rules.ts"), "utf8");

console.log("■ 2.8.177 確定閉じ・入れた・検索把握→AD・外す");
ok("manifest ≥2.8.178", verGe(man.version, "2.8.178"), man.version);
ok("_AXLX_PAGE_VER ≥2.8.178", verGe((ps.match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1], "2.8.178"));
ok("_guideLikeAfterConfirmCheck がある", /function _guideLikeAfterConfirmCheck/.test(ps));
ok("_guideLikeAfterSearchGrasp がある", /function _guideLikeAfterSearchGrasp/.test(ps));
ok("駅後に after_confirm", /_guideLikeAfterConfirmCheck\("station"/.test(ps));
ok("地域後に after_confirm", /_guideLikeAfterConfirmCheck\("area"/.test(ps));
ok("地域 after_confirm が after_area と同数（フォールバック抜け無し）",
  (ps.match(/_guideLikeAfterConfirmCheck\("area"/g) || []).length
    === (ps.match(/_guideLikePhaseCheck\("after_area"/g) || []).length,
  "confirm=" + (ps.match(/_guideLikeAfterConfirmCheck\("area"/g) || []).length
    + " area=" + (ps.match(/_guideLikePhaseCheck\("after_area"/g) || []).length);
ok("検索押下後に after_search", /_guideLikeAfterSearchGrasp\("search_press_ok"\)/.test(ps));
ok("検索click直前にも after_search（リロード生存）", /_guideLikeAfterSearchGrasp\("search_click_直前"\)/.test(ps));
ok("Case C で search_grasp を立て直す", /search_grasp_gate[\s\S]{0,40}?case_c/.test(bd));
ok("after_confirm の focus は入忘れ", /phase === "after_confirm"[\s\S]{0,80}?miss/.test(ps));
ok("axlx-search-grasped を postMessage", /from: "axlx-search-grasped"/.test(ps));
ok("bulk-dl が search-grasped を受ける", /axlx-search-grasped/.test(bd));
ok("bulk-dl に search_grasp_gate", /search_grasp_gate/.test(bd));
ok("検索把握なしで sort_blocked", /sort_blocked[\s\S]{0,40}?search_ungrasped/.test(bd));
ok("入力開始で search_grasped を消す", /remove\("axlx_search_grasped"\)/.test(bd));
ok("外し後 after_clear がある", /function _guideLikeAfterClearCheck/.test(ps));
ok("決まり since 2.8.177", /id: "guide_phase_checkpoints"[\s\S]{0,600}?since: "2\.8\.177"/.test(rules));
ok("決まりに after_confirm / after_search", /guide_phase_after_confirm[\s\S]{0,200}?guide_phase_after_search/.test(rules));
ok("marker が AfterConfirm", /marker: "_guideLikeAfterConfirmCheck"/.test(rules));

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
