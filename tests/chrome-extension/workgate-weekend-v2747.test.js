// tests/chrome-extension/workgate-weekend-v2747.test.js
// 実行: node tests/chrome-extension/workgate-weekend-v2747.test.js
// 2026-11-14 竹内さん「自動検索は自動モードでうごけばよいのでは」→「土日も動かす」を選ばれた。
//
//   ⚠ 旧は `effDay === 0 || 6` で**土日は必ず止まって**いた。
//     そのため土曜の今日、自動モードにしても自動便120件が誰にも拾われずに閉じた（実測）。
//   → 既定を「土日も動く」に変えた。`axlxWeekendOff=1` で元に戻せる。
//   ⚠ ただし**時間の決まりは残す**（9〜23時・12〜13時は休憩・90分で小休憩）＝夜中に走らない。
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const A = require(path.join(dir, "auto-run.js"));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra) : "")); }
}

const at = (s) => Date.parse(s);
// 2026-11-14 は土曜 / 2026-11-15 は日曜 / 2026-11-16 は月曜
const SAT_AM = at("2026-11-14T10:30:00+09:00");
const SAT_NOON = at("2026-11-14T12:30:00+09:00");
const SAT_NIGHT = at("2026-11-14T23:30:00+09:00");
const SUN_AM = at("2026-11-15T10:30:00+09:00");
const MON_AM = at("2026-11-16T10:30:00+09:00");

console.log("■ ① 土日も動く（既定）");
{
  const g = A.workGate(SAT_AM);
  ok("土曜の10:30 は開いている", g.open === true, g);
  ok("  理由が weekend ではない", g.reason !== "weekend", g);
  const s = A.workGate(SUN_AM);
  ok("日曜の10:30 も開いている", s.open === true, s);
}

console.log("\n■ ② 時間の決まりは残す（土日でも夜中・昼休みは動かない）");
{
  const noon = A.workGate(SAT_NOON);
  ok("土曜の12:30 は昼休み", noon.open === false && noon.reason === "lunch", noon);
  const night = A.workGate(SAT_NIGHT);
  ok("土曜の23:30 は夜（止まる）", night.open === false && night.reason === "after_close", night);
  const mon = A.workGate(MON_AM);
  ok("月曜の10:30 は今まで通り開いている", mon.open === true, mon);
}

console.log("\n■ ③ 設定で元に戻せる（axlxWeekendOff=1）");
{
  // Node には localStorage が無いので、最小の差し替えを入れて確かめる
  const store = {};
  global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  store.axlxWeekendOff = "1";
  const g = A.workGate(SAT_AM);
  ok("設定すると土曜は止まる（元の動き）", g.open === false && g.reason === "weekend", g);
  store.axlxWeekendOff = "0";
  const g2 = A.workGate(SAT_AM);
  ok("  0 にすると動く", g2.open === true, g2);
  delete store.axlxWeekendOff;
  const g3 = A.workGate(SAT_AM);
  ok("  設定を消すと既定（動く）", g3.open === true, g3);
  delete global.localStorage;
}

console.log("\n■ ④ 表示も土日を止めない（自動モードの帯）");
{
  const N = require(path.join(dir, "autorun-note.js"));
  const lineSat = N.noteLine(SAT_AM);
  ok("土曜でも「次は」を出す", /次は/.test(lineSat), lineSat);
  ok("  ⚠「土日は止まります」を出さない", !/土日は止まります/.test(lineSat), lineSat);
  const mon = N.noteLine(MON_AM);
  ok("月曜は今まで通り", /次は/.test(mon), mon);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
