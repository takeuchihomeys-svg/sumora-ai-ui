/**
 * 2.8.273 1件ずつのまま1件の時間を縮める（2026-11-24 竹内さん「もっと時間25～55に短縮で1の1件ずつで行う」）
 *
 *   DB: 判定の間隔で1件の周期 p50 22秒・p75 52秒・p90 118秒。11-22（2.8.154）は「押した→送れた」9〜14秒・周期22秒、
 *       11-23（2.8.211〜）は周期 45〜200秒。間に足した「押して0.9秒で送る」（2026-11-22b）が、ダウンロードの捕捉の前に送り始め、
 *       手元（キャッシュ）でなくリアプロへ同じ資料をもう一度取りに行っていた。
 *   直し: 押した後は捕捉を最大6秒待つ（捕捉が来ればそこで手元から送る・来なければ押した印から送る）。
 *         待っている間は次を押さない（1件ずつ）。1件ごとに判定・送りの秒と手元かを点検の段に残す。
 */
"use strict";
var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var DIR = path.join(__dirname, "..", "..", "chrome-extension");
var dl = fs.readFileSync(path.join(DIR, "bulk-dl.js"), "utf8").replace(/\r\n/g, "\n");
var sa = fs.readFileSync(path.join(DIR, "search-audit.js"), "utf8").replace(/\r\n/g, "\n");

function slice(from, to) {
  var a = dl.indexOf(from);
  var b = dl.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error("範囲が見つからない: " + from.slice(0, 40));
  return dl.slice(a, b);
}

function makeBox() {
  var now = 0, seq = 0, timers = [];
  var log = { sends: [], steps: [], finishedAt: null };
  var sb = {
    console: { log: function () {}, warn: function () {}, error: function () {} },
    Date: { now: function () { return now; } },
    Math: Math, Object: Object, String: String,
    setTimeout: function (fn, ms) { var id = ++seq; timers.push({ id: id, fn: fn, at: now + (ms || 0) }); return id; },
    clearTimeout: function (id) { timers = timers.filter(function (t) { return t.id !== id; }); },
    self: {}, window: {},
    _onePdfSent: {}, _pdfBusy: false, _pdfSending: null,
    _tmark: function () {},
    _nudge: function () {},
    _liveDlStep: function (k, d) { log.steps.push({ at: now, k: k, d: d }); },
    _batchProgressPing: function () {},
    _pickCustomerIdForAuto: function () { return "c1"; },
    _itemFromPrintEl: function (btn) { return { btn: btn, cb: null }; },
    sendOnePdfNow: function (item) {
      if (sb._onePdfSent[item.btn.href] || sb._pdfBusy) return;
      log.sends.push({ at: now, url: item.btn.href });
      sb._pdfBusy = true; sb._pdfSending = item.btn.href;
    },
  };
  vm.createContext(sb);
  var code = slice("var _clickSendArmed = {};", "  try {\n    document.addEventListener(\"click\"")
    .replace(/function _itemFromPrintEl\(btn\) \{[\s\S]*?\n  \}\n/, "")
    + "\n" + slice("function _waitPdfIdle(cb, customerId) {", "\n  /**\n   * ★ 2026-11-16 竹内さん「送ったら次のページへ")
    + "\n;globalThis.__arm = _armClickSend; globalThis.__wait = _waitPdfIdle; globalThis.__armed = function () { return _clickSendArmed; };";
  vm.runInContext(code, sb, { filename: "bulk-dl-send.js" });
  return {
    sb: sb, log: log,
    now: function () { return now; },
    run: function (ms) {
      var end = now + ms;
      for (;;) {
        timers.sort(function (x, y) { return x.at - y.at; });
        var t = timers[0];
        if (!t || t.at > end) break;
        timers.shift(); now = t.at; t.fn();
      }
      now = end;
    },
    capture: function (url) {
      // background の axlx-pdf-captured を受けた時と同じ（印を消してから送る）
      delete sb.__armed()[url];
      sb.sendOnePdfNow({ btn: { href: url } });
    },
    finishSend: function (url) { sb._onePdfSent[url] = true; sb._pdfBusy = false; sb._pdfSending = null; },
  };
}

var results = [];
function scenario(name, fn) { try { fn(); results.push({ name: name, ok: true }); } catch (e) { results.push({ name: name, ok: false, err: e }); } }
var U = "https://www.realnetpro.com/common/factsheet.php?id=1";

scenario("捕捉が3秒で来たら、そこで1回だけ送る（0.9秒で先に送り始めない）", function () {
  var b = makeBox();
  b.sb.__arm({ href: U });
  b.run(2900);
  assert.strictEqual(b.log.sends.length, 0, "捕捉の前に送り始めない: " + JSON.stringify(b.log.sends));
  b.run(100);
  b.capture(U);
  assert.strictEqual(b.log.sends.length, 1);
  assert.strictEqual(b.log.sends[0].at, 3000, "捕捉の時に送る");
  b.run(10000);
  assert.strictEqual(b.log.sends.length, 1, "押した印の時計は何もしない");
  assert.ok(!b.log.steps.some(function (s) { return s.k === "pdf_click_nocap"; }), "捕捉が来た時は nocap の印を出さない");
});

scenario("捕捉が来なければ6秒で押した印から送る（永成の穴は塞いだまま）", function () {
  var b = makeBox();
  b.sb.__arm({ href: U });
  b.run(5900);
  assert.strictEqual(b.log.sends.length, 0);
  b.run(200);
  assert.strictEqual(b.log.sends.length, 1, "6秒で送る");
  assert.ok(b.log.steps.some(function (s) { return s.k === "pdf_click_nocap"; }), "pdf_click_nocap が残る");
});

scenario("捕捉を待っている間は次を押さない（2.5秒の「送信が始まらない」で抜けない）", function () {
  var b = makeBox();
  var done = null;
  b.sb.__arm({ href: U });
  b.sb.__wait(function () { done = b.now(); }, "c1");
  b.run(4000);
  assert.strictEqual(done, null, "捕捉待ちの4秒では次へ進まない");
  b.capture(U);
  b.run(15000);
  assert.strictEqual(done, null, "送っている間は次へ進まない");
  b.finishSend(U);
  b.run(2000);
  assert.ok(done != null && done >= 19000, "送り終わってから次へ: " + done);
});

scenario("押していない時（送付済みで何も始まらない）は今まで通り約2.5秒で次へ", function () {
  var b = makeBox();
  var done = null;
  b.sb.__wait(function () { done = b.now(); }, "c1");
  b.run(5000);
  assert.ok(done != null && done >= 2500 && done <= 3800, "約2.5秒: " + done);
});

scenario("1件ごとの内訳（判定・送り・手元）を点検の段に残す", function () {
  assert.ok(/_liveDlStep\("one_send_ms", "判定"/.test(dl), "one_send_ms を出す");
  assert.ok(/judgeMs: tj - t0, sendMs: Date\.now\(\) - tj, fromCache:/.test(dl), "判定と送りの秒を分けて測る");
  assert.ok(/KEEP_STEP = \/\^\(begin\|bulk_kick\|bulk_done_resend\|dl:one_send_ms\|dl:pdf_click_nocap\|/.test(sa), "残す段に入れる");
});

scenario("資料を見る間（人のランダムな間）は変えていない", function () {
  assert.ok(/if \(base < 1800\) base = 1800;\n\s*if \(base > 13000\) base = 13000;/.test(dl), "1.8〜13秒のまま");
});

var fail = 0;
results.forEach(function (r) {
  if (r.ok) console.log("  ✓ " + r.name);
  else { fail++; console.log("  ✗ " + r.name + "\n      " + (r.err && r.err.message)); }
});
console.log("\n" + (results.length - fail) + " 通り / " + fail + " 落ち");
if (fail) process.exit(1);
