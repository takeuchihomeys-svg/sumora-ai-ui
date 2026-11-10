// 実行: node tests/chrome-extension/human-rest-v2598.test.js
// 2026-11-10 竹内さん「このように細かい部分も実際の人間がするように／人間なので休憩するときもある」
//   ① 休憩は「決まった回数ごと」ではなく抽選（等間隔にしない）
//   ② 短い休憩 12〜30秒・長い休憩 60〜180秒
//   ③ 作業が続くほど休む確率が上がる（20分未満は休まない・120分超は長い休憩も抽選）
//   ④ 休憩はお客様の区切り（次の人へ移る前）に入る・サイトへのアクセスは増えない
//   ⑤ 細部: 検索を押す前に「全体を見直す間」がある
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const H = require(path.join(dir, "human-wait.js"));

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

console.log("■ ① 休憩は抽選（決まった回数ごとではない）");
ok("restDue がある", typeof H.restDue === "function");
ok("restRange がある", typeof H.restRange === "function");
// 同じ条件で何度も呼ぶと、休む時と休まない時がある（抽選）
(() => {
  const since = Date.now() - 40 * 60000; // 40分作業した
  const results = Array.from({ length: 400 }, () => H.restDue(since, Date.now()));
  const rested = results.filter((r) => r.rest).length;
  ok("40分作業: 休む時と休まない時がある（抽選）", rested > 0 && rested < 400, { rested });
  ok("40分作業: 休む割合はおおよそ 8%（2〜20%）", rested / 400 > 0.02 && rested / 400 < 0.20, { rate: (rested / 400).toFixed(3) });
})();

console.log("\n■ ② 短い休憩 12〜30秒・長い休憩 60〜180秒");
(() => {
  const since = Date.now() - 40 * 60000;
  const short = Array.from({ length: 600 }, () => H.restDue(since, Date.now())).filter((r) => r.rest && r.kind === "short");
  ok("短い休憩の長さが 12〜30秒に収まる", short.length > 0 && short.every((r) => r.ms >= 12000 && r.ms <= 30000), short.slice(0, 3));
})();
(() => {
  const since = Date.now() - 150 * 60000;
  const long = Array.from({ length: 1200 }, () => H.restDue(since, Date.now())).filter((r) => r.rest && r.kind === "long");
  ok("長い休憩の長さが 60〜180秒に収まる", long.length > 0 && long.every((r) => r.ms >= 60000 && r.ms <= 180000), long.slice(0, 3));
})();
ok("restRange が種類ごとの範囲を返す", H.restRange("short").lo === 12000 && H.restRange("long").hi === 180000);

console.log("\n■ ③ 作業の続き具合で確率が変わる");
(() => {
  const fresh = Array.from({ length: 400 }, () => H.restDue(Date.now() - 5 * 60000, Date.now()));
  ok("5分しか作業していない時は休まない", fresh.every((r) => !r.rest));
})();
(() => {
  const longRun = Array.from({ length: 600 }, () => H.restDue(Date.now() - 130 * 60000, Date.now()));
  ok("130分作業: 長い休憩も選ばれる", longRun.some((r) => r.rest && r.kind === "long"));
})();
ok("作業の開始が無い（0）なら休まない", H.restDue(0, Date.now()).rest === false);

console.log("\n■ ④ 休憩はお客様の区切りに入る");
const bg = read("background.js");
ok("background: 次のお客様の前に restDue を抽選", /self\.AxlxHumanWait\.restDue\(_autoWorkedSince \|\| 0, Date\.now\(\)\)/.test(bg));
ok("休憩の後は数え直す", /_autoWorkedSince = Date\.now\(\) \+ _rest\.ms;/.test(bg));
ok("「休憩中（N秒）」を画面に出す", /waitingFor: "休憩中（"/.test(bg));
ok("自動モードの時だけ（通常・スタッフでは休まない）", /if \(_autoModeOn && self\.AxlxHumanWait && self\.AxlxHumanWait\.restDue\)/.test(bg));

console.log("\n■ ⑤ 細部: 検索を押す前に全体を見直す間");
ok("page-script: 検索の直前に 1〜2.2秒の見直し", /var _lookMs = humanRand\(1000, 2200\);/.test(read("page-script.js")));
ok("見直しは1回だけ（無限に待たない）", /if \(!window\._axSearchLookedOver\)/.test(read("page-script.js")));
ok("点検に search_look を残す", /_auditStepP\('search_look'/.test(read("page-script.js")));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
