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
ok("点検は「わざと止める・止まりではない」と書く（秒は小数2桁で、ばらつきが見える）", /fill_pause', \(pause \/ 1000\)\.toFixed\(2\) \+ '秒（わざと止める・人の間＝止まりではない）'/.test(ps));
ok("再開の点検に予定と実際の秒", /わざと止めた後に再開 予定/.test(ps) && /'秒・実際'/.test(ps));
ok("押す前の待ち（迷い・間）にも印", /_intentWaitMark\(hesitate > 0 \? "hesitate" : "gap", _planned\);/.test(ps));
ok("押す時に印を外す", /_clickQueueTimer = setTimeout\(function\(\) \{\s*_clickQueueTimer = null;\s*_intentWaitEnd\(\);/.test(ps));
ok("列の20秒見張りは印の間は止まりと数えない", /if \(_holdingPause\) \{[^\n]*\n\s*if \(_intentWaitActive\(3000\)\) \{ _lastQueueProgressAt = Date\.now\(\); return; \}/.test(ps));
ok("沈黙135秒の見張りも印の間は数えない", /if \(_intentWaitActive\(3000\)\) \{\s*_silenceNoProgTicks = 0;\s*return;\s*\}\s*if \(idleMs < AXLX_STUCK_IDLE_MS\)/.test(ps));
ok("予定を大きく超えた時だけ本物の止まり（fill_pause_force）", /予定を15秒超えた（本物の止まり）/.test(ps));
ok("止まった時の点検 q= に印の種類（iw）", /"\/iw" \+ \(window\.__axlxIntentWait/.test(ps));
ok("版 2.8.303", /_AXLX_PAGE_VER = "2\.8\.303"/.test(ps));

console.log("\n■ 2.8.302 停止の上限は 11 秒（手の動きの既定 6 秒は他の呼び出しのまま・停止だけ maxMs で広げる）");
const pu = fs.readFileSync(path.join(__dirname, "../../chrome-extension/pointer-ui.js"), "utf8");
const driftCapDefault = (pu.match(/var cap = Number\(o\.maxMs\) > 0 \? Number\(o\.maxMs\) : (\d+);/) || [])[1];
ok("drift の既定の上限は 6 秒（他の呼び出しは変えない）", driftCapDefault === "6000", { driftCapDefault });
ok("停止の drift に maxMs を渡す", /P0\.drift\(pause, \{ maxMs: AXLX_HAND_PAUSE_MAX_MS \}\)/.test(ps));
const pauseCap = (ps.match(/var AXLX_HAND_PAUSE_MAX_MS = (\d+);/) || [])[1];
ok("停止の上限は 11 秒", pauseCap === "11000", { pauseCap });
ok("停止の長さは毎回決め直す（予定を切って固定しない）", /var pause = _longPauseDue\(item\) > 0 \? _handPauseMs\(\) : 0;/.test(ps) && !/var pause = Math\.min\(_longPauseDue/.test(ps));

console.log("\n■ 2.8.302 停止の長さは 4〜11 秒でばらつく（6000 に固めない・中央 6.5 秒）");
{
  const hs = ps.indexOf("  function _handPauseMs(");
  const he = ps.indexOf("  function _longPauseDue(");
  const hsrc = hs > 0 && he > hs ? ps.slice(hs, he) : "";
  const lnStart = ps.indexOf("  function _ln(");
  const lnEnd = ps.indexOf("  /**", lnStart);
  const lnsrc = lnStart > 0 && lnEnd > lnStart ? ps.slice(lnStart, lnEnd) : "";
  ok("_handPauseMs と _ln を取り出せた", hsrc.length > 0 && lnsrc.length > 0);
  // 本物の対数正規（AxlxHumanWait.logNormalDelay の代わりに Box-Muller で作る）
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const win = { AxlxHumanWait: { logNormalDelay: (median, sigma) => median * Math.exp(sigma * gauss()) } };
  const api = new Function("window", "AXLX_HAND_PAUSE_MAX_MS", "AXLX_HAND_PAUSE_MIN_MS", "Math",
    hsrc + "\n" + lnsrc + "\nreturn _handPauseMs;")(win, 11000, 4000, Object.assign(Object.create(Math), { random: rnd }));
  const xs = [];
  for (let i = 0; i < 2000; i++) xs.push(api());
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  const uniq = new Set(xs).size;
  const top = xs.filter((v) => v >= 10500).length;
  const bottom = xs.filter((v) => v <= 4500).length;
  ok("上限 11000ms・下限 4000ms の内側だけ", xs.every((v) => v <= 11000 && v >= 4000), { min: Math.min(...xs), max: Math.max(...xs) });
  ok("どこか1点に固まらない（同じ値が 2% を超えない）", Math.max(...Object.values(xs.reduce((m, v) => { m[v] = (m[v] || 0) + 1; return m; }, {}))) <= 40, {});
  ok("値に散らばりがある（標準偏差 1.0秒以上）", sd >= 1000, { sd: Math.round(sd) });
  ok("毎回ちがう値（2000回で別々の値が1000種以上）", uniq >= 1000, { uniq });
  ok("中央は 6〜7 秒（平均 5.8〜7.3 秒）", mean >= 5800 && mean <= 7300, { mean: Math.round(mean) });
  ok("長い側（10.5秒以上）も短い側（4.5秒以下）もそれなりに出る", top >= 10 && bottom >= 50, { top, bottom });
}

console.log("");
console.log("結果: " + pass + " 件 OK / " + fail + " 件 NG");
if (fail > 0) process.exit(1);
