// 総当たりの1 seed の流れを時刻つきで出す（調査用）: node scripts/_tmp-chaos-seed.js <seed> <reset:0|1>
var sim = require("../tests/chrome-extension/lib/bulk-sim.js");
var seed = Number(process.argv[2]), resetMode = process.argv[3] === "1";
var N = 8;
function rng(s) { s = s >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function customers(n) { var a = []; for (var i = 1; i <= n; i++) a.push({ id: "c" + i, name: "客" + i }); return a; }
var FAULTS = [
  { k: "ok", w: 10, page: {} }, { k: "slow_fill", w: 3, page: { fillMs: 150000 } }, { k: "drop_done", w: 3, page: { dropBatchDone: true } },
  { k: "no_fill_done", w: 2, page: { noFillDone: true } }, { k: "zero_count", w: 2, page: { count: 0 } }, { k: "psc_hang", w: 2, page: { postSendClear: "hang" } },
  { k: "psc_slow", w: 2, page: { postSendClear: "slow" } }, { k: "reset_nobutton", w: 3, page: { reset: "nobutton" } }, { k: "reset_hang", w: 3, page: { reset: "hang" } },
  { k: "reset_notempty", w: 3, page: { reset: "notempty" } }, { k: "sw_kill", w: 4, page: {}, kill: true },
];
function pick(r) { var tot = FAULTS.reduce(function (a, f) { return a + f.w; }, 0), x = r() * tot; for (var i = 0; i < FAULTS.length; i++) { x -= FAULTS[i].w; if (x < 0) return FAULTS[i]; } return FAULTS[0]; }
(async function () {
  var r = rng(seed), plan = {}, killDelay = {};
  customers(N).forEach(function (c) { plan[c.id] = pick(r); });
  customers(N).forEach(function (c) { killDelay[c.id] = Math.floor(r() * 150000); });
  var w = sim.createWorld({ customers: customers(N), resetButton: resetMode, page: function (cid) { return Object.assign({}, plan[cid].page); },
    onAutofill: function (world, cid) { if (plan[cid].kill) world.clock.add("page", function () { world.killSw("chaos:" + cid); }, killDelay[cid], false); } });
  var _os = w.session.set; var _lastH = 0; w.session.set = function (obj, cb) { if (obj && obj.axlx_bulk_queue) { var h = (obj.axlx_bulk_queue.handledCids || []).length; if (h < _lastH || (obj.axlx_bulk_queue.index < (globalThis.__li||0))) { console.log("  !! 退行 @" + Math.round((w.clock.now() - Date.UTC(2026,10,24,1,0,0)) / 1000) + "s handled " + _lastH + "→" + h + " index " + (globalThis.__li||0) + "→" + obj.axlx_bulk_queue.index + " stage=" + obj.axlx_bulk_queue.stage + "\n" + String(new Error().stack).split("\n").slice(2,9).join("\n")); } _lastH = h; globalThis.__li = obj.axlx_bulk_queue.index; } return _os.call(w.session, obj, cb); };
  var sw = w.startSw(); await w.run(10);
  sw.call("_manualBulkRun", { site: "realnetpro", ids: customers(N).map(function (c) { return c.id; }), isWide: false, startIndex: 0, resume: false, why: "popup" });
  for (var _t = 0; _t < 60; _t++) { await w.run(40000); var q = w.session.data.axlx_bulk_queue || {}; var key = q.index + "/" + q.stage + "/" + q.cid + "/h=" + (q.handledCids || []).join("") ; if (key !== globalThis.__lk) { globalThis.__lk = key; console.log("  [queue @" + Math.round((w.clock.now() - Date.UTC(2026,10,24,1,0,0)) / 1000) + "s] " + key + " alive=" + (w.sw ? w.sw.get("_manualBulkAlive") : "-")); } }
  var t0 = w.log.length ? w.log[0].t : 0;
  console.log("計画:", customers(N).map(function (c) { return c.id + "=" + plan[c.id].k; }).join(" "));
  w.log.filter(function (l) { return /autofill|sw_kill|sw_start|page_batch_done_sent|batch_done_lost|post_send_clear_exec|reset_press_exec/.test(l.kind); })
    .forEach(function (l) { console.log("  +" + String(Math.round((l.t - t0) / 1000)).padStart(5) + "s " + l.kind + " " + (l.d || "")); });
  w.db.forEach(function (v, k) { console.log("  run", k.slice(0, 6), v.cid, v.status, (v.steps || []).map(function (s) { return s.k; }).filter(function (k) { return /bulk_kick|kick_clamp|autofill_dead|sw_restart|finish|reset_/.test(k); }).join(",")); });
})();


