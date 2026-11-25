"use strict";
/**
 * 2.8.299 竹内さん「人の動きの停止の部分はあえて停止させているとちゃんと理解させる」
 *   ・人の間（迷い・一息・手を止める）の前に印 window.__axlxIntentWait を立て、終わったら消す
 *   ・印がある間（予定の終わり＋3秒まで）は、列の20秒見張り・沈黙135秒の見張りが止まりと数えない
 *   ・印を立てても「動いた」扱いにはしない（やり直しの空回りを隠さない）。終わった時に待った分だけ止まりの計測から外す
 *   ・予定を大きく超えた時だけ本物の止まり（fill_pause_force）
 */
const fs = require("fs");
const path = require("path");
const ps = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "page-script.js"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra).slice(0, 300) : "")); }
}

const start = ps.indexOf("  function _intentWaitMark(");
const end = ps.indexOf("  function _longPauseDue(");
const src = start > 0 && end > start ? ps.slice(start, end) : "";

function load() {
  const clock = { now: 1000000 };
  const win = {};
  const fakeDate = { now: () => clock.now };
  const api = new Function("window", "Date", src + "\nreturn { mark: _intentWaitMark, active: _intentWaitActive, end: _intentWaitEnd };")(win, fakeDate);
  return { api, win, clock };
}

console.log("■ ① わざとの待ちの印（実ソースから取り出して動かす）");
ok("3つの関数を取り出せた", src.includes("_intentWaitMark") && src.includes("_intentWaitActive") && src.includes("_intentWaitEnd"), src.length);
{
  const { api, win, clock } = load();
  win.__axlxFillTouchAt = clock.now - 60000; // 最後の動きは60秒前
  api.mark("fill_pause", 12000);
  ok("印を立てても「動いた」扱いにはしない（最後の動きの時刻は変えない）", win.__axlxFillTouchAt === clock.now - 60000, win.__axlxFillTouchAt);
  ok("待ちの最中は印が生きている", api.active(3000) === true);
  clock.now += 14000; // 予定12秒＋2秒
  ok("予定の終わり＋3秒までは生きている", api.active(3000) === true);
  clock.now += 2000; // 予定＋4秒
  ok("予定＋3秒を過ぎたら印は効かない（印が残っても永久には止めない）", api.active(3000) === false);
}
{
  const { api, win, clock } = load();
  win.__axlxFillTouchAt = clock.now - 10000;
  api.mark("fill_pause", 9000);
  clock.now += 9000;
  const r = api.end();
  ok("終わったら印を消す", win.__axlxIntentWait === null && api.active(3000) === false);
  ok("予定と実際の長さを返す（点検に残す用）", r && r.kind === "fill_pause" && r.planned === 9000 && r.actual === 9000, r);
  ok("待った分だけ止まりの計測から外す（最後の動き＋9秒）", win.__axlxFillTouchAt === clock.now - 10000, { touch: win.__axlxFillTouchAt, now: clock.now });
}
{
  const { api, win, clock } = load();
  api.mark("gap", 20000);
  api.mark("hesitate", 3000);
  ok("長い待ちの最中に短い待ちが来ても、終わりを縮めない", win.__axlxIntentWait.kind === "gap" && win.__axlxIntentWait.until === clock.now + 20000, win.__axlxIntentWait);
  ok("印が無い時に終わりを呼んでも壊れない", (() => { win.__axlxIntentWait = null; return api.end() === null; })());
}

console.log("■ ② 見張りと点検への配線");
ok("手を止める前に印（fill_pause）", /_intentWaitMark\("fill_pause", pause\);/.test(ps));
ok("点検は「わざと止める・止まりではない」と書く", /fill_pause', Math\.round\(pause \/ 1000\) \+ '秒（わざと止める・人の間＝止まりではない）'/.test(ps));
ok("再開の点検に予定と実際の秒", /わざと止めた後に再開 予定/.test(ps) && /'秒・実際'/.test(ps));
ok("押す前の待ち（迷い・間）にも印", /_intentWaitMark\(hesitate > 0 \? "hesitate" : "gap", _planned\);/.test(ps));
ok("押す時に印を外す", /_clickQueueTimer = setTimeout\(function\(\) \{\s*_clickQueueTimer = null;\s*_intentWaitEnd\(\);/.test(ps));
ok("列の20秒見張りは印の間は止まりと数えない", /if \(_holdingPause\) \{[^\n]*\n\s*if \(_intentWaitActive\(3000\)\) \{ _lastQueueProgressAt = Date\.now\(\); return; \}/.test(ps));
ok("沈黙135秒の見張りも印の間は数えない", /if \(_intentWaitActive\(3000\)\) \{\s*_silenceNoProgTicks = 0;\s*return;\s*\}\s*if \(idleMs < AXLX_STUCK_IDLE_MS\)/.test(ps));
ok("予定を大きく超えた時だけ本物の止まり（fill_pause_force）", /予定を15秒超えた（本物の止まり）/.test(ps));
ok("止まった時の点検 q= に印の種類（iw）", /"\/iw" \+ \(window\.__axlxIntentWait/.test(ps));
ok("版 2.8.299", /_AXLX_PAGE_VER = "2\.8\.299"/.test(ps));

console.log("");
console.log("結果: " + pass + " 件 OK / " + fail + " 件 NG");
if (fail > 0) process.exit(1);
