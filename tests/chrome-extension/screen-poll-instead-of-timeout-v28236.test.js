// 実行: node tests/chrome-extension/screen-poll-instead-of-timeout-v28236.test.js
// v2.8.236: タイムアウトの代わりに画面照会→把握→API次手
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const sa = fs.readFileSync(path.join(root, "search-audit.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(__dirname, "../../app/lib/auto-procedure-rules.ts"), "utf8");
const rc = fs.readFileSync(path.join(__dirname, "../../app/lib/root-cause-improve-loop.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, d) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (d !== undefined ? "  " + String(d).slice(0, 160) : "")); }
}

console.log("\n■ 版");
ok("manifest ≥2.8.236", mf.version >= "2.8.236", mf.version);
ok("page ≥2.8.236", (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] >= "2.8.236");
ok("rules ≥2.8.236", (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] >= "2.8.236");

console.log("\n■ 画面照会コア");
ok("_diagnoseStuckScreen", /function _diagnoseStuckScreen\(/.test(ps));
ok("_screenPollGrasp", /function _screenPollGrasp\(/.test(ps));
ok("_screenPollThenApiNext", /function _screenPollThenApiNext\(/.test(ps));
ok("印 screen_poll_grasp", /"screen_poll_grasp"/.test(ps));
ok("印 screen_poll_api_next", /"screen_poll_api_next"/.test(ps));
ok("wait mid で画面照会", /wait_mid[\s\S]{0,80}_screenPollGrasp|_screenPollGrasp\(\{ phase: "wait_mid"/.test(ps));
ok("wait timeout で API次手", /wait_timeout[\s\S]{0,120}_screenPollThenApiNext|_screenPollThenApiNext\("wait_timeout"/.test(ps));
ok("fill_timeout 前に画面照会", /fill_timeout[\s\S]{0,200}_screenPollThenApiNext|_screenPollThenApiNext\("fill_timeout"/.test(ps));
// 2.8.256 以降: 未回復時の録画→強化→橋渡しが間に入り窓 {0,1200} では届かない。関数の本体（次の「/**」の手前まで）の中で呼ぶ事を見る。
  ok("API経路 _graspBeforeNextTaskThen", (() => {
    const i = ps.indexOf("function _screenPollThenApiNext("); const j = ps.indexOf("\n  /**", i);
    const body = i > 0 && j > i ? ps.slice(i, j) : "";
    return body.length > 500 && /_graspBeforeNextTaskThen\(\s*String\(phase \|\| "wait_timeout"\)[\s\S]{0,300}finish,/.test(body);
  })());

console.log("\n■ 決まり・KEEP");
ok("RULES_DONE", /"screen_poll_instead_of_timeout"/.test(ps));
ok("決まり screen_poll_instead_of_timeout", /id: "screen_poll_instead_of_timeout"/.test(rules));
ok("marker _screenPollThenApiNext", /marker: "_screenPollThenApiNext"/.test(rules));
ok("KEEP/RULE screen_poll_", /screen_poll_/.test(sa));
ok("_PIN screen_poll_", /screen_poll_/.test(ps.match(/var _PIN = \/[\s\S]*?\//)[0]));

console.log("\n■ F64");
ok("症例 timeout_without_screen_poll", /timeout_without_screen_poll/.test(rc));
ok("minVerify ≥2.8.236", /timeout_without_screen_poll[\s\S]{0,900}minVerifyExtVersion: "2\.8\.236"/.test(rc));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
