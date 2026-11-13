// chrome-extension/human-trace.js
// 2026-11-10 竹内「この画面の見張りの部分もちゃんと人間が動いているか確認もできるように」
//   「拡張が押した・打った」と「人が本当に押した・打った」を区別して数える共通の部品（UMD・chrome.* を使わない）。
//
// なぜ要るか:
//   案内モード（スタッフが押す）では、拡張は押さない。だから画面に人の操作が起きたかを数えれば
//   「本当に人が動いているか」を確かめられる（0 のままなら、誰も触っていない＝案内が止まっている）。
//   自動モードでも「人の操作」が混ざっていないか（スタッフが割り込んでいないか）を逆に見られる。
//
// 見分け方:
//   ブラウザが本当に人が起こしたイベントは isTrusted === true。拡張が dispatchEvent / el.click() で作った物は false。
//   （el.click() は isTrusted=false。ただし Playwright 等の自動化は true になる＝そこは区別できない）
//
// 残す物: 数（押した・打った・選んだ・スクロールした回数）と、最後の操作の種類・欄の名前・操作の間の平均（ms）。
//   **入力した中身（値）は残さない**（個人の情報を記録に載せない）。
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (root) { root.AxlxHumanTrace = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var MAX_OPS = 40;
  var SCROLL_QUIET_MS = 400; // スクロールは数が多いので 400ms に1回だけ数える

  /**
   * 数える器を作る（1ページに1つ）。
   * @param {{ now?: () => number }} opt
   */
  function create(opts) {
    var o = opts || {};
    var now = typeof o.now === "function" ? o.now : function () { return Date.now(); };
    var st = { n: 0, keys: 0, scroll: 0, clicks: 0, changes: 0, last_k: null, last_name: null, last_at: 0, gap: null, ops: [], _scrollAt: 0 };

    function push(kind, el) {
      var t = now();
      if (st.last_at) {
        var g = t - st.last_at;
        st.gap = st.gap == null ? g : Math.round(st.gap * 0.7 + g * 0.3); // 直近の間を重めに見る平均
      }
      st.n++;
      st.last_at = t;
      st.last_k = kind;
      if (kind === "click") st.clicks++;
      if (kind === "change") st.changes++;
      if (el && el.name) st.last_name = String(el.name).slice(0, 30);
      st.ops.push({ at: t, k: kind, n: st.n });
      if (st.ops.length > MAX_OPS) st.ops.shift();
    }

    /** その要素のイベントが人による物か（isTrusted === true だけ数える） */
    function trusted(e) { return !!(e && e.isTrusted); }

    /** 画面（document）に付ける。戻り値は外す関数 */
    function attach(doc, win) {
      var d = doc || (typeof document !== "undefined" ? document : null);
      var w = win || (typeof window !== "undefined" ? window : null);
      if (!d || !d.addEventListener) return function () {};
      var on = function (type, fn) { try { d.addEventListener(type, fn, true); } catch (_) {} };
      var onw = function (type, fn) { try { if (w && w.addEventListener) w.addEventListener(type, fn, true); } catch (_) {} };

      var hClick = function (e) { if (trusted(e)) push("click", e.target || {}); };
      var hKey = function (e) { if (trusted(e)) { st.keys++; push("key", e.target || {}); } };
      var hChange = function (e) { if (trusted(e)) push("change", e.target || {}); };
      var hWheel = function (e) { if (trusted(e)) { var t = now(); if (t - st._scrollAt >= SCROLL_QUIET_MS) { st._scrollAt = t; st.scroll++; push("scroll", null); } } };
      var hScroll = function () {
        // スクロール自体は isTrusted を持たないので、ホイール・キー（人の操作）から来た時だけ近い時刻で1回足す
        var t = now();
        if (t - st._scrollAt > 2500) return;
        if (t - st._scrollAt >= SCROLL_QUIET_MS) { st._scrollAt = t; st.scroll++; push("scroll", null); }
      };

      on("click", hClick);
      on("keydown", hKey);
      on("change", hChange);
      onw("wheel", hWheel);
      onw("touchmove", function (e) { if (trusted(e)) hWheel(e); });
      onw("scroll", hScroll);

      return function detach() {
        try { d.removeEventListener("click", hClick, true); d.removeEventListener("keydown", hKey, true); d.removeEventListener("change", hChange, true); } catch (_) {}
        try { if (w) { w.removeEventListener("wheel", hWheel, true); w.removeEventListener("scroll", hScroll, true); } } catch (_) {}
      };
    }

    /** 点検の記録に載せる形（入力の中身は入れない） */
    function snapshot() {
      return {
        n: st.n, clicks: st.clicks, changes: st.changes, keys: st.keys, scroll: st.scroll,
        last_k: st.last_k, last_name: st.last_name,
        last_at: st.last_at ? now() - st.last_at : null,
        avg_gap_ms: st.gap,
      };
    }

    function reset() {
      st.n = 0; st.keys = 0; st.scroll = 0; st.clicks = 0; st.changes = 0;
      st.last_k = null; st.last_name = null; st.last_at = 0; st.gap = null; st.ops = []; st._scrollAt = 0;
    }

    return { attach: attach, snapshot: snapshot, reset: reset, count: function () { return st.n; }, ops: function () { return st.ops.slice(); } };
  }

  /**
   * 点検の記録から「人が動いていたか」を判定する（純関数）。見張りの画面でも同じ線で出す。
   * @returns {{ level: "human"|"auto"|"none"|"unknown", ja: string }}
   *   human   … 人の操作がある（案内モードならこれが正常）
   *   auto    … 人の操作が無い（拡張だけが動いた＝自動モードなら正常・案内モードなら止まっている疑い）
   *   none    … 記録が無い
   */
  function judge(human, guideMode) {
    if (!human || typeof human !== "object") return { level: "unknown", ja: "人が動いたかの記録が無い" };
    var n = Number(human.n) || 0;
    if (n > 0) return { level: "human", ja: "人が操作している（" + n + "回）" };
    return guideMode
      ? { level: "none", ja: "人の操作が0回（案内モードなのに誰も触っていない＝止まっている疑い）" }
      : { level: "auto", ja: "拡張だけで動いている（人の操作 0回）" };
  }

  return { create: create, judge: judge, MAX_OPS: MAX_OPS, SCROLL_QUIET_MS: SCROLL_QUIET_MS };
});
