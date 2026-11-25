// 2.8.170: 駅・沿線・所在地モーダル中は並べ替えしない／手順表照合で止める
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
var rules = fs.readFileSync(path.join(__dirname, "..", "..", "app", "lib", "auto-procedure-rules.ts"), "utf8");

console.log("■ 2.8.170 条件モーダル中は並べ替え禁止＋照合ゲート");
ok("manifest ≥2.8.170", verGe(man.version, "2.8.170"), man.version);
ok("_AXLX_PAGE_VER ≥2.8.170", verGe((ps.match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1], "2.8.170"));
ok("_isCondModalOpen がある", /function _isCondModalOpen/.test(bd));
ok("駅モーダル判定", /駅の設定|沿線の設定へ戻る/.test(bd));
ok("autoPress がモーダルで止める", /blocked_cond_modal/.test(bd));
ok("並べ替え前にモーダル検査", /条件入力中のため並べ替えしない/.test(bd));
ok("_abortAdSort がある", /function _abortAdSort/.test(bd));
ok("autofill 開始で並べ替え中断", /_abortAdSort\("autofill_initiated"\)/.test(bd));
ok("照合NGで list_flow_block", /list_flow_block/.test(bd));
ok("ホバー中もモーダルで中断", /during_hover_head|during_menu|during_hover_ad/.test(bd));
ok("決まり guide_list_next since 2.8.170", /id: "guide_list_next_flow"[\s\S]{0,500}?since: "2\.8\.170"/.test(rules));

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
