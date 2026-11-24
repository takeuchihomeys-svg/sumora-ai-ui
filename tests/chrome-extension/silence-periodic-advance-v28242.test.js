// v2.8.242: 沈黙でも定期照会→次タスク/次客／武装keep／強制flush
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..");
var ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
var mf = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");
var sa = fs.readFileSync(path.join(root, "chrome-extension/search-audit.js"), "utf8");
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
ok("manifest ≥2.8.242", mf.version >= "2.8.242", mf.version);
ok("page ≥2.8.242", (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] >= "2.8.242");
ok("rules ≥2.8.242", (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] >= "2.8.242");

console.log("\n■ 武装keep（計リセット禁止）");
ok("_armFillSilenceWatch", /function _armFillSilenceWatch\(/.test(ps));
ok("既武装なら return", /if \(_clearWatchTimer\)[\s\S]{0,500}return;/.test(ps));
ok("silence_watch_keep 印", /silence_watch_keep/.test(ps));

console.log("\n■ 定期照会→次タスク→次客");
ok("沈黙で screenPoll", /_screenPollThenApiNext\("silence_watch"/.test(ps));
ok("3回で次タスク", /_silenceNoProgTicks >= 3/.test(ps) && /silence_task_advance/.test(ps));
ok("publishTaskGrasp スキップ", /沈黙スキップ:/.test(ps));
ok("6回で次客", /_silenceNoProgTicks >= 6/.test(ps) && /notifyDone\(/.test(ps) && /silence_stuck/.test(ps));

console.log("\n■ 途中flush");
ok("_forceAuditStepsFlush", /function _forceAuditStepsFlush\(/.test(ps));
ok("沈黙tickで強制flush", /_forceAuditStepsFlush\("silence_tick/.test(ps));
ok("fill-progress force", /force:\s*true/.test(ps));

console.log("\n■ 決まり・F64・KEEP");
ok("決まり silence since 242", /silence_stuck_watch_and_flush[\s\S]{0,200}since: "2\.8\.242"/.test(rules));
ok("marker _forceAuditStepsFlush", /marker: "_forceAuditStepsFlush"/.test(rules));
ok("KEEP silence_task_advance", /silence_task_advance/.test(sa));
ok("F64 minVerify 242", /minVerifyExtVersion: "2\.8\.242"/.test(f64));
ok("F64 verify silence_task_advance", /silence_task_advance/.test(f64));

console.log("\n" + n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
