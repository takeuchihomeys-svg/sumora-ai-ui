/** v2.8.265: 一括で1人目の送付完了の後、次のお客さんへ移らない時に「把握して・画面から指示して・続ける」 */
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var root = path.join(__dirname, "..", "..");
var bg = fs.readFileSync(path.join(root, "chrome-extension/background.js"), "utf8");
var bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8");
var ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
var saSrc = fs.readFileSync(path.join(root, "chrome-extension/search-audit.js"), "utf8");
var mf = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");
var n = 0, fail = 0;
function ok(name, cond) {
  n++;
  if (cond) console.log("  ✓ " + name);
  else { fail++; console.log("  ✗ " + name); }
}
function topFn(src, name) {
  var i = src.indexOf("function " + name + "(");
  if (i < 0) return "";
  if (src.slice(i - 6, i) === "async ") i -= 6;
  var s = src.slice(i).replace(/\r\n/g, "\n");
  var e = s.indexOf("\n}\n");
  return e < 0 ? s.slice(0, 8000) : s.slice(0, e + 2);
}

function vge(v, min) {
  var a = String(v || "0").split(".").map(Number), b = String(min).split(".").map(Number);
  for (var i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); }
  return true;
}
console.log("\n■ 版 2.8.265 以上");
ok("manifest ≥2.8.265", vge(mf.version, "2.8.265"));
ok("page ≥2.8.265", vge((ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1], "2.8.265"));
ok("rules ≥2.8.265", vge((rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1], "2.8.265"));
ok("RULES_DONE に bulk_handoff_watch_resume", /"bulk_handoff_watch_resume"/.test(ps));
ok("手順の決まりに bulk_handoff_watch_resume", /id: "bulk_handoff_watch_resume"[\s\S]{0,1200}since: "2\.8\.265"/.test(rules));

console.log("\n■ 裏: 一括のループを関数にして、どこからでも続けられる");
var run = topFn(bg, "_manualBulkRun");
ok("_manualBulkRun がある", run.length > 1000);
ok("startIndex から回す", /for \(var _bi = _startIndex;/.test(run));
ok("世代が変わったら古いループは抜ける", /_myGen !== _manualBulkGen/.test(run));
ok("終わりは世代が今の時だけ片付ける", /finally \{\s*if \(_myGen === _manualBulkGen\)/.test(run));
ok("進みを控える（pre／running／done）", /stage: "pre"/.test(run) && /stage: "running"/.test(run) && /stage: "done"/.test(run));
ok("把握の送りに上限", (run.match(/_withTimeout\(_publishBulkGrasp/g) || []).length >= 3);
ok("段を残す（gap／look／interval／autofill）", /_bulkPhaseSet\("gap"/.test(run) && /_bulkPhaseSet\("look"/.test(run) && /_bulkPhaseSet\("interval"/.test(run) && /_bulkPhaseSet\("autofill"/.test(run));
ok("再開時はページの再読込をしない", /if \(!_resume\) try \{\s*var _pf = await _ensureRealproPageFresh/.test(run));
ok("再開時はストップの印を見て止まる", /stop_before_resume/.test(run));
ok("受け手は関数を呼ぶだけ", /_manualBulkRun\(\{ site: _bulkSite, ids: _bulkIds, isWide: _bulkIsWide, startIndex: 0, resume: false, why: "popup" \}\)/.test(bg));
ok("受け手に使い捨てのループが残っていない", !/sendResponse\(\{ ok: true, started: true \}\);\s*\(async \(\) => \{/.test(bg));

console.log("\n■ 裏: 起こし続ける・止まりを見つける・続ける");
ok("進みは storage.session（SW が止められても残る）", /chrome\.storage\.session\.set\(\{ axlx_bulk_queue: _bulkQueue \}\)/.test(bg));
ok("20秒ごとに getPlatformInfo", /getPlatformInfo[\s\S]{0,600}\}, 20000\)/.test(bg));
ok("見回りで段の止まりを見て進める", /_bulkPhaseStuck\(p\)\)\s*\{\s*_bulkKick\("stuck:"/.test(bg));
ok("入力・送付の待ちは見回りで進めない", /BULK_KICKABLE_PHASES = \{[^}]*\}/.test(bg) && !/BULK_KICKABLE_PHASES = \{[^}]*wait_batch_done/.test(bg) && !/BULK_KICKABLE_PHASES = \{[^}]*autofill/.test(bg));
ok("立ち上がり直したら続きを探す", /sw_restart/.test(bg));
ok("入力・送付の最中に止められた時は送付完了を待つ", /q\.stage === "running"\)\s*\{[\s\S]{0,300}送付完了を待って続ける[\s\S]{0,6500}?batch_done_sw_watchdog[\s\S]{0,400}?return;/.test(bg));
ok("送付完了の合図でループが無ければ続ける", /batch_done_no_loop/.test(bg));
ok("定時の一括は続きを待つ間は割り込まない", /_bq && !_bq\.done && _bq\.beatAt/.test(bg));
ok("Realtime も割り込まない", /_rtBq && !_rtBq\.done/.test(bg));
ok("画面の問い合わせ axlx-bulk-status", /msg\.type !== "axlx-bulk-status"/.test(bg));
ok("画面の指示 axlx-bulk-kick で待ちを解く", /bulk_done_resend[\s\S]{0,200}_notifyBatchCustomerDone\(doneCid/.test(bg));
ok("送付後の executeScript に上限", /_withTimeout\(chrome\.scripting\.executeScript\(\{[\s\S]{0,400}force_clear_gap_flag/.test(bg));
ok("ロック解除に上限", /_withTimeout\(_releasePipelineLock\(/.test(bg));
ok("段: 送付完了待ち", /_bulkPhaseSet\("wait_batch_done"/.test(bg));
ok("段: 送付後の外し", /_bulkPhaseSet\("post_send_clear"/.test(bg));

console.log("\n■ _bulkKick の決め方（vm で動かす）");
(function () {
  var kick = topFn(bg, "_bulkKick");
  var calls = [];
  var ctx = {
    console: { log: function () {}, warn: function () {} },
    Date: Date,
    _bulkKickAt: 0,
    _bulkPhase: null,
    _bulkPhaseRunId: null,
    _manualBulkGen: 0,
    _manualBulkAlive: false,
    _bulkQueue: null,
    _bulkQueueLoad: async function () { return ctx._q; },
    _bulkQueueSave: function (p) { ctx._q = Object.assign({}, ctx._q, p); },
    _auditStep: function () {},
    _quietClear: function () { return false; }, // 2.8.295: 邪魔しない窓を閉じる（ここでは決め方だけ見るので何もしない）
    _withTimeout: function (p) { return p; },
    _publishBulkGrasp: async function () {},
    _manualBulkRun: function (o) { calls.push(o); },
  };
  vm.createContext(ctx);
  vm.runInContext(kick, ctx);
  // 2.8.283: 未処理の客を飛ばさない上限（_bulkKick が使う）。今のコードの関数をそのまま入れる
  vm.runInContext(topFn(bg, "_bulkClampStart"), ctx);
  function reset(q) { ctx._q = q; ctx._bulkKickAt = 0; calls.length = 0; }
  return (async function () {
    reset({ ids: ["a", "b", "c"], index: 0, stage: "done", cid: "a", site: "realnetpro", isWide: false });
    var r1 = await ctx._bulkKick("t");
    ok("done → 次の客から", r1.ok && calls[0] && calls[0].startIndex === 1 && calls[0].resume === true);
    reset({ ids: ["a", "b", "c"], index: 1, stage: "pre", cid: "b", handledCids: ["a"] }); // 2.8.283: 前の客が片付いている形（片付いていない客は飛ばさない）
    await ctx._bulkKick("t");
    ok("pre → その客から", calls[0] && calls[0].startIndex === 1);
    reset({ ids: ["a", "b", "c"], index: 0, stage: "running", cid: "a" });
    var r3 = await ctx._bulkKick("t");
    ok("running（合図なし）→ 進めない", !r3.ok && r3.reason === "running_not_done" && calls.length === 0);
    reset({ ids: ["a", "b", "c"], index: 0, stage: "running", cid: "a" });
    await ctx._bulkKick("t", { doneCid: "a" });
    ok("running＋同じ客の送付完了 → 次の客から", calls[0] && calls[0].startIndex === 1);
    reset({ ids: ["a", "b", "c"], index: 0, stage: "running", cid: "a" });
    var r5 = await ctx._bulkKick("t", { doneCid: "zzz" });
    ok("running＋別の客の合図 → 進めない", !r5.ok && calls.length === 0);
    reset({ ids: ["a", "b", "c"], index: 0, stage: "running", cid: "a" });
    ctx._bulkPhase = { phase: "post_send_clear", cid: "a" };
    await ctx._bulkKick("t");
    ok("送付後の外しで止まった → 次の客から（送付は済み）", calls[0] && calls[0].startIndex === 1);
    reset({ ids: ["a", "b", "c"], index: 0, stage: "running", cid: "a" });
    ctx._bulkPhase = { phase: "wait_batch_done", cid: "a" };
    var r4b = await ctx._bulkKick("t");
    ok("送付完了待ちは合図なしで進めない", !r4b.ok && calls.length === 0);
    ctx._bulkPhase = null;
    reset({ ids: ["a", "b"], index: 1, stage: "done", cid: "b", handledCids: ["a"] }); // 2.8.283: 前の客が片付いている形
    var r6 = await ctx._bulkKick("t");
    ok("最後の客が済み → 一括を閉じる", r6.ended === true && ctx._q.done === true && calls.length === 0);
    reset({ ids: ["a", "b"], index: 0, stage: "done", done: true });
    var r7 = await ctx._bulkKick("t");
    ok("終わった一括は動かさない", !r7.ok && r7.reason === "no_queue");
    reset({ ids: ["a", "b", "c"], index: 0, stage: "done" });
    await ctx._bulkKick("t");
    var r8 = await ctx._bulkKick("t");
    ok("20秒以内の2回目は無視（二重に回さない）", !r8.ok && r8.reason === "recent_kick" && calls.length === 1);
  })();
})().then(function () {
  console.log("\n■ 点検: 知らない番号でも開いている一括の回へ足す");
  var prog = topFn(bg, "_auditOnFillProgress");
  var done = topFn(bg, "_auditOnFillDone");
  ok("fill-progress: 一括の回を findOpen", /_openBulk = _auditTracker\.findOpen\(msg\.customerId/.test(prog) && /_openBulk\.trigger !== "local"/.test(prog));
  ok("fill-done: 一括の回を findOpen", /_openBulkD = _auditTracker\.findOpen\(msg\.customerId/.test(done));
  ok("tracker に flush", /function flush\(id\)/.test(saSrc) && /flush: flush/.test(saSrc));
  ok("KEEP_STEP に bulk_kick", /KEEP_STEP = \/\^\(begin\|bulk_kick\|bulk_done_resend\|/.test(saSrc));
  ok("RULE_STEP に bulk_phase", /RULE_STEP = \/\^\(fill_progress\|bulk_phase\|/.test(saSrc));

  // flush を実際に動かす
  var sent = [];
  var timers = [];
  var sandbox = { self: {}, console: console, Date: Date, fetch: function () { return Promise.resolve({ ok: true }); }, setTimeout: function (fn) { timers.push(fn); return timers.length; } };
  sandbox.window = sandbox.self;
  vm.createContext(sandbox);
  vm.runInContext(saSrc, sandbox);
  var SA = sandbox.self.AxlxSearchAudit || sandbox.AxlxSearchAudit;
  if (SA && SA.createTracker) {
    var t = 1000;
    var tr = SA.createTracker({ post: function (b) { sent.push(b); return Promise.resolve({ ok: true }); }, now: function () { return t; } });
    tr.begin({ run_id: "r1", site: "realnetpro", customer_id: "c1", trigger: "bulk_manual" });
    tr.step("r1", "bulk_phase", "gap");
    tr.flush("r1");
    tr.flush("r1");
    t += 1500;
    tr.flush("r1");
    return Promise.resolve().then(function () { return Promise.resolve(); }).then(function () {
      var prog2 = sent.filter(function (b) { return b.phase === "progress"; });
      ok("flush で progress を送る（1秒に1回まで）", prog2.length === 2 && prog2[0].steps.some(function (s) { return s.k === "bulk_phase"; }));
      ok("progress は started の後（2.8.267）", sent[0].phase === "started" && sent.indexOf(prog2[0]) > 0);
      ok("1秒以内の2回目は後でまとめて送る予約になる（2.8.267）", timers.length === 1);
    });
  } else {
    ok("search-audit を読み込めた", false);
  }
}).then(function () {

  console.log("\n■ 画面: 送付完了の後も見張って指示する");
  ok("見張りの関数", /function _armHandoffWatch\(cid, n, why\)/.test(bd));
  ok("送付完了で見張り開始", /_autoRunCid = null;\s*_armHandoffWatch\(cid/.test(bd));
  ok("押さずに終わった時も見張り開始", /_armHandoffWatch\(cid, sentSoFar/.test(bd));
  ok("15秒ごと", /HANDOFF_POLL_MS = 15000/.test(bd));
  ok("裏に段を聞く", /type: "axlx-bulk-status"/.test(bd));
  ok("裏のループが無ければ指示", /if \(!r\.alive\) \{ _handoffKick/.test(bd));
  ok("段が止まっていれば指示", /if \(r\.stuck\) \{ _handoffKick/.test(bd));
  ok("裏がまだ送付完了待ちなら合図を出し直させる", /p\.phase === "wait_batch_done"[\s\S]{0,200}_handoffKick/.test(bd));
  ok("次の客が始まったら外す", /_stopHandoffWatch\(w, "advanced"\)/.test(bd));
  ok("一括が終われば外す", /_stopHandoffWatch\(w, "bulk_done"\)/.test(bd));
  ok("30分で外す", /HANDOFF_MAX_MS = 30 \* 60000/.test(bd));
  ok("指示は3回まで", /w\.kicks >= 3/.test(bd));
  ok("枠に段を出す", /_nudge\("⏭ 次のお客さんへ: "/.test(bd));

  console.log("\n" + (fail ? "✗ " + fail + "/" + n + " 失敗" : "✓ 全 " + n + " 件 OK"));
  if (fail) process.exit(1);
});
