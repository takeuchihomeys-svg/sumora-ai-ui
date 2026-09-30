// 実行: node tests/chrome-extension/parallel-sites.test.js
// 2026-09-30 v2.5.43 竹内「拡張ツールはリアプロと ITANDI を開いているので、同時に動かす形でも大丈夫ならそれで行う」:
//   同時に動かせるかの判定（別々の窓・前面・見えている・1秒のタイマーが間引かれていない）／2本の待ち手・合流・片方の時間切れ／
//   見張りの2本（本ごとの時間切れ・止まり）／background・manifest の配線を固定する
const fs = require("fs");
const path = require("path");
const P = require("../../chrome-extension/parallel-sites.js");
const AR = require("../../chrome-extension/auto-run.js");
let pass = 0, fail = 0;
function eq(name, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok ? "" : `\n      expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)); }
function ok(name, c, extra) { const v = !!c; v ? pass++ : fail++; console.log((v ? "  ✓ " : "  ✗ ") + name + (v || extra === undefined ? "" : `\n      ${JSON.stringify(extra).slice(0, 400)}`)); }
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

const RP = "https://www.realnetpro.com/main.php?x=1";
const IT = "https://itandibb.com/rent_rooms/list";
const tabs2win = [
  { id: 11, windowId: 1, active: true, url: RP },
  { id: 12, windowId: 1, active: false, url: "https://sumora-ai-ui.vercel.app/conditions" },
  { id: 21, windowId: 2, active: true, url: IT },
];
const wins = [{ id: 1, state: "normal" }, { id: 2, state: "maximized" }];
const good = { ok: true, visibilityState: "visible", lagMs: 30 };
const probes = { realnetpro: good, itandi: good };

console.log("\n■ 同時に動かせるか（decideParallel）");
{
  const d = P.decideParallel({ sites: ["realnetpro", "itandi"], tabs: tabs2win, windows: wins, probes });
  eq("別々の窓・両方前面・見えている・タイマーの遅れ 30ms → 同時", [d.parallel, d.reason, d.lanes, d.tabs], [true, "ok", ["realnetpro", "itandi"], { realnetpro: 11, itandi: 21 }]);
  eq("1サイトだけ → 順（single_site）", P.decideParallel({ sites: ["realnetpro"], tabs: tabs2win, windows: wins, probes }).reason, "single_site");
  eq("レインズ＋リアプロ → 順", P.decideParallel({ sites: ["realnetpro", "reins"], tabs: tabs2win, windows: wins, probes }).parallel, false);
  eq("storage の parallelSites=false → 順（disabled）", P.decideParallel({ sites: ["realnetpro", "itandi"], tabs: tabs2win, windows: wins, probes, flag: false }).reason, "disabled");
  eq("ITANDI のタブが無い → no_tab:itandi", P.decideParallel({ sites: ["realnetpro", "itandi"], tabs: tabs2win.slice(0, 2), windows: wins, probes }).reason, "no_tab:itandi");
  const same = [{ id: 11, windowId: 1, active: true, url: RP }, { id: 21, windowId: 1, active: false, url: IT }];
  eq("同じ窓（前面に出せるタブは1つ）→ same_window", P.decideParallel({ sites: ["realnetpro", "itandi"], tabs: same, windows: wins, probes }).reason, "same_window");
  const bgTab = [{ id: 11, windowId: 1, active: true, url: RP }, { id: 21, windowId: 2, active: false, url: IT }, { id: 22, windowId: 2, active: true, url: "https://example.com/" }];
  eq("ITANDI の窓で別のタブが前面 → tab_not_active:itandi", P.decideParallel({ sites: ["realnetpro", "itandi"], tabs: bgTab, windows: wins, probes }).reason, "tab_not_active:itandi");
  eq("窓が最小化 → window_minimized:realnetpro", P.decideParallel({ sites: ["realnetpro", "itandi"], tabs: tabs2win, windows: [{ id: 1, state: "minimized" }, { id: 2, state: "normal" }], probes }).reason, "window_minimized:realnetpro");
  const disc = tabs2win.map((t) => t.id === 21 ? Object.assign({}, t, { discarded: true }) : t);
  eq("タブが休止（discarded）→ 順", P.decideParallel({ sites: ["realnetpro", "itandi"], tabs: disc, windows: wins, probes }).reason, "tab_discarded:itandi");
  eq("見えていない（hidden・他の窓に覆われた等）→ hidden:itandi", P.decideParallel({ sites: ["realnetpro", "itandi"], tabs: tabs2win, windows: wins, probes: { realnetpro: good, itandi: { ok: true, visibilityState: "hidden", lagMs: 0 } } }).reason, "hidden:itandi");
  eq("1秒のタイマーが 1.8秒で戻った（間引き）→ timer_throttled:realnetpro", P.decideParallel({ sites: ["realnetpro", "itandi"], tabs: tabs2win, windows: wins, probes: { realnetpro: { ok: true, visibilityState: "visible", lagMs: 800 }, itandi: good } }).reason, "timer_throttled:realnetpro");
  eq("境界: 遅れ 500ms（1.5秒で戻った）は通る", P.decideParallel({ sites: ["realnetpro", "itandi"], tabs: tabs2win, windows: wins, probes: { realnetpro: { ok: true, visibilityState: "visible", lagMs: 500 }, itandi: good } }).parallel, true);
  eq("境界: 遅れ 501ms は順", P.decideParallel({ sites: ["realnetpro", "itandi"], tabs: tabs2win, windows: wins, probes: { realnetpro: { ok: true, visibilityState: "visible", lagMs: 501 }, itandi: good } }).parallel, false);
  eq("実測の答えが無い（content script が古い・4秒切れ）→ probe_failed", P.decideParallel({ sites: ["realnetpro", "itandi"], tabs: tabs2win, windows: wins, probes: { realnetpro: good, itandi: { ok: false, error: "no_answer" } } }).reason, "probe_failed:itandi");
  eq("実測が無い → probe_failed", P.decideParallel({ sites: ["realnetpro", "itandi"], tabs: tabs2win, windows: wins, probes: {} }).reason, "probe_failed:realnetpro");
  const loginTab = [{ id: 10, windowId: 3, active: true, url: "https://www.realnetpro.com/login.php" }].concat(tabs2win);
  eq("リアプロは main.php のタブを選ぶ（ログインの画面のタブを掴まない）", P.tabFor(loginTab, "realnetpro").id, 11);
  eq("送り主のタブの URL → サイト", [P.siteOfSenderUrl(RP), P.siteOfSenderUrl(IT), P.siteOfSenderUrl("https://system.reins.jp/main"), P.siteOfSenderUrl("https://evil-realnetpro.com.example/")], ["realnetpro", "itandi", "reins", null]);
  eq("実測の答えの形（1秒 → 1.04秒で戻った＝遅れ 40ms）", P.probeResult("visible", 1000, 2040), { ok: true, visibilityState: "visible", lagMs: 40 });
  ok("理由の1行（同時）", /^同時: /.test(P.describeDecision({ parallel: true, reason: "ok" })));
  ok("理由の1行（順・どのサイトか）", P.describeDecision({ parallel: false, reason: "hidden:itandi" }) === "順（リアプロ → ITANDI）: 見えていない（itandi）", P.describeDecision({ parallel: false, reason: "hidden:itandi" }));
}

console.log("\n■ 2本目のずらし・合流の上限");
{
  eq("ずらしは 3〜15秒（最小）", P.laneStartOffsetMs(() => 0), 3000);
  eq("ずらしは 3〜15秒（最大）", P.laneStartOffsetMs(() => 0.999999), 15000);
  const dl = (s) => (s === "itandi" ? 25 : 20) * 60 * 1000;
  eq("合流の上限＝一番長い見張り（ITANDI 25分）＋ずらし＋余裕90秒", P.joinBudgetMs(["realnetpro", "itandi"], dl, 1, 10000), 25 * 60 * 1000 + 10000 + 90000);
  eq("地域→駅の2パスのお客様は 2倍＋パスの間", P.joinBudgetMs(["realnetpro", "itandi"], dl, 2, 0), 2 * 25 * 60 * 1000 + 10000 + 90000);
}

(async function () {
  console.log("\n■ 合流（joinLanes）: 両方を待つ・片方の失敗はもう片方を止めない・上限で待つのをやめる");
  {
    const later = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
    const r1 = await P.joinLanes([{ site: "realnetpro", promise: later(30, { cancelled: false }) }, { site: "itandi", promise: later(60, { cancelled: false }) }], 2000);
    eq("両方が終わるまで待つ（遅い方まで）", [r1.timedOut, r1.pending, !!r1.results.realnetpro.ok, !!r1.results.itandi.ok], [false, [], true, true]);
    ok("遅い方の時間 ≥ 早い方", r1.results.itandi.ms >= r1.results.realnetpro.ms);
    const boom = Promise.reject(new Error("タブが応答しない"));
    const r2 = await P.joinLanes([{ site: "realnetpro", promise: boom }, { site: "itandi", promise: later(40, { cancelled: false }) }], 2000);
    eq("リアプロが投げても ITANDI は最後まで（片方の失敗がもう片方を止めない）", [r2.results.realnetpro.ok, r2.results.realnetpro.error.message, r2.results.itandi.ok], [false, "タブが応答しない", true]);
    const r3 = await P.joinLanes([{ site: "realnetpro", promise: later(10, 1) }, { site: "itandi", promise: new Promise(() => {}) }], 80);
    eq("ITANDI が終わらない → 上限で待つのをやめ、残った本を返す", [r3.timedOut, r3.pending, !!r3.results.realnetpro], [true, ["itandi"], true]);
    const r4 = await P.joinLanes([], 50);
    eq("本が無い → すぐ終わる", [r4.timedOut, r4.pending], [false, []]);
  }

  console.log("\n■ 見張りの2本（summarizeLanes・laneView・activeLaneViews）");
  {
    const w = { commandId: "cmd1", customerId: "c1", customerName: "YUMA", lanes: {
      realnetpro: { site: "realnetpro", guardId: 5, passStartedAt: 1000, lastProgressAt: 9000, waitingFor: "検索の完了（fill-done）と全ページの送信", lastEvent: "送信の進み" },
      itandi: { site: "itandi", guardId: 6, passStartedAt: 5000, lastProgressAt: 4000, waitingFor: "条件の入力（タブの確かめ・popup）" },
    } };
    P.summarizeLanes(w, 10000);
    eq("上の段の最後に進んだ時刻＝止まっている方（古い方）", w.lastProgressAt, 4000);
    eq("待っている物は2本分", w.waitingFor, "リアプロ: 検索の完了（fill-done）と全ページの送信 ／ itandi: 条件の入力（タブの確かめ・popup）");
    const v = P.laneView(w, "itandi");
    eq("その本を重ねた見え方（時間切れの文・止まりの鍵に使う）", [v.site, v.guardId, v.lastProgressAt, v.customerName, v.lanes], ["itandi", 6, 4000, "YUMA", undefined]);
    w.lanes.itandi.done = true;
    P.summarizeLanes(w, 10000);
    eq("終わった本はまとめから外す", [w.lastProgressAt, w.sites], [9000, ["realnetpro"]]);
    eq("止まりの見張りは終わっていない本だけ", P.activeLaneViews(w).map((x) => x.site), ["realnetpro"]);
    eq("本の無い（順の回の）見張りはそのまま1つ", P.activeLaneViews({ site: "realnetpro", lastProgressAt: 1 }).length, 1);
  }

  console.log("\n■ auto-run: 同時の回はサイトごとの指定を並べて置く（by_site）");
  {
    const rp = AR.record("c1", "realnetpro", { mode: "pm", rp_update_days: 1, sort: "updated", max_pages: 5 }, 1000, { last_search_at: "2026-09-29T08:00:00.000Z" });
    const it = AR.record("c1", "itandi", { mode: "pm", rp_update_days: 1, sort: "updated", max_pages: 5 }, 1500, { last_search_at: "2026-09-29T08:10:00.000Z" });
    let mem = AR.withSite(null, rp);
    mem = AR.withSite(mem, it);
    eq("リアプロの分を消さずに ITANDI を足す", Object.keys(mem.by_site).sort(), ["itandi", "realnetpro"]);
    eq("bulk-dl（リアプロ）はリアプロの前回の時刻", AR.forCustomer(mem, "c1", "realnetpro", 2000).last_search_at, "2026-09-29T08:00:00.000Z");
    eq("itandi-bulk-dl は ITANDI の前回の時刻", AR.forCustomer(mem, "c1", "itandi", 2000).last_search_at, "2026-09-29T08:10:00.000Z");
    eq("別のお客様 → null", AR.forCustomer(mem, "c2", "itandi", 2000), null);
    const next = AR.withSite(mem, AR.record("c2", "realnetpro", { mode: "pm" }, 3000));
    eq("次のお客様に替わったら前のお客様の分は持ち越さない", Object.keys(next.by_site), ["realnetpro"]);
    eq("旧の形（1つの record）も読む", AR.forCustomer(rp, "c1", "realnetpro", 2000).max_pages, 5);
  }

  console.log("\n■ background の配線（静的に確かめる）");
  {
    const bg = read("background.js");
    ok("parallel-sites.js・update-order-stop.js を読む", /import "\.\/parallel-sites\.js";/.test(bg) && /import "\.\/update-order-stop\.js";/.test(bg));
    const rb = bg.slice(bg.indexOf("async function _runBatchSearch(command)"), bg.indexOf("function _recordBulkSearch("));
    ok("1人×1サイトの回は _runSiteLane（var が本ごと）", /async function _runSiteLane\(customer, batchSite, laneMode, laneNote\) \{/.test(rb));
    ok("お客様ごとに同時か順かを決める → 同時なら2本・順なら今まで通り", /var _lanePlan = await _decideLanes\(custSites\);/.test(rb) && /if \(_lanePlan\.parallel\) \{\s*var _laneRes = await _runLanesParallel\(customer, _runSiteLane, _laneNote\);/.test(rb) && /var _seqRes = await _runSiteLane\(customer, batchSite, false,/.test(rb));
    ok("同時の回の見張りは本ごと（_startPassGuard の lane）", /_startPassGuard\(\{\s*lane: laneMode,/.test(rb));
    ok("両方終わってから次のお客様（合流の後に processed_customers）", rb.indexOf("_runLanesParallel(customer") < rb.indexOf("processed_customers: i + 1"));
    const lp = bg.slice(bg.indexOf("async function _runLanesParallel("), bg.indexOf("// ===== END: 自動化バッチ検索 ====="));
    ok("リアプロを先に始め、ITANDI はずらしてから（ずらす間も止める要求を見る）", /var pRp = runLane\(customer, "realnetpro", true, laneNote\);/.test(lp) && /laneStartOffsetMs\(\)/.test(lp) && /if \(_batchShouldStop\) return \{ cancelled: true \};/.test(lp));
    ok("合流の上限を過ぎた本は待ちを解いて置き去り", /_endFillDoneWaiter\(s, cid, "合流の時間切れ"\)/.test(lp) && /_abandonBatchCustomerDoneWaiter\(cid, s\)/.test(lp));
    ok("判定の前にタブ・窓を見て、満たす時だけ実測（axlx-lane-probe）", /var pre = P\.decideParallel\(/.test(bg) && /if \(!pre\.parallel\) return pre;/.test(bg) && /type: "axlx-lane-probe"/.test(bg));
    ok("fill-done の捨てた記録はお客様×サイト", /function _markFillDoneAbandoned\(customerId, site\)/.test(bg) && /_markFillDoneAbandoned\(entry\.customerId, entry\.site\);/.test(bg) && /_abandonedIdsFor\(site \|\| null\)/.test(bg));
    ok("送信の終わりの待ち手はサイトも持ち、合図の送り主のタブで当てる", /_createBatchCustomerDoneWaiter\(customerId, 300000, _siteKey\)/.test(bg) && /_notifyBatchCustomerDone\(msg\.customerId \|\| null, msg\.propertyCount != null \? msg\.propertyCount : null, msg\.audit \|\| null, _msgSite\)/.test(bg));
    ok("見張りの時間切れは自分のサイトの待ちだけを解く", /_abandonBatchCustomerDoneWaiter\(ctx\.customerId, ctx\.site\)/.test(bg) && /_endFillDoneWaiter\(ctx\.site, ctx\.customerId, "見張りの時間切れ"\)/.test(bg));
    ok("時間切れは自分の本の guardId だけで見る（もう片方が替わっても止めない）", /if \(laneSite\) \{\s*var l = _watchLane\(laneSite\);\s*return l && l\.guardId === id \?/.test(bg));
    ok("止まりの見張りは本ごと（activeLaneViews）", /activeLaneViews\(w\)/.test(bg));
    ok("直前の1回の結果はサイトごと（_scrapeOutcomeFor）", /_scrapeOutcomeBySite\[_siteKey\] = _out;/.test(bg) && /_scrapeOutcomeFor\(batchSite\)\.timedOut/.test(rb));
    ok("送付済みで飛ばした数もお客様×サイト", /_lastSentSkipped\[_sentSkipKey\(msg\.customerId, _msgSite\)\]/.test(bg));
    ok("サイトへのアクセスは同じ（_runSiteLane の中の検索・送信の呼び方は1本の時と同じ）", (rb.match(/_batchAutofill\(effectiveCustomer/g) || []).length === 1 && (rb.match(/_scrapeAndSendRealpro\(/g) || []).length === 2);
  }

  console.log("\n■ manifest・content script の受け口");
  {
    const mf = JSON.parse(read("manifest.json"));
    eq("版 2.5.51", mf.version, "2.5.51");
    ok("3サイトの先頭の段に parallel-sites.js（snapshot-core.js より前）", mf.content_scripts[0].js.join(",") === "human-wait.js,search-audit.js,parallel-sites.js,snapshot-core.js");
    const sc = read("snapshot-core.js");
    ok("snapshot-core に axlx-lane-probe の受け口（サイトには触らない・非同期で答える）", /msg\.type !== "axlx-lane-probe"/.test(sc) && /return true;\s*\}\);\s*\}\s*\} catch/.test(sc));
    ok("parallel-sites.js は _ で始まらない", !fs.existsSync(path.join(EXT, "_parallel-sites.js")));
    ok("合流の既定のタイマーは包んで呼ぶ（Chrome の Illegal invocation を避ける）", /setTimeout: function \(f, ms\) \{ return setTimeout\(f, ms\); \}/.test(read("parallel-sites.js")));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
