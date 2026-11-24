/**
 * 2.8.274 一括を「止めた／画面を消した／固まった」後に、最初から始められる（2026-11-24 竹内さん
 *   「前のやつ強制的に終わらせたのにまだ残っている／変な設定入れてないか／画面消したらちゃんと最初からできるように」）
 *
 * 場面（偽の Chrome・偽の時計で、本物の background.js の範囲を動かす）:
 *   T1 止める → 記録は終わり・「動いている」の印は戻り・次の人に進まない・立ち上げ直しても再開しない
 *   T2 前の一括が1人目で固まった（印が「動いている」のまま）→ 元気に見える間は奪わず、force で引き継いで最初から始められる
 *   T3 止める指示が出ているのに印が残った → 画面で聞かずに引き継げる
 *   T4 段が上限＋1分を過ぎて動かない → 引き継げる
 *   T5 元気に動いている一括は、確かめ無しに奪わない
 * 配線（文字の確認）: 入口・止める4経路・popup・点検の段・版
 */
"use strict";
var assert = require("assert");
var fs = require("fs");
var path = require("path");
var sim = require("./lib/bulk-sim.js");

var ROOT = path.join(__dirname, "..", "..");
function read(p) { return fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n"); }
function vmSet(sw, stmt) { require("vm").runInContext("with (__auto) { " + stmt + " }", sw.sandbox); }

var results = [];
async function scenario(name, fn) {
  try { await fn(); results.push({ name: name, ok: true }); }
  catch (e) { results.push({ name: name, ok: false, err: e }); }
}
function customers(n) { var a = []; for (var i = 1; i <= n; i++) a.push({ id: "c" + i, name: "客" + i }); return a; }
function ids(n) { return customers(n).map(function (c) { return c.id; }); }
function cidsFilled(w) { return w.autofills.map(function (a) { return a.cid; }); }
function queue(w) { return w.session.data.axlx_bulk_queue || null; }
/** 偽の時計を進めながら待つ（時計が止まったままだと待ちが戻らない） */
async function drive(w, p, ms) {
  var done = false; var val;
  Promise.resolve(p).then(function (v) { done = true; val = v; });
  await w.run(ms || 5000);
  assert.ok(done, "時計を進めても戻らない");
  return val;
}
process.on("exit", function () { if (!global.__done) console.log("(試験が最後まで走らず終了しました)"); });
function runFresh(sw, n) { return sw.call("_manualBulkRun", { site: "realnetpro", ids: ids(n), isWide: false, startIndex: 0, resume: false, why: "popup" }); }

/** 最初の1回だけ固まる画面（fill-done も送付完了も来ない） */
function hangOnce(cid) {
  var hung = false;
  return function (c) {
    if (c === cid && !hung) { hung = true; return { noFillDone: true, dropBatchDone: true, noPageWatch: true, fillMs: 99 * 3600000 }; }
    return {};
  };
}

(async function main() {
  await scenario("T1 止める → 記録は終わり・印は戻り・次の人に進まず・立ち上げ直しでも再開しない", async function () {
    var w = sim.createWorld({ customers: customers(3) });
    var sw = w.startSw();
    await w.run(10);
    runFresh(sw, 3);
    await w.run(40000);
    vmSet(sw, "_batchShouldStop = true");
    await w.local.set({ batchStopRequested: true });
    await drive(w, sw.call("_bulkOnStop", "test_stop"));
    var q = queue(w);
    assert.ok(q && q.done === true, "記録は終わり: " + JSON.stringify(q));
    assert.strictEqual(sw.get("_manualBulkAlive"), false, "動いている印は戻る");
    await w.run(20 * 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1"], "次の人に進まない: " + cidsFilled(w).join(","));
    w.killSw("idle");
    w.startSw();
    await w.run(60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1"], "立ち上げ直しでも再開しない: " + cidsFilled(w).join(","));
  });

  await scenario("T2 前の一括が1人目で固まった → 元気に見える間は奪わない・force で引き継いで最初から", async function () {
    var w = sim.createWorld({ customers: customers(3), page: hangOnce("c1") });
    var sw = w.startSw();
    await w.run(10);
    runFresh(sw, 3);
    await w.run(3 * 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1"], "1人目で固まっている");
    assert.strictEqual(sw.get("_manualBulkAlive"), true, "印は残っている（これが開始を断っていた）");
    assert.strictEqual(sw.call("_bulkTakeoverWhy", false, false), null, "固まっていても、元気に見える間は force 無しで奪わない");
    assert.strictEqual(sw.call("_bulkTakeoverWhy", true, false), "force", "force なら引き継げる");
    await drive(w, sw.call("_bulkTakeOver", "force"));
    assert.strictEqual(sw.get("_manualBulkAlive"), false, "引き継ぎで印は戻る");
    assert.ok(queue(w).done === true, "古い記録は終わり");
    runFresh(sw, 3);
    await w.run(20 * 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1", "c1", "c2", "c3"], "最初（1人目）から入れ直して3人とも: " + cidsFilled(w).join(","));
    var q = queue(w);
    assert.ok(q && q.done === true && q.stage === "done", "最後は終わり: " + JSON.stringify(q));
    assert.deepStrictEqual(w.clock.errors, [], "時計の中で例外: " + w.clock.errors.map(String).join(" / "));
  });

  await scenario("T3 止める指示が出ているのに印が残った → 聞かずに引き継げる", async function () {
    var w = sim.createWorld({ customers: customers(2), page: hangOnce("c1") });
    var sw = w.startSw();
    await w.run(10);
    runFresh(sw, 2);
    await w.run(60000);
    assert.strictEqual(sw.call("_bulkTakeoverWhy", false, true), "stop_requested");
  });

  await scenario("T4 段が上限＋1分を過ぎて動かない → 引き継げる", async function () {
    var w = sim.createWorld({ customers: customers(2), page: hangOnce("c1") });
    var sw = w.startSw();
    await w.run(10);
    runFresh(sw, 2);
    await w.run(60000);
    assert.strictEqual(sw.call("_bulkTakeoverWhy", false, false), null, "上限の前は奪わない");
    vmSet(sw, "_bulkPhase = Object.assign({}, _bulkPhase, { until: Date.now() - 5 * 60000 })");
    assert.strictEqual(sw.call("_bulkTakeoverWhy", false, false), "phase_over", "上限＋1分を過ぎたら引き継げる");
  });

  await scenario("T5 元気に動いている一括は、確かめ無しに奪わない", async function () {
    var w = sim.createWorld({ customers: customers(3) });
    var sw = w.startSw();
    await w.run(10);
    runFresh(sw, 3);
    await w.run(35000);
    assert.strictEqual(sw.get("_manualBulkAlive"), true);
    assert.strictEqual(sw.call("_bulkTakeoverWhy", false, false), null, "動いている最中は奪わない");
    await w.run(20 * 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1", "c2", "c3"], cidsFilled(w).join(","));
  });

  await scenario("R1 止めてリセット（2.8.275）→ 固まった一括が終わり・停止の合図は下りて・すぐ最初から始められる", async function () {
    var w = sim.createWorld({ customers: customers(3), page: hangOnce("c1") });
    var sw = w.startSw();
    await w.run(10);
    runFresh(sw, 3);
    await w.run(3 * 60000);
    assert.strictEqual(sw.get("_manualBulkAlive"), true, "固まって印が残っている");
    await drive(w, sw.call("_bulkResetAll", "button"), 5000);
    var q = queue(w);
    assert.ok(q && q.done === true, "記録は終わり: " + JSON.stringify(q));
    assert.strictEqual(sw.get("_manualBulkAlive"), false, "印は戻る");
    assert.strictEqual(sw.get("_batchShouldStop"), false, "停止の合図は下りている（次の開始を邪魔しない）");
    var st = await w.local.get("batchStopRequested");
    assert.ok(!st.batchStopRequested, "storage の停止指示も下りている: " + JSON.stringify(st));
    assert.deepStrictEqual(cidsFilled(w), ["c1"], "リセットの後に次の人へは進まない");
    // 聞かれずに（force 無しで）最初から始められる
    assert.strictEqual(sw.call("_bulkTakeoverWhy", false, false), "queue_done", "印が無く記録が終わっている＝そのまま始められる");
    runFresh(sw, 3);
    await w.run(20 * 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1", "c1", "c2", "c3"], "最初から3人とも: " + cidsFilled(w).join(","));
    assert.deepStrictEqual(w.clock.errors, [], "時計の中で例外: " + w.clock.errors.map(String).join(" / "));
  });

  await scenario("R2 止めてリセット: 何も動いていなくても安全（何もしない・例外なし）", async function () {
    var w = sim.createWorld({ customers: customers(1) });
    var sw = w.startSw();
    await w.run(10);
    await drive(w, sw.call("_bulkResetAll", "button"), 5000);
    assert.strictEqual(sw.get("_batchShouldStop"), false);
    assert.deepStrictEqual(w.clock.errors, []);
  });

  await scenario("配線(2.8.275): 枠のボタン・画面の処理・裏の受け口", function () {
    var bd = read("chrome-extension/bulk-dl.js");
    assert.ok(/id="axlx-reset-stop-btn"[^>]*>⏹ 止めてリセット</.test(bd), "枠にボタン");
    assert.ok(!/id="axlx-reset-stop-btn"[^>]*display:none/.test(bd), "いつでも出ている（隠さない）");
    var fn = bd.slice(bd.indexOf("function _stopAndReset("), bd.indexOf("function stopAutoPdfs("));
    assert.ok(/type: "axlx-reset-all"/.test(fn) && /location\.reload\(\)/.test(fn) && /setTimeout\(reload, 6000\)/.test(fn), "裏へ送り・必ず読み直す");
    assert.ok(/_autoPdfRun\.stopped = true/.test(fn), "画面の自動も止める");
    assert.ok(/getElementById\("axlx-reset-stop-btn"\);\s*\n\s*if \(resetBtn\) resetBtn\.addEventListener\("click"/.test(bd), "押したら呼ぶ");
    var bg = read("chrome-extension/background.js");
    assert.ok(/msg\.type !== "axlx-reset-all"/.test(bg) && /_bulkResetAll\(/.test(bg), "裏の受け口");
  });

  await scenario("配線: 入口・止める4経路・popup・点検の段・版", function () {
    var bg = read("chrome-extension/background.js");
    var entry = bg.slice(bg.indexOf('msg.type === "axlx-manual-bulk-search"'), bg.indexOf("// ── 見積書自動モード"));
    assert.ok(/_bulkTakeoverWhy\(msg\.force === true/.test(entry), "入口は引き継ぎの判定を通る");
    assert.ok(/await _bulkTakeOver\(/.test(entry), "引き継ぐ時は _bulkTakeOver");
    assert.ok(/kind: "manual"/.test(entry) && /phaseJa/.test(entry), "断る時は画面で聞ける情報を返す");
    ["stop_command", "force_stop_batch", "stop_all_pending", '"stop_all"'].forEach(function (k) {
      assert.ok(bg.indexOf("_bulkOnStop(" + (k.charAt(0) === '"' ? k : '"' + k + '"') + ")") >= 0, "止める経路 " + k + " が後始末を呼ぶ");
    });
    var pop = read("chrome-extension/popup.js");
    assert.ok(/res\.error === "batch_running" && res\.kind === "manual" && !force/.test(pop) && /confirm\(/.test(pop) && /sendBulkStart\(true\)/.test(pop), "popup は断られたら聞いて force で送り直す");
    var au = read("chrome-extension/search-audit.js");
    assert.ok(/dl:pdf_click_nocap\|bulk_end_now\|page:perf_\|/.test(au), "点検の段に bulk_end_now と page:perf_");
    var ps = read("chrome-extension/page-script.js");
    assert.ok(/_axlxPerfProbe/.test(ps) && /\^\(perf_\|silence_watch_/.test(ps), "計測は進んだ印に数えない");
    var man = JSON.parse(read("chrome-extension/manifest.json"));
    var m = /_AXLX_PAGE_VER = "([\d.]+)"/.exec(ps);
    assert.strictEqual(m && m[1], man.version, "page-script の版と manifest の版が同じ");
    var parts = man.version.split(".").map(Number);
    assert.ok(parts[0] > 2 || (parts[0] === 2 && (parts[1] > 8 || (parts[1] === 8 && parts[2] >= 274))), "2.8.274 以上: " + man.version);
  });

  global.__done = true;
  var fail = 0;
  results.forEach(function (r) {
    if (r.ok) console.log("  ✓ " + r.name);
    else { fail++; console.log("  ✗ " + r.name + "\n      " + (r.err && r.err.stack ? r.err.stack.split("\n").slice(0, 4).join("\n      ") : r.err)); }
  });
  console.log("\n" + (results.length - fail) + " 通り / " + fail + " 落ち");
  process.exit(fail ? 1 : 0);
})();
