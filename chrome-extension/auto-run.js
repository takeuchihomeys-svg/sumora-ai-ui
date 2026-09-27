// chrome-extension/auto-run.js（self.AxlxAutoRun・純関数・chrome.* を使わない）
// 時刻起動の自動便（payload.source="auto_schedule"・/api/cron/auto-property-search が積む）の決まりを1か所に。
//
// 2026-09-27 竹内「ITANDI もおねがい」「開始時間を…ランダムに不規則性をもって毎日変える」:
//   ① 自動便はリアプロと ITANDI の両方（コマンドの sites）。同じお客様はリアプロ → ITANDI と続けて走る。
//      ITANDI のタブが開いていない PC では ITANDI の分だけ飛ばす（新しくタブを開かない・失敗と数えない）＝planSites
//   ② サイトの間・お客様の間は人の動きのようにばらつかせる（多くは短め・時々長い一息）＝siteGapMs / customerGapMs
//   ③ 便の指定（午後の便＝更新日1日以内・更新順・1ページ／午前の便＝3ページ）が popup を通る経路でも届くように、
//      background が「今このお客様×サイトは自動便のこの指定」を storage に置き（record）、
//      popup（switch-customer の autoRun）・bulk-dl.js・itandi-bulk-dl.js が読む（forCustomer）
//      ※ 旧は payload の指定が popup を通らない直接入力の経路にしか届かず、popup の経路（ほぼ毎回）では
//        更新日＝人ごと・AD 順・3ページのままだった（bulk-dl はいつも AD 高い順に並べ替え、conditions は文字列で max_pages が読めない）
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AxlxAutoRun = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var STORAGE_KEY = "axlx_auto_run";
  /** storage に置いた指定を信じる長さ（1人×1サイトの検索は長くても 90秒＋5分の待ち） */
  var TTL_MS = 20 * 60 * 1000;

  function _rand(rng) {
    var r = (typeof rng === "function") ? rng() : Math.random();
    if (!(r >= 0)) r = 0;
    if (r >= 1) r = 0.999999;
    return r;
  }

  /** 自動便の payload か */
  function isAuto(payload) {
    return !!(payload && typeof payload === "object" && payload.source === "auto_schedule");
  }

  /**
   * 自動便の payload → 検索に当てる指定。自動便でなければ null（手動・AIX・web_brain は今までどおり）。
   *   rp_update_days … 午後の便だけ上書き（全員「本日の更新日付」＝1）。午前の便は null＝popup が今までどおり
   *                    （手で決めた更新日 → 無ければ前回物件を出した日から＝サーバーの計算と同じ線）
   *   sort           … "updated"（午後・更新順）／"ad"（午前・AD 高い順）
   *   max_pages      … 午後 1・午前 3
   */
  function optsFromPayload(payload) {
    if (!isAuto(payload)) return null;
    var pm = payload.mode === "pm";
    var days = payload.rp_update_days != null ? Number(payload.rp_update_days) : NaN;
    var pages = Number(payload.max_pages);
    return {
      mode: pm ? "pm" : "am",
      rp_update_days: pm && isFinite(days) && days > 0 ? days : null,
      sort: payload.sort === "updated" ? "updated" : (payload.sort === "ad" ? "ad" : null),
      max_pages: isFinite(pages) && pages > 0 ? Math.floor(pages) : null,
    };
  }

  /** storage に置く形（お客様×サイトの印付き） */
  function record(customerId, site, opts, nowMs) {
    if (!opts || customerId == null) return null;
    return {
      customerId: String(customerId), site: String(site || ""), mode: opts.mode,
      rp_update_days: opts.rp_update_days, sort: opts.sort, max_pages: opts.max_pages,
      at: Number(nowMs) || 0,
    };
  }

  /** storage の値が「このお客様（とサイト）の今の自動便」の物なら指定を返す。違う・古い・無い → null */
  function forCustomer(stored, customerId, site, nowMs) {
    if (!stored || typeof stored !== "object" || customerId == null) return null;
    if (String(stored.customerId) !== String(customerId)) return null;
    if (site && stored.site && String(stored.site) !== String(site)) return null;
    var age = (Number(nowMs) || 0) - (Number(stored.at) || 0);
    if (!(age >= 0) || age > TTL_MS) return null;
    return { mode: stored.mode, rp_update_days: stored.rp_update_days, sort: stored.sort, max_pages: stored.max_pages };
  }

  /** ページの上限（指定が無ければ既定＝今までどおり） */
  function pageLimit(opts, fallback) {
    var n = opts && Number(opts.max_pages);
    return (isFinite(n) && n > 0) ? Math.floor(n) : (fallback == null ? null : fallback);
  }

  /** リアプロの結果を AD 高い順へ並べ替えてよいか（午後の便＝更新順の時は並べ替えない） */
  function allowAdSort(opts) {
    return !(opts && opts.sort === "updated");
  }

  /**
   * この回に回すサイト。自動便で ITANDI のタブが無い時だけ ITANDI を飛ばす（自動便でなければ今までどおり＝無ければ開く）。
   * @returns {{ sites: string[], skipped: Array<{site: string, why: string}> }}
   */
  function planSites(sites, ctx) {
    var list = Array.isArray(sites) ? sites.slice() : [];
    var c = ctx || {};
    var out = [], skipped = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (c.isAuto && s === "itandi" && !c.hasItandiTab) { skipped.push({ site: s, why: "no_itandi_tab" }); continue; }
      out.push(s);
    }
    return { sites: out, skipped: skipped };
  }

  /** 開いているタブの中に ITANDI の画面があるか */
  function hasItandiTab(tabs) {
    var list = Array.isArray(tabs) ? tabs : [];
    for (var i = 0; i < list.length; i++) {
      var u = list[i] && typeof list[i].url === "string" ? list[i].url : "";
      if (/^https:\/\/itandibb\.com\//.test(u)) return true;
    }
    return false;
  }

  /**
   * 同じお客様のリアプロ → ITANDI の間（ミリ秒）。人が次のサイトのタブに移って見る間:
   *   多くは 8〜28秒、7回に1回くらい 40〜95秒の一息
   */
  function siteGapMs(rng) {
    var breath = _rand(rng) < 0.14;
    var r = _rand(rng);
    return breath ? Math.round(40000 + r * 55000) : Math.round(8000 + r * 20000);
  }

  /**
   * 自動便のお客様の間（ミリ秒・1コマンドで何人も回す午後の便）。人が次のお客様を開いて条件を見る間:
   *   多くは 15〜60秒、6回に1回くらい 90〜200秒の一息（旧は 3〜8秒の一様乱数）
   */
  function customerGapMs(rng) {
    var breath = _rand(rng) < 0.16;
    var r = _rand(rng);
    return breath ? Math.round(90000 + r * 110000) : Math.round(15000 + r * 45000);
  }

  /** 飛ばしたサイトを完了の記録に残す文（無ければ null） */
  function skippedNote(skippedSites) {
    var list = Array.isArray(skippedSites) ? skippedSites : [];
    if (!list.length) return null;
    return "ITANDI のタブが開いていない PC のため ITANDI は飛ばした（" + list.length + "件）";
  }

  return {
    STORAGE_KEY: STORAGE_KEY, TTL_MS: TTL_MS,
    isAuto: isAuto, optsFromPayload: optsFromPayload, record: record, forCustomer: forCustomer,
    pageLimit: pageLimit, allowAdSort: allowAdSort,
    planSites: planSites, hasItandiTab: hasItandiTab,
    siteGapMs: siteGapMs, customerGapMs: customerGapMs, skippedNote: skippedNote,
  };
});
