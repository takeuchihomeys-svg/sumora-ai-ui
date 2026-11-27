/**
 * 一括（手の一括検索）の裏（background.js）を、本物のコードのまま偽の Chrome と偽の時計の上で動かす模擬。
 *
 *   ・切り出して動かす本物: fill-done／送付完了の待ち（_createFillDoneWaiter・_createBatchCustomerDoneWaiter・_releasePipelineLock…）、
 *     一括のループと見回り（_manualBulkRun・_bulkKick・20秒の見回り・起動時の再開・axlx-bulk-status/kick の受け手）、
 *     送付後のリセットと送付完了待ち（_postSendClearOrReset・_resetWithInsurance・_scrapeAndSendRealpro）、送付完了の合図の受け手（axlx-batch-customer-done）
 *   ・偽物: chrome.*（storage は local/session を裏の再起動の後も残す）、時計（早送り）、画面（入力・送付の合図をシナリオ通りに返す）、
 *     点検の記録の送り先（DB の行に段が入るかを search-audit-server の recordProgress と同じ決まりで真似る）
 *   ・切り出した範囲で定義の無い `_名前` は空の関数で埋め、使った名前を env.autoStubs に残す（何を偽物にしたかを見える形に）
 *
 * 使い方は tests/chrome-extension/bulk-loop-sim-v28265.test.js。
 */
"use strict";
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var DIR = path.join(__dirname, "..", "..", "..", "chrome-extension");

function readBg() { return fs.readFileSync(path.join(DIR, "background.js"), "utf8").replace(/\r\n/g, "\n"); }

function sliceBetween(src, startMark, endMark, label) {
  var a = src.indexOf(startMark);
  if (a < 0) throw new Error("bulk-sim: 始まりが見つからない: " + label);
  var b = src.indexOf(endMark, a + startMark.length);
  if (b < 0) throw new Error("bulk-sim: 終わりが見つからない: " + label);
  return src.slice(a, b);
}

/** background.js から模擬に使う範囲を切り出す（印が変わったらここで落ちる＝試験が黙って古くならない） */
function extractRegions(src) {
  var waiters = sliceBetween(src, "var _fillDoneWaiters = [];", "// ── 2026-09-29 v2.5.40 一括の見張り", "fill-done／送付完了の待ち");
  var loop = sliceBetween(src, "var _batchLoopAlive = false;", "\nvar _batchWatch = null;", "一括のループと見回り");
  var scrape = sliceBetween(src, "var RESET_PRESS_TIMEOUT_MS = 130000;", "\nfunction _compactFill(", "送付後のリセットと送付完了待ち（2.8.328: 従来の1つずつ外しは無い）");
  var lStart = src.indexOf("chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {\n  // 2026-09-30 v2.5.43");
  if (lStart < 0) throw new Error("bulk-sim: 送付完了の受け手が見つからない");
  var lEnd = src.indexOf("\n});\n", lStart);
  var doneListener = src.slice(lStart, lEnd + 4);
  var auditStep = sliceBetween(src, "function _auditStep(runId, k, d) {", "\n/** 次の回が始まったら", "点検の段を足す");
  // 2.8.278 結果の見出しが希望と違った時の入れ直し（1客1回）
  var redo = sliceBetween(src, "async function _resultMismatchRedo(", "\n// ── 2026-09-30 v2.5.43 リアプロと ITANDI を同時に動かす", "結果の入れ直し");
  // 2.8.328 リセットで押すタブの選び方（入力と同じ・送付後／保険／入力前で1か所）
  var pickTab = sliceBetween(src, "function _pickRealproResetTab(", "\n}\n", "リセットで押すタブの選び方") + "\n}\n";
  return { waiters: waiters, loop: loop, scrape: scrape, doneListener: doneListener, auditStep: auditStep, redo: redo, pickTab: pickTab };
}

function declaredNames(code) {
  var out = new Set();
  var re = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^var\s+([A-Za-z_$][\w$]*)/gm;
  var m;
  while ((m = re.exec(code))) out.add(m[1] || m[2]);
  return out;
}

// ── 偽の時計（裏ごとに止められる）────────────────────────────────
function createClock(startMs) {
  var now = startMs;
  var seq = 0;
  var timers = new Map(); // id -> { at, fn, owner, every }
  function add(owner, fn, ms, every) {
    var id = ++seq;
    timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn: fn, owner: owner, every: every ? Math.max(1, Number(ms) || 1) : 0, seq: id });
    return id;
  }
  function clear(id) { timers.delete(id); }
  function killOwner(owner) { timers.forEach(function (t, id) { if (t.owner === owner) timers.delete(id); }); }
  function next() {
    var best = null, bestId = null;
    timers.forEach(function (t, id) { if (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq)) { best = t; bestId = id; } });
    return best ? { id: bestId, t: best } : null;
  }
  function flush() {
    return new Promise(function (r) { setImmediate(r); }).then(function () { return new Promise(function (r) { setImmediate(r); }); });
  }
  async function run(ms) {
    var target = now + ms;
    await flush();
    for (var guard = 0; guard < 200000; guard++) {
      var n = next();
      if (!n || n.t.at > target) break;
      now = n.t.at;
      if (n.t.every) n.t.at = now + n.t.every; else timers.delete(n.id);
      try { n.t.fn(); } catch (e) { (clock.errors = clock.errors || []).push(e); }
      await flush();
    }
    now = target;
    await flush();
  }
  var clock = {
    now: function () { return now; },
    add: add, clear: clear, killOwner: killOwner, run: run, flush: flush,
    pending: function (owner) { var n = 0; timers.forEach(function (t) { if (!owner || t.owner === owner) n++; }); return n; },
    errors: [],
  };
  return clock;
}

function makeDateClass(clock) {
  var RealDate = Date;
  function FakeDate() {
    var args = Array.prototype.slice.call(arguments);
    if (!(this instanceof FakeDate)) return new RealDate(clock.now()).toString();
    return args.length ? new (Function.prototype.bind.apply(RealDate, [null].concat(args)))() : new RealDate(clock.now());
  }
  FakeDate.now = function () { return clock.now(); };
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  FakeDate.prototype = RealDate.prototype;
  return FakeDate;
}

// ── 偽の保存先（裏を立ち上げ直しても残る）────────────────────────
function createArea(clock) {
  var data = {};
  function pick(keys) {
    if (keys == null) return Object.assign({}, data);
    var list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    var out = {};
    list.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = JSON.parse(JSON.stringify(data[k])); });
    return out;
  }
  function later(cb, v) { return Promise.resolve().then(function () { if (cb) cb(v); return v; }); }
  return {
    data: data,
    get: function (keys, cb) { return later(cb, pick(keys)); },
    set: function (obj, cb) { Object.keys(obj || {}).forEach(function (k) { data[k] = JSON.parse(JSON.stringify(obj[k])); }); return later(cb, undefined); },
    remove: function (keys, cb) { (typeof keys === "string" ? [keys] : keys || []).forEach(function (k) { delete data[k]; }); return later(cb, undefined); },
  };
}

/**
 * 模擬の世界（時計・保存先・画面・点検の送り先）を作る。裏は world.startSw() で何度でも立ち上げ直せる。
 *   scenario.customers: [{ id, name }]
 *   scenario.page(cid, index): { fillMs, batchMs, dropBatchDone, noFillDone, postSendClear: "ok"|"hang"|"slow" }
 */
function createWorld(scenario) {
  var src = readBg();
  var regions = extractRegions(src);
  var clock = createClock(Date.UTC(2026, 10, 24, 1, 0, 0)); // JST 10:00（昼休みに当てない）
  var local = createArea(clock), session = createArea(clock);
  var world = {
    clock: clock, local: local, session: session, regions: regions,
    log: [],            // 何が起きたかを時刻つきで
    autofills: [],      // { cid, at, sw }
    publishes: [],
    db: new Map(),      // run_id -> { status, steps[], trigger, cid }
    posts: [],          // 点検の送信 { phase, run_id, at, steps }
    sw: null, swCount: 0, kicksSent: [],
    scenario: scenario || {},
  };
  function note(kind, d) { world.log.push({ t: clock.now(), kind: kind, d: d }); }
  world.note = note;

  // 点検の送り先（search-audit-server.ts の recordStarted／recordProgress／recordFinished の決まりを真似る）
  function postAudit(body) {
    var id = body.run_id;
    world.posts.push({ phase: body.phase, run_id: id, at: world.clock.now(), steps: (body.steps || []).length });
    if (body.phase === "started") {
      var ins = function () { world.db.set(id, { status: "started", steps: [], trigger: body.trigger, cid: body.property_customer_id }); };
      var dl = world.scenario && world.scenario.startedDelayMs;
      if (dl) return new Promise(function (res) { world.clock.add("net", function () { ins(); res({ ok: true }); }, dl, false); });
      ins();
    } else if (body.phase === "progress") {
      var r = world.db.get(id);
      if (r && r.status === "started") {
        var seen = new Set(r.steps.map(function (s) { return s.k + "|" + s.at; }));
        (body.steps || []).forEach(function (s) { if (s && !seen.has(s.k + "|" + s.at)) { seen.add(s.k + "|" + s.at); r.steps.push(s); } });
      }
    } else if (body.phase === "finished") {
      var f = world.db.get(id);
      if (f && f.status === "started") { f.status = "finished"; f.steps = (body.steps || []).slice(); f.error = body.error || null; f.error_kind = body.error_kind || null; }
    }
    return Promise.resolve({ ok: true });
  }

  // 画面（リアプロのタブ）の偽物
  var tab = { id: 1, url: "https://www.realnetpro.com/main.php", active: true, windowId: 1 };
  world.tab = tab;
  world.postSendClearCalls = 0;
  world.resetPressCalls = 0;
  world.resetVerifyCalls = 0;
  // 2.8.284 既定の試験は従来の外しのまま（リセット押下の試験だけ scenario.resetButton: true で有効にする）
  local.data.axlx_reset_button_mode = !!(scenario && scenario.resetButton);

  world.startSw = function () {
    if (world.sw) world.killSw("restart");
    var owner = "sw" + (++world.swCount);
    var env = createSwEnv(world, owner, regions, postAudit, note);
    world.sw = env;
    note("sw_start", owner);
    return env;
  };
  world.killSw = function (why) {
    if (!world.sw) return;
    clock.killOwner(world.sw.owner);
    world.sw.dead = true;
    note("sw_kill", world.sw.owner + " " + (why || ""));
    world.sw = null;
  };
  /** 画面から裏へ合図を送る（裏が止まっていたら Chrome と同じく立ち上げてから届ける） */
  world.pageSend = function (msg) {
    if (!world.sw) world.startSw();
    return world.sw.deliver(msg, { tab: tab, url: tab.url });
  };
  world.run = function (ms) { return clock.run(ms); };

  // 画面の側の「送付完了の後の見張り」（bulk-dl.js の本物を切り出す）。画面は裏が止まっても生きている（時計の持ち主は page）
  var dl = fs.readFileSync(path.join(DIR, "bulk-dl.js"), "utf8").replace(/\r\n/g, "\n");
  var watchCode = sliceBetween(dl, "  var _handoffWatch = null;", "\n  /** 完了の合図だけ送る", "画面の送付後の見張り");
  world.pageMarks = [];
  var pageSandbox = {
    console: { log: function () {}, warn: function () {}, error: function () {} },
    Date: makeDateClass(clock),
    setInterval: function (fn, ms) { return clock.add("page", fn, ms, true); },
    clearInterval: function (id) { clock.clear(id); },
    setTimeout: function (fn, ms) { return clock.add("page", fn, ms, false); },
    _liveDlStep: function (k, d, cid) { world.pageMarks.push({ t: clock.now(), k: k, d: d, cid: cid }); },
    _tmark: function (k, d, cid) { world.pageMarks.push({ t: clock.now(), k: k, d: d, cid: cid }); },
    _nudge: function () {},
    chrome: {
      runtime: {
        lastError: undefined,
        sendMessage: function (msg, cb) {
          if (msg && msg.type === "axlx-bulk-kick") world.kicksSent.push({ t: clock.now(), msg: msg });
          world.pageSend(msg).then(function (r) { if (cb) cb(r); });
        },
      },
    },
  };
  vm.createContext(pageSandbox);
  vm.runInContext(watchCode + "\n;globalThis.__arm = _armHandoffWatch; globalThis.__cur = function () { return _handoffWatch; };", pageSandbox, { filename: "bulk-dl-handoff-watch.js" });
  /** 画面が送付完了の合図を送った直後と同じく見張りを付ける（_sendBatchDone の中と同じ） */
  world.pageArmWatch = function (cid, n, why) { pageSandbox.__arm(cid, n, why || "batch_done"); };
  world.pageWatch = function () { return pageSandbox.__cur(); };
  return world;
}

function createSwEnv(world, owner, regions, postAudit, note) {
  var clock = world.clock;
  var listeners = [];
  var env = { owner: owner, dead: false, autoStubs: new Set(), platformPings: 0 };
  var scenario = world.scenario || {};

  function st(fn, ms) { return clock.add(owner, fn, ms, false); }
  function si(fn, ms) { return clock.add(owner, fn, ms, true); }

  var chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener: function (fn) { listeners.push(fn); } },
      sendMessage: function (msg, cb) { note("bg_runtime_send", msg && msg.type); if (cb) Promise.resolve().then(function () { cb(undefined); }); return Promise.resolve(); },
      getPlatformInfo: function (cb) { env.platformPings++; if (cb) Promise.resolve().then(function () { cb({ os: "win" }); }); return Promise.resolve({ os: "win" }); },
    },
    storage: { local: world.local, session: world.session },
    tabs: {
      query: function (q, cb) { var r = [world.tab]; if (cb) Promise.resolve().then(function () { cb(r); }); return Promise.resolve(r); },
      get: function (id, cb) { if (cb) Promise.resolve().then(function () { cb(world.tab); }); return Promise.resolve(world.tab); },
      sendMessage: function (tabId, msg, cb) {
        note("tab_send", msg && msg.type);
        if (cb) Promise.resolve().then(function () { cb({ ok: true }); });
        return Promise.resolve({ ok: true });
      },
    },
    scripting: {
      executeScript: function (o) {
        var f = String(o && o.func);
        if (f.indexOf("__axlxResetPressP") >= 0) {
          world.resetPressCalls++;
          var rmode = (world.currentPage && world.currentPage.reset) || "ok";
          note("reset_press_exec", rmode);
          if (rmode === "nobutton") return Promise.resolve([{ result: { ok: false, why: "no_reset_button" } }]);
          if (rmode === "hang") return new Promise(function () {});
          return new Promise(function (resolve) {
            clock.add("page", function () { resolve([{ result: { ok: true, pressed: true, closed: 1, before: "wards=3" } }]); }, 1500, false);
          });
        }
        if (f.indexOf("__axlxResetVerifyP") >= 0) {
          world.resetVerifyCalls++;
          var vmode = (world.currentPage && world.currentPage.reset) || "ok";
          // 2.8.296 scenario.dirtyStart: 最初のリセットを押すまで画面に前の条件が残っている（一括の最初の客・前客が0件で終わった回の模擬）
          if (scenario && scenario.dirtyStart && world.resetPressCalls === 0) vmode = "notempty";
          note("reset_verify_exec", vmode);
          return new Promise(function (resolve) {
            clock.add("page", function () {
              resolve([{ result: vmode === "notempty" ? { ok: true, empty: false, left: 2, detail: "wards=2" } : { ok: true, empty: true, left: 0, reloaded: true } }]);
            }, 900, false);
          });
        }
        if (f.indexOf("__axlxForceClearAllPlace") >= 0 && world.currentPage && world.currentPage.forceFlagHang) return new Promise(function () {});
        return Promise.resolve([{ result: null }]);
      },
    },
    alarms: { create: function () {}, onAlarm: { addListener: function () {} } },
  };

  var tracker = null;
  var auditSrc = fs.readFileSync(path.join(DIR, "search-audit.js"), "utf8");
  var matchSrc = fs.readFileSync(path.join(DIR, "fill-done-match.js"), "utf8");

  var selfObj = {
    AxlxAutoRun: {
      bulkCustomerGapMs: function () { return scenario.gapMs || 12000; },
      lookAtDocMs: function () { return 3000; },
    },
  };

  var sandbox = {
    console: { log: function () {}, warn: function () {}, error: function () {} },
    chrome: chrome,
    self: selfObj,
    setTimeout: st, clearTimeout: function (id) { clock.clear(id); },
    setInterval: si, clearInterval: function (id) { clock.clear(id); },
    Date: makeDateClass(clock),
    fetch: function (url, opt) {
      (world.fetches = world.fetches || []).push({ t: clock.now(), url: String(url), body: opt && opt.body ? String(opt.body) : "" });
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } });
    },
    SUMORA_BATCH_API: "https://example.invalid",
    _lastSentSkipped: {},
    _sentSkipKey: function (c, s) { return String(c) + (s ? "|" + s : ""); },
    _siteOfSender: function () { return "realnetpro"; },
    _fetchCustomerListWithRetry: function () {
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve((scenario.customers || []).map(function (c) { return Object.assign({ customer_name: c.name }, c); })); } });
    },
    _publishBulkGrasp: function (g) {
      world.publishes.push(g);
      if (scenario.publishHang) return new Promise(function () {});
      return Promise.resolve();
    },
    _auditBegin: function (ctx) {
      var run = tracker.begin({ site: ctx.site, customer_id: ctx.customer_id, trigger: ctx.trigger, mode: "brain_aix", is_wide: ctx.is_wide });
      return Promise.resolve({ runId: run.run_id, trigger: ctx.trigger });
    },
    _auditFinish: function (rid, x) { if (rid) tracker.finish(rid, x || {}); },
    _auditOpenRunId: function (cid, site) { var r = tracker.findOpen(cid != null ? String(cid) : null, site || null); return r ? r.run_id : null; },
    _auditOnBatchDone: function () {},
    _batchAutofill: function (customer) {
      var cid = String(customer.id);
      var idx = world.autofills.length;
      world.autofills.push({ cid: cid, at: clock.now(), sw: owner });
      note("autofill", cid);
      var p = (scenario.page && scenario.page(cid, idx)) || {};
      world.currentPage = p;
      if (scenario.onAutofill) { try { scenario.onAutofill(world, cid, idx); } catch (e) { world.clock.errors.push(e); } }
      if (p.throwOnAutofill) return Promise.reject(new Error(p.throwOnAutofill));
      if (!p.noFillDone) {
        clock.add("page", function () {
          if (world.sw) world.sw.call("_notifyFillDone", "realnetpro", cid, null);
          note("page_fill_done", cid);
        }, p.fillMs || 30000, false);
      }
      clock.add("page", function () {
        note("page_batch_done_sent", cid);
        world.lastDoneCid = cid;
        var n = p.count == null ? 5 : p.count;
        if (p.dropBatchDone) note("batch_done_lost", cid);
        else if (p.resultMismatch) {
          // 2.8.278 結果の見出しが希望と違う → 資料を取らず印を付けて完了合図（bulk-dl.js の _resultVerifyReport と同じ形）
          world.pageSend({ type: "axlx-batch-customer-done", customerId: cid, propertyCount: null, audit: { result_mismatch: p.resultMismatch } });
        }
        else world.pageSend({ type: "axlx-batch-customer-done", customerId: cid, propertyCount: n });
        // 結果が希望と違って止めた合図は見張りを付けない（bulk-dl.js の _resultVerifyReport は _sendBatchDone を通らない）
        if (!p.noPageWatch && !p.resultMismatch) world.pageArmWatch(cid, n, "batch_done");
      }, (p.fillMs || 30000) + (p.batchMs || 60000), false);
      return Promise.resolve({});
    },
  };
  // 2.8.308 止められた裏（env.dead）の古いループは、本物の Chrome では JS ごと消える。模擬では約束（Promise）が生き残って
  //   共有の保存先へ古い位置を書き戻す・二重に入力する、という「模擬だけの」誤りが出ていたので、外への作用を止める
  //   （scenario.zombies: true で従来どおり生かす）
  if (!(scenario && scenario.zombies)) {
    var never = function () { return new Promise(function () {}); };
    var guardFn = function (fn) { return function () { return env.dead ? never() : fn.apply(this, arguments); }; };
    var guardArea = function (area) { return { data: area.data, get: guardFn(area.get), set: guardFn(area.set), remove: guardFn(area.remove) }; };
    chrome.storage = { local: guardArea(world.local), session: guardArea(world.session) };
    Object.keys(chrome.tabs).forEach(function (k) { chrome.tabs[k] = guardFn(chrome.tabs[k]); });
    chrome.scripting.executeScript = guardFn(chrome.scripting.executeScript);
    ["fetch", "_publishBulkGrasp", "_batchAutofill", "_auditBegin"].forEach(function (k) { if (typeof sandbox[k] === "function") sandbox[k] = guardFn(sandbox[k]); });
  }  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(matchSrc, sandbox, { filename: "fill-done-match.js" });
  // fill-done-match.js は self に載せる
  if (!selfObj.AxlxFillDoneMatch && sandbox.AxlxFillDoneMatch) selfObj.AxlxFillDoneMatch = sandbox.AxlxFillDoneMatch;
  vm.runInContext(auditSrc, sandbox, { filename: "search-audit.js" });
  var SA = selfObj.AxlxSearchAudit || sandbox.AxlxSearchAudit;
  tracker = SA.createTracker({ post: postAudit, now: function () { return clock.now(); }, extVersion: "sim" });
  sandbox._auditTracker = tracker;

  var code = [regions.auditStep, regions.pickTab, regions.waiters, regions.loop, regions.scrape, regions.redo, regions.doneListener].join("\n;\n");
  var declared = declaredNames(code);
  var stored = {};
  var auto = new Proxy({}, {
    has: function (_t, name) {
      if (typeof name !== "string" || name.charAt(0) !== "_") return false;
      if (declared.has(name) || Object.prototype.hasOwnProperty.call(sandbox, name)) return false;
      return true;
    },
    get: function (_t, name) {
      if (name === Symbol.unscopables) return undefined;
      if (Object.prototype.hasOwnProperty.call(stored, name)) return stored[name];
      env.autoStubs.add(name);
      return function () { return undefined; };
    },
    set: function (_t, name, v) { stored[name] = v; return true; },
  });
  sandbox.__auto = auto;
  // async function は囲み（with の中）の外へ出ないので、囲みの中で外の名前へ写す
  var fnNames = [];
  var reFn = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, mf;
  while ((mf = reFn.exec(code))) fnNames.push(mf[1]);
  var exportJs = fnNames.map(function (n) { return "globalThis." + n + " = " + n + ";"; }).join("\n");
  vm.runInContext("with (__auto) {\n" + code + "\n;\n" + exportJs + "\n}", sandbox, { filename: "background-regions.js" });

  env.sandbox = sandbox;
  env.tracker = tracker;
  env.deliver = function (msg, sender) {
    return new Promise(function (resolve) {
      var answered = false;
      var respond = function (r) { if (!answered) { answered = true; resolve(r); } };
      var asyncAny = false;
      listeners.forEach(function (fn) {
        try { if (fn(msg, sender || {}, respond) === true) asyncAny = true; } catch (e) { world.clock.errors.push(e); }
      });
      if (!asyncAny) Promise.resolve().then(function () { respond(undefined); });
    });
  };
  env.call = function (name) { var args = Array.prototype.slice.call(arguments, 1); return sandbox[name] ? sandbox[name].apply(null, args) : vm.runInContext(name, sandbox).apply(null, args); };
  env.get = function (expr) { return vm.runInContext(expr, sandbox); };
  return env;
}

module.exports = { createWorld: createWorld, extractRegions: extractRegions, readBg: readBg };
