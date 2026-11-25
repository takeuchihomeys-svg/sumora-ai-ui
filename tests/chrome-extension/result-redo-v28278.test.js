/**
 * 2.8.278 竹内さん「外せていなければやり直す」実装の試験。
 *   結果ページの見出しが希望と違った（前の客の条件が残った疑い）→ 資料を送らず、場所を全部外して1客1回だけ入れ直す。
 *
 * 本物の background.js（一括ループ・送付完了待ち・入れ直し）を偽の Chrome・偽の時計で丸ごと動かす（lib/bulk-sim.js）。
 *   R1 2人目が1回目だけ違った → 入れ直して直り、3人目へ（通知なし）
 *   R2 2人目が入れ直しても違う → 物件は送らず飛ばし、★物件出し★に1行、3人目へ（入れ直しは1回だけ）
 *   R3 入れ直しの待ちの間にストップ → 入れ直さず止まる
 *   R4 違いが無ければ入れ直しは一切起きない（誤作動しない）
 *   R5 入れ直し前に場所を全部外す旗を画面へ立てる
 *   R6 画面側（bulk-dl.js）: 止める条件（番号一致・旗 "0" で切る・unknown は止めない）と合図の形（1回だけ）
 *   R7 版が揃っている
 */
"use strict";
var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var sim = require("./lib/bulk-sim.js");

var ROOT = path.join(__dirname, "..", "..");
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
function cidsFilled(world) { return world.autofills.map(function (a) { return a.cid; }); }
function allSteps(world) {
  var out = [];
  world.db.forEach(function (r) { (r.steps || []).forEach(function (s) { out.push(JSON.stringify(s)); }); });
  return out.join("\n");
}
function notices(world) { return (world.fetches || []).filter(function (f) { return /notify-group/.test(f.url) && /検索できなかった/.test(f.body); }); }
var MISMATCH = { verdict: "mismatch", why: "駅が違う（希望: なおき／見出し: 大村）", brief: "見出し:大村 家賃8万" };

(async function main() {
  await scenario("R1 2人目が1回目だけ違った → 入れ直して直り、3人目へ（通知なし）", async function () {
    var w = sim.createWorld({
      customers: customers(3),
      page: function (cid, idx) { return idx === 1 ? { resultMismatch: MISMATCH } : {}; },
    });
    await startBulk(w, 3);
    await w.run(30 * 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1", "c2", "c2", "c3"], "c2 を1回だけ入れ直す: " + cidsFilled(w).join(","));
    assert.strictEqual(notices(w).length, 0, "直ったので通知は出さない");
    var s = allSteps(w);
    assert.ok(/result_mismatch_retry/.test(s), "入れ直しの段が点検に残る");
    assert.ok(/result_mismatch_fixed/.test(s), "直ったの段が点検に残る");
    assert.ok(!/result_mismatch_skip/.test(s), "飛ばしは無い");
    assert.strictEqual(w.sw.get("_manualBulkAlive"), false, "最後まで走り切る");
    assert.deepStrictEqual(w.clock.errors, [], "時計の中で例外: " + w.clock.errors.map(String).join(" / "));
  });

  await scenario("R2 入れ直しても違う → 物件は送らず飛ばし、通知1本、3人目へ（入れ直しは1回だけ）", async function () {
    var w = sim.createWorld({
      customers: customers(3),
      page: function (cid) { return cid === "c2" ? { resultMismatch: MISMATCH } : {}; },
    });
    await startBulk(w, 3);
    await w.run(30 * 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1", "c2", "c2", "c3"], "c2 は2回まで（1回入れ直すだけ）: " + cidsFilled(w).join(","));
    assert.strictEqual(notices(w).length, 1, "★物件出し★の通知は1本: " + notices(w).length);
    assert.ok(/客2/.test(notices(w)[0].body) && /pickup_group_id/.test(notices(w)[0].body), "客の名前と宛先: " + notices(w)[0].body);
    var s = allSteps(w);
    assert.ok(/result_mismatch_skip/.test(s), "飛ばしの段");
    assert.ok(!/result_mismatch_fixed/.test(s), "直ったは無い");
    assert.strictEqual(w.sw.get("_manualBulkAlive"), false, "最後まで走り切る（c3 まで）");
    assert.deepStrictEqual(w.clock.errors, [], "時計の中で例外: " + w.clock.errors.map(String).join(" / "));
  });

  await scenario("R3 入れ直しの待ちの間にストップ → 入れ直さず止まる", async function () {
    var w = sim.createWorld({
      customers: customers(3),
      page: function (cid, idx) { return idx === 1 ? { resultMismatch: MISMATCH } : {}; },
    });
    var sw = await startBulk(w, 3);
    // c1 の完了〜c2 の1回目の完了まで走らせ、入れ直しの待ち（9〜22秒）に入った所で止める
    for (var i = 0; i < 200 && cidsFilled(w).length < 2; i++) await w.run(5000);
    await w.run(30000 + 60000 + 1000);
    vm.runInContext("with (__auto) { _batchShouldStop = true }", sw.sandbox);
    await w.run(30 * 60000);
    assert.ok(cidsFilled(w).length <= 2, "入れ直しも次の人も入れない: " + cidsFilled(w).join(","));
    assert.ok(!/result_mismatch_fixed|result_mismatch_skip/.test(allSteps(w)), "終わりの段は付かない");
  });

  await scenario("R4 違いが無ければ入れ直しは一切起きない", async function () {
    var w = sim.createWorld({ customers: customers(3) });
    await startBulk(w, 3);
    await w.run(20 * 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1", "c2", "c3"], cidsFilled(w).join(","));
    assert.ok(!/result_mismatch/.test(allSteps(w)), "result_mismatch の段は無い");
    assert.strictEqual(notices(w).length, 0);
  });

  await scenario("R5 入れ直し前に場所を全部外す旗を画面へ立てる", async function () {
    var flags = [];
    var w = sim.createWorld({
      customers: customers(2),
      page: function (cid, idx) { return idx === 0 ? { resultMismatch: MISMATCH } : {}; },
    });
    // executeScript の関数文字を見て旗を数える
    var orig = w.startSw;
    w.startSw = function () {
      var env = orig.call(w);
      var ex = env.sandbox.chrome.scripting.executeScript;
      env.sandbox.chrome.scripting.executeScript = function (o) {
        var f = String(o && o.func);
        ["__axlxForceClearAllPlace", "__axlxForceClearStations", "__axlxForceClearWards"].forEach(function (n) { if (f.indexOf(n) >= 0) flags.push(n); });
        return ex(o);
      };
      return env;
    };
    await startBulk(w, 2);
    await w.run(20 * 60000);
    assert.ok(flags.indexOf("__axlxForceClearAllPlace") >= 0, "全場所の強制クリア旗: " + flags.join(","));
    assert.ok(flags.indexOf("__axlxForceClearStations") >= 0 && flags.indexOf("__axlxForceClearWards") >= 0, "駅・区の旗も: " + flags.join(","));
    assert.deepStrictEqual(cidsFilled(w), ["c1", "c1", "c2"], cidsFilled(w).join(","));
  });

  await scenario("R6 画面側: 番号一致の時だけ止める・旗 \"0\" で切る・合図は1回だけ", async function () {
    var dl = fs.readFileSync(path.join(ROOT, "chrome-extension", "bulk-dl.js"), "utf8").replace(/\r\n/g, "\n");
    var a = dl.indexOf("function _resultVerifyEnforce(");
    var b = dl.indexOf("function _resultVerifyOnce(");
    assert.ok(a > 0 && b > a, "bulk-dl.js に止める関数がある");
    var code = dl.slice(a, b);
    // コメントの「/** … */」直前の続きまで含むので、関数だけ取り出す
    var store = {};
    var sent = [];
    var steps = [];
    var sb = {
      localStorage: { getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; } },
      chrome: { runtime: { lastError: undefined, sendMessage: function (m, cb) { sent.push(m); if (cb) cb(); } } },
      self: { AxlxResultVerify: { brief: function () { return "見出し:大村"; } } },
      window: {},
      _liveDlStep: function (k, d) { steps.push(k + ":" + d); },
    };
    vm.createContext(sb);
    vm.runInContext(code + "\n;globalThis.E = _resultVerifyEnforce; globalThis.R = _resultVerifyReport;", sb);
    assert.strictEqual(sb.E({ cidOk: true }), true, "番号が一致 → 止める");
    assert.strictEqual(sb.E({ cidOk: false }), false, "番号が取れない → 警告だけ");
    assert.strictEqual(sb.E(null), false);
    store.axlx_result_verify_enforce = "0";
    assert.strictEqual(sb.E({ cidOk: true }), false, "旗 \"0\" で切れる");
    delete store.axlx_result_verify_enforce;

    var r = { verdict: "mismatch", diffs: ["駅が違う", "家賃が違う"], cidOk: true, expectCid: "c9" };
    sb.R(r); sb.R(r);
    assert.strictEqual(sent.length, 1, "合図は1回だけ: " + sent.length);
    assert.strictEqual(sent[0].type, "axlx-batch-customer-done");
    assert.strictEqual(sent[0].customerId, "c9");
    assert.strictEqual(sent[0].propertyCount, null, "件数は送らない（物件は送っていない）");
    assert.strictEqual(sent[0].audit.result_mismatch.verdict, "mismatch");
    assert.ok(/駅が違う/.test(sent[0].audit.result_mismatch.why), sent[0].audit.result_mismatch.why);
    assert.ok(steps.some(function (s) { return /^result_verify_stop:/.test(s); }), "点検の段 result_verify_stop: " + steps.join(","));
    // 全件
    sent.length = 0;
    sb.R({ verdict: "full", diffs: [], cidOk: true, expectCid: "c7", count: { b: 16387 } });
    assert.ok(/16387/.test(sent[0].audit.result_mismatch.why), "全件の理由に棟数: " + JSON.stringify(sent[0]));
    // 番号が取れない時は合図を送らない（expectCid が無い）→ 別の客を誤って止めない
    sent.length = 0;
    sb.R({ verdict: "mismatch", diffs: ["x"], cidOk: false, expectCid: null });
    assert.strictEqual(sent[0].customerId, null, "番号無しの合図は呼び出し側で出さない前提（念のため null）");
  });

  await scenario("R6b 画面側の呼び出し口: 止める時は _resultVerifyReport を呼ぶ・unknown は止めない", async function () {
    var dl = fs.readFileSync(path.join(ROOT, "chrome-extension", "bulk-dl.js"), "utf8");
    assert.ok(/_resultVerifyEnforce\(_rvr\)\)\s*\{[\s\S]{0,200}_resultVerifyReport\(_rvr\)/.test(dl), "呼び出し口");
    assert.ok(/verdict === "mismatch" \|\| _rvr\.verdict === "full"/.test(dl), "止めるのは mismatch / full だけ（unknown・ok は止めない）");
    assert.ok(/r\.cidOk = /.test(dl), "番号一致の印");
  });

  await scenario("R7 版が揃っている（manifest・page-script・自動手順の確認版）", async function () {
    var man = JSON.parse(fs.readFileSync(path.join(ROOT, "chrome-extension", "manifest.json"), "utf8"));
    var ps = fs.readFileSync(path.join(ROOT, "chrome-extension", "page-script.js"), "utf8");
    var rules = fs.readFileSync(path.join(ROOT, "app", "lib", "auto-procedure-rules.ts"), "utf8");
    function ge(v, min) { var a = v.split(".").map(Number), b = min.split(".").map(Number); for (var i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; } return true; }
    assert.ok(ge(man.version, "2.8.278"), "manifest " + man.version);
    var pv = /_AXLX_PAGE_VER\s*=\s*"([\d.]+)"/.exec(ps);
    assert.ok(pv && ge(pv[1], "2.8.278"), "page-script " + (pv && pv[1]));
    var rv = /AUTO_RULES_REVIEWED_UP_TO\s*=\s*"([\d.]+)"/.exec(rules);
    assert.ok(rv && ge(rv[1], "2.8.278"), "rules " + (rv && rv[1]));
    var sa = fs.readFileSync(path.join(ROOT, "chrome-extension", "search-audit.js"), "utf8");
    assert.ok(/result_mismatch/.test(sa) || /result_verify/.test(sa), "点検の KEEP_STEP に結果照合の段");
  });

  var fail = 0;
  results.forEach(function (r) {
    if (r.ok) console.log("  ✓ " + r.name);
    else { fail++; console.log("  ✗ " + r.name + "\n      " + (r.err && r.err.stack ? r.err.stack.split("\n").slice(0, 4).join("\n      ") : r.err)); }
  });
  console.log("\n" + (results.length - fail) + " 通り / " + fail + " 落ち");
  process.exit(fail ? 1 : 0);
})();
