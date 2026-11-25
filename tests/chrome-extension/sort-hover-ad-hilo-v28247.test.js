// v2.8.247: 並べ替えは押さず hover→AD hover→高→低 click（ループ止め）
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..");
var bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8");
var ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
var mf = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");
var f64 = fs.readFileSync(path.join(root, "app/lib/root-cause-improve-loop.ts"), "utf8");
var n = 0;
var fail = 0;
function ok(name, cond, detail) {
  n++;
  if (cond) console.log("  ✓ " + name);
  else {
    fail++;
    console.log("  ✗ " + name + (detail ? " — " + detail : ""));
  }
}

console.log("\n■ 版");
ok("manifest ≥2.8.247", mf.version >= "2.8.247", mf.version);
ok("page ≥2.8.247", (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] >= "2.8.247");
ok("rules ≥2.8.247", (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] >= "2.8.247");

console.log("\n■ 正本: hover→AD→高→低");
ok("① hover(sortHead)・pressしない", /hover\(sortHead/.test(bd) && !/press\(sortHead/.test(bd));
ok("② hover(adItem)", /hover\(adItem/.test(bd));
ok("③ press(hiToLo) だけ", /press\(hiToLo/.test(bd));
ok("sort_forbid_click（並べ替え/AD押禁）", /sort_forbid_click/.test(bd));
ok("findAdInOpenMenu", /function findAdInOpenMenu|var findAdInOpenMenu/.test(bd));
ok("below 560（メニュー下部AD）", /ar\.bottom \+ 560/.test(bd));
ok("waitAdBelowHead", /waitAdBelowHead/.test(bd));
ok("飛行中ガード _adSortInFlight", /_adSortInFlight/.test(bd) && /sort_skip_inflight/.test(bd));
ok("sort_flow_grasp 印", /sort_flow_grasp/.test(bd));
ok("通常録画 scene_flows 把握", /sort_flow_from_rec/.test(bd) && /axlx_learn_scene_flows/.test(bd));
ok("jQuery mouseenter（clickしない）", /trigger\("mouseenter"\)/.test(bd));

console.log("\n■ 決まり・F64");
ok("決まり sort_hover_no_click_loop", /id: "sort_hover_no_click_loop"/.test(rules));
ok("RULES_DONE", /"sort_hover_no_click_loop"/.test(ps));
ok("F64 sort_click_loop_miss_ad", /sort_click_loop_miss_ad/.test(f64));
ok("旧 below+220 を捨てた", !/ar\.bottom \+ 220/.test(bd));

console.log("\n" + n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
