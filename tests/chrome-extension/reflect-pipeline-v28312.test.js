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
  ok("itandi-page-script.js: _itEnsureLearnReflectedForFill & _itSerialType & _itLearnPosOf(names)",
    itPageSrc.includes("_itEnsureLearnReflectedForFill")
    && itPageSrc.includes("_itSerialType")
    && itPageSrc.includes("_itLearnPosOf(names)"));
  ok("underbar.js: startForward の 8秒フォールバック & 拡張更新リロードバナー",
    underbarSrc.includes("load-timeout-8s") && underbarSrc.includes("_showReloadBanner"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
