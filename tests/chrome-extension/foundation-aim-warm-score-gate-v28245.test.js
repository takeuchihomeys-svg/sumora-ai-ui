// v2.8.245: 再現55%の主因（aim無・point47%）を入口で切る土台
//   ・fill入口で aim 強制 warm
//   ・score_gate（配線F58≠再現%）を印で明示
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..");
var ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
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
ok("manifest ≥2.8.245", mf.version >= "2.8.245", mf.version);
ok("page ≥2.8.245", (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] >= "2.8.245");
ok("rules ≥2.8.245", (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] >= "2.8.245");

console.log("\n■ 入口で aim warm＋score_gate");
ok("_enforceAutoFoundation に _learnWarm(true)", /_learnWarm\(true/.test(ps));
ok("score_gate 印", /score_gate/.test(ps) && /配線≠再現/.test(ps));
ok("foundation_aim_warm 印", /foundation_aim_warm/.test(ps));
ok("RULES_DONE foundation_aim_warm_score_gate", /"foundation_aim_warm_score_gate"/.test(ps));
ok("決まり foundation_aim_warm_score_gate", /id: "foundation_aim_warm_score_gate"/.test(rules));

console.log("\n■ KEEP / RULE / PIN");
ok("KEEP score_gate", /score_gate/.test(sa));
ok("KEEP foundation_aim_warm", /foundation_aim_warm/.test(sa));
ok("RULE score_gate", /var RULE_STEP = [^\n]*\|score_gate\|/.test(sa) /* RULE_STEP は1行の長い正規表現（窓の長さに依存せず、その行の中に score_gate がある事を見る） */);
ok("PIN score_gate", /score_gate/.test(ps) && /foundation_aim_warm/.test(ps));

console.log("\n■ F64 症例");
ok("F64 aim_warm_score_gate", /aim_warm_score_gate|foundation_aim_warm_score/.test(f64));

console.log("\n" + n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
