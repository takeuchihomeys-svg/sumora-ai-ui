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
  //   2026-09-29 v2.5.41 更新日の計画（payload.update_days_plan・サーバーが「前回の検索から空いた時間を覆う所まで」広げた値）:
  //     payloadForCustomer がそのお客様の分を _update_days に写した payload は、自動便（午前・午後）でも web_brain でも
  //     その値を popup の経路にも渡す（rp_update_days・null＝指定なしは rp_update_days_none）。計画の無い payload は今までどおり
  function optsFromPayload(payload) {
    var plan = decidedDays(payload);
    if (!isAuto(payload)) {
      if (!plan) return null;
      return { mode: null, rp_update_days: plan.days, rp_update_days_none: plan.days == null, sort: null, max_pages: null };
    }
    var pm = payload.mode === "pm";
    var days = payload.rp_update_days != null ? Number(payload.rp_update_days) : NaN;
    var pages = Number(payload.max_pages);
    return {
      mode: pm ? "pm" : "am",
      rp_update_days: plan ? plan.days : (pm && isFinite(days) && days > 0 ? days : null),
      rp_update_days_none: !!(plan && plan.days == null),
      sort: payload.sort === "updated" ? "updated" : (payload.sort === "ad" ? "ad" : null),
      max_pages: isFinite(pages) && pages > 0 ? Math.floor(pages) : null,
    };
  }

  /** payloadForCustomer が決めた更新日（{days}・days=null は指定なし）。無ければ null */
  function decidedDays(payload) {
    var d = payload && typeof payload === "object" ? payload._update_days : null;
    if (!d || typeof d !== "object") return null;
    var n = d.days == null ? null : Number(d.days);
    return { days: n != null && isFinite(n) && n > 0 ? Math.floor(n) : null };
  }

  /**
   * 2026-09-29 v2.5.41 命令の payload → このお客様の分（update_days_plan.by_customer[id].days を rp_update_days と _update_days に写す）。
   *   計画の無い命令・そのお客様の分が無い時は元の payload をそのまま返す（今までどおり）
   *   2026-09-30 点検の直し: 計画はサーバーが**積んだ時刻**（cron 10:00／16:00）で空いた時間を数えている。実際の検索は not_before
   *     （10:15〜11:15 のばらつき＋お客様の間）の後なので、積んだ時は 23時間でも検索する時は 25時間になり、1日以内では前回との間が漏れる
   *     （点検 search-audit-check の gap_uncovered は検索を始めた時刻で数える＝そちらと同じ時刻で決め直す）。
   *     e.last_search_at があれば**今の時刻で**要る日数を数え直し、広げるだけ（狭めない）。線は app/lib/search-update-days.ts と同じ（余裕 0.5時間・1/3/7/14・超えたら指定なし）
   */
  var UPDATE_CHOICES = [1, 3, 7, 14];
  var UPDATE_GRACE_HOURS = 0.5;
  function widenForNow(days, lastIso, nowMs) {
    if (days == null || !lastIso) return { days: days, widened: false, gap_hours: null };
    var t = Date.parse(lastIso);
    var now = Number(nowMs);
    if (!isFinite(t) || !isFinite(now) || t > now + 60000) return { days: days, widened: false, gap_hours: null };
    var gapH = Math.max(0, (now - t) / 3600000);
    var need = Math.max(1, Math.ceil(Math.max(0, gapH - UPDATE_GRACE_HOURS) / 24));
    if (days >= need) return { days: days, widened: false, gap_hours: gapH };
    var cover = null;
    for (var i = 0; i < UPDATE_CHOICES.length; i++) if (UPDATE_CHOICES[i] >= need) { cover = UPDATE_CHOICES[i]; break; }
    return { days: cover, widened: true, gap_hours: gapH };
  }
  function payloadForCustomer(payload, customerId, nowMs) {
    if (!payload || typeof payload !== "object" || customerId == null) return payload || null;
    var plan = payload.update_days_plan;
    var e = plan && plan.by_customer ? plan.by_customer[String(customerId)] : null;
    if (!e || typeof e !== "object" || !("days" in e)) return payload;
    var n = e.days == null ? null : Number(e.days);
    var days = n != null && isFinite(n) && n > 0 ? Math.floor(n) : null;
    var w = widenForNow(days, e.last_search_at || null, nowMs != null ? nowMs : Date.now());
    var out = Object.assign({}, payload);
    out.rp_update_days = w.days;
    out._update_days = {
      days: w.days, widened: !!e.widened || w.widened,
      gap_hours: w.gap_hours != null ? Math.round(w.gap_hours * 10) / 10 : (e.gap_hours == null ? null : Number(e.gap_hours)),
    };
    return out;
  }

  /**
   * storage に置く形（お客様×サイトの印付き）。
   *   2026-09-30 v2.5.43 extra.last_search_at＝このお客様×サイトの前回の検索の時刻（更新順の一覧で「前回より古い行」で止める線・update-order-stop.js）
   */
  function record(customerId, site, opts, nowMs, extra) {
    if (!opts || customerId == null) return null;
    var e = extra || {};
    return {
      customerId: String(customerId), site: String(site || ""), mode: opts.mode,
      rp_update_days: opts.rp_update_days, rp_update_days_none: !!opts.rp_update_days_none, sort: opts.sort, max_pages: opts.max_pages,
      last_search_at: e.last_search_at ? String(e.last_search_at) : null,
      at: Number(nowMs) || 0,
    };
  }

  /**
   * 2026-09-30 v2.5.43 同時の回（リアプロと ITANDI が同じお客様で並んで走る）: storage の鍵は1つなので、サイトごとの record を by_site に並べて置く。
   *   stored が旧の形（1つの record）でも、by_site の形でも受ける。rec が null なら stored のまま
   */
  function withSite(stored, rec) {
    if (!rec) return stored || null;
    var by = {};
    if (stored && typeof stored === "object") {
      if (stored.by_site && typeof stored.by_site === "object") Object.keys(stored.by_site).forEach(function (k) { by[k] = stored.by_site[k]; });
      else if (stored.site) by[String(stored.site)] = stored;
    }
    // 別のお客様の分は持ち越さない（同時の回は同じお客様だけ）
    Object.keys(by).forEach(function (k) { if (!by[k] || String(by[k].customerId) !== String(rec.customerId)) delete by[k]; });
    by[String(rec.site || "")] = rec;
    return { by_site: by, customerId: String(rec.customerId), at: Number(rec.at) || 0 };
  }

  /** storage の値が「このお客様（とサイト）の今の自動便」の物なら指定を返す。違う・古い・無い → null */
  function forCustomer(stored, customerId, site, nowMs) {
    if (!stored || typeof stored !== "object" || customerId == null) return null;
    // by_site の形（v2.5.43）: そのサイトの record を取り出して今までどおりに読む
    if (stored.by_site && typeof stored.by_site === "object") {
      var picked = site ? stored.by_site[String(site)] : null;
      if (!picked && !site) { var ks = Object.keys(stored.by_site); picked = ks.length ? stored.by_site[ks[0]] : null; }
      stored = picked || null;
      if (!stored) return null;
    }
    if (String(stored.customerId) !== String(customerId)) return null;
    if (site && stored.site && String(stored.site) !== String(site)) return null;
    var age = (Number(nowMs) || 0) - (Number(stored.at) || 0);
    if (!(age >= 0) || age > TTL_MS) return null;
    return { mode: stored.mode, rp_update_days: stored.rp_update_days, sort: stored.sort, max_pages: stored.max_pages, last_search_at: stored.last_search_at || null };
  }

  /**
   * 2026-09-30 v2.5.42 竹内「ページの上限は 5 ページまで上げる」: 一括の回（自動便・AIXツールの一括検索・広げての回）のページの上限（リアプロ・ITANDI とも）。
   *   ここ1か所（bulk-dl・itandi-bulk-dl が読む・サーバーの自動便 auto-search-schedule.ts の max_pages も 5・点検の cut_by_pages はこの値で打ち切った回）
   *   ITANDI は別に1回の物件数の上限（itandi-guard.js MAX_ROWS）もある
   */
  var DEFAULT_MAX_PAGES = 5;

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

  /**
   * 2026-09-30 v2.5.42 竹内「お客さん毎にリアプロと itandi 完了して、次のお客さんに移る…動き方もロボットみたいじゃなくて人間のように」:
   *   1人1コマンド（AIXツールの一括検索 web_brain・午前の便）の時、1人を終えてから次のコマンドを拾うまでの間（ミリ秒）。
   *   30秒おきの見回りのままだと「終わった直後に次の人」が機械的に続く → お客様の間（customerGapMs）と同じ幅で揺らす。
   *   ⚠ 間を足すだけで、サイトへのアクセス（検索・ページ・資料）の数は増やさない
   */
  function nextCommandGapMs(rng) {
    return customerGapMs(rng);
  }

  /** 1コマンドの中でサイトを並べる（同じお客様はリアプロ → ITANDI の順・無いサイトは足さない・重複は1つ・レインズは最後） */
  function orderSites(sites) {
    var list = Array.isArray(sites) ? sites : [];
    var rank = { realnetpro: 0, realpro: 0, itandi: 1, reins: 2 };
    var seen = {}, out = [];
    list.forEach(function (s) { var k = String(s || ""); if (k && !seen[k]) { seen[k] = 1; out.push(k); } });
    return out.sort(function (a, b) { return (rank[a] == null ? 9 : rank[a]) - (rank[b] == null ? 9 : rank[b]); });
  }

  /** 飛ばしたサイトを完了の記録に残す文（無ければ null） */
  function skippedNote(skippedSites) {
    var list = Array.isArray(skippedSites) ? skippedSites : [];
    if (!list.length) return null;
    return "ITANDI のタブが開いていない PC のため ITANDI は飛ばした（" + list.length + "件）";
  }

  return {
    STORAGE_KEY: STORAGE_KEY, TTL_MS: TTL_MS,
    isAuto: isAuto, optsFromPayload: optsFromPayload, record: record, withSite: withSite, forCustomer: forCustomer,
    payloadForCustomer: payloadForCustomer, decidedDays: decidedDays,
    pageLimit: pageLimit, allowAdSort: allowAdSort, DEFAULT_MAX_PAGES: DEFAULT_MAX_PAGES,
    planSites: planSites, hasItandiTab: hasItandiTab, orderSites: orderSites,
    siteGapMs: siteGapMs, customerGapMs: customerGapMs, nextCommandGapMs: nextCommandGapMs, skippedNote: skippedNote,
  };
});
