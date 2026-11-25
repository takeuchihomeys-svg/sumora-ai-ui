// v2.8.243: 土台関所＋細分化駆動＋旧legacy衝突をscreenOkで止める
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..");
var ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
var bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8");
var sa = fs.readFileSync(path.join(root, "chrome-extension/search-audit.js"), "utf8");
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
ok("manifest ≥2.8.243", mf.version >= "2.8.243", mf.version);
ok("page ≥2.8.243", (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] >= "2.8.243");
ok("rules ≥2.8.243", (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] >= "2.8.243");

console.log("\n■ 旧legacy衝突を止める");
ok("legacy_blocked_no_screen", /legacy_blocked_no_screen/.test(bd));
ok("screen_ok_path", /screen_ok_path/.test(bd));
ok("afterSearchもscreenOk必須", /afterSearch[\s\S]{0,200}legacy_blocked_no_screen|_isSearchConfirmGrasp[\s\S]{0,120}legacy_blocked/.test(bd));
ok("一覧ありでもscreen無しはADしない", /list_without_screen/.test(bd));
ok("旧legacy_claude_pathでADしない", !/search_grasp_gate\",\s*\"legacy_claude_path\"/.test(bd));
ok("RULES_DONE legacy_ad", /"legacy_ad_requires_screen_ok"/.test(ps));
ok("決まり legacy_ad", /id: "legacy_ad_requires_screen_ok"/.test(rules));
ok("旧sort_legacy_claude_path退役", !/id: "sort_legacy_claude_path"/.test(rules));

console.log("\n■ 土台→細分化→自動反映");
ok("_enforceAutoFoundation", /function _enforceAutoFoundation\(/.test(ps));
ok("_driveFlowSubdivideGaps", /function _driveFlowSubdivideGaps\(/.test(ps));
ok("fill_startで土台", /_enforceAutoFoundation\("fill_start"\)/.test(ps));
ok("沈黙で細分化drive", /_driveFlowSubdivideGaps\("silence_tick"\)/.test(ps));
ok("foundation_gate 印", /foundation_gate/.test(ps));
ok("flow_subdivide_drive 印", /flow_subdivide_drive/.test(ps));
ok("原子 sort_screen_ok", /sort_screen_ok/.test(ps) && /sort_screen_ok/.test(bd));
ok("決まり foundation", /id: "auto_foundation_subdivide_reflect"/.test(rules));
ok("RULES_DONE foundation", /"auto_foundation_subdivide_reflect"/.test(ps));

console.log("\n■ F64・KEEP");
ok("F64 legacy症例", /legacy_ad_collides_screen_ok/.test(f64));
ok("F64 foundation症例", /foundation_subdivide_auto_reflect/.test(f64));
ok("KEEP legacy_blocked", /legacy_blocked_no_screen/.test(sa));
ok("KEEP foundation_gate", /foundation_gate/.test(sa));
ok("KEEP flow_subdivide_", /flow_subdivide_/.test(sa));

console.log("\n" + n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
