/**
 * 2.8.272 一連のボトルネックを外す（2026-11-24 竹内さん「一連のテストしてボトルネックになっている部分見つけてはずす」）
 *
 *   ① 止まりと判断（最後の動きから135秒）した後、まだ動かない時の次の撮影・次手は45秒おき（旧は135秒おき＝次客まで約13.5分）
 *   ② 裏の入力済みの待ち: 応答するタブが無いまま進みが5分無ければ閉じて次客へ（旧は30分・模擬 S13 で 1821秒）
 *      画面が応答している間は今まで通り（30分・進みで延長）
 *   ③ 外しの群の90秒は把握が返ってから数える
 */
"use strict";
var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var sim = require("./lib/bulk-sim.js");

var DIR = path.join(__dirname, "..", "..", "chrome-extension");
var ps = fs.readFileSync(path.join(DIR, "page-script.js"), "utf8").replace(/\r\n/g, "\n");
var dl = fs.readFileSync(path.join(DIR, "bulk-dl.js"), "utf8").replace(/\r\n/g, "\n");
var bg = fs.readFileSync(path.join(DIR, "background.js"), "utf8").replace(/\r\n/g, "\n");

var results = [];
async function scenario(name, fn) {
  try { await fn(); results.push({ name: name, ok: true }); }
  catch (e) { results.push({ name: name, ok: false, err: e }); }
}
function customers(n) { var a = []; for (var i = 1; i <= n; i++) a.push({ id: "c" + i, name: "客" + i }); return a; }
async function startBulk(world, n) {
  var sw = world.startSw();
  await world.run(10);
  sw.call("_manualBulkRun", { site: "realnetpro", ids: customers(n).map(function (c) { return c.id; }), isWide: false, startIndex: 0, resume: false, why: "popup" });
  return sw;
}
function frozenFirst(cid) { return cid === "c1" ? { noFillDone: true, dropBatchDone: true, noPageWatch: true, fillMs: 99 * 3600000 } : {}; }

/** page-script の止まり見張りだけを偽の時計で動かす */
function makeSilenceSandbox() {
  var a = ps.indexOf("var _clearWatchTimer = null;");
  var b = ps.indexOf("try { window.__axlxForceAuditStepsFlush = _forceAuditStepsFlush; }");
  if (a < 0 || b < 0) throw new Error("止まり見張りの範囲が見つからない");
  var now = 1000000;
  var timers = [];
  var seq = 0;
  var acts = [];
  var steps = [];
  var done = null;
  var win = { _axFillRunning: true, __axlxFillTouchAt: now, postMessage: function () {} };
  var sb = {
    console: { log: function () {}, warn: function () {}, error: function () {} },
    Date: { now: function () { return now; } },
    Math: Math, String: String, Number: Number, Array: Array,
    window: win,
    setInterval: function (fn, ms) { var id = ++seq; timers.push({ id: id, fn: fn, ms: ms, at: now + ms, every: true }); return id; },
    clearInterval: function (id) { timers = timers.filter(function (t) { return t.id !== id; }); },
    setTimeout: function (fn, ms) { var id = ++seq; timers.push({ id: id, fn: fn, ms: ms, at: now + ms, every: false }); return id; },
    clearTimeout: function (id) { timers = timers.filter(function (t) { return t.id !== id; }); },
    _audit: { steps: [], ops: [] },
    _doneNotified: false,
    _fillRunId: "r1", _fillCustomerId: "c1", _axConditionsReady: false,
    _auditStepP: function (k, d) { steps.push({ t: now, k: k, d: d }); },
    _screenPollThenApiNext: function (ph, why, cb) { acts.push(now); cb({ stuck: "x", acted: "none", recovered: false }); },
    _driveKeepStrengthen: function () {},
    _publishTaskGrasp: function () {},
    _actBestNextFromStuck: function () {},
    notifyDone: function (why) { if (!done) done = { t: now, why: why }; },
  };
  vm.createContext(sb);
  vm.runInContext(ps.slice(a, b) + "\n;globalThis.__arm = _armFillSilenceWatch;", sb, { filename: "page-silence.js" });
  return {
    start: now,
    arm: function () { sb.__arm("fill:test"); },
    run: function (ms) {
      var end = now + ms;
      for (;;) {
        timers.sort(function (x, y) { return x.at - y.at; });
        var t = timers[0];
        if (!t || t.at > end) break;
        now = t.at;
        if (t.every) t.at = now + t.ms; else timers.shift();
        t.fn();
      }
      now = end;
    },
    acts: acts, steps: steps,
    done: function () { return done; },
    touch: function () { win.__axlxFillTouchAt = now; },
  };
}

(async function main() {
  await scenario("① 135秒は動かず、止まりと判断した後は45秒おき・6回目で次客へ（約6分）", async function () {
    var s = makeSilenceSandbox();
    s.arm();
    s.run(130000);
    assert.strictEqual(s.acts.length, 0, "135秒より前に撮影・次手をしない: " + s.acts.length);
    s.run(30 * 60000);
    var rel = s.acts.map(function (t) { return Math.round((t - s.start) / 1000); });
    assert.ok(rel.length >= 6, "6回は試す: " + rel.join(","));
    assert.ok(rel[0] >= 135 && rel[0] <= 150, "1回目は135〜150秒: " + rel[0]);
    for (var i = 1; i < 6; i++) {
      var gap = rel[i] - rel[i - 1];
      assert.ok(gap >= 45 && gap <= 60, (i + 1) + "回目の間は45〜60秒: " + gap + "（" + rel.join(",") + "）");
    }
    var d = s.done();
    assert.ok(d, "6回で次客へ（notifyDone）");
    var dSec = Math.round((d.t - s.start) / 1000);
    assert.ok(dSec <= 420, "次客へ進むまで7分以内（旧は約13.5分）: " + dSec + "秒");
    assert.ok(s.steps.some(function (x) { return x.k === "silence_task_advance"; }), "3回で次のタスクへ（silence_task_advance）");
  });

  await scenario("① 動きがあれば数え直す（判断は最後の動きから135秒のまま）", async function () {
    var s = makeSilenceSandbox();
    s.arm();
    s.run(100000);
    s.touch();
    s.run(120000);
    assert.strictEqual(s.acts.length, 0, "動いてから135秒たつまで撮影しない: " + s.acts.length);
    s.run(30000);
    assert.strictEqual(s.acts.length, 1, "動いてから135秒を過ぎたら1回: " + s.acts.length);
  });

  await scenario("① 一覧の側（bulk-dl）も同じ: 判断は135秒・2回目からは45秒", async function () {
    assert.ok(/var AXLX_STUCK_IDLE_MS = 135000;/.test(dl), "bulk-dl の判断は135秒");
    assert.ok(/var AXLX_STUCK_RETRY_MS = 45000;/.test(dl), "bulk-dl の次の試しは45秒");
    assert.ok(/if \(idleMs < AXLX_STUCK_IDLE_MS\) return;\n\s*if \(_pipelineStuckActAt && Date\.now\(\) - _pipelineStuckActAt < AXLX_STUCK_RETRY_MS\) return;/.test(dl), "bulk-dl は判断135秒→次の試し45秒の順");
    assert.ok(/if \(_pdfBusy \|\| _isFillBusy\(\)\) return;/.test(dl), "1件の送付中・次客の入力中は撮影しない（2.8.269 のまま）");
  });

  await scenario("② 画面が応答しない（固まった）→ 30分待たず、8分以内に2人目へ", async function () {
    var w = sim.createWorld({ customers: customers(2), page: frozenFirst });
    await startBulk(w, 2);
    await w.run(40 * 60000);
    assert.ok(w.autofills[1], "2人目へ進む");
    var sec = Math.round((w.autofills[1].at - w.autofills[0].at) / 1000);
    assert.ok(sec <= 480, "2人目まで8分以内（旧1821秒）: " + sec + "秒");
    var ks = [];
    Array.from(w.db.values()).forEach(function (r) { if (r.cid === "c1") ks = ks.concat(r.steps.map(function (s) { return s.k; })); });
    assert.ok(ks.indexOf("tab_no_response_stall") >= 0, "1人目の行に tab_no_response_stall が残る: " + ks.join(","));
  });

  await scenario("② 画面が応答している（生きている）間は早まって閉じない（30分のまま）", async function () {
    var w = sim.createWorld({ customers: customers(2), page: frozenFirst });
    var sw = await startBulk(w, 2);
    sw.sandbox._probeRealproTab = function () { return Promise.resolve({ url: "https://www.realnetpro.com/", pong: true, vis: "visible", fillRunning: true, fillCustomerId: "c1" }); };
    await w.run(12 * 60000);
    assert.strictEqual(w.autofills.length, 1, "12分では2人目へ進まない（画面が生きていれば画面側の見張りが先に次客へ進める）");
  });

  await scenario("② 進みの合図で数え直す時は、応答なしの回数も数え直す", async function () {
    assert.ok(/_hidLastProg = Date\.now\(\);\n\s*_hidN = 0;\n\s*_deadN = 0;/.test(bg), "restart で _deadN も0に戻す");
    assert.ok(/var FILL_NO_RESPONSE_CLOSE_MS = 5 \* 60 \* 1000;/.test(bg), "応答なしで閉じるのは進みが5分無い時");
    assert.ok(/var FILL_DONE_TIMEOUT_MS = \{ itandi: 1800000, realnetpro: 1800000 \};/.test(bg), "生きている画面の30分は変えない");
    assert.ok(/if \(_deadN >= 2\) \{/.test(bg), "応答なしは2回続いた時だけ閉じる");
  });

  await scenario("③ 外しの群の90秒は把握が返ってから数える", async function () {
    assert.ok(/_clearStartGraspThen\(why \|\| tg, function \(\) \{ t0 = Date\.now\(\); step\(\); \}\)/.test(ps), "把握の後に t0 を取り直す");
  });

  await scenario("版 2.8.272 以上がそろっている", async function () {
    var ge = function (v) { var a = String(v).split(".").map(Number), b = [2, 8, 272]; for (var i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; } return true; };
    var man = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
    assert.ok(ge(man.version), "manifest: " + man.version);
    var pv = (ps.match(/var _AXLX_PAGE_VER = "([\d.]+)";/) || [])[1];
    assert.ok(pv && ge(pv) && pv === man.version, "page-script の版: " + pv);
    var rules = fs.readFileSync(path.join(__dirname, "..", "..", "app", "lib", "auto-procedure-rules.ts"), "utf8");
    var rv = (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([\d.]+)"/) || [])[1];
    assert.ok(rv === man.version, "手順の決まりの版: " + rv);
  });

  var fail = 0;
  results.forEach(function (r) {
    if (r.ok) console.log("  ✓ " + r.name);
    else { fail++; console.log("  ✗ " + r.name + "\n      " + (r.err && r.err.message)); }
  });
  console.log("\n" + (results.length - fail) + " 通り / " + fail + " 落ち");
  if (fail) process.exit(1);
})();
