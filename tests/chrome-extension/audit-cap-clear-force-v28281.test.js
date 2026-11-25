/**
 * 2.8.281 統括Pro通し点検: 点検の段が120段を超えても、外し（station_clear・ward_clear・line_clear）・
 *   dl:auto_force（2.8.280 の通常モードの強制停止）・次客の把握が、普通の段より先に捨てられない。
 * 実物の search-audit.js の pushStep を動かす。
 */
const fs = require("fs");
const path = require("path");
const A = require(path.join(__dirname, "..", "..", "chrome-extension", "search-audit.js"));
const man = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "manifest.json"), "utf8"));

let pass = 0, fail = 0;
function ok(name, c, extra) { if (c) pass++; else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 220))); } }
function semverOk(v, min) {
  const a = String(v).split(".").map(Number), b = String(min).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) > (b[i] || 0)) return true; if ((a[i] || 0) < (b[i] || 0)) return false; }
  return true;
}
ok(semverOk(man.version, "2.8.281"), "manifest >= 2.8.281 got " + man.version);

// 普通の段を大量に流しても、守りたい段は残る
function flood(guardKeys) {
  const steps = [];
  A.pushStep(steps, "begin", "bulk_manual", 1);
  guardKeys.forEach((k, i) => A.pushStep(steps, k, "g" + i, 10 + i));
  for (let i = 0; i < 400; i++) A.pushStep(steps, "page:plain_chatter_" + (i % 37), "x" + i, 100 + i);
  return steps;
}
const guards = [
  "dl:auto_force_denied", "dl:auto_force",
  "page:station_clear_stuck", "page:ward_clear_hidden_left", "page:line_clear_stuck",
  "dl:next_customer_grasp", "dl:next_move_grasp",
];
const steps = flood(guards);
ok(steps.length <= 120, "上限は120のまま（" + steps.length + "）");
guards.forEach((g) => ok(steps.some((s) => s.k === g), "残る: " + g));
ok(steps.some((s) => s.k === "begin"), "begin は残る");

// 同じ外しの段が繰り返されても、重複は先に落ちる（上限を食い潰さない）
{
  const s2 = [];
  A.pushStep(s2, "begin", "x", 1);
  for (let i = 0; i < 300; i++) A.pushStep(s2, "page:station_clear_retry", "n" + i, 10 + i);
  A.pushStep(s2, "finish", "ok", 9999);
  ok(s2.length <= 120, "外しの繰り返しでも上限は120");
  ok(s2.some((s) => s.k === "finish") && s2.some((s) => s.k === "begin"), "begin と finish は残る");
}

// 守り方は「落とす順の後ろへ」で、決まりの段（RULE）に入っている
ok(A.RULE_STEP.test("dl:auto_force_denied") && A.RULE_STEP.test("page:ward_clear_open"), "RULE_STEP に入っている");
ok(!A.KEEP_STEP.test("page:station_clear_retry"), "KEEP には入れない（重複は落とせる）");

console.log("audit-cap-clear-force-v28281: " + pass + " pass, " + fail + " fail");
if (fail) process.exit(1);
