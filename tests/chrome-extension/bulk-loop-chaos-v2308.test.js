/**
 * 一括ループの総当たり（故障をランダムに混ぜた8人）— 全員が完了するまで回り続けるか／どの故障が時間を食うか
 *   2026-11-26 竹内さん「一連のループの流れボトルネックにならずにすべてのお客さん完了するまでループで検索されるようになっているのか・テストして調査」
 *
 * 仮想時計・偽の Chrome で本物の background.js のループ（_manualBulkRun・送付後のリセット・見張り・復帰）を回す。
 * 故障（1客ごとに1つ）: 普通／入力が遅い／送付完了の合図が落ちた／入力済みの合図なし／0件／送付後の外しが固まる・遅い／
 *   リセットのボタン無し・押して返事なし・押しても空にならない／裏（SW）が途中で止められる（誰も手で起こさない）
 * 判定: 8人が順に1回ずつ入る・ループが終わる・時計の中で例外なし・1人あたりの時間が上限以内
 * 環境変数: CHAOS_SEEDS=60（既定）・CHAOS_VERBOSE=1（失敗の中身を出す）
 */
"use strict";
var sim = require("./lib/bulk-sim.js");

var N = 8;
var SEEDS = Number(process.env.CHAOS_SEEDS || 60);
var VERBOSE = !!process.env.CHAOS_VERBOSE;
var PER_CUSTOMER_LIMIT_MS = 12 * 60000; // 1人あたり12分を超えたら「ボトルネック」
var TOTAL_RUN_MS = N * 25 * 60000;

function rng(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function customers(n) { var a = []; for (var i = 1; i <= n; i++) a.push({ id: "c" + i, name: "客" + i }); return a; }

var FAULTS = [
  { k: "ok", w: 10, page: {} },
  { k: "slow_fill", w: 3, page: { fillMs: 150000 } },
  { k: "drop_done", w: 3, page: { dropBatchDone: true } },
  { k: "no_fill_done", w: 2, page: { noFillDone: true } },
  { k: "zero_count", w: 2, page: { count: 0 } },
  { k: "reset_nobutton", w: 3, page: { reset: "nobutton" } },
  { k: "reset_hang", w: 3, page: { reset: "hang" } },
  { k: "reset_notempty", w: 3, page: { reset: "notempty" } },
  { k: "sw_kill", w: 4, page: {}, kill: true },
];

function pick(r) {
  var tot = FAULTS.reduce(function (a, f) { return a + f.w; }, 0), x = r() * tot;
  for (var i = 0; i < FAULTS.length; i++) { x -= FAULTS[i].w; if (x < 0) return FAULTS[i]; }
  return FAULTS[0];
}

async function one(seed, resetMode) {
  var r = rng(seed);
  var plan = {};
  customers(N).forEach(function (c) { plan[c.id] = pick(r); });
  var killDelay = {};
  customers(N).forEach(function (c) { killDelay[c.id] = Math.floor(r() * 150000); });
  var w = sim.createWorld({
    customers: customers(N),
    resetButton: resetMode,
    page: function (cid) { return Object.assign({}, plan[cid].page); },
    onAutofill: function (world, cid) {
      if (plan[cid].kill) world.clock.add("page", function () { world.killSw("chaos:" + cid); }, killDelay[cid], false);
    },
  });
  var sw = w.startSw();
  await w.run(10);
  sw.call("_manualBulkRun", { site: "realnetpro", ids: customers(N).map(function (c) { return c.id; }), isWide: false, startIndex: 0, resume: false, why: "popup" });
  await w.run(TOTAL_RUN_MS);
  var filled = w.autofills.map(function (a) { return a.cid; });
  var want = customers(N).map(function (c) { return c.id; });
  // 再開で同じ客をやり直した場合は重複する（retrySame）。ここでは「全員に届いた」と「飛ばされていない」を見る
  var uniq = [];
  filled.forEach(function (c) { if (uniq.indexOf(c) < 0) uniq.push(c); });
  var q = w.session.data.axlx_bulk_queue || null;
  var alive = null;
  try { alive = w.sw ? w.sw.get("_manualBulkAlive") : null; } catch (_) {}
  var gaps = [];
  for (var i = 1; i < w.autofills.length; i++) gaps.push({ cid: w.autofills[i - 1].cid, ms: w.autofills[i].at - w.autofills[i - 1].at });
  // 2026-11-27（リセットは押して空を確かめる・確かめられなければ止める）: リセットの故障で止まった時は、
  // 次の客へ入らず止まっていること（届いた客は先頭からの連続＝飛ばして入れていない）を見る
  var resetFault = customers(N).some(function (c) { return /^reset_/.test(plan[c.id].k); });
  // 2.8.328: 従来の1つずつ外しへ戻る道は無いので、リセットの確かめられない客は（ボタンの有無に関わらず）止まる
  var stoppedByReset = resetFault && JSON.stringify(Array.from(w.db.values())).indexOf("reset_stop") >= 0;
  var prefixOk = want.slice(0, uniq.length).join() === uniq.join();
  var res = {
    seed: seed, plan: plan, filled: filled,
    allReached: uniq.length === N && uniq.join() === want.join(),
    stoppedByReset: stoppedByReset, prefixOk: prefixOk,
    dup: filled.length - uniq.length,
    done: !!(q && (q.done || q.stage === "done") && (q.index === N - 1 || q.done)),
    queue: q, alive: alive,
    errors: w.clock.errors.map(String),
    gaps: gaps, maxGap: gaps.reduce(function (m, g) { return Math.max(m, g.ms); }, 0),
    lastAt: w.autofills.length ? w.autofills[w.autofills.length - 1].at : 0,
    postSendClear: w.postSendClearCalls, resetPress: w.resetPressCalls,
    steps: Array.from(w.db.values()),
    clockEnd: w.clock.now(),
  };
  return res;
}

(async function main() {
  var summary = { runs: 0, ok: 0, fail: [], slow: [] };
  var perFault = {};
  var modes = [false, true];
  for (var mi = 0; mi < modes.length; mi++) {
    var mode = modes[mi];
    var failMode = 0, runs = 0;
    for (var s = 1; s <= SEEDS; s++) {
      var res;
      try { res = await one(s * 7919 + (mode ? 1 : 0), mode); } catch (e) { res = { seed: s, crash: String(e && e.stack || e), allReached: false }; }
      runs++; summary.runs++;
      var problems = [];
      if (res.crash) problems.push("crash:" + res.crash.slice(0, 200));
      else {
        if (!res.allReached && !(res.stoppedByReset && res.prefixOk)) problems.push("全員に届かず（入れた=" + res.filled.join(",") + "）");
        if (res.errors.length) problems.push("例外:" + res.errors[0].slice(0, 100));
        if (res.maxGap > PER_CUSTOMER_LIMIT_MS) problems.push("1人あたり " + Math.round(res.maxGap / 60000) + "分");
        if (res.dup > 3) problems.push("同じ客を" + res.dup + "回やり直し");
      }
      // 故障ごとの1人あたり時間
      if (res.gaps) res.gaps.forEach(function (g) {
        var f = res.plan[g.cid].k;
        var e = perFault[(mode ? "reset" : "clear") + ":" + f] || (perFault[(mode ? "reset" : "clear") + ":" + f] = { n: 0, sum: 0, max: 0 });
        e.n++; e.sum += g.ms; e.max = Math.max(e.max, g.ms);
      });
      if (problems.length) {
        failMode++;
        summary.fail.push({ mode: mode ? "reset" : "clear", seed: res.seed, problems: problems, plan: res.plan ? Object.keys(res.plan).map(function (k) { return res.plan[k].k; }).join(",") : "" });
      } else summary.ok++;
    }
    console.log("[" + (mode ? "リセット方式" : "従来の外し方式") + "] " + runs + " 通り中 失敗 " + failMode);
  }
  console.log("\n■ 故障ごとの「次の客が入るまでの時間」（秒・平均／最大）");
  Object.keys(perFault).sort().forEach(function (k) {
    var e = perFault[k];
    console.log("  " + k.padEnd(24) + " n=" + String(e.n).padStart(3) + " 平均" + String(Math.round(e.sum / e.n / 1000)).padStart(5) + " 最大" + String(Math.round(e.max / 1000)).padStart(6));
  });
  console.log("\n■ 失敗 " + summary.fail.length + " / " + summary.runs);
  summary.fail.slice(0, VERBOSE ? 40 : 12).forEach(function (f) { console.log("  [" + f.mode + "] seed=" + f.seed + " " + f.problems.join(" | ") + "\n      計画: " + f.plan); });
  console.log("\n" + summary.ok + " passed, " + summary.fail.length + " failed");
  process.exit(summary.fail.length ? 1 : 0);
})();
