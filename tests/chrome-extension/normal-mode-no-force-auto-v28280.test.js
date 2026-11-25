/**
 * 2.8.280 竹内さん「通常モードでも並べ替えのADが勝手になってしまっている」
 *   原因: _forceAutoForPending が、検索後の印（自動入力が検索直前に書く）だけで
 *         通常モードでも「この一覧だけ自動ON」にしていた → 並べ替え AD → 印刷用PDF押し。
 *   直し: モードを読み終えて「自動でない」なら強制しない。
 * bulk-dl.js から実物の関数を切り出して vm で動かす。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..", "..", "chrome-extension");
const bulk = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
const man = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++; else { fail++; console.log("NG: " + msg); }
}
function semverOk(v, min) {
  const a = String(v).split(".").map(Number), b = String(min).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) > (b[i] || 0)) return true; if ((a[i] || 0) < (b[i] || 0)) return false; }
  return true;
}
ok(semverOk(man.version, "2.8.280"), "manifest >= 2.8.280 got " + man.version);

function slice(startMarker, endMarker) {
  const s = bulk.indexOf(startMarker);
  if (s < 0) throw new Error("not found: " + startMarker);
  const e = bulk.indexOf(endMarker, s);
  if (e < 0) throw new Error("end not found: " + endMarker);
  return bulk.slice(s, e);
}

// 実物: _readAutoMode 〜 _applyAutoMode と _hasSearchPendingSync / _forceAutoForPending
const readApply = slice("function _readAutoMode(st)", "chrome.storage.local.get([\"guideMode\"");
const _p0 = bulk.indexOf("function _hasSearchPendingSync()");
const _p1 = bulk.lastIndexOf("/**", bulk.indexOf("★ 2026-11-22 2.8.191", _p0));
const pendingFns = bulk.slice(_p0, _p1);
ok(pendingFns.includes("function _forceAutoForPending"), "切り出し: _forceAutoForPending を含む");

function makeWorld(opts) {
  const steps = [];
  const store = {};
  if (opts.pending) store.axlx_pending_auto_send_sync = JSON.stringify({ ts: Date.now(), customerId: "c1" });
  const ctx = {
    console: { log() {}, warn() {} },
    Date, JSON,
    sessionStorage: { getItem: (k) => (k in store ? store[k] : null), setItem() {}, removeItem() {} },
    chrome: { storage: { local: { get() {} }, session: { remove() {}, set() {} } } },
    setTimeout: () => 0,
    _maybeAutoPressOnLoad() {},
    _liveDlStep: (k, d) => steps.push(k + ":" + d),
    _autoSendArmed: !!opts.armed,
  };
  vm.createContext(ctx);
  vm.runInContext(
    "var _guideOff=false,_autoModeOn=false,_modeLoaded=false,_autoForceDeniedLogged=false,_GUIDE_ONLY=true,_AUTO_STAFF_TTL=7200000;\n"
      + readApply + "\n" + pendingFns + "\n"
      + "this.apply=_applyAutoMode; this.force=_forceAutoForPending; this.state=function(){return {on:_autoModeOn,off:_guideOff,loaded:_modeLoaded};};",
    ctx,
  );
  return { ctx, steps };
}

// 1) 通常モード（読み込み済み）＋検索後の印あり → 強制しない（本件の再現）
{
  const w = makeWorld({ pending: true, armed: true });
  w.ctx.apply({});                       // 何も選んでいない＝通常
  ok(w.ctx.state().loaded === true && w.ctx.state().on === false, "通常: 読み込み済み・自動OFF");
  const r = w.ctx.force("sort_cursor");
  ok(r === false, "通常: 強制しない（戻り値 false）");
  ok(w.ctx.state().on === false, "通常: _autoModeOn は false のまま → 並べ替えへ行かない");
  w.ctx.force("estate_stuck"); w.ctx.force("case_c_sync");
  ok(w.steps.filter((s) => s.startsWith("auto_force_denied")).length === 1, "通常: 点検に auto_force_denied を1回だけ残す");
  ok(!w.steps.some((s) => s.startsWith("auto_force:")), "通常: auto_force は出ない");
}

// 2) 切れたスタッフ（TTL超過）も通常と同じ
{
  const w = makeWorld({ pending: true });
  w.ctx.apply({ staffMode: true, staffModeAt: Date.now() - 3 * 3600 * 1000 });
  ok(w.ctx.force("page_displayed") === false && w.ctx.state().on === false, "切れたスタッフ: 強制しない");
}

// 3) 自動モード（aix＋選んだ印）は元から ON
{
  const w = makeWorld({ pending: true });
  w.ctx.apply({ aixMode: true, autoModeAt: Date.now() });
  ok(w.ctx.state().on === true, "自動: ON");
  ok(w.ctx.force("x") === false && w.ctx.state().on === true, "自動: そのまま ON（変わらない）");
}

// 4) 有効なスタッフ・AIX(ai) も ON
{
  const w1 = makeWorld({ pending: true });
  w1.ctx.apply({ staffMode: true, staffModeAt: Date.now() });
  ok(w1.ctx.state().on === true, "スタッフ: ON");
  const w2 = makeWorld({ pending: true });
  w2.ctx.apply({ aiMode: true, autoModeAt: Date.now() });
  ok(w2.ctx.state().on === true, "AIX: ON");
}

// 5) モードの読み込み前（一瞬）は従来どおり強制できる／読み終えたら正しい値に戻る
{
  const w = makeWorld({ pending: true });
  ok(w.ctx.state().loaded === false, "読み込み前: loaded=false");
  ok(w.ctx.force("early") === true && w.ctx.state().on === true, "読み込み前: 従来どおり強制ON（止まらない）");
  w.ctx.apply({});                        // 読み終えたら通常に戻る
  ok(w.ctx.state().on === false, "読み込み後: 通常なら OFF に戻る");
}

// 6) 印も armed も無ければ強制しない（読み込み前でも）
{
  const w = makeWorld({ pending: false, armed: false });
  ok(w.ctx.force("none") === false && w.ctx.state().on === false, "印なし: 強制しない");
}

// 7) 見回りも通常モードでは待ち仕事なし扱い
ok(/if \(_modeLoaded && !_autoModeOn\) _pendWork = false;/.test(bulk), "estate_stuck: 通常モードは見回さない");
// 8) 並べ替えの入口は _autoModeOn を見ている（強制が唯一の抜け道だった）
ok(/_forceAutoForPending\(why \|\| "sort_cursor"\);\s*\n\s*if \(!_autoModeOn\) return false;/.test(bulk), "sort_cursor: 強制の直後に _autoModeOn を見る");

console.log("normal-mode-no-force-auto-v28280: " + pass + " pass, " + fail + " fail");
if (fail) process.exit(1);
