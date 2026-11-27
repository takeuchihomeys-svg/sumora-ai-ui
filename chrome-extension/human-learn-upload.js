// chrome-extension/human-learn-upload.js
// 2026-11-11 竹内さん「データベース等にはいっているのか」→ まだ入っていなかった（PC の中だけ）。
//
// 通常モード・スタッフモードで覚えた人の動きを **/api/human-motion に送って DB に残す**。
//   送るのは**数と傾向だけ**（速さ・曲がり・押した位置・スクロール量・間・欄の名前）。
//   ⚠ 入力した中身（文字・数字）・お客様の名前・電話・住所は送らない。
//   ⚠ 画面の写真も**この表には入れない**（撮るなら Storage に置き、置いた場所の名前だけ送る）。
//
// 送るタイミング: 学習の記録が増えた時（storage の axlx_human_learn が変わった時）に、
//   前回送ってから一定時間たっていれば1回送る（1分ごと・送りすぎない）。
//   送れたら「この分は送った」と印（axlx_human_learn_uploaded_at）を残す。
(function () {
  "use strict";
  if (window.__axlxHumanLearnUpload) return;
  window.__axlxHumanLearnUpload = true;

  var KEY = "axlx_human_learn";
  var SENT_KEY = "axlx_human_learn_uploaded_at";
  var MIN_GAP_MS = 5 * 60 * 1000;   // 前回の送信から5分は送らない（サーバーを叩きすぎない）
  var ENDPOINT = "/api/human-motion";
  function _siteNow() {
    try {
      var h = String((typeof location !== "undefined" && location && location.hostname) || "");
      if (/realnetpro/.test(h)) return "realpro";
      if (/itandibb/.test(h)) return "itandi";
      if (/reins/.test(h)) return "reins";
    } catch (_) {}
    return "unknown";
  }
  function _siteKey(base, s) {
    var v = String(s || _siteNow() || "");
    return (v && v !== "unknown") ? (base + "__" + v) : base;
  }
  var SITE = _siteNow();
  var SITE_KEY = _siteKey(KEY, SITE);
  var SITE_SENT_KEY = _siteKey(SENT_KEY, SITE);

  function apiBase() {
    try {
      var r = (typeof self !== "undefined" ? self : window);
      var v = r.AXLX_API_BASE;
      if (v) return String(v).replace(/\/$/, "");
    } catch (_) {}
    return "https://sumora-ai-ui.vercel.app";
  }

  var _sending = false;
  function _isAllowedSiteField(k) {
    if (typeof k !== "string" || !k) return false;
    var s = k.trim();
    if (!s || s.indexOf("[object ") >= 0) return false;
    if (SITE === "realpro") {
      // リアプロの必須固有キーは通す。ITANDI 固有（#_r_ / css- / itandi-bb-ui / colon演算子）およびゴミを落とす
      if (/^#?_r_[a-z0-9_]+_(?:｜|$)|css-[a-z0-9]{4,}|itandi-bb-ui|:(?:lteq|gteq|eq|in|match|not_eq)/i.test(s)) return false;
      if (/^[-ー－_・=|]{2,}$|^(input|select|textarea|button|a|span|div|label|iframe|id)$/i.test(s)) return false;
    } else if (SITE === "itandi") {
      if (/^(?:eq_rm|city_code|town_code|route_id|station_id|room_layout_id|struct_id|exclusive_area)\[|^rental_cost[12]$|^structured_date$|^#(?:top_free|main_form)$|\.(?:one_city|one_town|one_line|one_station|go_search)(?:[^a-zA-Z0-9_]|$)|駅の設定へ進む|沿線の設定へ戻る|確定してリストへ|沿線・駅絞り込み|所在地絞り込み/.test(s)) return false;
      if (/^[-ー－_・=|]{2,}$|^(input|select|textarea|button|a|span|div|label|iframe|id)$/i.test(s) || /路線・駅選択都道府県/.test(s)) return false;
    }
    return true;
  }
  function _clampMotionForUpload(agg) {
    if (!agg || typeof agg !== "object") return agg;
    try {
      var out = Object.assign({}, agg);
      if (out.points && typeof out.points === "object" && out.points.fields && typeof out.points.fields === "object") {
        var cleanPf = {};
        Object.keys(out.points.fields).slice(0, 60).forEach(function (k) {
          if (!_isAllowedSiteField(k)) return;
          var v = out.points.fields[k];
          if (!v || typeof v !== "object") return;
          var nv = Number(v.n) || 0;
          if (nv <= 0) return;
          cleanPf[k] = Object.assign({}, v, { n: Math.min(200, Math.round(nv)) });
        });
        out.points = Object.assign({}, out.points, { fields: cleanPf, n: Math.min(500, Number(out.points.n) || Object.keys(cleanPf).length) });
      }
      return out;
    } catch (_) { return agg; }
  }
  function upload(agg, opts) {
    if (_sending || !agg || !agg.n) return;
    var o = opts || {};
    _sending = true;
    // 鍵は background が持っている（画面側には出さない）
    try {
      chrome.runtime.sendMessage({
        type: "axlx-human-motion",
        motion: _clampMotionForUpload(agg),
        site: o.site || agg.site || null,
        mode: o.mode || null,
        shot_taken: !!o.shot_taken,
        shot_key: o.shot_key || null,
        shot_w: o.shot_w || null,
        shot_h: o.shot_h || null,
      }, function () { void chrome.runtime.lastError; _sending = false; });
    } catch (_) { _sending = false; }
  }

  /**
   * 2026-11-11: 今のモード（通常／スタッフ）を読む。DB の `mode` が空だったのを直す。
   * 2026-11-14 竹内さん「通常と自動のところで自動で強化必要な部分強化する」:
   *   ⚠ 旧は `staffMode` しか見ておらず、**通常／自動／AIX／ブレインの区別が付かなかった**
   *     （実測: DB の mode が全部空）。→ どのモードの動きかを学べず、
   *     「自動の時に必要な強化」と「通常の時の学び」を分けられなかった。
   *   → `AxlxModeCore`（モードの正本）から読む。読めなければ今まで通り staff／normal。
   */
  function _modeNow(cb) {
    try {
      var core = self.AxlxModeCore || null;
      var keys = (core && core.STORAGE_KEYS) || ["staffMode", "staffModeAt", "aixMode", "aiMode", "brainMode", "autoModeAt"];
      chrome.storage.local.get(keys, function (r) {
        var s = r || {};
        try {
          if (core && core.readState) {
            var st = core.readState(s, Date.now());
            /** normal / staff / aix / brain×aix を1語に（DB の mode 列にそのまま入る） */
            var m = String(st && st.mode ? st.mode : "normal");
            cb(m);
            return;
          }
        } catch (_) { /* 読めなければ下の従来の判定 */ }
        var at = s.staffModeAt || 0;
        var staffOn = !!s.staffMode && (!at || Date.now() - at <= 2 * 60 * 60 * 1000);
        cb(staffOn ? "staff" : "normal");
      });
    } catch (_) { cb("normal"); }
  }

  /** 貯まった物を読んで、必要なら送る */
  function maybeUpload() {
    try {
      chrome.storage.local.get([SITE_KEY, SITE_SENT_KEY], function (r) {
        var agg = r && r[SITE_KEY];
        if (!agg || !agg.n) return;
        // サイト不一致の古いデータがあれば送らない
        if (SITE !== "unknown" && agg.site && agg.site !== SITE) return;
        var last = Number(r && r[SITE_SENT_KEY]) || 0;
        if (last && Date.now() - last < MIN_GAP_MS) return;
        // 送った印は先に置く（同じ分を2回送らない）
        var o = {}; o[SITE_SENT_KEY] = Date.now();
        try { chrome.storage.local.set(o); } catch (_) {}
        _modeNow(function (m) { upload(agg, { site: (SITE !== "unknown" ? SITE : agg.site), mode: m }); });
      });
    } catch (_) {}
  }

  // 学習の記録が増えたら送る（1分ごとの書き出しの後・自サイトキーのみ監視）
  try {
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== "local" || !ch || !ch[SITE_KEY] || !ch[SITE_KEY].newValue) return;
      maybeUpload();
    });
  } catch (_) {}

  // 画面を開いた時にも1回（前回送れていなければここで送る）
  //   2026-11-11: 固定の待ちは使わない（人の操作の間は human-wait を通す決まり）。
  //     学習の記録がまだ書かれていないだけなので、人の間（humanDelay）で少し待ってから見る
  try {
    var H = (typeof self !== "undefined" ? self : window).AxlxHumanWait;
    var wait = H && H.humanDelay ? H.humanDelay(8000) : 8000;
    setTimeout(maybeUpload, wait);
  } catch (_) { maybeUpload(); }

  // 外から手で送れるように（点検・確かめ用）
  window.__axlxHumanMotionUpload = function () { maybeUpload(); return true; };
  /**
   * 2026-11-11: 貯めた直後に**その場で**送る（human-learn-record.js が貯めた後に呼ぶ）。
   *   記録側から渡された集計をそのまま送る（storage の変化待ちに頼らない＝確実・速い）。
   *   ⚠ 送りすぎないよう、ここでも5分の間隔は守る。
   */
  window.__axlxHumanMotionUploadNow = function (agg, opts) {
    try {
      if (!agg || !agg.n) { maybeUpload(); return; }
      var o2 = opts || {};
      /**
       * 2026-11-14 竹内さん「自動検索の部分学習反映されるようにちゃんと連携する」:
       *   自動モード（拡張が押した動き）も送る。
       *   ⚠ 人の記録と同じ5分の間隔で止めると、**自動が動いた直後の学びが落ちる**。
       *     自動の記録は mode を付けて**別枠**で送る（人の記録の間隔には影響しない）。
       */
      var mode = o2.mode || null;
      var targetSite = o2.site || agg.site || (SITE !== "unknown" ? SITE : null);
      if (mode) {
        upload(agg, { site: targetSite, mode: mode });
        return;
      }
      var sKey = _siteKey(SENT_KEY, targetSite);
      chrome.storage.local.get([sKey], function (r) {
        var last = Number(r && r[sKey]) || 0;
        if (last && Date.now() - last < MIN_GAP_MS) { void chrome.runtime.lastError; return; }
        var o = {}; o[sKey] = Date.now();
        try { chrome.storage.local.set(o); } catch (_) {}
        upload(agg, { site: targetSite });
      });
    } catch (_) {}
  };
})();
