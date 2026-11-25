// 実行: node tests/chrome-extension/screen-task-grasp-arch-v28237.test.js
// v2.8.237: 画面照会3層＋タスク切替ごとに screen_task_grasp
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const sa = fs.readFileSync(path.join(root, "search-audit.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(__dirname, "../../app/lib/auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, d) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (d !== undefined ? "  " + String(d).slice(0, 160) : "")); }
}

console.log("\n■ 版");
ok("manifest ≥2.8.237", mf.version >= "2.8.237", mf.version);
ok("page ≥2.8.237", (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] >= "2.8.237");
ok("rules ≥2.8.237", (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] >= "2.8.237");

console.log("\n■ 3層の説明がコードにある");
ok("層A DOM", /DOM画面照会|DOM照会/.test(ps));
ok("層B API手順書", /API手順書取込|human-learn-profile/.test(ps));
ok("層C スクショは学習", /スクショ撮影[\s\S]{0,80}学習|学習用/.test(ps));
ok("Visionでないと明記", /スクショVisionで次手を決めるのではない|スクショVisionではない/.test(ps) || /スクショVisionではない/.test(rules));

console.log("\n■ タスクごとに画面照会");
ok("screen_task_grasp 印", /"screen_task_grasp"/.test(ps));
ok("_graspBeforeNextTaskThen が先に画面", /function _graspBeforeNextTaskThen[\s\S]{0,1800}screen_task_grasp/.test(ps));
ok("切れ経路は skipScreen", /skipScreen:\s*true/.test(ps));
ok("RULES_DONE", /"screen_task_grasp_every_transition"/.test(ps));
ok("決まり", /id: "screen_task_grasp_every_transition"/.test(rules));
ok("KEEP/RULE screen_task_grasp", /screen_task_grasp/.test(sa));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
