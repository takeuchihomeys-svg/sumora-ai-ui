// 実行: node tests/chrome-extension/reflect-pipeline-v28312.test.js
// 2026-11-27: サイト分離・CDN版バイパス・監査SW復元耐性・両サイト配管整合・JS構文チェック
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail === undefined ? "" : " :: " + JSON.stringify(detail))); }
}

const ROOT = path.join(__dirname, "../..");
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

console.log("■ 1. learn-refresh-gate: サイト別投影・ITANDIルール欠検知・版パラメータURL");
{
  const src = read("chrome-extension/learn-refresh-gate.js");
  const ctx = { window: {}, self: {} };
  ctx.window = ctx; ctx.self = ctx;
  vm.runInNewContext(src, ctx);
  const G = ctx.self.AxlxLearnRefreshGate;

  // axlx_learn_for_site="itandi" の共有状態で realpro 投影を呼んでも __realpro 専用キーを優先して返す
  const mixedStorage = {
    axlx_learn_for_site: "itandi",
    axlx_learn_playbook: { rules: [], scenes: [{ name: "itandi_scene" }] },
    axlx_learn_playbook__realpro: { rules: [{ id: "r1" }], scenes: [{ name: "rp_scene" }], build_v: 7, flow_series: [1, 2, 3, 4, 5] },
    axlx_learn_screen: { it: { n: 1 } },
    axlx_learn_screen__realpro: { "左の検索": { n: 4 } },
    axlx_learn_needs_auto: true,
    axlx_learn_needs_auto__realpro: false,
  };
  const rpView = G.projectLearnStorageForSite(mixedStorage, "realpro");
  ok("projectLearnStorageForSite(realpro): __realpro 専用キーが勝つ（他サイト共有の混入・偽needs_autoを受けない）",
    rpView.axlx_learn_playbook.scenes[0].name === "rp_scene" && rpView.axlx_learn_needs_auto === false && !!rpView.axlx_learn_screen["左の検索"],
    rpView);

  // 逆に __itandi がまだ無いのに axlx_learn_for_site="realpro" の共有がある時は itandi にリアルプロ共有を渡さない
  const rpOnlyStorage = {
    axlx_learn_for_site: "realpro",
    axlx_learn_playbook: { rules: [{ id: "r1" }], scenes: [{ name: "rp_scene" }] },
    axlx_learn_needs_auto: false,
  };
  const itView = G.projectLearnStorageForSite(rpOnlyStorage, "itandi");
  ok("projectLearnStorageForSite(itandi): __itandi未保存かつ共有がrealproの時は共有フォールバックしない",
    itView.axlx_learn_playbook === undefined && !Object.prototype.hasOwnProperty.call(itView, "axlx_learn_playbook"),
    itView);

  // shouldForceLearnRefresh は itandi で pb.rules 空の時に強制更新する
  const itNeed = G.shouldForceLearnRefresh({
    axlx_learn_for_site: "itandi",
    axlx_learn_playbook__itandi: { build_v: 7, flow_series: [1, 2, 3, 4, 5], rules: [] },
    axlx_learn_screen__itandi: { "検索": { n: 3 } },
  }, 1000, { site: "itandi" });
  ok("shouldForceLearnRefresh(itandi): rules 空のとき強制リフレッシュが true", itNeed.force === true, itNeed);

  // buildBundleFetchUrl が scope と v を付与する
  const url = G.buildBundleFetchUrl("https://example.com", "itandi", { bundle_v: "2026-11-27_v123" });
  const url2 = G.buildBundleFetchUrl("https://example.com/api/human-learn-profile?scope=old", "itandi", { generated_at: "2026-11-27T01:02:03Z", playbook_rules_v: "abc", server_build_v: 19 });
  ok("buildBundleFetchUrl が scope と &v= 版クエリを正しく組み立てる",
    url === "https://example.com/api/human-learn-profile?scope=itandi&v=2026-11-27_v123"
    && url2 === "https://example.com/api/human-learn-profile?scope=itandi&v=2026-11-27T01%3A02%3A03Z_abc_19",
    { url, url2 });
}

console.log("\n■ 2. search-audit.js: adopt 復元フラグ & listOpen");
{
  const src = read("chrome-extension/search-audit.js");
  const ctx = { window: {}, self: {} };
  ctx.window = ctx; ctx.self = ctx;
  vm.runInNewContext(src, ctx);
  const SA = ctx.self.AxlxSearchAudit;

  const t1 = SA.createTracker(function () {});
  const t2 = SA.createTracker(function () {});
  const r = t1.begin({ mode: "auto_bulk", site: "realpro", customer_id: "c1", customer_name: "山田" });
  const exported = t1.exportOpen();
  t2.adopt(exported[0]);
  const openList = t2.listOpen();
  ok("adopt で復元された run に restored: true が付く & listOpen が返す",
    openList.length === 1 && openList[0].run_id === r.run_id && openList[0].restored === true,
    openList);
}

console.log("\n■ 3. content.js / itandi-content.js / page-script.js / itandi-page-script.js / background.js / underbar.js 構造確認");
{
  const contentSrc = read("chrome-extension/content.js");
  const itContentSrc = read("chrome-extension/itandi-content.js");
  const bgSrc = read("chrome-extension/background.js");
  const pageSrc = read("chrome-extension/page-script.js");
  const itPageSrc = read("chrome-extension/itandi-page-script.js");
  const underbarSrc = read("chrome-extension/underbar.js");

  ok("content.js: _realproLearnView & PUSH_KEYS末尾が axlx_learn_gaps & extVer返却",
    contentSrc.includes("_realproLearnView")
    && /"axlx_learn_gaps",?\s*\]/.test(contentSrc)
    && contentSrc.includes("extVer"));
  ok("itandi-content.js: _itandiLearnView & refresh/auto-linked中継 & bootLearnIfNeeded & extVer返却",
    itContentSrc.includes("_itandiLearnView")
    && itContentSrc.includes("axlx-page-learn-refresh")
    && itContentSrc.includes("axlx-page-learn-auto-linked")
    && itContentSrc.includes("bootLearnIfNeeded")
    && itContentSrc.includes("extVer"));
  ok("background.js: _headCheckAtBySite & _auditPersistNow & extVer強制更新 & superseded_by_new_bulk & SW見張り",
    bgSrc.includes("_headCheckAtBySite")
    && bgSrc.includes("_auditPersistNow")
    && bgSrc.includes("p.extVer !== ver")
    && bgSrc.includes("superseded_by_new_bulk")
    && bgSrc.includes("batch_done_sw_watchdog"));
  ok("page-script.js: _startResetAfterReflect が _doReset より先にゲート完了を待つ & notifyDone で clearClickQueue",
    pageSrc.includes("_startResetAfterReflect")
    && pageSrc.includes("_learnReflectP.then(_startResetAfterReflect")
    && pageSrc.includes('if (typeof clearClickQueue === "function") clearClickQueue();'));
  ok("itandi-page-script.js: _itEnsureLearnReflectedForFill & _itSerialType & _itLearnPosOf(names) & _itScreenPosToElAim",
    itPageSrc.includes("_itEnsureLearnReflectedForFill")
    && itPageSrc.includes("_itSerialType")
    && itPageSrc.includes("_itLearnPosOf(names)")
    && itPageSrc.includes("_itScreenPosToElAim"));
  ok("underbar.js: startForward の 8秒フォールバック & 拡張更新リロードバナー",
    underbarSrc.includes("load-timeout-8s") && underbarSrc.includes("_showReloadBanner"));
}

console.log("\n■ 4. 実ランタイム結合テスト: human-learn.js サイト別 motion/gaps 読込");
{
  const hlSrc = read("chrome-extension/human-learn.js");
  function makeStorageEnv(hostname, data) {
    const ctx = {
      Date, Math, Object, Array, Number, String, Boolean, RegExp, JSON,
      location: { hostname },
      chrome: {
        storage: {
          local: {
            get(keys, cb) {
              const out = {};
              const arr = Array.isArray(keys) ? keys : [keys];
              for (const k of arr) { if (k in data) out[k] = data[k]; }
              cb(out);
            },
          },
        },
      },
      self: {},
      window: {},
      setTimeout, clearTimeout,
    };
    ctx.self = ctx; ctx.window = ctx;
    vm.runInNewContext(hlSrc, ctx);
    return ctx.self.AxlxHumanLearn;
  }
  const mixed = {
    axlx_learn_for_site: "realpro",
    axlx_learn_motion: { speed_px_s: 310, curve: 1.9 },
    axlx_learn_motion__realpro: { speed_px_s: 310, curve: 1.9 },
    axlx_learn_motion__itandi: { speed_px_s: 740, curve: 1.1 },
    axlx_learn_gaps: { median_ms: 420 },
    axlx_learn_gaps__realpro: { median_ms: 420 },
    axlx_learn_gaps__itandi: { median_ms: 1450 },
  };
  const hlIt = makeStorageEnv("itandibb.com", mixed);
  const hlRp = makeStorageEnv("www.realnetpro.com", mixed);
  ok("human-learn.js(itandibb.com): 共有が realpro でも __itandi の速さ・曲がり・間隔を読む",
    hlIt.learnedSpeedPxS(null) === 740 && hlIt.serverCurve() === 1.1 && hlIt.serverGapMs() === 1450,
    { speed: hlIt.learnedSpeedPxS(null), curve: hlIt.serverCurve(), gap: hlIt.serverGapMs() });
  ok("human-learn.js(realnetpro.com): __realpro の速さ・曲がり・間隔を読む",
    hlRp.learnedSpeedPxS(null) === 310 && hlRp.serverCurve() === 1.9 && hlRp.serverGapMs() === 420,
    { speed: hlRp.learnedSpeedPxS(null), curve: hlRp.serverCurve(), gap: hlRp.serverGapMs() });

  // __itandi 専用がまだ空で共有キーに realpro が入っている時でも混入しない
  const hlItOnlyRp = makeStorageEnv("itandibb.com", {
    axlx_learn_for_site: "realpro",
    axlx_learn_motion: { speed_px_s: 310, curve: 1.9 },
    axlx_learn_gaps: { median_ms: 420 },
  });
  ok("human-learn.js(itandibb.com): __itandi 未保存かつ共有が realpro のときは汚染されない",
    hlItOnlyRp.learnedSpeedPxS(null) === null && hlItOnlyRp.serverCurve() === null && hlItOnlyRp.serverGapMs() === null,
    { speed: hlItOnlyRp.learnedSpeedPxS(null), curve: hlItOnlyRp.serverCurve(), gap: hlItOnlyRp.serverGapMs() });
}

console.log("\n■ 5. 実ランタイム結合テスト: itandi-content.js <-> pointer-ui / itandi-page-script 座標変換 & boot再取込 & ping");
{
  const itContentSrc = read("chrome-extension/itandi-content.js");
  const itPageSrc = read("chrome-extension/itandi-page-script.js");

  // 5a: itandi-content.js を VM で起動し、axlx-ping の fillRunning と bootLearnIfNeeded(rules_up_to古版) を実測検証
  const msgListeners = [];
  const postedToPage = [];
  const sentToBg = [];
  let docAttrs = {};
  const storeData = {
    axlx_learn_for_site: "realpro",
    axlx_learn_playbook: { build_v: 19, rules_up_to: "2.8.312", rules: [{ id: "rp" }], flow_series: [1, 2, 3, 4, 5] },
    // ITANDI の手順書は旧版 2.8.311 で止まっている状態
    axlx_learn_playbook__itandi: { build_v: 19, rules_up_to: "2.8.311", rules: [{ id: "it1" }], flow_series: [1, 2, 3, 4, 5] },
    axlx_learn_points__itandi: { "検索": { x: 0.19, y: 0.45, n: 1 } },
    axlx_learn_screen__itandi: { form: [{ name: "検索", x: 0.11, y: 0.97, n: 4 }] },
  };
  const scheduled = [];
  const icCtx = {
    Object, Array, Number, String, Boolean, RegExp, JSON, Math, Date, Promise, Error, Map, Set, URLSearchParams,
    location: { pathname: "/rent_rooms/list", hostname: "itandibb.com", search: "", href: "https://itandibb.com/rent_rooms/list" },
    document: {
      visibilityState: "visible",
      documentElement: {
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(docAttrs, k) ? docAttrs[k] : null; },
        setAttribute(k, v) { docAttrs[k] = String(v); },
        removeAttribute(k) { delete docAttrs[k]; },
      },
      addEventListener() {},
      querySelectorAll() { return []; },
    },
    window: null, self: null,
    setTimeout(fn, ms) { scheduled.push({ fn, ms }); return scheduled.length; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    console: { log() {}, warn() {}, error() {} },
    chrome: {
      runtime: {
        lastError: null,
        getManifest() { return { version: "2.8.312" }; },
        onMessage: { addListener(fn) { msgListeners.push(fn); } },
        sendMessage(m, cb) { sentToBg.push(m); if (cb) cb({ ok: true }); },
      },
      storage: {
        local: {
          get(keys, cb) {
            const arr = Array.isArray(keys) ? keys : [keys];
            const out = {};
            for (const k of arr) { if (k in storeData) out[k] = storeData[k]; }
            if (cb) cb(out);
            return Promise.resolve(out);
          },
          set(patch, cb) { Object.assign(storeData, patch); if (cb) cb(); return Promise.resolve(); },
        },
        onChanged: { addListener() {} },
      },
    },
  };
  icCtx.window = {
    addEventListener() {},
    postMessage(m) { postedToPage.push(m); },
    document: icCtx.document,
    location: icCtx.location,
  };
  icCtx.self = icCtx;
  vm.runInNewContext(itContentSrc, icCtx);

  // axlx-ping の fillRunning 実動作確認
  let pingIdle = null, pingBusy = null;
  for (const fn of msgListeners) fn({ type: "axlx-ping" }, {}, (r) => { pingIdle = r; });
  docAttrs["data-axlx-it-fill-running"] = "1";
  for (const fn of msgListeners) fn({ type: "axlx-ping" }, {}, (r) => { pingBusy = r; });
  ok("itandi-content.js: axlx-ping が fillRunning を正確に切り替える",
    pingIdle && pingIdle.pong === true && pingIdle.fillRunning === false
    && pingBusy && pingBusy.pong === true && pingBusy.fillRunning === true,
    { pingIdle, pingBusy });

  // bootLearnIfNeeded（1200ms タイマー）を発火させ、rules_up_to 2.8.311 を検知して axlx-learn-refresh を送るか確認
  for (const s of scheduled) { if (s.ms === 1200) s.fn(); }
  ok("itandi-content.js: bootLearnIfNeeded が旧 rules_up_to(2.8.311) を検知し site=itandi で refresh 要求",
    sentToBg.some((m) => m && m.type === "axlx-learn-refresh" && m.force === true && m.site === "itandi"),
    sentToBg);

  // 5b: itandi-page-script.js の _itLearnPosOf + _itScreenPosToElAim を直接読み込んで座標系変換を実測検証
  const i1 = itPageSrc.indexOf("function _itApplyLearnData(");
  const i2 = itPageSrc.indexOf("// 2026-11-10 人間的な動き:");
  const posFnSlice = itPageSrc.slice(i1, i2);
  const posCtx = {
    Date, Math, Object, Array, Number, String, Boolean, RegExp, JSON, Promise, setTimeout() {}, clearTimeout() {},
    window: {
      addEventListener() {},
      postMessage() {},
      innerWidth: 1000,
      innerHeight: 800,
      __axlxLearnPoints: { "検索": { x: 0.19, y: 0.45, n: 1 } },
      __axlxLearnPlaybook: {
        positions: [
          { field: "検索", x: 0.11, y: 0.97, n: 4, source: "screen" },
          { field: "所在地で絞り込み", x: 0.08, y: 0.49, n: 6, source: "screen" },
          { field: "路線から探す", x: 0.25, y: 0.60, n: 4, source: "alias" },
        ],
      },
      __axlxLearnScreen: { form: [{ name: "検索", x: 0.11, y: 0.97, n: 4 }] },
    },
  };
  vm.runInNewContext(posFnSlice + "\nthis.__exp = { _itLearnPosOf, _itScreenPosToElAim };", posCtx);
  const { _itLearnPosOf, _itScreenPosToElAim } = posCtx.__exp;

  const lpSearch = _itLearnPosOf(["検索"]);
  const aimSearch = _itScreenPosToElAim({ getBoundingClientRect: () => ({ left: 80, top: 750, width: 100, height: 40 }) }, lpSearch);
  ok("itandi-page-script: 要素内 points(0.19,0.45) が画面座標(0.11,0.97)より優先され変換無しでそのまま使われる",
    lpSearch && !lpSearch.isScreen && aimSearch && Math.abs(aimSearch.x - 0.19) < 0.001 && Math.abs(aimSearch.y - 0.45) < 0.001,
    { lpSearch, aimSearch });

  const lpArea = _itLearnPosOf(["所在地で絞り込み"]);
  const aimAreaIn = _itScreenPosToElAim({ getBoundingClientRect: () => ({ left: 40, top: 360, width: 120, height: 40 }) }, lpArea);
  const aimAreaOut = _itScreenPosToElAim({ getBoundingClientRect: () => ({ left: 600, top: 50, width: 120, height: 40 }) }, lpArea);
  ok("itandi-page-script: source=screen(0.08,0.49) が 1000x800 上の矩形(40,360,120,40)内の相対(0.333,0.80)へ変換される",
    lpArea && lpArea.isScreen === true && aimAreaIn && Math.abs(aimAreaIn.x - 0.3333) < 0.01 && Math.abs(aimAreaIn.y - 0.8) < 0.01,
    { lpArea, aimAreaIn });
  ok("itandi-page-script: スクロール等で画面座標が要素矩形外の時は null（誤った端を狙わない）",
    aimAreaOut === null,
    aimAreaOut);
}

console.log("\n■ 6. 実ランタイム結合テスト: content.js(realpro) の bootLearnIfNeeded & PUSH_KEYS & pointer-ui連携");
{
  const contentSrc = read("chrome-extension/content.js");
  const rpMsg = [];
  const rpSent = [];
  const rpStore = {
    axlx_learn_for_site: "itandi",
    axlx_learn_playbook: { build_v: 19, rules_up_to: "2.8.312", rules: [], flow_series: [1, 2, 3, 4, 5] },
    // realpro 側が旧 build_v=18 で残っている
    axlx_learn_playbook__realpro: { build_v: 18, rules_up_to: "2.8.310", rules: [{ id: "r1" }], flow_series: [1, 2, 3, 4, 5] },
    axlx_learn_needs_auto: true,
    axlx_learn_needs_auto__realpro: false,
  };
  const rpTimers = [];
  const rpWinListeners = [];
  const rpPosted = [];
  const rpCtx = {
    Object, Array, Number, String, Boolean, RegExp, JSON, Math, Date, Promise, Error, Map, Set, URLSearchParams,
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle() { return { display: "none", visibility: "hidden", opacity: "1" }; },
    MutationObserver: function () { this.observe = function () {}; this.disconnect = function () {}; },
    sessionStorage: { getItem() { return null; }, setItem() {} },
    localStorage: { getItem() { return null; }, setItem() {} },
    location: { pathname: "/main.php", hostname: "www.realnetpro.com", search: "", href: "https://www.realnetpro.com/main.php" },
    document: {
      readyState: "complete",
      visibilityState: "visible",
      styleSheets: [],
      body: { appendChild() {}, querySelectorAll() { return []; } },
      documentElement: { appendChild() {}, getAttribute() { return null; }, classList: { add() {}, remove() {} } },
      head: { appendChild() {}, querySelectorAll() { return []; } },
      createElement() { return { style: {}, dataset: {}, setAttribute() {}, remove() {}, sheet: null }; },
      createTreeWalker() { return { nextNode() { return null; } }; },
      addEventListener() {},
      querySelectorAll() { return []; },
      getElementById() { return null; },
    },
    window: null, self: null,
    setTimeout(fn, ms) { rpTimers.push({ fn, ms }); return rpTimers.length; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    console: { log() {}, warn() {}, error() {} },
    chrome: {
      runtime: {
        lastError: null,
        getManifest() { return { version: "2.8.312" }; },
        getURL(p) { return "chrome-extension://test/" + p; },
        onMessage: { addListener(fn) { rpMsg.push(fn); } },
        sendMessage(m, cb) { rpSent.push(m); if (cb) cb({ ok: true }); },
      },
      storage: {
        local: {
          get(keys, cb) {
            const arr = Array.isArray(keys) ? keys : [keys];
            const out = {};
            for (const k of arr) { if (k in rpStore) out[k] = rpStore[k]; }
            if (cb) cb(out);
            return Promise.resolve(out);
          },
          set(patch, cb) { Object.assign(rpStore, patch); if (cb) cb(); return Promise.resolve(); },
        },
        onChanged: { addListener() {} },
      },
    },
  };
  rpCtx.window = {
    addEventListener(t, fn) { rpWinListeners.push({ t, fn }); },
    postMessage(m) { rpPosted.push(m); },
    document: rpCtx.document,
    location: rpCtx.location,
  };
  rpCtx.self = rpCtx;
  vm.runInNewContext(contentSrc, rpCtx);

  for (const t of rpTimers) { if (t.ms === 1200) t.fn(); }
  ok("content.js(realpro): bootLearnIfNeeded が旧 build_v(18)/rules_up_to(2.8.310) を検知し site=realpro で refresh 要求",
    rpSent.some((m) => m && m.type === "axlx-learn-refresh" && m.force === true && m.site === "realpro"),
    rpSent);

  // axlx-page-storage-get に対して realpro 投影されたビューだけが返ること（itandi の偽 needs_auto=true は混ぜない）
  for (const l of rpWinListeners) {
    if (l.t === "message") {
      l.fn({ source: rpCtx.window, data: { from: "axlx-page-storage-get", id: "rp_1", keys: ["axlx_learn_playbook", "axlx_learn_needs_auto"] } });
    }
  }
  const stRes = rpPosted.find((m) => m && m.from === "axlx-page-storage-result" && m.id === "rp_1");
  ok("content.js: axlx-page-storage-get に __realpro を投影して返し、共有の偽 needs_auto=true を混ぜない",
    stRes && stRes.data && stRes.data.axlx_learn_playbook.build_v === 18 && stRes.data.axlx_learn_needs_auto === false,
    stRes);
}

console.log("\n■ 7. 実ランタイム結合テスト: itandi-content.js <-> human-learn.js <-> pointer-ui.js 実メッセージ結線（サイト分離保証）");
{
  const itContentSrc = read("chrome-extension/itandi-content.js");
  const humanLearnSrc = read("chrome-extension/human-learn.js");
  const pointerSrc = read("chrome-extension/pointer-ui.js");
  const storeData = {
    axlx_learn_for_site: "realpro",
    axlx_learn_playbook__itandi: { build_v: 19, rules_up_to: "2.8.312", rules: [{ id: "it1" }], flow_series: [1, 2, 3, 4, 5] },
    axlx_learn_motion: { speed_px_s: 280, curve: 2.0 },
    axlx_learn_motion__realpro: { speed_px_s: 280, curve: 2.0 },
    axlx_learn_motion__itandi: { speed_px_s: 810, curve: 1.05 },
    axlx_human_points__realpro: { "左の検索": { x: 0.9, y: 0.9, n: 10 } },
    axlx_human_points__itandi: { "検索": { x: 0.19, y: 0.45, n: 2 } },
    axlx_learn_cursor_hand: { "realproHand": { n: 5 } },
    axlx_learn_cursor_hand__itandi: { "検索": { n: 3 } },
  };
  const winListeners = [];
  const bridgeCtx = {
    Object, Array, Number, String, Boolean, RegExp, JSON, Math, Date, Promise, Error, Map, Set, URLSearchParams,
    location: { pathname: "/rent_rooms/list", hostname: "itandibb.com", search: "", href: "https://itandibb.com/rent_rooms/list" },
    document: { visibilityState: "visible", documentElement: { getAttribute() { return null; } }, addEventListener() {}, querySelectorAll() { return []; } },
    window: null, self: null,
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
    console: { log() {}, warn() {}, error() {} },
    chrome: {
      runtime: { lastError: null, getManifest() { return { version: "2.8.312" }; }, onMessage: { addListener() {} }, sendMessage(_m, cb) { if (cb) cb({ ok: true }); } },
      storage: {
        local: {
          get(keys, cb) {
            const out = {};
            for (const k of (Array.isArray(keys) ? keys : [keys])) { if (k in storeData) out[k] = storeData[k]; }
            if (cb) cb(out);
            return Promise.resolve(out);
          },
          set(patch, cb) { Object.assign(storeData, patch); if (cb) cb(); return Promise.resolve(); },
        },
        onChanged: { addListener() {} },
      },
    },
  };
  const sharedWin = {
    innerWidth: 1000,
    innerHeight: 800,
    location: bridgeCtx.location,
    document: bridgeCtx.document,
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } },
    addEventListener(t, fn) { winListeners.push({ t, fn }); },
    postMessage(m) {
      for (const l of winListeners.slice()) { if (l.t === "message") l.fn({ source: sharedWin, data: m }); }
    },
  };
  bridgeCtx.window = sharedWin; bridgeCtx.self = bridgeCtx;
  vm.runInNewContext(itContentSrc, bridgeCtx);

  const ptrCtx = {
    Object, Array, Number, String, Boolean, RegExp, JSON, Math, Date, Promise, Error, Map, Set,
    location: sharedWin.location,
    localStorage: sharedWin.localStorage,
    document: { visibilityState: "visible", body: { appendChild() {} }, head: { appendChild() {} }, documentElement: { appendChild() {}, classList: { add() {}, remove() {} } }, createElement() { return { style: {}, setAttribute() {}, getAttribute() { return null; }, appendChild() {}, remove() {} }; }, addEventListener() {}, querySelectorAll() { return []; }, getElementById() { return null; } },
    window: sharedWin,
    self: null,
    setTimeout() { return 1; }, clearTimeout() {},
    requestAnimationFrame() { return 1; },
    console: { log() {}, warn() {}, error() {} },
  };
  ptrCtx.self = ptrCtx;
  // manifest.json の MAIN world と同じ順で human-learn.js → pointer-ui.js をロード
  vm.runInNewContext(humanLearnSrc, ptrCtx);
  vm.runInNewContext(pointerSrc, ptrCtx);

  // MAIN world の pointer-ui がブリッジ越しに __itandi の motion と points を受け取る
  ptrCtx.self.AxlxPointerUi.ensure();
  ptrCtx.self.AxlxPointerUi.moveToEl({
    tagName: "BUTTON",
    textContent: "検索",
    getAttribute() { return null; },
    getBoundingClientRect() { return { left: 100, top: 200, width: 100, height: 40 }; },
  });
  ok("pointer-ui.js(itandibb.com): itandi-content経由で __itandi の __axlxServerMotion(speed=810) を受け、realpro(280)に汚染されない",
    ptrCtx.__axlxServerMotion && ptrCtx.__axlxServerMotion.speed_px_s === 810,
    { srvMotion: ptrCtx.__axlxServerMotion });
  const cachedIt = JSON.parse(sharedWin.localStorage.getItem("axlx_pointer_cache__itandi") || "{}");
  ok("pointer-ui.js(itandibb.com): localStorage キャッシュ(axlx_pointer_cache__itandi) に __itandi だけ保存され realpro(左の検索)は混ざらない",
    cachedIt && cachedIt.axlx_human_points__itandi && cachedIt.axlx_human_points__itandi["検索"]
    && !cachedIt.axlx_human_points__realpro,
    cachedIt);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
