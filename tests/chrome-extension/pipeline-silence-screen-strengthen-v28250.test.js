/**
 * v2.8.250: 一連停止→画面把握→強化（一覧・AD・送付の沈黙）
 */
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..");
var bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8");
var ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
var sa = fs.readFileSync(path.join(root, "chrome-extension/search-audit.js"), "utf8");
var mf = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");
var n = 0, fail = 0;
function ok(name, cond, detail) {
  n++;
  if (cond) console.log("  ✓ " + name);
  else { fail++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
}

console.log("\n■ 版");
ok("manifest ≥2.8.250", mf.version >= "2.8.250", mf.version);
ok("page ≥2.8.250", (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] >= "2.8.250");
ok("rules ≥2.8.250", (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] >= "2.8.250");

console.log("\n■ bulk: 一覧後沈黙武装");
ok("_armPipelineSilence", /function _armPipelineSilence\(/.test(bd));
ok("fill-doneで武装", /_armPipelineSilence\("fill_done"\)/.test(bd));
ok("ADで武装", /_armPipelineSilence\("ad_sort"\)/.test(bd));
ok("pressで武装", /_armPipelineSilence\("press"\)/.test(bd));
ok("postMessage tick", /axlx-pipeline-silence-tick/.test(bd));
ok("印 pipeline_silence_tick", /pipeline_silence_tick/.test(bd));

console.log("\n■ page: 把握→スクショ→強化");
ok("pipeline tick受信", /axlx-pipeline-silence-tick/.test(ps));
ok("_screenPollThenApiNext呼び出し", /_screenPollThenApiNext\(\s*"pipeline_silence"/.test(ps));
ok("_driveKeepStrengthen", /_driveKeepStrengthen\(\s*"pipeline:/.test(ps));
ok("pipeline_screen_grasp印", /pipeline_screen_grasp/.test(ps));
ok("flushにpipeline_silenceピン", /pipeline_silence_/.test(ps));
ok("flushにstrengthenピン", /strengthen_/.test(ps));

console.log("\n■ 決まり・KEEP");
ok("決まり pipeline_silence_screen_strengthen", /id: "pipeline_silence_screen_strengthen"/.test(rules));
ok("RULES_DONE", /"pipeline_silence_screen_strengthen"/.test(ps));
ok("KEEP dl:pipeline_silence_", /dl:pipeline_silence_/.test(sa));
ok("KEEP page:pipeline_screen_", /pipeline_screen_/.test(sa));

console.log("\n" + n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
