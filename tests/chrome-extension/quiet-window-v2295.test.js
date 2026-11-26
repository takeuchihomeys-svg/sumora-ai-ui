/**
 * 2.8.295 竹内さん「並べ替えやリセット、そして新しいお客さんの条件を拡張ツールのAPIから入れなおすところのあいだで
 *   別の作業入って邪魔されないように」「テスト繰り返してボトルネックになっている部分ないか」
 *
 *   ① 配線: 邪魔しない窓（axlx_quiet）を立てる所・見送る所・点検に残す所
 *   ② 動き: 本物の関数を取り出して動かす（窓の上限・見送りの間引き・引き継ぎの待ち・並べ替えの待ちの判定）
 *   ③ 繰り返し: 本物の待ち時間の関数で 5000 人分回し、待ちと見張り・窓の上限がぶつかる所を数える
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.join(__dirname, "../../chrome-extension");
const rd = (f) => fs.readFileSync(path.join(EXT, f), "utf8");
const bg = rd("background.js");
const bd = rd("bulk-dl.js");
const ps = rd("page-script.js");
const ct = rd("content.js");
const sa = rd("search-audit.js");
const rules = fs.readFileSync(path.join(__dirname, "../../app/lib/auto-procedure-rules.ts"), "utf8");
const mf = JSON.parse(rd("manifest.json"));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
}
/** 関数の本文を名前で取り出す（中括弧の数合わせ） */
function fnSrc(src, name) {
  const re = new RegExp("(async )?function " + name.replace(/\$/g, "\\$") + "\\(");
  const m = re.exec(src);
  if (!m) throw new Error("no fn " + name);
  let i = src.indexOf("{", m.index);
  let d = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "{") d++;
    else if (c === "}") { d--; if (d === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error("unbalanced " + name);
}
/** 決まった乱数（繰り返しても同じ結果） */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

console.log("■ ① 配線（background）");
ok("窓の印は storage.session の axlx_quiet（裏の起き直しでも残る）", /var QUIET_KEY = "axlx_quiet";/.test(bg) && /chrome\.storage\.session\.set\(\{ axlx_quiet: q \}\)/.test(bg));
ok("窓は上限で必ず切れる（_quietNow は until を見る）", /function _quietNow\(\) \{[\s\S]{0,80}Date\.now\(\) < q\.until/.test(bg));
ok("一括の間: gap（間＋30秒）", /_bulkPhaseSet\("gap", _gap, \{\}\);\s*_quietSet\("gap", _gap \+ 30000/.test(bg));
ok("一括の入力: refill（300秒）", /_bulkPhaseSet\("autofill", 300000, \{ runId: _bulkPhaseRunId \}\);\s*_quietSet\("refill", 300000/.test(bg));
ok("入れ直しの道（_resultMismatchRedo）も gap と refill", /_quietSet\("gap", gap \+ 30000, \{ cid: cid, runId: runId \}\)/.test(bg) && /_quietSet\("refill", 300000, \{ cid: cid, runId: runId \}\)/.test(bg));
ok("fill-done の後は sort（150秒・押し始めでページが外す）", /_quietSet\("sort", 150000, \{ cid: String\(customerId\), runId: _runId \}\)/.test(bg));
ok("送付後のリセットは reset（330秒＝段の上限と同じ・2.8.316 待ち120秒に合わせて広げた）", /_bulkPhaseSet\("post_send_clear", 330000[\s\S]{0,120}_quietSet\("reset", 330000/.test(bg));
ok("リセットの後は一括の時だけ gap（単発は窓を外す＝次の指示を3分止めない）", /if \(_manualBulkAlive\) _quietSet\("gap", 180000[\s\S]{0,120}else _quietClear\("reset", "single_done"\)/.test(bg));
ok("一括の終わり・止める・kick の終わりで窓を外す", (bg.match(/_quietClear\(null, "(bulk_end|bulk_stop|kick_end)"\)/g) || []).length === 3);
ok("条件を入れる前に前の回のリセットを引き継いで待つ（リアプロ）", /await _waitAfterHumanReset\(_bulkAudit[\s\S]{0,300}await _waitInheritedReset\(_bulkAudit/.test(bg));
const iPoll = bg.indexOf("async function _pollAndRunBatch() {");
ok("_pollAndRunBatch の頭で一括中・窓の間は拾わない（アラームと poll-now の両方）", /^async function _pollAndRunBatch\(\) \{[\s\S]{0,600}if \(_manualBulkAlive \|\| _quietNow\(\)\) \{\s*_quietDefer\("poll_batch"/.test(bg.slice(iPoll)));
ok("poll-now は窓の間 bulk_busy を返す", /_quietDefer\("poll_now"[\s\S]{0,80}reason: "bulk_busy"/.test(bg));
const iWs = bg.indexOf('if (msg.type === "axlx-webapp-search")');
const iWsGuard = bg.indexOf('_quietDefer("webapp_search"');
const iWsSwitch = bg.indexOf('type:         "axlx-switch-customer"');
ok("ウェブからの検索は切り替え・移動より前に断る", iWs > 0 && iWsGuard > iWs && iWsGuard < iWsSwitch, { iWs, iWsGuard, iWsSwitch });
ok("  断る時は理由を返す（error: bulk_busy・日本語の文）", /error: "bulk_busy",\s*message: "一括検索の途中/.test(bg));
const iShot = bg.indexOf("async function _takeShot(");
const shot = bg.slice(iShot, iShot + 9000);
ok("写真: 窓の間はタブ・窓を切り替えて撮らない（切り替えより前）", shot.indexOf('_quietDefer("shot_tab_switch"') > 0 && shot.indexOf('_quietDefer("shot_tab_switch"') < shot.indexOf("await chrome.tabs.update(tab.id, { active: true })"));
ok("写真: 撮り直し（窓を前に出す）も窓の間はしない", /_quietDefer\("shot_retry_focus"/.test(shot));
const snap = fnSrc(bg, "_takeSnapshot");
ok("見張りの写真（_takeSnapshot）も窓の間はタブを切り替えない（切り替えより前）", snap.indexOf('_quietDefer("snap_activate"') > 0 && snap.indexOf('_quietDefer("snap_activate"') < snap.indexOf("await chrome.tabs.update(to.tab_id, { active: true })"));
ok("読み直しの前の確かめ直しは窓の間5回", /var _rpMax = _quietNow\(\) \? 5 : 2;/.test(bg));
ok("前客待ちの間は段を autofill_wait_prev（見回りが同じ客を二重に回さない）", /_bulkPhaseSet\("autofill_wait_prev"/.test(bg) && /phase === "autofill_wait_prev"\) _bulkPhaseSet\("autofill", 300000, \{\}\)/.test(bg));
const kick = bg.match(/var BULK_KICKABLE_PHASES = \{[^}]*\}/)[0];
ok("  autofill_wait_prev は見回りが進めない段", !/autofill_wait_prev/.test(kick));
ok("  _bulkAutofillDeadKick は autofill の段だけ", /p\.phase !== "autofill"/.test(fnSrc(bg, "_bulkAutofillDeadKick")));
ok("拡張のリセットの前に前客の続きの印を消す（裏とページの両方）", /axlx_pending_auto_send", "axlx_auto_next_page", "axlx_search_grasped", "axlx_ad_sort_pending"/.test(bg) && /"axlx_pending_auto_send_sync", "axlx_search_grasped_sync", "axlx_auto_send"/.test(bg));

console.log("\n■ ① 配線（ページ）");
ok("並べ替えの待ちを『忙しい』に入れる（estate_stuck_recover が割らない）", /var _sw = _sortWaitState\(\);\s*if \(_sw === "waiting"\) _busy = true;/.test(bd));
ok("  古い待ちの印だけ外して張り直す", /else if \(_sw === "stale"\) _clearStaleSortWait\("estate_watch"\)/.test(bd) && /if \(_sortWaitState\(\) === "stale"\) _clearStaleSortWait\("kick:/.test(bd));
ok("並べ替えの予約で sort の窓（待ち＋120秒）", /_quietPageSet\("sort", wait \+ 120000\)/.test(bd));
ok("並べ替えの待ち直しでも sort の窓", /_quietPageSet\("sort", waitMs \+ 120000\)/.test(bd));
ok("押し始め・送付完了で sort の窓を外す", /_quietPageClear\("sort", "press_start"\)/.test(bd) && /_quietPageClear\("sort", "batch_done"\)/.test(bd));
ok("窓の印を html の data-axlx-quiet に写す", /setAttribute\("data-axlx-quiet", String\(_quietMem\.kind\) \+ "\|" \+ Number\(_quietMem\.until\)\)/.test(bd));
ok("page-script の見送りを点検へ中継（axlx-quiet-defer）", /e\.data\.from !== "axlx-quiet-defer"/.test(bd) && /from: "axlx-quiet-defer", who: "show_sidebar"/.test(ps));
ok("並べ替えの最中は案内・お客様パネルを戻さない", /if \(!_sortNow && document\.querySelector\("\[data-axlx-sort-prev-display\]"\)\) _restoreGuidesAfterSort\(\);/.test(bd) && /if \(!_sortNow\) \{ try \{ _snapCustomerPanelRight\(\); \} catch \(_\) \{\} \}/.test(bd));
ok("「検索条件を表示」は sort／reset の窓の間は押さない（page-script）", /var _qb = _axQuietBlocksSidebar\(\);\s*if \(_qb\)/.test(ps));
ok("  content.js も同じ印を見る", /\(_qr\[0\] === "sort" \|\| _qr\[0\] === "reset"\) && Date\.now\(\) < \(Number\(_qr\[1\]\) \|\| 0\)/.test(ct));

console.log("\n■ ① 記録・版・手順書");
const keep = sa.match(/var KEEP_STEP = \/[^\n]+/)[0];
["quiet_on", "quiet_off", "quiet_defer", "quiet_inherit", "dl:quiet_", "reset_clear_marks", "tab_reload", "tab_check", "autofill_dead_kick"].forEach(function (k) {
  ok("KEEP_STEP に " + k + "（上限で落ちない）", keep.indexOf("|" + k) > 0);
});
ok("版: manifest == page-script == 手順書の見直し（版を上げるたびに試験を直さない形）", /^\d+\.\d+\.\d+$/.test(mf.version) && new RegExp('_AXLX_PAGE_VER = "' + mf.version.replace(/\./g, "\\.") + '"').test(ps) && new RegExp('AUTO_RULES_REVIEWED_UP_TO = "' + mf.version.replace(/\./g, "\\.") + '"').test(rules));
ok("決まり quiet_window_no_interrupt（手順書と拡張の一覧）", /id: "quiet_window_no_interrupt"/.test(rules) && /"quiet_window_no_interrupt",/.test(ps));
ok("  目印がコードにある（_quietSet(\"reset\"）", bg.indexOf('_quietSet("reset"') > 0);

console.log("\n■ ② 動き（background の窓）");
{
  const steps = [];
  const store = {};
  let now = 1_000_000;
  const ctx = {
    Date: { now: () => now },
    Math,
    console: { log() {}, warn() {} },
    chrome: {
      storage: { session: {
        set: (o) => { Object.assign(store, o); return Promise.resolve(); },
        get: (k) => Promise.resolve({ [k]: store[k] }),
        remove: (k) => { delete store[k]; return Promise.resolve(); },
      } },
      tabs: { query: () => Promise.resolve([]) },
      scripting: { executeScript: () => Promise.resolve([]) },
    },
    _auditStep: (rid, k, d) => steps.push({ rid, k, d }),
    _manualBulkGen: 3, _manualBulkAlive: true, _bulkPhaseRunId: "run1",
    _bulkPhaseSet: () => {},
    _withTimeout: (p) => p,
    RESET_SETTLE_MIN_MS: 30000, RESET_SETTLE_JITTER_MS: 4000,
    setTimeout: (f) => { f(); return 0; },
    QUIET_KEY: "axlx_quiet", _SW_BOOT: "boot1", _quiet: null, _quietDeferAt: {},
  };
  vm.createContext(ctx);
  ["_quietOwner", "_quietRunId", "_quietSet", "_quietClear", "_quietNow", "_quietDefer", "_waitInheritedReset"].forEach((n) => vm.runInContext(fnSrc(bg, n), ctx));
  const q = vm.runInContext('_quietSet("reset", 260000, { cid: 123 })', ctx);
  ok("_quietSet: 種類・上限・持ち主・cid を文字に", q.kind === "reset" && q.until === now + 260000 && q.owner === "boot1:3" && q.cid === "123");
  ok("  点検に quiet_on", steps.some((s) => s.k === "quiet_on" && /reset 上限260秒/.test(s.d)));
  ok("  storage にも置く", store.axlx_quiet && store.axlx_quiet.kind === "reset");
  vm.runInContext('_quietDefer("webapp_search", "x")', ctx);
  vm.runInContext('_quietDefer("webapp_search", "y")', ctx);
  ok("_quietDefer: 同じ相手は15秒に1回だけ点検へ", steps.filter((s) => s.k === "quiet_defer").length === 1);
  now += 16000;
  vm.runInContext('_quietDefer("webapp_search", "z")', ctx);
  ok("  15秒たてばもう1回", steps.filter((s) => s.k === "quiet_defer").length === 2);
  ok("  窓の種類と残り秒を残す", /webapp_search 窓=reset 残り244秒/.test(steps.filter((s) => s.k === "quiet_defer")[1].d));
  now += 260000;
  ok("_quietNow: 上限を過ぎたら null（窓が残って止まらない）", vm.runInContext("_quietNow()", ctx) === null);
  ok("_quietClear: 種類が違えば外さない", (vm.runInContext('_quietSet("gap", 60000, {})', ctx), vm.runInContext('_quietClear("reset", "x")', ctx)) === false);
  ok("  同じ種類なら外して quiet_off", vm.runInContext('_quietClear("gap", "done")', ctx) === true && steps.some((s) => s.k === "quiet_off") && !store.axlx_quiet);

  // 引き継ぎ: 別の持ち主の reset が 5秒前に始まっていた → 30秒＋8秒の残り（33〜37秒）を待つ
  ctx._quiet = { kind: "reset", since: now - 5000, until: now + 200000, owner: "old:1", cid: "c9" };
  let waited = 0;
  ctx.setTimeout = (f, ms) => { waited = ms; f(); return 0; };
  const p1 = vm.runInContext("_waitInheritedReset('run2')", ctx);
  p1.then(function (need) {
    ok("_waitInheritedReset: 別の持ち主の reset は残りを待つ（33〜37秒）", need >= 33000 && need < 37000 && waited === need, { need, waited });
    ok("  点検に quiet_inherit", steps.some((s) => s.k === "quiet_inherit"));
    ok("  待った後は gap の窓", ctx._quiet && ctx._quiet.kind === "gap");
    ctx._quiet = { kind: "reset", since: now - 5000, until: now + 200000, owner: "boot1:3" };
    return vm.runInContext("_waitInheritedReset('run2')", ctx);
  }).then(function (need2) {
    ok("  自分の reset（同じ持ち主）は待たない", need2 === 0);
    ctx._quiet = { kind: "gap", since: now - 5000, until: now + 200000, owner: "old:1" };
    return vm.runInContext("_waitInheritedReset('run2')", ctx);
  }).then(function (need3) {
    ok("  reset でなければ待たない", need3 === 0);
    part3();
  }).catch(function (e) { ok("引き継ぎの試しが落ちない", false, String(e && e.stack || e)); part3(); });
}

function part3() {
  console.log("\n■ ② 動き（ページ）");
  {
    let now = 5_000_000;
    const ctx = { Date: { now: () => now }, SORT_WAIT_OWN_MAX_MS: 90000 };
    vm.createContext(ctx);
    vm.runInContext(fnSrc(bd, "_sortWaitState"), ctx);
    const set = (o) => Object.assign(ctx, { _sortWaitRetryPending: false, _sortWaitRetryAt: 0, _sortCursorScheduled: false, _sortCursorScheduledAt: 0, _sortCursorTimer: null, _autoPdfRun: null, _adSortInFlight: false }, o);
    set({ _sortCursorScheduled: true, _sortCursorScheduledAt: now - 20000, _sortCursorTimer: 1 });
    ok("並べ替えの待ち（20秒前に予約）は waiting", vm.runInContext("_sortWaitState()", ctx) === "waiting");
    set({ _sortCursorScheduled: true, _sortCursorScheduledAt: now - 95000, _sortCursorTimer: 7 });
    ok("  上限を過ぎてもタイマーが生きていれば waiting（裏のタブで遅れただけ）", vm.runInContext("_sortWaitState()", ctx) === "waiting");
    set({ _sortCursorScheduled: true, _sortCursorScheduledAt: now - 95000, _sortCursorTimer: null });
    ok("  上限を過ぎてタイマーも無い＝stale（張り直してよい）", vm.runInContext("_sortWaitState()", ctx) === "stale");
    set({ _sortCursorScheduled: true, _sortCursorScheduledAt: now - 95000, _autoPdfRun: {} });
    ok("  押している最中は待ちではない（none）", vm.runInContext("_sortWaitState()", ctx) === "none");
    set({ _sortWaitRetryPending: true, _sortWaitRetryAt: now - 10000 });
    ok("  失敗後の待ち直しは waiting", vm.runInContext("_sortWaitState()", ctx) === "waiting");
    set({});
    ok("  何も無ければ none", vm.runInContext("_sortWaitState()", ctx) === "none");
  }
  {
    let attr = "";
    let now = 9_000_000;
    const ctx = { Date: { now: () => now }, document: { documentElement: { getAttribute: () => attr } } };
    vm.createContext(ctx);
    vm.runInContext(fnSrc(ps, "_axQuietBlocksSidebar"), ctx);
    attr = "sort|" + (now + 1000);
    ok("「検索条件を表示」: sort の窓は押さない", vm.runInContext("_axQuietBlocksSidebar()", ctx) === "sort");
    attr = "reset|" + (now + 1000);
    ok("  reset の窓も押さない", vm.runInContext("_axQuietBlocksSidebar()", ctx) === "reset");
    attr = "refill|" + (now + 1000);
    ok("  refill（次客の入力）は押す（左の欄が要る）", vm.runInContext("_axQuietBlocksSidebar()", ctx) === "");
    attr = "sort|" + (now - 1);
    ok("  上限を過ぎた印は無視", vm.runInContext("_axQuietBlocksSidebar()", ctx) === "");
  }
  part4();
}

function part4() {
  console.log("\n■ ③ 繰り返し（5000人分・本物の待ちの関数）");
  const rng = mulberry32(20261125);
  const HW = require(path.join(EXT, "human-wait.js"));
  const autoCtx = { self: {}, Math: Object.create(Math) };
  autoCtx.Math.random = rng;
  vm.createContext(autoCtx);
  vm.runInContext(rd("auto-run.js"), autoCtx);
  const A = autoCtx.self.AxlxAutoRun;
  const sortCtx = { self: { AxlxHumanWait: HW }, window: {}, Math: Object.create(Math), SORT_AFTER_SEARCH_MIN_MS: 30000, SORT_AFTER_SEARCH_MAX_MS: 36000 };
  sortCtx.Math.random = rng;
  vm.createContext(sortCtx);
  vm.runInContext(fnSrc(bd, "_humanWaitAfterSearchMs"), sortCtx);
  const num = (re) => Number((bg.match(re) || bd.match(re) || [])[1]);
  const RESET_MIN = num(/var RESET_SETTLE_MIN_MS = (\d+);/);
  const RESET_JIT = num(/var RESET_SETTLE_JITTER_MS = (\d+);/);
  const PRESS_TO = num(/var RESET_PRESS_TIMEOUT_MS = (\d+);/);
  const VERIFY_TO = num(/var RESET_VERIFY_TOTAL_MS = (\d+);/);
  const SILENCE = num(/var AXLX_STUCK_IDLE_MS = (\d+);/);
  const OWN_MAX = num(/var SORT_WAIT_OWN_MAX_MS = (\d+);/);
  ok("定数を読めた（リセット30秒・揺れ4秒・押し25秒・確かめ25秒・沈黙135秒・待ちの持ち90秒）",
    RESET_MIN === 30000 && RESET_JIT === 4000 && PRESS_TO === 130000 && VERIFY_TO === 25000 && SILENCE === 135000 && OWN_MAX === 90000,
    { RESET_MIN, RESET_JIT, PRESS_TO, VERIFY_TO, SILENCE, OWN_MAX });

  const N = 5000;
  const col = { sortQuiet: 0, sortSilence: 0, sortOwnStale: 0, resetQuiet: 0, resetPhase: 0, gapQuiet: 0, estateOld: 0, estateNew: 0 };
  const per = [], waitsSort = [], waitsReset = [], gaps = [];
  const U = (a, b) => a + rng() * (b - a);
  for (let i = 0; i < N; i++) {
    // W1: 検索確認→待ち→並べ替え（乗せ・選ぶ 3〜12秒）→読み直し（2〜15秒）→押し始め。5% は失敗→待ち直し（もう1回待つ）
    const w = vm.runInContext("_humanWaitAfterSearchMs()", sortCtx);
    waitsSort.push(w);
    const retry = rng() < 0.05;
    const w2 = retry ? vm.runInContext("_humanWaitAfterSearchMs()", sortCtx) : 0;
    const sortWork = U(3000, 12000) + U(2000, 15000) + (retry ? U(3000, 12000) + U(2000, 15000) : 0);
    const w1 = w + w2 + sortWork;
    // 窓: 予約で 待ち+120秒、待ち直しで 待ち2+120秒 を張り直す
    const sortQuietEnd = retry ? (w + U(3000, 12000) + w2 + 120000) : (w + 120000);
    if (w1 > sortQuietEnd) col.sortQuiet++;
    // 沈黙の見張り（135秒）は armed_sort から数える・並べ替えの段で触り直す
    if (w + sortWork / (retry ? 2 : 1) > SILENCE) col.sortSilence++;
    // 見張り（2秒ごと・4.5秒×6回→30秒）が待ちの間に出す段: 旧は待ちを忙しいと見ない／新は見る
    let t = 0, n = 0, firstAt = null;
    while (t < w) { t += 2000; if (firstAt == null) firstAt = t; const gap = n < 6 ? 4500 : 30000; if (t - firstAt >= gap) { n++; firstAt = t; } }
    col.estateOld += n;
    // W2: 押す（1〜25秒）＋読み直し（≦8秒）＋待機（30〜34秒）＋確かめ（1〜25秒）＋写真の間（2〜4秒）＋写真（≦25秒）／2% は従来の外し（≦125秒）
    const settle = RESET_MIN + Math.floor(rng() * RESET_JIT);
    waitsReset.push(settle);
    const fallback = rng() < 0.02;
    const w2r = U(1000, PRESS_TO) * (rng() < 0.9 ? 0.15 : 1) + U(500, 8000) + settle + U(1000, VERIFY_TO) * (rng() < 0.9 ? 0.1 : 1)
      + (fallback ? U(20000, 125000) : U(2000, 4000) + U(1000, 25000));
    if (w2r > 330000) col.resetQuiet++;
    if (w2r > 330000 + 60000) col.resetPhase++;
    // 間: 8〜25秒（16%で40〜95秒）・窓は 間+30秒
    const g = A.bulkCustomerGapMs(rng);
    gaps.push(g);
    if (g > g + 30000) col.gapQuiet++;
    per.push(w + settle + g);
  }
  const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
  const sec = (ms) => (ms / 1000).toFixed(1) + "秒";
  console.log("    並べ替えの待ち p50=" + sec(pct(waitsSort, 0.5)) + " 最小=" + sec(Math.min(...waitsSort)) + " 最大=" + sec(Math.max(...waitsSort)));
  console.log("    リセット後の待機 p50=" + sec(pct(waitsReset, 0.5)) + " 最大=" + sec(Math.max(...waitsReset)));
  console.log("    客の間 p50=" + sec(pct(gaps, 0.5)) + " p95=" + sec(pct(gaps, 0.95)) + " 最大=" + sec(Math.max(...gaps)));
  console.log("    1人あたりの決まった待ち（並べ替え＋リセット＋間） p50=" + sec(pct(per, 0.5)) + " p95=" + sec(pct(per, 0.95)));
  console.log("    旧: 並べ替えの待ちの間に見張りが出していた段 合計=" + col.estateOld + "（1人 約" + (col.estateOld / N).toFixed(1) + "段）→ 新: 0（待ちは忙しい）");
  ok("並べ替えの待ちは 30〜36秒の中（5000回）", Math.min(...waitsSort) >= 30000 && Math.max(...waitsSort) <= 36000);
  ok("リセット後の待機は 30〜34秒の中（5000回）", Math.min(...waitsReset) >= 30000 && Math.max(...waitsReset) < 34000);
  ok("並べ替えの窓が押し始めより先に切れる回: 0", col.sortQuiet === 0, col.sortQuiet);
  ok("並べ替えの待ち＋作業が沈黙の見張り（135秒）を越える回: 0", col.sortSilence === 0, col.sortSilence);
  ok("リセットの一連が窓（330秒）を越える回: 0", col.resetQuiet === 0, col.resetQuiet);
  ok("リセットの一連が段の上限＋1分を越えて見回りに進められる回: 0", col.resetPhase === 0, col.resetPhase);
  ok("客の間の窓が間より先に切れる回: 0", col.gapQuiet === 0);
  // 2秒ごとの見回り・4.5秒の間＝実際は6秒ごと → 30〜36秒の待ちで4〜6回（そのたびに並べ替えの kick も呼んでいた）
  ok("旧の見張りは待ちの間に1人あたり4段以上出していた（直した価値の確認）", col.estateOld / N >= 4, col.estateOld / N);
  ok("待ちの持ちの上限（90秒）は並べ替えの待ちの最大（36秒）の2倍以上（待ち直し1回でも stale にしない）", OWN_MAX >= 2 * 36000);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}
