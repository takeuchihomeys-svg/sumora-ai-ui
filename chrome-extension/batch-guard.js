// chrome-extension/batch-guard.js（self.AxlxBatchGuard・純関数・chrome.* を使わない）
// 一括検索（AIXツールの一括検索 web_brain・自動便・手動の一括）で「検索していないのに検索したことにする」を防ぐ決まり。
//
// 2026-09-27 竹内「リアプロログインした／重い順から治す」（YUMA のテスト顧客・点検 24／26）:
//   ① 拡張を読み直した後・ログインし直した後、開いていたリアプロのタブの中身（content.js・page-script.js）が動かないまま使われ、
//      90秒の fill-done 待ちで時間切れになっていた（点検 24 は switch-customer が即失敗／点検 26 は popup は応答したがページが一度も動かない）。
//      → 使う前にタブを確かめ（main.php か・content.js が応答するか・page-script が応答するか）、だめなら main.php を開き直す。
//        入力を始めた合図（fill-started）が来ない時もタブを読み直して1回だけやり直す
//   ② 代わりの入力の経路（popup に届かない時の直接入力）が地域を決める前に条件をページへ渡していた（page-script は区のお客様で
//      city_codes が無いと場所なし＝全件検索になる）→ 先に地域を決め、地域が空なら検索しない（locationGate）
//   ④ 失敗した回はピックアップ用グループに1回知らせる（failureNotice・0件と言わない）
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AxlxBatchGuard = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var REALPRO_MAIN_RE = /^https:\/\/(?:www\.)?realnetpro\.com\/main\.php/;
  var REALPRO_ANY_RE = /^https:\/\/(?:www\.)?realnetpro\.com\//;

  /** リアプロのタブのうち使う物: main.php（content.js・page-script.js が入るのはここだけ）を先に。無ければ他のリアプロのページ */
  function pickRealproTab(tabs) {
    var list = Array.isArray(tabs) ? tabs : [];
    var main = null, any = null;
    for (var i = 0; i < list.length; i++) {
      var u = list[i] && typeof list[i].url === "string" ? list[i].url : "";
      if (!main && REALPRO_MAIN_RE.test(u)) main = list[i];
      if (!any && REALPRO_ANY_RE.test(u)) any = list[i];
    }
    return main || any || null;
  }

  /**
   * そのタブをそのまま使うか・開き直すか。probe = { url, pong, page }
   *   pong: content.js が axlx-ping に答えたか（拡張を読み直した後の古いタブは答えない）
   *   page: page-script.js が答えたか（true/false・古い content.js は page を返さない＝null は「分からない」で使う）
   */
  function realproTabPlan(probe) {
    var p = probe || {};
    var url = typeof p.url === "string" ? p.url : "";
    if (!REALPRO_MAIN_RE.test(url)) return { action: "reload", reason: url ? "not_main_php" : "no_url" };
    if (!p.pong) return { action: "reload", reason: "content_script_dead" };
    if (p.page === false) return { action: "reload", reason: "page_script_dead" };
    // 2026-09-27 点検 26: 生きていても背面のタブ（hidden）は Chrome がタイマーを間引き、入力に約10分かかった（fill-done の90秒に間に合わない）
    //   → そのタブを前に出してから入力させる（front）。vis が分からない古い content.js は前に出さない
    return { action: "use", reason: "alive", front: p.vis === "hidden" };
  }

  var REASON_JA = {
    not_main_php: "検索の画面（main.php）ではない",
    no_url: "タブの場所が分からない",
    content_script_dead: "拡張の中身が応答しない（拡張の読み直しの後にページを読み直していない等）",
    page_script_dead: "ページの入力の仕組みが応答しない",
    alive: "応答あり",
  };
  function reasonJa(reason) { return REASON_JA[reason] || String(reason || ""); }

  /**
   * 地域が決まっているか（page-script.js の decideLocationMode と同じ決まり）。
   *   ward（地域）: city_codes か detail_ward／station（駅）: station_names か route_ids／指定なし: どれか1つ
   *   none ＝ 場所なし＝リアプロでは大阪府の全件検索になる → 検索しない
   */
  function locationGate(c) {
    c = c || {};
    var nonEmpty = function (a) { return Array.isArray(a) && a.length > 0; };
    var hasArea = nonEmpty(c.city_codes) || !!c.detail_ward;
    var hasStation = nonEmpty(c.station_names), hasRoute = nonEmpty(c.route_ids);
    var mode;
    if (c.area_mode === "ward") mode = hasArea ? "area" : "none";
    else if (c.area_mode === "station") mode = hasStation ? "station" : hasRoute ? "route" : "none";
    else mode = hasStation ? "station" : hasRoute ? "route" : hasArea ? "area" : "none";
    return { ok: mode !== "none", mode: mode };
  }

  /**
   * 失敗した回の知らせ（ピックアップ用グループ・1回だけ）。止めた回（__BATCH_STOPPED__）は知らせない（null）。
   *   「0件」とは言わない（検索できていない）。理由は短い日本語に（内部のメッセージは載せない）
   */
  function failureNotice(input) {
    var i = input || {};
    var msg = String((i.error && i.error.message) || i.error || "");
    if (msg === "__BATCH_STOPPED__") return null;
    var name = String(i.customerName || "").trim();
    if (!name) return null;
    var site = i.siteLabel || "リアプロ";
    var why;
    if (/AXLX_TAB_DEAD|タブが応答しません/.test(msg)) why = "リアプロのタブが応答しません（読み直してもだめでした）";
    else if (/AXLX_NO_FILL_START|入力を始めませんでした/.test(msg)) why = "ページが条件の入力を始めませんでした（読み直して1回やり直してもだめでした）";
    else if (/AXLX_NO_LOCATION|地域を決められない/.test(msg)) why = "希望エリアから地域を決められませんでした（全件検索を防ぐため検索していません）";
    else if (/fill-done/.test(msg)) why = "条件の入力が時間内に終わりませんでした。ページが遅れて検索を続け、後から物件が届くことがあります";
    else if (/watchdog|85秒/.test(msg)) why = "条件の入力が途中で止まりました";
    else if (/Cannot access contents of the page/.test(msg)) why = "リアプロのページに触れませんでした（ログイン切れ・エラーのページの可能性）";
    else why = "途中で止まりました";
    return "⚠【検索できなかった】" + name + "さんの" + site + "検索ができませんでした（" + why + "・0件とは限りません）";
  }

  return {
    pickRealproTab: pickRealproTab,
    realproTabPlan: realproTabPlan,
    reasonJa: reasonJa,
    locationGate: locationGate,
    failureNotice: failureNotice,
    /** 入力を始めた合図（fill-started）を待つ長さ。popup は登録の条件の読み直しを最長6秒・人の間 0.8〜1.2秒待ってから押す */
    FILL_START_TIMEOUT_MS: 25000,
  };
});
