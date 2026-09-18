// chrome-extension/search-history.js
// 「いつ・どのサイトを・どのモードで検索したか」の記録を1か所にまとめる（純関数＋保存の1関数）。
//
// 2026-09-18 竹内「物件検索と一括検索を条件広げて検索でもできるようにする。
//   また一括検索したお客さんも項目のところに日付と一括検索した日にちをいれるようにする」
//
// 調べて分かったこと（2つの依頼は同じ根だった）:
//   ・記録の仕組みは既にあった（property_customers.search_history に realpro_p/realpro_w …＝
//     サイト×モードごとの検索日時。顧客リストの RP/IT/RE の ✓ / P・広 グリッドがこれを描いている）
//   ・**書いているのは popup.js の個別検索だけ**。background.js の一括検索は search_history を
//     1行も書いていなかった → 一括検索しても行の日付が埋まらない
//   ・一括検索は _batchAutofill(customer, site, isWide) の isWide を**常に false** で呼んでいた
//     → 「広げて検索」で一括できない
//
// 設計知見「同じ判定は同じ関数・入口は1つにまとめる（四者同名）」に従い、
//   キーの作り方と保存を1か所に置いて popup.js（個別）と background.js（一括）の両方が使う。

(function (root) {
  "use strict";

  /** サイト名のゆれを search_history のキーに揃える（realnetpro も realpro も realpro_） */
  function siteKey(site) {
    var s = String(site || "").toLowerCase();
    if (s === "realnetpro" || s === "realpro" || s === "リアプロ") return "realpro";
    if (s === "itandi") return "itandi";
    if (s === "reins" || s === "レインズ") return "reins";
    return null;
  }

  /** モードの印（ピンポイント=p / 広げて=w） */
  function modeKey(isWide) {
    return isWide ? "w" : "p";
  }

  /** search_history に入れるキー（例: realpro_w） */
  function historyKey(site, isWide) {
    var k = siteKey(site);
    return k ? k + "_" + modeKey(isWide) : null;
  }

  /** そのモードの「最後に検索した日時」を入れる列（既存の2列と同じ） */
  function lastSearchField(isWide) {
    return isWide ? "last_wide_search_at" : "last_pinpoint_search_at";
  }

  /**
   * 既存の search_history に今回の検索を足した新しいオブジェクトを返す（純関数）。
   * 知らないサイトなら null（呼び出し側は保存しない）。
   */
  function withSearch(history, site, isWide, nowIso) {
    var key = historyKey(site, isWide);
    if (!key) return null;
    var next = Object.assign({}, history || {});
    next[key] = nowIso || new Date().toISOString();
    return next;
  }

  /**
   * 検索日時を保存する（個別検索・一括検索の共通の入口）。
   * ・失敗しても検索そのものは止めない（fire-and-forget・戻り値で成否だけ返す）
   * ・onSaved があれば、保存した値で手元の顧客データも更新できる
   */
  async function recordSearch(opts) {
    var apiBase = opts.apiBase || "https://sumora-ai-ui.vercel.app";
    var customer = opts.customer || {};
    var id = customer.id != null ? customer.id : opts.customerId;
    if (id == null) return { ok: false, reason: "no-id" };

    var nowIso = opts.nowIso || new Date().toISOString();
    var history = withSearch(customer.search_history, opts.site, opts.isWide, nowIso);
    if (!history) return { ok: false, reason: "unknown-site" };
    var field = lastSearchField(opts.isWide);

    var body = { id: id, search_history: history };
    body[field] = nowIso;

    try {
      var res = await fetch(apiBase + "/api/property-customers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return { ok: false, reason: "http-" + res.status };
      if (typeof opts.onSaved === "function") opts.onSaved(history, field, nowIso);
      return { ok: true, history: history, field: field, at: nowIso };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  var api = {
    siteKey: siteKey,
    modeKey: modeKey,
    historyKey: historyKey,
    lastSearchField: lastSearchField,
    withSearch: withSearch,
    recordSearch: recordSearch,
  };

  // Service Worker（background）・popup・Node のテストのどこからでも使えるようにする
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AxlxSearchHistory = api;
})(typeof self !== "undefined" ? self : globalThis);
