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
   * v2.5.48 命令を拾いに行く前に: リアプロのタブが検索の画面（main.php）か。
   *   true＝main.php のタブがある／false＝リアプロのタブはあるが main.php が1つも無い（ログインの画面等）／null＝リアプロのタブが無い（分からない＝今まで通り）
   *   false の時だけ /api/automation/pending に rp=0 を付ける（サーバーがリアプロを含む手の命令を少しの間ほかの PC に譲る）
   */
  function realproReady(tabs) {
    var list = Array.isArray(tabs) ? tabs : [];
    var any = false;
    for (var i = 0; i < list.length; i++) {
      var u = list[i] && typeof list[i].url === "string" ? list[i].url : "";
      if (REALPRO_MAIN_RE.test(u)) return true;
      if (REALPRO_ANY_RE.test(u)) any = true;
    }
    return any ? false : null;
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

  // ── v2.5.45 ITANDI のタブ（旧は itandibb.com の最初のタブをそのまま使っていた＝物件の詳細・ログインの画面でも入力を始めた）──
  var ITANDI_LIST_RE = /^https:\/\/itandibb\.com\/rent_rooms\/list(?:[?#/]|$)/;
  var ITANDI_ANY_RE = /^https:\/\/itandibb\.com\//;
  /** ITANDI のタブのうち使う物: 検索の一覧（/rent_rooms/list）を先に。無ければ他の ITANDI のページ */
  function pickItandiTab(tabs) {
    var list = Array.isArray(tabs) ? tabs : [];
    var hit = null, any = null;
    for (var i = 0; i < list.length; i++) {
      var u = list[i] && typeof list[i].url === "string" ? list[i].url : "";
      if (!hit && ITANDI_LIST_RE.test(u)) hit = list[i];
      if (!any && ITANDI_ANY_RE.test(u)) any = list[i];
    }
    return hit || any || null;
  }
  /**
   * ITANDI のタブをそのまま使うか・一覧を開き直すか。probe = { url, pong, list }
   *   pong: itandi-content.js が axlx-ping に答えたか（拡張を読み直した後の古いタブは答えない）
   *   list: 答えた中身が一覧の場所か（無い＝古い版は url だけで見る）
   */
  function itandiTabPlan(probe) {
    var p = probe || {};
    var url = typeof p.url === "string" ? p.url : "";
    if (!url) return { action: "reload", reason: "no_url" };
    if (!ITANDI_LIST_RE.test(url)) return { action: "reload", reason: "not_itandi_list" };
    if (!p.pong) return { action: "reload", reason: "content_script_dead" };
    if (p.list === false) return { action: "reload", reason: "not_itandi_list" };
    // v2.5.48: 背面のタブ（hidden）は Chrome がタイマーを間引く → 前に出してから入力させる（リアプロの front と同じ・vis が無い古い中身は出さない）
    //   2026-09-30 YUMA（順の回）: 背面のまま資料を3件取った所で「物件資料出力」の窓が開いたまま止まり、5分無進捗
    return { action: "use", reason: "alive", front: p.vis === "hidden" };
  }

  var REASON_JA = {
    not_itandi_list: "ITANDI の検索の画面（賃貸の部屋の一覧）ではない（物件の詳細・ログインの画面等）",
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
    // 2026-09-29 v2.5.40 見張り（1回の検索の上限）で閉じて次のお客様へ進んだ回。
    //   見張りの文は「待っていた物=検索の完了（fill-done）…・最後の合図=fill-done」を含むので、fill-done の判定より先に見る
    if (/__PASS_DEADLINE__|見張りの時間切れ/.test(msg)) why = "1回の検索が上限の時間を過ぎたので次のお客様へ進みました（画面の写真を AIXツールの「🔍 検索の点検」→「📷 拡張の画面」に残しています）";
    else if (/AXLX_TAB_DEAD|タブが応答しません/.test(msg)) why = /ITANDI/.test(msg) ? "ITANDI のタブが検索の画面になりません（一覧を開き直してもだめでした・ログイン切れの可能性）" : "リアプロのタブが応答しません（読み直してもだめでした）";
    // v2.5.45 ITANDI の検索のボタンが押せなかった（入力の誤り・3,000件超）。理由は page-script の日本語のまま
    // v2.5.46 ITANDI の前のお客様の条件を外せなかった（欄の名前は page-script の日本語のまま）→ 混ざった条件で検索しないで飛ばした
    else if (/AXLX_RESET_FAILED/.test(msg)) why = "前のお客様の条件を画面から外せませんでした（" + (msg.split("AXLX_RESET_FAILED:")[1] || "").trim().slice(0, 70) + "）";
    else if (/AXLX_SEARCH_BLOCKED/.test(msg)) why = "検索のボタンが押せませんでした（" + (msg.split("AXLX_SEARCH_BLOCKED:")[1] || "").trim().slice(0, 60) + "）";
    else if (/AXLX_NO_FILL_START|入力を始めませんでした/.test(msg)) why = "ページが条件の入力を始めませんでした（読み直して1回やり直してもだめでした）";
    else if (/AXLX_NO_LOCATION|地域を決められない/.test(msg)) why = "希望エリアから地域を決められませんでした（全件検索を防ぐため検索していません）";
    else if (/fill-done/.test(msg)) why = "条件の入力が時間内に終わりませんでした。ページが遅れて検索を続け、後から物件が届くことがあります";
    else if (/watchdog|85秒/.test(msg)) why = "条件の入力が途中で止まりました";
    else if (/Cannot access contents of the page/.test(msg)) why = "リアプロのページに触れませんでした（ログイン切れ・エラーのページの可能性）";
    else why = "途中で止まりました";
    return "⚠【検索できなかった】" + name + "さんの" + site + "検索ができませんでした（" + why + "・0件とは限りません）";
  }

  // ── v2.5.49 物件の付け先（送る相手）の見張り ──
  // 2026-09-30 竹内「監視のところでちゃんと入り込まんように対策する／お客さんの名前ずれてないか監視する」:
  //   v2.5.47 までは ITANDI の物件が「検索したお客様」でなく前のお客様に付いた（16:39〜19:02 の 161件・未送信のうちに外した）。
  //   v2.5.48 で送る側（itandi-bulk-dl）は一括の回のお客様で送るようにしたが、それは同じ所の中の直し＝また別の経路でずれても気づけない。
  //   ここは送信の出口（background の callMergeApi・3サイト共通）で、別の材料＝「今この PC がそのサイトで検索している回のお客様」
  //   （_batchWatch・同時の回は lanes[site]）と照らす。一括の回が走っていない時（手の検索・スタッフの送信）は何も見ない。
  function siteKey(s) {
    var v = String(s || "").toLowerCase();
    if (/itandi/.test(v)) return "itandi";
    if (/real/.test(v)) return "realnetpro";
    if (/reins/.test(v)) return "reins";
    return v || null;
  }
  /**
   * @param watch  background の _batchWatch（{ customerId, customerName, site, runId, commandId, lanes? }）
   * @param alive  一括の回が走っているか（_batchLoopAlive）
   * @param site   送ろうとしている物のサイト
   * @param customerId 送ろうとしている相手
   * @returns { batch:false } ＝見ない ／ { batch:true, ok, fill, ownerId, ownerName, runId, commandId, reason }
   *   ok:false（mismatch）＝送らない。fill:true ＝相手が空だったので回のお客様で送る
   */
  function normName(s) {
    var v = String(s == null ? "" : s);
    try { v = v.normalize("NFKC"); } catch (_) {}
    return v.replace(/(さん|様)\s*$/, "").replace(/[\s　]+/g, "");
  }
  /** 相手の ID は同じだが、見出しに載せる名前が回のお客様の名前と違う（名前ずれ）。どちらかが空なら見ない */
  function nameDrift(ownerName, sendName) {
    var a = normName(ownerName), b = normName(sendName);
    return !!a && !!b && a !== b;
  }
  function sendOwner(watch, alive, site, customerId) {
    if (!alive || !watch) return { batch: false, ok: true };
    var k = siteKey(site);
    if (!k) return { batch: false, ok: true };
    var w = null;
    if (watch.lanes) {
      for (var key in watch.lanes) {
        if (Object.prototype.hasOwnProperty.call(watch.lanes, key) && siteKey(key) === k && watch.lanes[key] && !watch.lanes[key].done) w = watch.lanes[key];
      }
    }
    if (!w && siteKey(watch.site) === k) w = watch;
    if (!w || !w.customerId) return { batch: false, ok: true };
    var base = { batch: true, ownerId: String(w.customerId), ownerName: w.customerName || null, runId: w.runId || null, commandId: w.commandId || null };
    if (!customerId) return Object.assign(base, { ok: true, fill: true, reason: "no_customer" });
    var same = String(customerId) === base.ownerId;
    return Object.assign(base, { ok: same, fill: false, reason: same ? null : "mismatch" });
  }

  return {
    siteKey: siteKey,
    sendOwner: sendOwner,
    nameDrift: nameDrift,
    pickRealproTab: pickRealproTab,
    pickItandiTab: pickItandiTab,
    itandiTabPlan: itandiTabPlan,
    realproTabPlan: realproTabPlan,
    realproReady: realproReady,
    reasonJa: reasonJa,
    locationGate: locationGate,
    failureNotice: failureNotice,
    /** 入力を始めた合図（fill-started）を待つ長さ。popup は登録の条件の読み直しを最長6秒・人の間 0.8〜1.2秒待ってから押す */
    FILL_START_TIMEOUT_MS: 25000,
  };
});
