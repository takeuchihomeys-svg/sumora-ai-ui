/**
 * 一括（手の一括検索）のループを、本物の background.js の範囲を切り出して偽の Chrome・偽の時計で丸ごと動かす試験。
 *   2026-11-24 竹内さん「ちゃんと外すして新しいお客さんの条件入れることができるようになっているか テストも行って徹底的に細部までちょうさおねがい
 *   テストの仕組みも強化していくように」
 *
 * 場面:
 *   S1 普通に3人 → 3人とも入れて送付完了・外し・最後に一括完了
 *   S2 送付完了の合図が落ちた → 画面の見張り（axlx-bulk-kick）で送り直し → 2人目へ
 *   S3 裏が「人の間」の途中で止められた → 立ち上げ直しで2人目から続ける
 *   S4 裏が送付完了待ちの途中で止められた → 送付完了の合図（ループ無し）で次へ
 *   S5 パネルへの知らせが返ってこない → 8秒で諦めて進む
 *   S6 送付後の外しが返ってこない → 125秒で諦めて次へ
 *   S7 ストップ → 次の人に進まない
 *   S8 見回りが 20秒ごとに裏を起こしている
 *   S9 2回続けて起こしても、ループは1本だけ
 *   S10 点検の記録（DB の行）に段が入り、各お客さんの行が閉じる
 */
"use strict";
var assert = require("assert");
var sim = require("./lib/bulk-sim.js");

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
function queue(world) { return world.session.data.axlx_bulk_queue || null; }

(async function main() {
  await scenario("S1 普通に3人 → 順に入れて最後に一括完了", async function () {
    var w = sim.createWorld({ customers: customers(3) });
    await startBulk(w, 3);
    await w.run(20 * 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1", "c2", "c3"], "入れた順: " + cidsFilled(w).join(","));
    assert.strictEqual(w.resetPressCalls, 3, "送付後のリセットは3人とも（最後の人は待たずに戻す・2.8.328）: " + w.resetPressCalls);
    var q = queue(w);
    assert.ok(q && q.stage === "done", "列の最後は done: " + JSON.stringify(q));
    assert.strictEqual(w.sw.get("_manualBulkAlive"), false, "ループは終わっている");
    assert.deepStrictEqual(w.clock.errors, [], "時計の中で例外: " + w.clock.errors.map(String).join(" / "));
    var order = w.log.filter(function (l) { return l.kind === "autofill" || l.kind === "reset_press_exec" || l.kind === "reset_verify_exec" || l.kind === "page_batch_done_sent"; }).map(function (l) { return l.kind + ":" + (l.d || ""); });
    assert.deepStrictEqual(order, [
      "autofill:c1", "page_batch_done_sent:c1", "reset_press_exec:ok", "reset_verify_exec:ok",
      "autofill:c2", "page_batch_done_sent:c2", "reset_press_exec:ok", "reset_verify_exec:ok",
      "autofill:c3", "page_batch_done_sent:c3", "reset_press_exec:ok", "reset_verify_exec:ok",
    ], "外してから次の人を入れる順: " + order.join(" → "));
    assert.strictEqual(w.kicksSent.length, 0, "普通の時は画面から起こさない: " + JSON.stringify(w.kicksSent.map(function (k) { return k.msg.why; })));
    var ends = w.pageMarks.filter(function (m) { return m.k === "handoff_watch_end"; }).map(function (m) { return m.d.split(" ")[0]; });
    assert.deepStrictEqual(ends, ["advanced", "advanced", "bulk_done"], "画面の見張りは次の人が始まった・一括が終わったで外れる: " + ends.join(","));
    w.autoStubsUsed = Array.from(w.sw.autoStubs).sort();
    results.autoStubs = w.autoStubsUsed;
  });

  await scenario("S2 送付完了の合図が落ち、画面の見張りも無い → 裏は送付完了を待ち続ける（見張りが要る理由）", async function () {
    var w = sim.createWorld({ customers: customers(2), page: function (cid) { return cid === "c1" ? { dropBatchDone: true, noPageWatch: true } : {}; } });
    await startBulk(w, 2);
    await w.run(5 * 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1"], "見張りが無いと2人目に進まない");
    var st = await w.pageSend({ type: "axlx-bulk-status" });
    assert.ok(st && st.phase && st.phase.phase === "wait_batch_done" && st.phase.cid === "c1", "段は1人目の送付完了待ち: " + JSON.stringify(st && st.phase));
    var k = await w.pageSend({ type: "axlx-bulk-kick", why: "test", cid: "c1", propertyCount: 5 });
    assert.ok(k && k.resent, "起こすと待ちを解く: " + JSON.stringify(k));
    await w.run(3 * 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1", "c2"], cidsFilled(w).join(","));
  });

  await scenario("S2b 送付完了の合図が落ちた → 画面の見張りが45秒後に裏を起こして2人目へ（手で何もしない）", async function () {
    var w = sim.createWorld({ customers: customers(2), page: function (cid) { return cid === "c1" ? { dropBatchDone: true } : {}; } });
    await startBulk(w, 2);
    var doneAt = 30000 + 60000;
    await w.run(doneAt + 10 * 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1", "c2"], "2人目へ: " + cidsFilled(w).join(","));
    var c2 = w.autofills[1].at - w.autofills[0].at;
    assert.ok(c2 < doneAt + 3 * 60000, "合図が落ちても3分以内に2人目（旧は20〜45分）: " + Math.round(c2 / 1000) + "秒");
    assert.ok(w.kicksSent.some(function (k) { return /送付完了をまだ待っている/.test(k.msg.why); }), "起こしの理由: " + JSON.stringify(w.kicksSent.map(function (k) { return k.msg.why; })));
    results.s2bSec = Math.round((w.autofills[1].at - w.autofills[0].at - doneAt) / 1000);
  });

  await scenario("S11 合図が落ちた上に裏も止められた → 画面の見張りが裏を起こし、2人目から", async function () {
    var w = sim.createWorld({ customers: customers(3), page: function (cid) { return cid === "c1" ? { dropBatchDone: true } : {}; } });
    await startBulk(w, 3);
    await w.run(30000 + 30000);
    w.killSw("idle");
    await w.run(15 * 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1", "c2", "c3"], cidsFilled(w).join(","));
  });

  await scenario("S12 入力済みの合図（fill-done）が来ないが送付完了は来る → 待たずに次へ", async function () {
    var w = sim.createWorld({ customers: customers(2), page: function (cid) { return cid === "c1" ? { noFillDone: true } : {}; } });
    await startBulk(w, 2);
    await w.run(10 * 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1", "c2"], cidsFilled(w).join(","));
    var gap = w.autofills[1].at - w.autofills[0].at;
    assert.ok(gap < 5 * 60000, "5分以内: " + Math.round(gap / 1000) + "秒");
  });

  await scenario("S13 画面が入力の途中で固まった（fill-done も送付完了も来ない）→ 何分で2人目へ進むか", async function () {
    var w = sim.createWorld({ customers: customers(2), page: function (cid) { return cid === "c1" ? { noFillDone: true, dropBatchDone: true, noPageWatch: true, fillMs: 99 * 3600000 } : {}; } });
    await startBulk(w, 2);
    await w.run(90 * 60000);
    var sec = w.autofills[1] ? Math.round((w.autofills[1].at - w.autofills[0].at) / 1000) : null;
    results.s13Sec = sec;
    assert.ok(sec != null, "90分たっても2人目へ進まない");
  });

  await scenario("S3 裏が「人の間」の途中で止められた → 立ち上げ直しで2人目から", async function () {
    var w = sim.createWorld({ customers: customers(3), gapMs: 60000 });
    await startBulk(w, 3);
    // c1: 入力30秒＋送付60秒＋リセット前の20秒＋押す1.5秒＋30〜34秒の確かめ＋読む0.9秒＋リセット後の20秒 → 間（60秒）の途中で止める（2.8.328）
    await w.run(30000 + 60000 + 20000 + 1500 + 34000 + 1000 + 20000 + 20000);
    var ph = w.session.data.axlx_bulk_phase;
    assert.ok(ph && ph.phase === "gap", "止める時の段は gap: " + JSON.stringify(ph));
    w.killSw("idle");
    await w.run(60000);
    w.startSw();
    await w.run(15 * 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1", "c2", "c3"], "2人目から続ける（1人目をやり直さない）: " + cidsFilled(w).join(","));
  });

  await scenario("S4 裏が送付完了待ちの途中で止められた → 送付完了の合図でループ無しから次へ", async function () {
    var w = sim.createWorld({ customers: customers(2) });
    await startBulk(w, 2);
    await w.run(30000 + 30000); // 入力済み・送付の途中
    assert.strictEqual(w.session.data.axlx_bulk_phase && w.session.data.axlx_bulk_phase.phase, "wait_batch_done");
    w.killSw("idle");
    await w.run(10 * 60000); // 画面は送付完了の合図を送る（裏はその時に立ち上がる）
    assert.deepStrictEqual(cidsFilled(w), ["c1", "c2"], "2人目へ: " + cidsFilled(w).join(","));
  });

  await scenario("S5 パネルへの知らせが返らない → 8秒で諦めて進む", async function () {
    var w = sim.createWorld({ customers: customers(2), publishHang: true });
    await startBulk(w, 2);
    await w.run(15 * 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1", "c2"], cidsFilled(w).join(","));
  });

  await scenario("S6 リセットを押した返事が返らない → 画面を読み直す保険で空を確かめて次へ（2.8.328）", async function () {
    var w = sim.createWorld({ customers: customers(2), page: function (cid) { return cid === "c1" ? { reset: "hang" } : {}; } });
    await startBulk(w, 2);
    await w.run(30000 + 60000 + 20000 + 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1"], "返事待ちと保険の途中は2人目へ進まない");
    await w.run(10 * 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1", "c2"], cidsFilled(w).join(","));
  });

  await scenario("S7 ストップ → 次の人に進まない", async function () {
    var w = sim.createWorld({ customers: customers(3) });
    var sw = await startBulk(w, 3);
    await w.run(40000);
    vmSet(sw, "_batchShouldStop = true");
    await w.run(20 * 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1"], cidsFilled(w).join(","));
  });

  await scenario("S8 見回りが 20秒ごとに裏を起こしている", async function () {
    var w = sim.createWorld({ customers: customers(3), page: function () { return { fillMs: 120000, batchMs: 240000 }; } });
    var sw = await startBulk(w, 3);
    var before = sw.platformPings;
    await w.run(5 * 60000);
    assert.ok(sw.platformPings - before >= 14, "5分で15回前後: " + (sw.platformPings - before));
  });

  await scenario("S9 2回続けて起こしても、ループは1本だけ", async function () {
    var w = sim.createWorld({ customers: customers(3), page: function (cid) { return cid === "c1" ? { dropBatchDone: true } : {}; } });
    await startBulk(w, 3);
    await w.run(3 * 60000);
    await Promise.all([
      w.pageSend({ type: "axlx-bulk-kick", why: "test_double", cid: "c1", propertyCount: 5 }),
      w.pageSend({ type: "axlx-bulk-kick", why: "test_double", cid: "c1", propertyCount: 5 }),
    ]);
    await w.run(20 * 60000);
    var c2 = cidsFilled(w).filter(function (c) { return c === "c2"; }).length;
    assert.strictEqual(c2, 1, "2人目は1回だけ入れる: " + cidsFilled(w).join(","));
  });

  await scenario("S10 点検の記録（DB の行）に段が入り、各お客さんの行が閉じる", async function () {
    var w = sim.createWorld({ customers: customers(2) });
    await startBulk(w, 2);
    await w.run(15 * 60000);
    var rows = Array.from(w.db.values()).filter(function (r) { return r.trigger === "bulk_manual"; });
    assert.strictEqual(rows.length, 2, "2人分の行: " + rows.length);
    rows.forEach(function (r) {
      assert.strictEqual(r.status, "finished", "行が閉じる: " + r.cid);
      var ks = r.steps.map(function (s) { return s.k; });
      assert.ok(ks.indexOf("bulk_phase") >= 0, "段（bulk_phase）が入る: " + r.cid + " " + ks.join(","));
    });
  });

  await scenario("S14 送付完了まで済んだ前客の鍵だけ「古い鍵」として外す（2.8.266）", async function () {
    var seen = [];
    var w = sim.createWorld({
      customers: customers(3),
      onAutofill: function (world, cid, idx) {
        if (idx === 0) return;
        var prev = "c" + idx;
        seen.push({
          cid: cid,
          prevLock: world.sw.call("_bulkStaleLockCid", { customerId: prev }, cid),
          ownLock: world.sw.call("_bulkStaleLockCid", { customerId: cid }, cid),
          otherLock: world.sw.call("_bulkStaleLockCid", { customerId: "x9" }, cid),
          noLock: world.sw.call("_bulkStaleLockCid", null, cid),
        });
      },
    });
    await startBulk(w, 3);
    await w.run(20 * 60000);
    assert.deepStrictEqual(seen, [
      { cid: "c2", prevLock: "c1", ownLock: null, otherLock: null, noLock: null },
      { cid: "c3", prevLock: "c2", ownLock: null, otherLock: null, noLock: null },
    ], JSON.stringify(seen));
    assert.deepStrictEqual(queue(w).sentCids, ["c1", "c2", "c3"]);
    assert.strictEqual(w.sw.call("_bulkStaleLockCid", { customerId: "c1" }, "c9"), null, "一括が終わったら外さない（別の作業の鍵かもしれない）");
  });

  await scenario("S15 前客が送付の途中で切れた（入力で例外）→ その鍵は外さない", async function () {
    var seen = [];
    var w = sim.createWorld({
      customers: customers(2),
      page: function (cid) { return cid === "c1" ? { throwOnAutofill: "AXLX_PIPELINE_SEND_HOLD: 送付途中" } : {}; },
      onAutofill: function (world, cid, idx) { if (idx === 1) seen.push(world.sw.call("_bulkStaleLockCid", { customerId: "c1" }, cid)); },
    });
    await startBulk(w, 2);
    await w.run(10 * 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1", "c2"]);
    assert.deepStrictEqual(seen, [null], "送付完了でない前客の鍵は外さない: " + JSON.stringify(seen));
    assert.deepStrictEqual(queue(w).sentCids, ["c2"]);
  });

  await scenario("S16 裏が止められて立ち上がり直しても、送付完了の記録（sentCids）は残る", async function () {
    var seen = [];
    var w = sim.createWorld({
      customers: customers(3), gapMs: 60000,
      onAutofill: function (world, cid, idx) { if (idx === 1) seen.push(world.sw.call("_bulkStaleLockCid", { customerId: "c1" }, cid)); },
    });
    await startBulk(w, 3);
    // 2.8.328: 送付→リセット（20秒＋押す＋30〜34秒の確かめ＋20秒）の後の間で止める（S3 と同じ時刻）
    await w.run(30000 + 60000 + 20000 + 1500 + 34000 + 1000 + 20000 + 20000);
    w.killSw("idle");
    await w.run(60000);
    w.startSw();
    await w.run(15 * 60000);
    assert.deepStrictEqual(cidsFilled(w), ["c1", "c2", "c3"]);
    assert.deepStrictEqual(seen, ["c1"], JSON.stringify(seen));
  });

  await scenario("S17 行を作る送信（started）が遅くても、最初の段（bulk_phase）は DB に残る（2.8.267・#1631 の形）", async function () {
    var w = sim.createWorld({
      customers: customers(1), startedDelayMs: 2500,
      page: function () { return { fillMs: 10 * 60000, batchMs: 10 * 60000 }; },
    });
    await startBulk(w, 1);
    await w.run(60000);
    var rows = Array.from(w.db.values()).filter(function (r) { return r.trigger === "bulk_manual"; });
    assert.strictEqual(rows.length, 1, "行がある");
    assert.strictEqual(rows[0].status, "started", "まだ開いている（閉じる時にまとめて送るのではない）");
    var ks = rows[0].steps.map(function (s) { return s.k; });
    assert.ok(ks.indexOf("bulk_phase") >= 0, "開いている間に段が届く: " + ks.join(","));
  });

  await scenario("S18 回が閉じる前でも、裏で足した段（前客の待ち・一覧の段）は3秒以内に DB へ届く（2.8.267・#1633 の形）", async function () {
    var w = sim.createWorld({
      customers: customers(1),
      page: function () { return { fillMs: 10 * 60000, batchMs: 10 * 60000 }; },
    });
    await startBulk(w, 1);
    await w.run(30000);
    var rid = w.sw.call("_auditOpenRunId", "c1", null);
    assert.ok(rid, "開いている回");
    w.sw.call("_auditStep", rid, "wait_prev_send", "前客の送付待ち");
    w.sw.call("_auditStep", rid, "dl:pipeline_silence_tick", "n=1");
    await w.run(3500);
    var row = w.db.get(rid);
    var ks = row.steps.map(function (s) { return s.k; });
    assert.strictEqual(row.status, "started");
    assert.ok(ks.indexOf("wait_prev_send") >= 0 && ks.indexOf("dl:pipeline_silence_tick") >= 0, "段が届く: " + ks.join(","));
    var prog = w.posts.filter(function (p) { return p.run_id === rid && p.phase === "progress" && p.at >= w.clock.now() - 4000; });
    assert.strictEqual(prog.length, 1, "2段まとめて1回で送る: " + prog.length);
  });

  await scenario("版 2.8.266 と手順の決まり bulk_stale_prev_lock がそろっている", async function () {
    var fs = require("fs"), path = require("path");
    var root = path.join(__dirname, "..", "..");
    var mf = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
    var ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
    var rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");
    var bg = fs.readFileSync(path.join(root, "chrome-extension/background.js"), "utf8");
    var sa = fs.readFileSync(path.join(root, "chrome-extension/search-audit.js"), "utf8");
    var v = mf.version.split(".").map(Number);
    assert.ok(v[0] > 2 || (v[0] === 2 && (v[1] > 8 || (v[1] === 8 && v[2] >= 266))), "manifest " + mf.version);
    assert.strictEqual((ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1], mf.version, "page と manifest の版が同じ");
    assert.ok(/"bulk_stale_prev_lock"/.test(ps), "RULES_DONE");
    assert.ok(/id: "bulk_stale_prev_lock"[\s\S]{0,1200}since: "2\.8\.266"/.test(rules), "手順の決まり");
    assert.ok(/_bulkStaleLockCid\(_lockJob, _cidStr\)/.test(bg), "_batchAutofill の鍵の確かめで使う");
    assert.ok(/stale_prev_lock_dropped/.test(bg) && /RULE_STEP = \/\^\(fill_progress\|bulk_phase\|bulk_kick\|bulk_done_resend\|stale_prev_lock_dropped\|/.test(sa), "印を残す・落とさない");
    assert.ok(v[0] > 2 || (v[0] === 2 && (v[1] > 8 || (v[1] === 8 && v[2] >= 267))), "2.8.267 以上: " + mf.version);
    assert.ok(/function _auditStep\(runId, k, d\) \{[\s\S]{0,200}flushSoon\(runId, 3000\)/.test(bg), "裏の段は3秒まとめで送る");
    assert.ok(/function sendProgress\(r\)[\s\S]{0,400}_startedP/.test(sa), "started の後に progress");
    assert.ok(/silence_watch_tick 等）は進みではない/.test(ps), "見張り記録は進み印にしない");
    var bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8");
    assert.ok(/AXLX_STUCK_IDLE_MS = 135000/.test(ps) && /AXLX_STUCK_IDLE_MS = 135000/.test(bd), "止まりは135秒（120〜150秒のあいだ）");
    assert.ok(/_pdfBusy \|\| _isFillBusy\(\)/.test(bd), "送付中・入力中は撮影を始めない");
  });

  var fail = 0;
  results.forEach(function (r) {
    if (r.ok) console.log("  ✓ " + r.name);
    else { fail++; console.log("  ✗ " + r.name + "\n      " + (r.err && r.err.stack ? r.err.stack.split("\n").slice(0, 3).join("\n      ") : r.err)); }
  });
  if (results.autoStubs) console.log("  （偽物で埋めた関数: " + results.autoStubs.join(", ") + "）");
  if (results.s2bSec != null) console.log("  （合図が落ちた時、送付完了から2人目の入力まで: " + results.s2bSec + "秒）");
  if (results.s13Sec != null) console.log("  （画面が固まった時、1人目の入力から2人目の入力まで: " + results.s13Sec + "秒）");
  console.log("\n" + (results.length - fail) + " 通り / " + fail + " 落ち");
  process.exit(fail ? 1 : 0);
})();

function vmSet(sw, stmt) { require("vm").runInContext("with (__auto) { " + stmt + " }", sw.sandbox); }
