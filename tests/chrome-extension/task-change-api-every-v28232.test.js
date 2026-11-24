// 実行: node tests/chrome-extension/task-change-api-every-v28232.test.js
// v2.8.232: タスク切替ごとに必ずAPI経路（薄い時だけの抜けを禁止）
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(__dirname, "../../app/lib/auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, d) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (d !== undefined ? "  " + String(d).slice(0, 160) : "")); }
}

console.log("\n■ 版");
ok("manifest ≥2.8.232", mf.version >= "2.8.232", mf.version);
ok("page ≥2.8.232", /_AXLX_PAGE_VER = "2\.8\.(23[2-9]|2[4-9]\d|[3-9]\d{2})"/.test(ps) || /_AXLX_PAGE_VER = "2\.8\.232"/.test(ps) || (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] >= "2.8.232");
ok("rules ≥2.8.232", /AUTO_RULES_REVIEWED_UP_TO = "2\.8\.(23[2-9]|2[4-9]\d|[3-9]\d{2})"/.test(rules) || (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] >= "2.8.232");

console.log("\n■ 毎回API（薄い時スキップ禁止）");
const thenBody = ps.match(/function _graspBeforeNextTaskThen\([\s\S]*?\n  function _recentTaskTransitionGrasped/);
ok("Then 関数がある", !!thenBody);
const body = thenBody ? thenBody[0] : "";
ok("needApi 早期returnが無い", !/if\s*\(\s*!needApi\s*\)\s*\{\s*runGrasp\(\);\s*return;/.test(body));
ok("タスク切替ごとにAPI 印文", /タスク切替ごとにAPI/.test(ps));
ok("必ず _requestLearnRefresh", /_graspBeforeNextTaskThen[\s\S]{0,900}_requestLearnRefresh\(!!forceMajor\)/.test(ps) || /_requestLearnRefresh\(!!forceMajor\)/.test(body));
ok("forceMajor 幹段", /clear_then_fill\|clear\|fill_start\|handoff/.test(ps));
ok("window 公開 Then", /__axlxGraspBeforeNextTaskThen/.test(ps));

console.log("\n■ guide→次へ");
ok("guide_task_link 後に Then", /guide_task_link→次/.test(ps));
ok("決まり task_change_api_every", /id: "task_change_api_every"/.test(rules));
ok("RULES_DONE", /"task_change_api_every"/.test(ps));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
