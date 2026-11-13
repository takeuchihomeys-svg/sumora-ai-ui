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

  function apiBase() {
    try {
      var r = (typeof self !== "undefined" ? self : window);
      var v = r.AXLX_API_BASE;
      if (v) return String(v).replace(/\/$/, "");
    } catch (_) {}
    return "https://sumora-ai-ui.vercel.app";
  }

  var _sending = false;
  function upload(agg, opts) {
    if (_sending || !agg || !agg.n) return;
    var o = opts || {};
    _sending = true;
    // 鍵は background が持っている（画面側には出さない）
    try {
      chrome.runtime.sendMessage({
        type: "axlx-human-motion",
        motion: agg,
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
      chrome.storage.local.get([KEY, SENT_KEY], function (r) {
        var agg = r && r[KEY];
        if (!agg || !agg.n) return;
        var last = Number(r && r[SENT_KEY]) || 0;
        if (last && Date.now() - last < MIN_GAP_MS) return;
        // 送った印は先に置く（同じ分を2回送らない）
        var o = {}; o[SENT_KEY] = Date.now();
        try { chrome.storage.local.set(o); } catch (_) {}
        _modeNow(function (m) { upload(agg, { site: agg.site, mode: m }); });
      });
    } catch (_) {}
  }

  // 学習の記録が増えたら送る（1分ごとの書き出しの後）
  try {
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== "local" || !ch || !ch[KEY] || !ch[KEY].newValue) return;
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
  window.__axlxHumanMotionUploadNow = function (agg) {
    try {
      if (!agg || !agg.n) { maybeUpload(); return; }
      chrome.storage.local.get([SENT_KEY], function (r) {
        var last = Number(r && r[SENT_KEY]) || 0;
        if (last && Date.now() - last < MIN_GAP_MS) { void chrome.runtime.lastError; return; }
        var o = {}; o[SENT_KEY] = Date.now();
        try { chrome.storage.local.set(o); } catch (_) {}
        upload(agg, { site: agg.site });
      });
    } catch (_) {}
  };
})();
