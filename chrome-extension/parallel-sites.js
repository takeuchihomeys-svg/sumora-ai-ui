// chrome-extension/parallel-sites.js（self.AxlxParallelSites・純関数・chrome.* を使わない）
// 2026-09-30 v2.5.43 竹内「拡張ツールはリアプロと ITANDI を開いているので、同時に動かす形でも大丈夫ならそれで行う」
//
// 1人のお客様のリアプロと ITANDI を**同時に**走らせてよいかを、拡張が自分で判定する。
//   v2.5.42 が1人ずつ順（リアプロ → ITANDI）にした理由は「前面に出せるタブは1つで、背面のタブは Chrome がタイマーを間引き
//   fill-done が遅れる（9/27 点検 26）・見張りと待ち手が1本」だった。竹内さんの PC はリアプロと ITANDI が**別々の窓**で
//   両方とも画面に見えている（スクショで確認）。その形の時だけ同時にし、満たさない時は v2.5.42 の順の形に自動で戻す。
//
// 同時にしてよい条件（全部満たす時だけ）:
//   ① この回のサイトにリアプロと ITANDI の両方がある
//   ② リアプロ（main.php）のタブと ITANDI のタブが**別の窓**にあり、それぞれの窓で前面（active）・窓が最小化されていない
//   ③ content script の見え方（document.visibilityState === "visible"）が両方とも visible
//   ④ 実測: 1秒のタイマーが 1.5秒以内に戻る（＝タイマーが間引かれていない）を両方とも満たす
//   ⑤ storage.local の parallelSites が false でない（止めたい PC は false にする）
// 満たさない時は理由（same_window／tab_not_active／hidden:itandi／timer_throttled:realnetpro 等）をログと点検の記録に残して順の形。
//
// 同時の回し方（background.js _runCustomerLanes）:
//   ・リアプロを先に始め、ITANDI は数秒〜十数秒ずらして始める（laneStartOffsetMs）。1つの窓の中の操作は今までどおりの揺らぎ
//   ・両方が終わる（または見張りの時間切れ＝リアプロ20分・ITANDI 25分・見送り）まで待ってから、そのお客様のまとめ → 次のお客様
//   ・片方が先に終わっても、もう片方の見張りの時間切れを超えては待たない（joinBudgetMs＝一番長い上限＋余裕）
//   ・サイトへのアクセスの数は順の形と同じ（同じ検索を2回しない）
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AxlxParallelSites = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  /** 実測のタイマー（content script に 1秒のタイマーを置き、戻りまでの遅れを測る） */
  var PROBE_TIMER_MS = 1000;
  /** 1秒のタイマーが戻るまでに許す遅れ（1.5秒以内に戻る＝間引かれていない） */
  var PROBE_MAX_LAG_MS = 500;
  /** 実測の答えを待つ上限（来なければ順の形） */
  var PROBE_WAIT_MS = 4000;
  /** 同時の時の2本目（ITANDI）の開始のずらし: 3〜15秒 */
  var LANE_OFFSET_MIN_MS = 3000;
  var LANE_OFFSET_RANGE_MS = 12000;
  /** 両方が終わるのを待つ上限に足す余裕（見張りの時間切れが投げなかった時の保険） */
  var JOIN_EXTRA_MS = 90 * 1000;
  /** storage.local の鍵（false で同時を止める） */
  var STORAGE_FLAG = "parallelSites";

  function _rand(rng) {
    var r = (typeof rng === "function") ? rng() : Math.random();
    if (!(r >= 0)) r = 0;
    if (r >= 1) r = 0.999999;
    return r;
  }

  /** メッセージの送り主（タブの URL）からサイトの鍵（background の待ち手・見張りの鍵と同じ名前） */
  function siteOfSenderUrl(url) {
    var u = String(url || "");
    var m = u.match(/^https?:\/\/([^\/?#]+)/i);
    if (!m) return null;
    var h = m[1].toLowerCase();
    if (h === "realnetpro.com" || /\.realnetpro\.com$/.test(h)) return "realnetpro";
    if (h === "itandibb.com" || /\.itandibb\.com$/.test(h)) return "itandi";
    if (/(^|\.)reins\.jp$/.test(h)) return "reins";
    return null;
  }

  /** そのサイトのタブ（リアプロは main.php を先に・無ければ realnetpro の最初のタブ） */
  function tabFor(tabs, site) {
    var list = Array.isArray(tabs) ? tabs.filter(function (t) { return t && siteOfSenderUrl(t.url) === site; }) : [];
    if (!list.length) return null;
    if (site === "realnetpro") {
      var main = list.filter(function (t) { return /realnetpro\.com\/main\.php/.test(String(t.url || "")); });
      if (main.length) list = main;
    }
    // 前面のタブがあればそれ（同じサイトのタブが2つある時）
    var active = list.filter(function (t) { return t.active; });
    return active[0] || list[0];
  }

  /**
   * 同時に動かしてよいか。
   * @param {object} i { sites, tabs, windows, probes: { realnetpro: {ok, visibilityState, lagMs}, itandi: {...} }, flag }
   * @returns {{ parallel: boolean, reason: string, lanes: string[], tabs: {realnetpro: number|null, itandi: number|null} }}
   */
  function decideParallel(i) {
    var o = i || {};
    var sites = Array.isArray(o.sites) ? o.sites : [];
    var out = { parallel: false, reason: "", lanes: [], tabs: { realnetpro: null, itandi: null } };
    var hasRp = sites.indexOf("realnetpro") >= 0, hasIt = sites.indexOf("itandi") >= 0;
    if (!hasRp || !hasIt) { out.reason = "single_site"; return out; }
    if (o.flag === false) { out.reason = "disabled"; return out; }
    var rp = tabFor(o.tabs, "realnetpro"), it = tabFor(o.tabs, "itandi");
    if (!rp) { out.reason = "no_tab:realnetpro"; return out; }
    if (!it) { out.reason = "no_tab:itandi"; return out; }
    out.tabs = { realnetpro: rp.id != null ? rp.id : null, itandi: it.id != null ? it.id : null };
    if (rp.windowId == null || it.windowId == null || rp.windowId === it.windowId) { out.reason = "same_window"; return out; }
    if (!rp.active) { out.reason = "tab_not_active:realnetpro"; return out; }
    if (!it.active) { out.reason = "tab_not_active:itandi"; return out; }
    if (rp.discarded) { out.reason = "tab_discarded:realnetpro"; return out; }
    if (it.discarded) { out.reason = "tab_discarded:itandi"; return out; }
    var wins = Array.isArray(o.windows) ? o.windows : [];
    var byId = {};
    wins.forEach(function (w) { if (w && w.id != null) byId[w.id] = w; });
    var wr = byId[rp.windowId], wi = byId[it.windowId];
    if (wr && wr.state === "minimized") { out.reason = "window_minimized:realnetpro"; return out; }
    if (wi && wi.state === "minimized") { out.reason = "window_minimized:itandi"; return out; }
    var probes = o.probes || {};
    var order = ["realnetpro", "itandi"];
    for (var k = 0; k < order.length; k++) {
      var s = order[k];
      var v = probeVerdict(probes[s]);
      if (!v.ok) { out.reason = v.reason + ":" + s; return out; }
    }
    out.parallel = true;
    out.reason = "ok";
    out.lanes = ["realnetpro", "itandi"];
    return out;
  }

  /** 実測の答え → 通るか（visible かつ 1秒のタイマーの遅れが PROBE_MAX_LAG_MS 以内） */
  function probeVerdict(p) {
    if (!p || typeof p !== "object") return { ok: false, reason: "probe_failed" };
    if (p.ok === false) return { ok: false, reason: "probe_failed" };
    if (p.visibilityState !== "visible") return { ok: false, reason: "hidden" };
    var lag = Number(p.lagMs);
    if (!isFinite(lag)) return { ok: false, reason: "probe_failed" };
    if (lag > PROBE_MAX_LAG_MS) return { ok: false, reason: "timer_throttled" };
    return { ok: true, reason: "ok" };
  }

  /** content script 側: 1秒のタイマーを置いて戻りの遅れを測った答えの形（startedAt → 戻った時刻） */
  function probeResult(visibilityState, startedAt, returnedAt) {
    var lag = (Number(returnedAt) || 0) - (Number(startedAt) || 0) - PROBE_TIMER_MS;
    return { ok: true, visibilityState: visibilityState || null, lagMs: Math.max(0, Math.round(lag)) };
  }

  /** 同時の時、2本目（ITANDI）を始めるまでのずらし（3〜15秒・毎回ちがう） */
  function laneStartOffsetMs(rng) {
    return Math.round(LANE_OFFSET_MIN_MS + _rand(rng) * LANE_OFFSET_RANGE_MS);
  }

  /**
   * 両方が終わるのを待つ上限（一番長い見張りの時間切れ × パスの数（地域→駅の2パスのお客様は2）＋パスの間＋2本目のずらし＋余裕）。
   *   deadlineOf(site) は snapshot-core passDeadlineMs。各本は自分の見張り（リアプロ20分・ITANDI 25分）で先に投げるので、これはその保険
   */
  var PASS_GAP_MAX_MS = 10 * 1000; // 地域→駅の切り替えの間（5〜10秒）
  function joinBudgetMs(lanes, deadlineOf, passes, offsetMs) {
    var list = Array.isArray(lanes) ? lanes : [];
    var max = 0;
    list.forEach(function (s) { var d = typeof deadlineOf === "function" ? Number(deadlineOf(s)) : 0; if (isFinite(d) && d > max) max = d; });
    var n = Math.max(1, Math.floor(Number(passes) || 1));
    var off = Math.max(0, Number(offsetMs) || 0);
    return (max || 20 * 60 * 1000) * n + PASS_GAP_MAX_MS * (n - 1) + off + JOIN_EXTRA_MS;
  }

  /** 見張りの「待っている物」を2本分の1行に（サイトの見え方: 名前: 待っている物 ／ 名前: …） */
  var SITE_JA = { realnetpro: "リアプロ", itandi: "itandi", reins: "レインズ" };
  function waitingForText(lanes) {
    var l = lanes || {};
    var parts = [];
    ["realnetpro", "itandi", "reins"].forEach(function (s) {
      var w = l[s];
      if (!w || w.done) return;
      parts.push((SITE_JA[s] || s) + ": " + (w.waitingFor || "?"));
    });
    return parts.join(" ／ ");
  }

  // ── 見張りの2本（background の _batchWatch.lanes）──────────────────────────────
  //   同時の回は、1回の検索の見張り（guardId・passStartedAt・待っている物・最後の合図・最後に進んだ時刻）をサイトごとに持つ。
  //   上の段（_batchWatch そのもの）は2本のまとめ: 待っている物＝waitingForText・最後に進んだ時刻＝**まだ終わっていない本の一番古い物**
  //   （片方が進んでいても、止まっている方の「動きなし」を隠さない）。止まりの写真・時間切れの文は laneView（その本を上に重ねた物）で作る

  /** 見張りの上の段を2本からまとめ直す（w を書き換えて返す・lanes が無ければそのまま） */
  function summarizeLanes(w, nowMs) {
    if (!w || !w.lanes || typeof w.lanes !== "object") return w;
    var active = [];
    ["realnetpro", "itandi", "reins"].forEach(function (s) { var l = w.lanes[s]; if (l && !l.done) active.push(s); });
    w.sites = active.slice();
    w.waitingFor = active.length ? waitingForText(w.lanes) : (w.waitingFor || null);
    if (active.length) {
      w.site = active[0];
      var oldest = null;
      active.forEach(function (s) { var t = Number(w.lanes[s].lastProgressAt); if (isFinite(t) && t > 0 && (oldest == null || t < oldest)) oldest = t; });
      w.lastProgressAt = oldest != null ? oldest : (Number(nowMs) || 0);
    }
    return w;
  }

  /** その本を上の段に重ねた物（describeStall・stallKey・写真の stall に使う）。本が無ければ上の段のまま */
  function laneView(w, site) {
    if (!w) return null;
    var l = w.lanes && site ? w.lanes[site] : null;
    if (!l) return w;
    var v = Object.assign({}, w, l);
    delete v.lanes;
    v.site = site;
    return v;
  }

  /** まだ終わっていない本それぞれの見え方（止まりの見張りが1本ずつ見る）。本が無ければ [w] */
  function activeLaneViews(w) {
    if (!w) return [];
    if (!w.lanes || typeof w.lanes !== "object") return [w];
    var out = [];
    ["realnetpro", "itandi", "reins"].forEach(function (s) { var l = w.lanes[s]; if (l && !l.done) out.push(laneView(w, s)); });
    return out;
  }

  /**
   * 両方が終わるのを待つ（合流）。lanes: [{ site, promise }]。
   *   ・どの本も投げない形で包む（片方の失敗がもう片方を止めない）→ 結果は site ごとの { ok, value | error, ms }
   *   ・budgetMs を過ぎたら待つのをやめる（timedOut: true・まだ終わっていない本の site を pending に）。見張りの時間切れが先に投げる前提の保険
   * @returns {Promise<{ results: Object, pending: string[], timedOut: boolean }>}
   */
  function joinLanes(lanes, budgetMs, timers) {
    // 既定のタイマーは包んで呼ぶ（Chrome は setTimeout を別の this で呼ぶと Illegal invocation）
    var T = timers || {
      setTimeout: function (f, ms) { return setTimeout(f, ms); },
      clearTimeout: function (h) { clearTimeout(h); },
      now: function () { return Date.now(); },
    };
    var list = Array.isArray(lanes) ? lanes : [];
    var results = {};
    var pending = {};
    var started = T.now();
    list.forEach(function (l) { pending[l.site] = true; });
    var wrapped = list.map(function (l) {
      return Promise.resolve(l.promise).then(
        function (v) { delete pending[l.site]; results[l.site] = { ok: true, value: v, ms: T.now() - started }; },
        function (e) { delete pending[l.site]; results[l.site] = { ok: false, error: e, ms: T.now() - started }; }
      );
    });
    return new Promise(function (resolve) {
      var finished = false;
      var timer = null;
      if (budgetMs && budgetMs > 0) {
        timer = T.setTimeout(function () {
          if (finished) return;
          finished = true;
          resolve({ results: results, pending: Object.keys(pending), timedOut: true });
        }, budgetMs);
      }
      Promise.all(wrapped).then(function () {
        if (finished) return;
        finished = true;
        if (timer != null) T.clearTimeout(timer);
        resolve({ results: results, pending: [], timedOut: false });
      });
    });
  }

  /** 判定の1行（ログ・点検の段） */
  var REASON_JA = {
    ok: "同時（別々の窓で両方とも前面・タイマーの間引きなし）",
    single_site: "1サイトだけ", disabled: "parallelSites=false（この PC は順）",
    same_window: "同じ窓（前面に出せるタブは1つ）", probe_failed: "見え方の実測に答えがない", hidden: "見えていない", timer_throttled: "タイマーが間引かれている",
  };
  function describeDecision(d) {
    var r = String((d && d.reason) || "");
    var head = r.split(":")[0], site = r.split(":")[1];
    var ja = REASON_JA[head] || (head === "no_tab" ? "タブが無い" : head === "tab_not_active" ? "タブが前面でない" : head === "tab_discarded" ? "タブが休止" : head === "window_minimized" ? "窓が最小化" : head);
    return (d && d.parallel ? "同時: " : "順（リアプロ → ITANDI）: ") + ja + (site ? "（" + (SITE_JA[site] || site) + "）" : "");
  }

  return {
    PROBE_TIMER_MS: PROBE_TIMER_MS, PROBE_MAX_LAG_MS: PROBE_MAX_LAG_MS, PROBE_WAIT_MS: PROBE_WAIT_MS, JOIN_EXTRA_MS: JOIN_EXTRA_MS, STORAGE_FLAG: STORAGE_FLAG,
    siteOfSenderUrl: siteOfSenderUrl, tabFor: tabFor, decideParallel: decideParallel, probeVerdict: probeVerdict, probeResult: probeResult,
    laneStartOffsetMs: laneStartOffsetMs, joinBudgetMs: joinBudgetMs, waitingForText: waitingForText, describeDecision: describeDecision,
    summarizeLanes: summarizeLanes, laneView: laneView, activeLaneViews: activeLaneViews, joinLanes: joinLanes,
  };
});
