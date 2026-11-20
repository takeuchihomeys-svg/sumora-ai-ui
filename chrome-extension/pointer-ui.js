// chrome-extension/pointer-ui.js
// 2026-11-10 v2.6.0 竹内さん「リアプロとITANDI人間のようにマウス動くようにする」
//
// 何をするか: 画面の上に**見えるカーソル（矢印）**を重ねて、人の軌跡で動かす。
//   Chrome 拡張は OS の本物のマウスカーソルを動かせない（セキュリティ上できない）ので、
//   「人が見て動いていると分かる」ための表示用のカーソルを自前で描く。
//   ⚠ これは**見た目だけ**。押す・選ぶは今まで通り（本物の click / イベント）。
//   ⚠ pointer-events:none なので、このカーソルがサイトの操作を邪魔しない。
//
// 使い方（どちらの世界でも同じ）:
//   var P = (typeof self !== "undefined" ? self : window).AxlxPointerUi;
//   P.moveTo(x, y);            // 今の位置から人の軌跡で動く（Promise・待たなくてよい）
//   P.moveToEl(el);            // 要素の真ん中あたりへ
//   P.hide();                  // 消す
//
// 読み込む順: human-wait.js の後・page-script.js / itandi-page-script.js の前（manifest と content.js）。
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (root) { root.AxlxPointerUi = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var ID = "axlx-fake-cursor";
  var _pos = { x: 0, y: 0 };
  var _el = null;
  var _ready = false;
  var _anim = null;
  var _tapEl = null;   // 2026-11-11: 直前に狙った要素（押した場所を記録するため）
  /**
   * ★ 2026-11-16 竹内さん「ボタン押す部分はマウスの形が変わるのも人間のように再現」:
   *   OSのカーソルはリンク/ボタン上で矢印→手になる。見えるカーソルも同じ切替をする。
   */
  /**
   * ★ 2026-11-20 竹内さん「マウスの色や選択するときのマウスの形が実際の人間の形と違う」:
   *   スタッフの PC（Windows）の標準カーソルに合わせる＝**白い矢印・黒い縁**／リンク等の**白い手（人差し指）**／
   *   文字の上は**I の形**。旧は黒い矢印・白い縁と、手の形が崩れた塊だった。押した時に縮む見た目も OS には無いのでやめた。
   */
  var _shape = "arrow";           // "arrow" | "hand" | "ibeam"
  var _shapeCheckAt = 0;
  var SVG_ARROW =
    '<svg width="20" height="22" viewBox="0 0 20 22" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M1 1 L1 17.2 L4.9 13.4 L7.6 19.6 L10.3 18.4 L7.7 12.4 L13 12.4 Z" ' +
    'fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="miter"/></svg>';
  var SVG_HAND =
    '<svg width="20" height="24" viewBox="0 0 20 24" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M6 2.3 C6 1.5 6.7 0.9 7.5 0.9 C8.3 0.9 9 1.5 9 2.3 L9 8.6 C9 7.9 9.6 7.4 10.4 7.4 C11.2 7.4 11.8 7.9 11.8 8.6 ' +
    'L11.8 9.3 C11.8 8.6 12.4 8.1 13.2 8.1 C14 8.1 14.6 8.6 14.6 9.3 L14.6 10.2 C14.6 9.5 15.2 9 16 9 C16.8 9 17.4 9.5 17.4 10.2 ' +
    'L17.4 15.6 C17.4 17.8 16.4 19.4 15.4 20.4 L15.4 22.6 L7.6 22.6 L7.6 20.8 C6.4 19.6 4.6 17.4 3.1 15 ' +
    'C2.5 14.1 2.8 13.1 3.6 12.8 C4.4 12.5 5.2 12.9 5.6 13.6 L6 14.3 Z" fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="round"/>' +
    '<path d="M9 8.6 V12.6 M11.8 9.3 V12.6 M14.6 10.2 V12.6" fill="none" stroke="#000" stroke-width="0.9"/></svg>';
  var SVG_IBEAM =
    '<svg width="10" height="20" viewBox="0 0 10 20" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M2 1.5 C4 1.5 5 2.2 5 3.5 C5 2.2 6 1.5 8 1.5 M5 3.5 V16.5 M2 18.5 C4 18.5 5 17.8 5 16.5 C5 17.8 6 18.5 8 18.5" fill="none" stroke="#fff" stroke-width="3"/>' +
    '<path d="M2 1.5 C4 1.5 5 2.2 5 3.5 C5 2.2 6 1.5 8 1.5 M5 3.5 V16.5 M2 18.5 C4 18.5 5 17.8 5 16.5 C5 17.8 6 18.5 8 18.5" fill="none" stroke="#000" stroke-width="1.2"/></svg>';
  function _svgOf(k) { return k === "hand" ? SVG_HAND : (k === "ibeam" ? SVG_IBEAM : SVG_ARROW); }
  /** 指している点（矢印の先・人差し指の先・I の真ん中）が要素の左上から何 px か */
  function _tipOffset() {
    if (_shape === "hand") return { x: 7.5, y: 0.9 };
    if (_shape === "ibeam") return { x: 5, y: 10 };
    return { x: 1, y: 1 };
  }

  /**
   * ★ 2026-11-20 竹内さん「同時に２つマウス出現しないように…実際の人間のように1つのマウスでおこなう」:
   *   リアプロ・ITANDI ではこのファイルが**2つの世界で別々に動く**（manifest の content script＝bulk-dl・記録側／
   *   content.js がページへ入れる方＝page-script の自動）。画面の要素は1つでも、位置と動きを**別々に持って**いたので、
   *   両方が動くと同じ要素が2か所に交互に描かれた（2つに見える・飛ぶ）。さらに `hide()` を誰も呼ばず、
   *   自動の後も見えるカーソルが残る → 人が本物のマウスを動かすと**本物と見えるカーソルの2つ**になった。
   *   → ① 位置は要素（data-x/y）に置いて両方の世界で同じ物を使う ② 動いている間は data-busy で順番待ち（1つの手）
   *     ③ 見えるカーソルが出ている間はページの OS カーソルを隠す ④ 人が本物のマウスを動かしたら、見えるカーソルを隠して
   *        OS カーソルを戻す。次に自動が動く時は**本物のマウスが居た所から**動き出す（同じ1つのマウスに見える）。
   */
  var _iid = "p" + Math.random().toString(36).slice(2, 8);
  var OS_STYLE_ID = "axlx-one-cursor-style";
  var OS_CLS = "axlx-one-cursor";
  var POS_KEY = "axlx_cursor_pos";
  var _realPos = null;
  var _realLsn = false;
  var _posSavedAt = 0;
  var _curCache = null;

  function _osHide(on) {
    var d = _doc();
    if (!d || !d.documentElement) return;
    try {
      var html = d.documentElement;
      if (on) {
        if (!d.getElementById(OS_STYLE_ID)) {
          var s = d.createElement("style");
          s.id = OS_STYLE_ID;
          s.textContent = "html." + OS_CLS + ",html." + OS_CLS + " *{cursor:none!important}";
          (d.head || html).appendChild(s);
        }
        if (!html.classList.contains(OS_CLS)) html.classList.add(OS_CLS);
      } else if (html.classList.contains(OS_CLS)) {
        html.classList.remove(OS_CLS);
      }
    } catch (_) {}
  }

  function _sharedEl() {
    if (_el && _el.isConnected) return _el;
    try { var d = _doc(); return d ? d.getElementById(ID) : null; } catch (_) { return null; }
  }

  /** 人が本物のマウスを動かした（isTrusted）→ 見えるカーソルを隠し、OS カーソルを戻す */
  function _humanTook(x, y) {
    _osHide(false);
    var el = _sharedEl();
    if (!el) return;
    try {
      el.style.opacity = "0";
      el.setAttribute("data-human-at", String(Date.now()));
      el.setAttribute("data-rx", String(Math.round(x)));
      el.setAttribute("data-ry", String(Math.round(y)));
    } catch (_) {}
  }

  function _installRealMouse() {
    if (_realLsn || typeof window === "undefined" || !window.addEventListener) return;
    _realLsn = true;
    var h = function (e) {
      if (!e || !e.isTrusted) return;
      // スクロールの後に Chrome が出す hover 直しの mousemove は動きが 0（本物の手ではない）
      if (e.type === "mousemove" && !e.movementX && !e.movementY) return;
      _realPos = { x: e.clientX, y: e.clientY };
      _humanTook(e.clientX, e.clientY);
    };
    try {
      window.addEventListener("mousemove", h, true);
      window.addEventListener("mousedown", h, true);
    } catch (_) {}
  }

  /** 画面のカーソルが今どこに居るか（もう1つの世界が動かした分・人が本物のマウスで動かした分も含む） */
  function _syncFromShared() {
    var el = _sharedEl();
    if (!el) return;
    try {
      var at = Number(el.getAttribute("data-at")) || 0;
      var hAt = Number(el.getAttribute("data-human-at")) || 0;
      var x, y;
      var human = hAt > 0 && hAt >= at;
      if (human) { x = Number(el.getAttribute("data-rx")); y = Number(el.getAttribute("data-ry")); }
      else { x = Number(el.getAttribute("data-x")); y = Number(el.getAttribute("data-y")); }
      if (isFinite(x) && isFinite(y) && el.hasAttribute(human ? "data-rx" : "data-x")) _pos = { x: x, y: y };
    } catch (_) {}
  }

  function _busyByOther() {
    var el = _sharedEl();
    if (!el) return false;
    try {
      var b = String(el.getAttribute("data-busy") || "");
      if (!b) return false;
      var i = b.indexOf(":");
      return b.slice(0, i) !== _iid && (Number(b.slice(i + 1)) || 0) > Date.now();
    } catch (_) { return false; }
  }
  function _claim(ms) {
    try { if (_el) _el.setAttribute("data-busy", _iid + ":" + (Date.now() + Math.max(300, ms || 0))); } catch (_) {}
  }
  function _release() {
    try {
      if (_el && String(_el.getAttribute("data-busy") || "").indexOf(_iid + ":") === 0) _el.removeAttribute("data-busy");
    } catch (_) {}
  }
  /** もう1つの世界が動かしている間は待つ（最大 6 秒・止まった手を待ち続けない） */
  function _waitTurn(cb) {
    var t0 = Date.now();
    (function poll() {
      if (!_busyByOther() || Date.now() - t0 > 6000) { cb(); return; }
      setTimeout(poll, 40);
    })();
  }

  function _savePos(x, y) {
    var now = Date.now();
    if (now - _posSavedAt < 250) return;
    _posSavedAt = now;
    try { window.sessionStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(x), y: Math.round(y), at: now })); } catch (_) {}
  }
  function _loadPos() {
    try {
      var v = JSON.parse(window.sessionStorage.getItem(POS_KEY) || "null");
      if (v && isFinite(v.x) && isFinite(v.y) && Date.now() - (Number(v.at) || 0) < 30 * 60 * 1000) return { x: Number(v.x), y: Number(v.y) };
    } catch (_) {}
    return null;
  }
  // 2026-11-11 竹内さん「通常モードの動きから学ぶのか」: 通常モードで覚えた実測から作った「動きの癖」
  var _prof = null;
  var _profLoaded = false;
  var PROF_KEY = "axlx_human_learn";
  // 2026-11-11 竹内さん「データたまって理解するたび反映」: 貯まるたびに作り直された癖（こちらを優先して読む）
  var PROF_LIVE_KEY = "axlx_human_profile";
  var L = null;
  // ⚠ pointer-ui.js は human-learn.js より**先**に読み込まれる。
  //   読み込み時の1回だけ見ると undefined になるので、**使う時に読む**（ensure / reloadProfile の中）。
  function _learn() {
    if (L) return L;
    try { L = (typeof self !== "undefined" ? self : window).AxlxHumanLearn || null; } catch (_) { L = null; }
    return L;
  }
  /** 覚えた癖（無ければ null＝今まで通りの動き） */
  function _profile() { return _prof; }
  /**
   * 2026-11-13 竹内さん「撮影したところからぼたんの押す場所の確認や移動の部分で学習した部分あるか」:
   *   **要素ごと**の押した位置（`point_fields`）を読む。
   *   例: rental_cost2 → { x:0.10, y:0.14 }（賃料の欄は左寄り）
   *   これは通常モードで人はこう押した、という実測（DB の human_motion_learn.point_fields と同じ形）。
   *   貯まるたびに `axlx_human_points` に書かれている（human-learn-record.js）。
   */
  var POINTS_KEY = "axlx_human_points";
  var _points = null;
  var _pointsLoadedAt = 0;
  /** ★ 2026-11-16: 通常録画から学んだ「手が付く欄」（axlx_learn_cursor_hand） */
  var CURSOR_HAND_KEY = "axlx_learn_cursor_hand";
  var _handFields = null;
  var _handLoadedAt = 0;
  /** ★ 2026-11-18 MAIN world(pointer-ui) 向け: content.js 橋＋localStorage キャッシュから癖/位置/手の形を読む */
  var _PTR_CACHE_KEY = "axlx_pointer_cache";
  /** ★ 2026-11-19 v2.8.25: サーバーで学んだ動き／ラン単位の動き計画（content.js の橋で届く） */
  var MOTION_KEY = "axlx_learn_motion";
  var PLAN_KEY = "axlx_motion_plan";
  function _root() {
    try {
      return (typeof self !== "undefined" ? self : null) || (typeof window !== "undefined" ? window : null) ||
        (typeof globalThis !== "undefined" ? globalThis : null);
    } catch (_) { return null; }
  }
  function _ptrCacheSave(partial) {
    try {
      if (!partial || typeof partial !== "object") return;
      var cur = {};
      try {
        var raw = localStorage.getItem(_PTR_CACHE_KEY);
        if (raw) cur = JSON.parse(raw) || {};
      } catch (_) { cur = {}; }
      for (var k in partial) {
        if (Object.prototype.hasOwnProperty.call(partial, k)) cur[k] = partial[k];
      }
      cur.at = Date.now();
      localStorage.setItem(_PTR_CACHE_KEY, JSON.stringify(cur));
    } catch (_) {}
  }
  function _ptrCacheLoad() {
    try {
      var raw = localStorage.getItem(_PTR_CACHE_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return null;
      if (obj.at && Date.now() - Number(obj.at) > 6 * 60 * 60 * 1000) return null;
      return obj;
    } catch (_) { return null; }
  }
  function _applyPtrStorage(r) {
    try {
      if (!r || typeof r !== "object") return;
      var LL = _learn();
      if (r[PROF_LIVE_KEY] && typeof r[PROF_LIVE_KEY] === "object") {
        _prof = r[PROF_LIVE_KEY];
      } else if (r[PROF_KEY] && LL && LL.profileFrom && !_prof) {
        _prof = LL.profileFrom(r[PROF_KEY]);
      }
      if (r[POINTS_KEY] && typeof r[POINTS_KEY] === "object") _points = r[POINTS_KEY];
      if (r[CURSOR_HAND_KEY] && typeof r[CURSOR_HAND_KEY] === "object") _handFields = r[CURSOR_HAND_KEY];
      /**
       * ★ 2026-11-19 v2.8.25: サーバーで学んだ動き（axlx_learn_motion）と動き計画（axlx_motion_plan）を MAIN world の
       *   グローバルへ置く。human-learn.js の _serverMotion は chrome.storage が無い時にこれを読む。
       *   （content.js の PUSH_KEYS に2キーを足した＝ axlx-page-learn-push で届く）。null は「無い」として消す。
       */
      _applyMotionKeys(r);
    } catch (_) {}
  }
  function _applyMotionKeys(r) {
    try {
      var _R = _root();
      if (!_R || !r || typeof r !== "object") return;
      if (Object.prototype.hasOwnProperty.call(r, MOTION_KEY)) {
        _R.__axlxServerMotion = (r[MOTION_KEY] && typeof r[MOTION_KEY] === "object") ? r[MOTION_KEY] : null;
      }
      if (Object.prototype.hasOwnProperty.call(r, PLAN_KEY)) {
        _R.__axlxMotionPlan = (r[PLAN_KEY] && typeof r[PLAN_KEY] === "object") ? r[PLAN_KEY] : null;
      }
    } catch (_) {}
  }
  function _ptrBridgeFetch(keys) {
    try {
      var cached = _ptrCacheLoad();
      if (cached) _applyPtrStorage(cached);
      var id = "ptr" + Date.now() + Math.random().toString(36).slice(2, 8);
      window.postMessage({ from: "axlx-page-storage-get", id: id, keys: keys }, "*");
    } catch (_) {}
  }
  try {
    window.addEventListener("message", function (e) {
      if (!e || e.source !== window || !e.data || typeof e.data !== "object") return;
      if (e.data.from === "axlx-page-learn-push" && e.data.data) {
        _ptrCacheSave(e.data.data);
        _applyPtrStorage(e.data.data);
      } else if (e.data.from === "axlx-page-storage-result" && String(e.data.id || "").indexOf("ptr") === 0 && e.data.data) {
        _ptrCacheSave(e.data.data);
        _applyPtrStorage(e.data.data);
      }
    });
  } catch (_) {}
  function _handFieldHit(el) {
    try {
      var now = Date.now();
      if (!_handFields || now - _handLoadedAt > 30000) {
        _handLoadedAt = now;
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get([CURSOR_HAND_KEY], function (r) {
            try { _handFields = (r && r[CURSOR_HAND_KEY]) || {}; _ptrCacheSave(r); } catch (_) { _handFields = {}; }
          });
        } else {
          _ptrBridgeFetch([CURSOR_HAND_KEY, POINTS_KEY, PROF_LIVE_KEY, PROF_KEY, MOTION_KEY, PLAN_KEY]);
        }
      }
      if (!_handFields || typeof _handFields !== "object") return false;
      var LE = (typeof self !== "undefined" ? self : window).AxlxHumanLearn;
      var nm = el && LE && LE.fieldName ? LE.fieldName(el) : null;
      if (!nm) return false;
      var v = _handFields[String(nm)];
      return !!(v && Number(v.hand) >= 2);
    } catch (_) { return false; }
  }
  function _pointsFor(name) {
    if (!name) return null;
    var now = Date.now();
    // 30秒ごとに読み直す（貯まった分を次の動きから使う）
    if (!_points || now - _pointsLoadedAt > 30000) {
      _pointsLoadedAt = now;
      try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get([POINTS_KEY], function (r) {
            try { _points = (r && r[POINTS_KEY]) || {}; _ptrCacheSave(r); } catch (_) { _points = {}; }
          });
        } else {
          _ptrBridgeFetch([POINTS_KEY, CURSOR_HAND_KEY, PROF_LIVE_KEY, PROF_KEY, MOTION_KEY, PLAN_KEY]);
        }
      } catch (_) {}
    }
    var v = _points && _points[name];
    if (!v || typeof v.x !== "number" || typeof v.y !== "number") return null;
    // 何回も押した所だけ使う（1回だけは偶然かもしれない）
    /** ★ 2026-11-17 統括Pro: n=1 の学びも捨てない（point%・aim無対策） */
    if (Number(v.n) < 1) return null;
    return { x: v.x, y: v.y, n: Number(v.n) };
  }
  /** storage から読み直す（モードや貯まり方が変わった時） */
  function reloadProfile() {
    try {
      var LL = _learn();
      if (!LL || !LL.profileFrom) return;
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
        _ptrBridgeFetch([PROF_LIVE_KEY, PROF_KEY, POINTS_KEY, CURSOR_HAND_KEY, MOTION_KEY, PLAN_KEY]);
        return;
      }
      /**
       * 2026-11-11 竹内さん「データたまって理解するたび反映」:
       *   ① 貯まるたびに作り直された癖（axlx_human_profile）があれば**それをそのまま使う**（一番新しい理解）
       *   ② 無ければ、貯まった実測（axlx_human_learn）から今この場で作る
       */
      chrome.storage.local.get([PROF_LIVE_KEY, PROF_KEY, MOTION_KEY, PLAN_KEY], function (r) {
        try {
          _applyMotionKeys(r);
          _ptrCacheSave(r);
          var live = r && r[PROF_LIVE_KEY];
          if (live && typeof live === "object") { _prof = live; return; }
          _prof = LL.profileFrom(r && r[PROF_KEY]);
        } catch (_) { _prof = null; }
      });
    } catch (_) {}
  }
  // 貯まり方が変わったら読み直す（通常モードで操作して増えた時に、次の動きから効く）
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (ch, area) {
        if (area !== "local" || !ch) return;
        if (ch[PLAN_KEY]) _applyMotionKeys((function () { var o = {}; o[PLAN_KEY] = ch[PLAN_KEY].newValue; return o; })());
        if (ch[PROF_LIVE_KEY] || ch[PROF_KEY]) reloadProfile();
      });
    }
  } catch (_) {}

  function _doc() {
    try { return document; } catch (_) { return null; }
  }

  function _hum() {
    var r = (typeof self !== "undefined" ? self : null) || (typeof window !== "undefined" ? window : null);
    return (r && r.AxlxHumanWait) || null;
  }

  /** カーソルの要素を作る（1つだけ・何度呼んでも同じ物） */
  function ensure() {
    var d = _doc();
    if (!d || !d.body) return null;
    /**
     * ★ 2026-11-17 竹内さん「マウスが2つになってしまう」:
     *   page 再注入・iframe・ensure 再入で #axlx-fake-cursor が複数残ることがある。
     *   → 余分を消してから1つだけ使う。
     */
    try {
      var all = d.querySelectorAll("#" + ID);
      if (all && all.length) {
        var keep = (_el && _el.isConnected) ? _el : all[0];
        for (var xi = 0; xi < all.length; xi++) {
          if (all[xi] !== keep) {
            try { all[xi].parentNode && all[xi].parentNode.removeChild(all[xi]); } catch (_) {}
          }
        }
        if (keep && keep.isConnected) {
          if (_el !== keep) { _el = keep; _syncFromShared(); }
          _ready = true;
          _installRealMouse();
          return _el;
        }
      }
    } catch (_) {}
    if (_el && _el.isConnected) return _el;
    if (_el && _el.parentNode) _el.parentNode.removeChild(_el);
    // 2026-11-11: 最初に使う時に、通常モードで覚えた動きの癖を読む（読めなければ今まで通り）
    if (!_profLoaded) { _profLoaded = true; reloadProfile(); }
    var el = d.createElement("div");
    el.id = ID;
    el.setAttribute("aria-hidden", "true");
    el.style.cssText = [
      "position:fixed", "left:0", "top:0", "width:20px", "height:24px",
      "pointer-events:none", "z-index:2147483647",
      // 2026-11-11: 60ms の transition は、毎フレーム位置を書く時に**遅れが積もって軌跡がずれる**。位置は即座に反映する
      "transition:none",
      "will-change:transform", "filter:drop-shadow(1px 1px 1px rgba(0,0,0,.35))",
    ].join(";");
    el.innerHTML = SVG_ARROW;
    el.setAttribute("data-axlx-shape", "arrow");
    d.documentElement.appendChild(el);
    _el = el;
    _ready = true;
    _shape = "arrow";
    _installRealMouse();
    // 出だし: 人が本物のマウスを動かした所 → 同じタブの前のページで居た所 → 左上の近く（急に真ん中に出ない）
    if (!_pos.x && !_pos.y) {
      _pos = _realPos ? { x: _realPos.x, y: _realPos.y } : (_loadPos() || { x: 40, y: 80 });
      _place(_pos.x, _pos.y);
    }
    return el;
  }

  /**
   * ページが本当に出すカーソル（CSS の cursor）を読む。見えるカーソルの間は OS カーソルを隠す class が付いているので、
   * 外して読んでから戻す（要素ごとに1回・動き始めに作り直す）。
   */
  function _rawCursor(el) {
    try {
      if (_curCache && _curCache.has(el)) return _curCache.get(el);
    } catch (_) {}
    var c = "";
    try {
      var html = document.documentElement;
      var on = html.classList.contains(OS_CLS);
      if (on) html.classList.remove(OS_CLS);
      try { c = String(window.getComputedStyle(el).cursor || "").toLowerCase(); } catch (_) { c = ""; }
      if (on) html.classList.add(OS_CLS);
    } catch (_) {}
    try { if (_curCache) _curCache.set(el, c); } catch (_) {}
    return c;
  }

  /** その点の下が「選べる文字」か（Chrome は cursor:auto の文字の上で I の形にする） */
  function _textUnder(x, y) {
    try {
      var d = document;
      if (!d.caretRangeFromPoint) return false;
      var r = d.caretRangeFromPoint(x, y);
      var n = r && r.startContainer;
      if (!n || n.nodeType !== 3) return false;
      var s = String(n.nodeValue || "");
      if (!s.trim()) return false;
      var a = Math.max(0, r.startOffset - 1), b = Math.min(s.length, r.startOffset + 1);
      if (a >= b) return false;
      var rr = d.createRange();
      rr.setStart(n, a); rr.setEnd(n, b);
      var rects = rr.getClientRects();
      for (var i = 0; i < rects.length; i++) {
        var q = rects[i];
        if (x >= q.left - 1 && x <= q.right + 1 && y >= q.top - 1 && y <= q.bottom + 1) {
          var pe = n.parentElement;
          var us = "";
          try { var cs = pe ? window.getComputedStyle(pe) : null; us = cs ? String(cs.userSelect || cs.webkitUserSelect || "") : ""; } catch (_) {}
          return us !== "none";
        }
      }
    } catch (_) {}
    return false;
  }

  /**
   * ★ 2026-11-20: 人の画面と同じ形を出す（Chrome がその場で出す形）。
   *   CSS の cursor が pointer → 手／text → I／auto → 文字を打つ欄・選べる文字の上は I、それ以外は矢印。
   *   旧は区・駅・ラベル・select・チェック欄を名前で「手」にしていたが、ページの CSS が矢印ならスタッフの画面も矢印。
   */
  function _shapeFor(el, x, y) {
    if (!el || el === _el) return "arrow";
    var c = _rawCursor(el);
    if (c.indexOf("pointer") >= 0) return "hand";
    if (c === "text" || c === "vertical-text") return "ibeam";
    if (c && c !== "auto") return "arrow";
    var tag = String(el.tagName || "").toUpperCase();
    if (tag === "TEXTAREA" || el.isContentEditable) return "ibeam";
    if (tag === "INPUT") {
      var ty = String(el.type || "text").toLowerCase();
      return /^(text|search|email|number|tel|url|password)$/.test(ty) ? "ibeam" : "arrow";
    }
    if (tag === "SELECT" || tag === "BUTTON" || tag === "IMG") return "arrow";
    return _textUnder(x, y) ? "ibeam" : "arrow";
  }

  function _setShape(kind) {
    if (!_el) return;
    var k = kind === "hand" ? "hand" : (kind === "ibeam" ? "ibeam" : "arrow");
    try { var cur = _el.getAttribute("data-axlx-shape"); if (cur) _shape = cur; } catch (_) {}
    if (_shape === k) return;
    _shape = k;
    try {
      _el.innerHTML = _svgOf(k);
      _el.setAttribute("data-axlx-shape", k);
    } catch (_) {}
  }

  /** 座標下の要素を見て 矢印／手／I を切替（チラつき防止で 40ms 間引き） */
  function _updateShapeAt(x, y) {
    var now = Date.now();
    if (now - _shapeCheckAt < 40) return;
    _shapeCheckAt = now;
    try {
      var under = (typeof document !== "undefined" && document.elementFromPoint)
        ? document.elementFromPoint(Math.round(x), Math.round(y)) : null;
      _setShape(_shapeFor(under, x, y));
    } catch (_) {}
  }

  /**
   * ★ 2026-11-20 竹内さん「最初画面おかしくなる問題」「人間のように」:
   *   通り道の mousemove は拡張の記録（human-learn.js の hMove）が isTrusted で捨てるので誰も使っていない。
   *   一方、通り道の一覧の行・号室メニューへ送るとサイト側が反応し得る（検索の始めに号室メニューが開く件の候補）。
   *   → 号室メニューには送らない。通り道（path=true）は一覧の行（tr）にも送らない。着地（押す所）は今まで通り。
   */
  function _moveEvTarget(el, path) {
    try {
      if (!el || !el.closest) return el || null;
      if (el.closest('[class*="room_menu"]')) return null;
      if (path && el.closest("tr")) return null;
    } catch (_) {}
    return el;
  }
  function _place(x, y) {
    if (!_el) return;
    /**
     * 2026-11-11 竹内さん「マウスちゃんとした場所にうごくようになっているか」:
     *   ① SVG の矢印の**先端は (4,2.5)**（22px の中で左上寄り）。要素の left/top に来た点が「先端」になるよう、
     *      先端の分だけ戻して置く（旧は要素の左上に点を合わせていたので、**実際に指している場所と 4〜2.5px ずれていた**）。
     *   ② transition を 60ms → **0ms に近く**（毎フレーム transform を書くので、CSS の遅れが積もると軌跡が遅れて見える）。
     * ★ 2026-11-16: 手の形の時は先端オフセットを変える／下の要素で形を切替。
     */
    _updateShapeAt(x, y);
    var tip = _tipOffset();
    _el.style.transform = "translate3d(" + Math.round(x - tip.x) + "px," + Math.round(y - tip.y) + "px,0)";
    try {
      _el.setAttribute("data-x", String(Math.round(x)));
      _el.setAttribute("data-y", String(Math.round(y)));
      _el.setAttribute("data-at", String(Date.now()));
      if (_el.style.opacity === "0") _el.style.opacity = "1";
    } catch (_) {}
    _osHide(true);
    _savePos(x, y);
  }

  /** OS のカーソルは押しても形も大きさも変わらないので、見た目は何もしない（押し込みの時間は holdMs で外が使う） */
  function _press() {}

  /**
   * 画面の外に出さない（スクロールで要素が外れた時など）
   * 2026-11-11 竹内さん「マウスちゃんとした場所にうごくようになっているか」:
   *   旧は端に寄せていた（x を 2〜vw-24 に丸める）ので、**画面の端の要素を狙うと押す点と 20px 以上ずれた**。
   *   端の要素（右端のチェックボックス等）を正しく指せるよう、**丸めない**（画面外でもそのまま置く＝見えないだけ）。
   *   押す点は `position()` が返すので、ずれない。
   */
  function _clamp(p) {
    return { x: Number(p.x) || 0, y: Number(p.y) || 0 };
  }

  /**
   * 2026-11-11 竹内さん「カーソルもちゃんと人間のようにひと息つくときもあるか」:
   *   人のマウスは**動いて → 止まって → また動く**。ずっと等速で動き続けるのは機械的。
   *   moveTo の途中に「ひと息」（その場で止まる）を確率的に挟む。
   *   ・移動が 400ms を超える長い移動の時だけ（短い移動で止まると不自然）
   *   ・18% で 120〜420ms 止まる（人が「次はどこだ」と一瞬手を止める形）
   *   ・止まる位置は軌跡の 25〜70% の所（途中で止まる＝人が迷った形）
   *   ・止まっている間もカーソルは見えている（消さない）
   */
  function _pausePointFor(n) {
    if (n < 8) return -1;                     // 点が少ない＝短い移動は止まらない
    // ★ 2026-11-16 統括Pro「カーソル→100%へ」: 長い移動で息を入れる確率をさらに上げる
    if (Math.random() >= 0.34) return -1;     // 34%
    return Math.floor(n * (0.22 + Math.random() * 0.50)); // 22〜72% の所
  }
  function _pauseMs() {
    // ★ 2026-11-17: 軌跡の途中の一息も対数正規（一様バンド禁止）
    var H = _hum();
    var v = H && H.logNormalDelay ? H.logNormalDelay(320, 0.45) : (180 + Math.floor(Math.random() * 380));
    if (v < 140) v = 140;
    if (v > 900) v = 900;
    return Math.round(v);
  }

  /**
   * ★ 2026-11-19 v2.8.25 ラン（検索）ごとの「動きの個性」（persona）。
   *   ・persona は「ラン／お客さん」が変わった時に作り直す。変わりの検知は**この中で完結**（page-script.js は触らない）:
   *       window.__axlxRunId と window._axFillRunningCustomerId の組が変わった／一度空になってから入った → 新しいラン。
   *       どちらも空（ラン外）の時は、最後の動きから 90秒 空いたら作り直す（休憩の長い待ちは run_key があるので変わらない）。
   *   ・同じラン内では persona を固定し、各移動の乱数は persona の seed 付き乱数から1本ずつ派生させる
   *     （ラン内の個性は一貫・移動ごとの細部は毎回ちがう）。
   *   ・サーバーの動き計画（window.__axlxMotionPlan＝ axlx_motion_plan）が有効なら run_seed と persona の値を優先
   *     （範囲に丸める・期限切れ/不正は無視）。無くても API が失敗してもローカルの seed で同等に動く。
   *   ・human-wait.js が読めない時は persona が作れない＝moveTo は従来の動き（_planLegacy）に戻る。
   */
  var IDLE_REBUILD_MS = 90 * 1000;
  var _persona = null;
  var _personaKey = "";
  var _personaPlanSig = "";
  var _personaSawEmpty = false;
  var _personaAt = 0;
  var _lastMoveAt = 0;
  var _runRng = null;
  var _forcedSeed = null;
  function _runKey() {
    var R = _root();
    var rid = R && R.__axlxRunId, cid = R && R._axFillRunningCustomerId;
    var a = (rid == null) ? "" : String(rid), b = (cid == null) ? "" : String(cid);
    return (a || b) ? (a + "|" + b) : "";
  }
  function _planNow() {
    try {
      var H = _hum();
      var R = _root();
      return (H && H.sanitizePlan && R) ? H.sanitizePlan(R.__axlxMotionPlan) : null;
    } catch (_) { return null; }
  }
  function _rebuildPersona(key, plan, now) {
    var H = _hum();
    if (!H || !H.makePersona) { _persona = null; _runRng = null; return null; }
    var seed;
    if (_forcedSeed != null) { seed = _forcedSeed; _forcedSeed = null; }
    else seed = (H.hashSeed(String(key) + ":" + now) ^ Math.floor(Math.random() * 4294967296)) >>> 0;
    try { _persona = H.makePersona(seed, plan ? _root().__axlxMotionPlan : null); } catch (_) { _persona = null; }
    if (!_persona) { _runRng = null; return null; }
    _personaKey = key || "";
    _personaPlanSig = plan ? (plan.plan_id + ":" + (plan.run_seed == null ? "" : plan.run_seed)) : "";
    _personaSawEmpty = !key;
    _personaAt = now;
    _runRng = H.seededRng((_persona.seed ^ 0x9e3779b9) >>> 0);
    return _persona;
  }
  /** 今のラン用の persona（必要なら作り直す）。作れなければ null＝従来の動き */
  function _ensurePersona() {
    var now = Date.now();
    var key = _runKey();
    var plan = _planNow();
    var sig = plan ? (plan.plan_id + ":" + (plan.run_seed == null ? "" : plan.run_seed)) : "";
    var need = !_persona || _forcedSeed != null;
    if (!need) {
      if (sig && sig !== _personaPlanSig) need = true;                              // 新しい計画が来た
      else if (key && (key !== _personaKey || _personaSawEmpty)) need = true;        // 新しいラン
      else if (!key && now - _lastMoveAt > IDLE_REBUILD_MS) need = true;             // ラン外で長く空いた
    }
    if (!key) _personaSawEmpty = true;
    var p = need ? _rebuildPersona(key, plan, now) : _persona;
    _lastMoveAt = now;
    return p;
  }
  /** 次の1回の移動用の乱数（persona の seed 付き乱数から派生・無ければ null＝Math.random） */
  function _moveRng() {
    try {
      var H = _hum();
      if (!_runRng || !H || !H.seededRng) return null;
      return H.seededRng(Math.floor(_runRng() * 4294967296));
    } catch (_) { return null; }
  }
  /** 呼び出し側が明示的に新しいランを始める（seed を渡せば再現できる）。persona を返す */
  function newRun(seed) {
    if (typeof seed === "number" && isFinite(seed)) _forcedSeed = Math.floor(seed) >>> 0;
    else if (seed != null && seed !== "") { var H = _hum(); _forcedSeed = H && H.hashSeed ? H.hashSeed(seed) : null; }
    else _forcedSeed = (Math.floor(Math.random() * 4294967296)) >>> 0;
    return _ensurePersona();
  }
  /** 見えるカーソルの押し込み時間(ms)。persona.press_ms を中央値とする対数正規（45〜180ms）。page-script.js の押す時間にも使える */
  function holdMs() {
    try {
      var H = _hum();
      var p = _ensurePersona();
      if (p && H && H.pressMs) return H.pressMs(p, _moveRng());
    } catch (_) {}
    return 90;
  }
  /** いまの persona の要約（監査用・値は範囲内に丸め済み） */
  function personaInfo() {
    var p = _persona || _ensurePersona();
    if (!p) return null;
    var o = {};
    for (var k in p) { if (Object.prototype.hasOwnProperty.call(p, k)) o[k] = p[k]; }
    return o;
  }
  /** 自動の動きの記録（軌跡の点は持たない）。最大 200件のリング */
  var MAX_AUTO_MOVES = 200;
  function _noteMove(m) {
    try {
      var R = _root();
      if (!R) return;
      if (!R.__axlxAutoMoves || !Array.isArray(R.__axlxAutoMoves)) R.__axlxAutoMoves = [];
      var a = R.__axlxAutoMoves;
      a.push(m);
      if (a.length > MAX_AUTO_MOVES) a.splice(0, a.length - MAX_AUTO_MOVES);
    } catch (_) {}
  }
  /**
   * 自動の動きの指標（監査の motion_stats に載せる用）:
   *   { n, speed_p50, speed_cv, ms_p50, ms_cv, curve_p50, curve_p90, curve_cv, dist_p50, peak_p50, over_pct, pause_pct, plan_id, persona }
   */
  function motionStats() {
    var H = _hum();
    var R = _root();
    var moves = (R && Array.isArray(R.__axlxAutoMoves)) ? R.__axlxAutoMoves : [];
    var s = (H && H.motionSummary) ? H.motionSummary(moves) : { n: moves.length };
    var plan = _planNow();
    s.plan_id = (plan && plan.plan_id) || (_persona && _persona.plan_id) || null;
    var p = _persona;
    s.persona = p ? {
      seed: p.seed, source: p.source,
      speed_scale: p.speed_scale, curve_gain: p.curve_gain, overshoot_p: p.overshoot_p, hesitate_p: p.hesitate_p,
      press_ms: p.press_ms, tremor: p.tremor, dwell_scale: p.dwell_scale,
    } : null;
    return s;
  }
  function _ptsLen(pts) {
    var s = 0;
    for (var i = 1; i < pts.length; i++) {
      var dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
      s += Math.sqrt(dx * dx + dy * dy);
    }
    return s;
  }

  /**
   * 従来の動きの計画（persona が作れない時＝human-wait.js が読めない時の安全な予備）。2026-11-19 までの moveTo と同じ。
   *   返り値: { pts, waits, total, pauseAt, pauseMs, overshoot }
   */
  function _planLegacy(from, t, dist, H, _LL, prof, _curve) {
    var _learned = (prof && _LL && _LL.moveMsFor) ? _LL.moveMsFor(prof, dist) : null;
    var total = _learned != null ? _learned : Math.min(1600, Math.max(320, Math.round(dist * 2.45)));
    if (_learned == null && H && H.logNormalDelay) {
      try {
        var _jitterT = H.logNormalDelay(total, 0.28);
        if (_jitterT > 280 && _jitterT < 1800) total = Math.round(_jitterT);
      } catch (_) {}
    }
    var steps = Math.min(48, Math.max(10, Math.round(dist / 16)));
    var pts = (H && H.pointerPath) ? H.pointerPath(from, t, steps) : [{ x: from.x, y: from.y }, t];
    // 学びが薄い時も曲げる（一直線の機械感を減らす）
    if (!(_curve > 1)) _curve = 1.18 + Math.random() * 0.28;
    if (_curve && _curve > 1 && pts.length > 3) {
      try { pts = _bendLike(pts, from, t, _curve); } catch (_) {}
    }
    var over = false;
    if (dist > 80 && pts.length > 4 && Math.random() < 0.72) {
      try {
        var _ox = (t.x - from.x) / (dist || 1);
        var _oy = (t.y - from.y) / (dist || 1);
        var _over = 8 + Math.random() * 28;
        var _overPt = { x: t.x + _ox * _over, y: t.y + _oy * _over };
        pts = pts.slice(0, -1).concat([_overPt, t]);
        total = Math.min(1800, total + 110 + Math.floor(Math.random() * 180));
        over = true;
      } catch (_) {}
    }
    var waits = (H && H.pointerDelays) ? H.pointerDelays(pts.length, total) : null;
    var pauseAt = total > 320 ? _pausePointFor(pts.length) : (Math.random() < 0.12 ? _pausePointFor(pts.length) : -1);
    return { pts: pts, waits: waits, total: total, pauseAt: pauseAt, pauseMs: pauseAt >= 0 ? _pauseMs() : 0, overshoot: over };
  }

  /**
   * 今の位置から (x, y) へ人の軌跡で動かす。
   * Promise は「着いたら」解決（待たなくてもよい）。動きながら押すと不自然なので、押す前に await すると良い。
   */
  function moveTo(x, y) {
    if (!ensure()) return Promise.resolve(false);
    if (_busyByOther()) {
      return new Promise(function (resolve) { _waitTurn(function () { resolve(_moveToNow(x, y)); }); });
    }
    return _moveToNow(x, y);
  }

  function _moveToNow(x, y) {
    var t = _clamp({ x: Number(x) || 0, y: Number(y) || 0 });
    if (!ensure()) return Promise.resolve(false);
    try { if (_anim) { _anim.cancelled = true; } } catch (_) {}
    try { _curCache = typeof WeakMap === "function" ? new WeakMap() : null; } catch (_) { _curCache = null; }
    _syncFromShared();
    var H = _hum();
    var from = { x: _pos.x, y: _pos.y };
    var dist = Math.sqrt(Math.pow(t.x - from.x, 2) + Math.pow(t.y - from.y, 2));
    // 近すぎる時は動かさない（同じ場所を押すたびに震えない）
    if (dist < 4) {
      _place(t.x, t.y);
      _pos = t;
      /**
       * ⚠ 2026-11-15: 動かない時も**押す位置を `mousemove` で知らせる**。
       *   記録側は `mousemove` でしか学ばないので、ここを飛ばすと
       *   「同じ所を続けて押した時」だけ記録に残らない（実測の 65% の一因）。
       */
      try {
        var _nearEl = _moveEvTarget((typeof document !== "undefined" && document.elementFromPoint)
          ? document.elementFromPoint(t.x, t.y) : null, false);
        if (_nearEl && typeof MouseEvent === "function") {
          _nearEl.dispatchEvent(new MouseEvent("mousemove", {
            bubbles: true, cancelable: true, view: window,
            clientX: Math.round(t.x), clientY: Math.round(t.y),
            screenX: Math.round(t.x), screenY: Math.round(t.y),
            buttons: 0,
          }));
        }
      } catch (_) {}
      return Promise.resolve(true);
    }
    /**
     * 2026-11-11 竹内さん「通常モードの動きから学ぶのか」:
     *   通常モードで覚えた**実測の速さ**があれば、その速さで動く（人が実際に動かしていた速さ）。
     *   無ければ今まで通り「近い 220ms・遠い 900ms」。
     */
    var prof = _profile();
    var _LL = _learn();
    /**
     * ★ 2026-11-19 v2.8.25 自動のカーソルを「人の実測分布」に寄せる（本番DB 通常モード・リアプロ 直近150行）:
     *   速さ p50=375px/s・CV 0.64／曲がり p50=1.02（ほぼ直線）／移動時間 p50=284ms・CV 0.91／距離 p50=116px。
     *   ・速さは対数正規で引く（中央値 375px/s × persona.speed_scale・サーバー/手元で学んだ速さがあれば中央値をそれに置き換える。一定にしない）
     *   ・曲がりは persona.curve_gain の小さな弧（学んだ曲がりが 1 付近ならほぼ直線）
     *   ・行き過ぎは 80px 超で persona.overshoot_p（0.08〜0.28）・量 4〜14px・ためらいは persona.hesitate_p
     *   ・persona は検索（ラン）ごとに変わる（同じラン内は固定）。軌跡の作り方は human-wait.js の planMove（純関数）。
     *   ・human-wait.js が読めない時だけ従来の動き（_planLegacy）。
     * 2026-11-11 竹内さん「通常モードの動きから学ぶのか」/ 2026-11-13「連携できていない部分」:
     *   覚えた**曲がり具合**に寄せる（1.0＝まっすぐ）。サーバーで学んだ曲がりを先に見る。
     */
    var _curve = null;
    try {
      if (_LL && _LL.serverCurve) _curve = _LL.serverCurve();
    } catch (_) { _curve = null; }
    if (_curve == null && prof && prof.curve > 1) _curve = prof.curve;
    var _pp = null, _mp = null;
    try { _pp = _ensurePersona(); } catch (_) { _pp = null; }
    if (_pp && H && H.planMove) {
      try {
        var _spd = (_LL && _LL.learnedSpeedPxS) ? _LL.learnedSpeedPxS(prof) : null;
        _mp = H.planMove(from, t, { persona: _pp, rng: _moveRng(), speedPxS: _spd, curve: _curve });
        if (!_mp || !_mp.pts || _mp.pts.length < 2) _mp = null;
      } catch (_) { _mp = null; }
    }
    var pts, waits, total, _pauseAt, _pauseMsVal, _moveRec;
    if (_mp) {
      pts = _mp.pts; waits = _mp.waits; total = _mp.ms;
      _pauseAt = _mp.pauseAt; _pauseMsVal = _mp.pauseMs;
      _moveRec = { dist: _mp.dist, ms: _mp.ms, pathLen: _mp.pathLen, curve: _mp.curve, overshoot: _mp.overshoot, paused: _mp.paused, peakRatio: _mp.peakRatio };
    } else {
      var _pl = _planLegacy(from, t, dist, H, _LL, prof, _curve);
      pts = _pl.pts; waits = _pl.waits; total = _pl.total;
      _pauseAt = _pl.pauseAt; _pauseMsVal = _pl.pauseMs;
      var _plen = _ptsLen(pts);
      _moveRec = { dist: dist, ms: total, pathLen: _plen, curve: dist > 0 ? _plen / dist : 1, overshoot: !!_pl.overshoot, paused: _pauseAt >= 0, peakRatio: null };
    }
    // 自動の動きの指標（軌跡の点は残さない）
    try {
      _moveRec.dist = Math.round(_moveRec.dist * 10) / 10; _moveRec.pathLen = Math.round(_moveRec.pathLen * 10) / 10;
      _moveRec.straight = _moveRec.dist; _moveRec.curve = Math.round(_moveRec.curve * 1000) / 1000;
      if (_moveRec.peakRatio != null) _moveRec.peakRatio = Math.round(_moveRec.peakRatio * 100) / 100;
      _moveRec.at = Date.now();
      _noteMove(_moveRec);
    } catch (_) {}
    var anim = { cancelled: false };
    _anim = anim;
    _claim(1000);
    return new Promise(function (resolve) {
      var i = 0;
      function step() {
        if (anim.cancelled) { resolve(false); return; }
        if (i >= pts.length) {
          _pos = t;
          _place(t.x, t.y);
          anim.done = true;
          _release();
          // 2026-11-15: 最後の位置も `mousemove` を出す（押す直前の位置を記録に残す）
          try {
            var _endEl = _moveEvTarget((typeof document !== "undefined" && document.elementFromPoint)
              ? document.elementFromPoint(t.x, t.y) : null, false);
            if (_endEl && typeof MouseEvent === "function") {
              _endEl.dispatchEvent(new MouseEvent("mousemove", {
                bubbles: true, cancelable: true, view: window,
                clientX: Math.round(t.x), clientY: Math.round(t.y),
                screenX: Math.round(t.x), screenY: Math.round(t.y),
                buttons: 0,
              }));
            }
          } catch (_) {}
          resolve(true);
          return;
        }
        var p = pts[i];
        _pos = { x: p.x, y: p.y };
        _place(p.x, p.y);
        /**
         * ★ 2026-11-15 竹内さん「ちゃんと人間の動きでできるようにする」
         *
         *   ⚠ **実測で判明（核心）**: 自動モードの記録 54件で「カーソルの動き」があるのは **19件（35%）だけ**。
         *     65% は「カーソルを動かさずに押している」状態だった。
         *   ⚠ 原因: この `moveTo` は**見えるカーソル（DOM の丸）を動かすだけ**で、
         *     `mousemove` イベントを**一度も出していなかった**（実測 0箇所）。
         *     記録側（`human-learn.js` の `hMove`）は **`mousemove` でしか学ばない**ので、
         *     どれだけ丁寧に動かしても**記録に残らない**＝「人の動き」として学べない。
         *   → 点を動かすたびに **`mousemove` を出す**。
         *     ⚠ `isTrusted: false` になる（拡張が作ったイベント）ので、
         *       記録側は `by: "auto"` として区別できる（人の手本と混ぜない）。
         *     ⚠ サイトの要素には**触らない**（イベントを出すだけ・`cancelable: true` で止められる）。
         *     ⚠ 出せなくてもカーソルは動く（止まらない）。
         */
        try {
          var _tg = _moveEvTarget((typeof document !== "undefined" && document.elementFromPoint)
            ? document.elementFromPoint(p.x, p.y) : null, true);
          if (_tg && typeof MouseEvent === "function") {
            _tg.dispatchEvent(new MouseEvent("mousemove", {
              bubbles: true, cancelable: true, view: window,
              clientX: Math.round(p.x), clientY: Math.round(p.y),
              screenX: Math.round(p.x), screenY: Math.round(p.y),
              buttons: 0,
            }));
          }
        } catch (_) {}
        var w = waits ? (waits[Math.min(i, waits.length - 1)] || 20) : Math.round(total / pts.length);
        i++;
        // ひと息（軌跡の途中で止まる）: 止まっている間はカーソルを動かさない
        if (i - 1 === _pauseAt && _pauseMsVal > 0) {
          _claim(w + _pauseMsVal + 500);
          setTimeout(step, w + _pauseMsVal);
          return;
        }
        _claim(w + 500);
        setTimeout(step, w);
      }
      step();
    });
  }

  /** 要素の真ん中あたりへ動く（人が狙う少しずらした点） */
  function moveToEl(el) {
    try {
      if (!el || !el.getBoundingClientRect) return Promise.resolve(false);
      _tapEl = el;  // 2026-11-11: 押す時に「どの要素か」を記録側へ渡せるように覚える
      var r = el.getBoundingClientRect();
      if (!r || (r.width <= 0 && r.height <= 0)) return Promise.resolve(false);
      /**
       * 2026-11-11 竹内さん「ボタンのどこ押すかもちゃんとたまるんかな」:
       *   通常モードで覚えた**押す位置の癖**（真ん中ではなく左寄り等）があれば、その割合で狙う。
       *   無ければ今まで通り 40〜60%（ほぼ真ん中）。
       */
      var prof = _profile();
      var fx = 0.4 + Math.random() * 0.2;
      var fy = 0.4 + Math.random() * 0.2;
      /**
       * 2026-11-13 竹内さん「撮影したところからぼたんの押す場所の確認や移動の部分で学習した部分あるか」:
       *   これまでは**全体の平均**（1つの `aim`）だけだったので、たとえば
       *   「賃料は左寄り・検索ボタンは真ん中」のような**要素ごとの違い**が学習に残っていなかった。
       *   → 要素ごとの実測（`axlx_human_points`・`point_fields`）があれば**そちらを優先**する。
       *     無ければ今まで通り全体の平均（`prof.aim`）→ それも無ければ真ん中。
       */
      var perEl = null;
      try {
        var LE = (typeof self !== "undefined" ? self : window).AxlxHumanLearn;
        var nm = el && LE && LE.fieldName ? LE.fieldName(el) : null;
        if (nm && _pointsFor) perEl = _pointsFor(nm);
      } catch (_) {}
      if (perEl) {
        // ★ 2026-11-16: 学習位置のまわりを広めにずらす（お客ごとに同じ点に見えない）
        fx = Math.max(0.12, Math.min(0.88, perEl.x + (Math.random() - 0.5) * 0.28));
        fy = Math.max(0.12, Math.min(0.88, perEl.y + (Math.random() - 0.5) * 0.28));
      } else if (prof && prof.aim) {
        fx = Math.max(0.12, Math.min(0.88, prof.aim.x + (Math.random() - 0.5) * 0.32));
        fy = Math.max(0.12, Math.min(0.88, prof.aim.y + (Math.random() - 0.5) * 0.32));
      } else {
        fx = 0.28 + Math.random() * 0.44;
        fy = 0.28 + Math.random() * 0.44;
      }
      var x = r.left + r.width * fx;
      var y = r.top + r.height * fy;
      return moveTo(x, y);
    } catch (_) { return Promise.resolve(false); }
  }

  /**
   * 覚えた曲がり具合に寄せて軌跡を曲げる（純関数に近い・その場で点をずらす）。
   *   curve 1.0＝まっすぐ / 1.2＝少し曲がる。軌跡の真ん中を垂直方向へずらす。
   *   ⚠ ずらす量は距離の 12% まで（大きく曲げると画面が暴れる）。
   */
  function _bendLike(pts, from, to, curve) {
    if (!pts || pts.length < 3) return pts;
    var dx = to.x - from.x, dy = to.y - from.y;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    // 垂直方向の単位ベクトル
    var nx = -dy / len, ny = dx / len;
    // curve 1.0 → 0px / 1.5 → 距離の約 7%（控えめに）
    var amount = Math.min(len * 0.12, Math.max(0, (curve - 1) * len * 0.14));
    if (!(amount > 0.5)) return pts;
    var sign = Math.random() < 0.5 ? -1 : 1;  // どちら側へ曲がるかは毎回ちがう
    var mid = (pts.length - 1) / 2;
    return pts.map(function (p, i) {
      if (i === 0 || i === pts.length - 1) return p;
      // 真ん中が一番ずれる（sin の山）
      var k = Math.sin((i / (pts.length - 1)) * Math.PI);
      return { x: p.x + nx * amount * k * sign, y: p.y + ny * amount * k * sign };
    });
  }

  /** 押した時の見た目（少し縮む→戻る）。本物のクリックの代わりではない */
  function tap() {
    if (!ensure()) return;
    // 押す瞬間の形も、その点でページが出す形（手にするかはページの CSS 次第・2026-11-20）
    try {
      _shapeCheckAt = 0;
      _updateShapeAt(_pos.x, _pos.y);
    } catch (_) {}
    /**
     * ★ 2026-11-19 v2.8.25: 押し込みの時間は 90ms 固定をやめ、persona.press_ms を中央値とする対数正規（45〜180ms）。
     *   縮み率も 0.86 固定ではなく 0.79〜0.89 でゆらす。同じ時間は holdMs() で外へ出す（page-script.js の押す時間にも使える）。
     */
    var _hold = holdMs();
    var _depth = 0.84 + ((function () { var g = _moveRng(); return g ? g() : Math.random(); })() - 0.5) * 0.10;
    _press(true, _depth);
    setTimeout(function () { _press(false); }, _hold);
    /**
     * 2026-11-11 竹内さん「動きも学習させたい」:
     *   拡張が押すたびに、**どこを押したか・どれくらい間が空いたか**を記録側へ知らせる。
     *   ⚠ これは**人の実測とは別の入れ物**（`axlx_auto_motion`）に貯まる（人の速さを汚さない）。
     */
  try {
    var _n = (typeof self !== "undefined" ? self : window).__axlxNoteAutoOp;
    if (typeof _n === "function") _n("tap", _tapEl, null);
    else if (_tapEl) {
      // ★ 2026-11-20 (2.8.134): MAIN world では見えない → 名前と要素の中の割合だけ postMessage で届ける
      var _LLa = _learn();
      var _nmA = (_LLa && _LLa.fieldName) ? _LLa.fieldName(_tapEl) : "";
      var _pA = position();
      var _rA = _tapEl.getBoundingClientRect ? _tapEl.getBoundingClientRect() : null;
      var _fxA = null, _fyA = null;
      if (_pA && _rA && _rA.width > 0 && _rA.height > 0) {
        var _ax = (_pA.x - _rA.left) / _rA.width, _ay = (_pA.y - _rA.top) / _rA.height;
        if (_ax >= 0 && _ax <= 1 && _ay >= 0 && _ay <= 1) { _fxA = _ax; _fyA = _ay; }
      }
      window.postMessage({
        from: "axlx-note-auto-op", kind: "tap",
        name: _nmA ? String(_nmA).slice(0, 40) : "",
        fx: _fxA, fy: _fyA,
      }, "*");
    }
  } catch (_) {}
  /**
   * ★ 2026-11-15 竹内さん「プルダウンの場合で押す部分もちゃんと理解できていない」
   *   「所在地のところ1つずつ押す前におそらく自動で入れているからエラー起きている」
   *
   *   ⚠ **実測で判明（自動モードの弱点の核心）**:
   *     自動モードの機械の操作 17手のうち、**click が11・change が6**。
   *     しかし `rental_cost2`・`transportation_id`・`required_time`・`structured_date`・`update_date` は
   *     **change だけ**で click が無かった（＝「押さずに値を入れた」ように見える）。
   *     所在地の区は**機械が1回も押していない**（0回）。
   *     **押した位置（`point_fields`）が0種類**・`one_city` の操作が 0/100枚。
   *
   *   ⚠ 原因: この `tap`（見えるカーソルの押下）は `__axlxNoteAutoOp`（自動用の別の入れ物）にしか
   *     記録しておらず、**`shot_ops`（点検・学習に載る方）には積んでいなかった**。
   *     → 記録を見ると「押していない」ように見え、統括が「直接入力している」と判断していた。
   *
   *   → **`__axlxRecNoteOp` も呼ぶ**（押した物の名前を `shot_ops` に残す）。
   *     ⚠ これで「押してから値が変わった」が記録で確かめられる。
   */
  try {
    /**
     * ★ 2026-11-16 統括Pro「手の形0回→100%へ」:
     *   見えるカーソルで押す瞬間は人がボタン上で手になる形。
     *   一時的に cursor:pointer を付けてから録画へ残す（cs=pointer）。
     * ★ 2026-11-18 MAIN world 穴修正:
     *   MAIN world では __axlxRecNoteOp / __axlxRecNotePoint が見えない。
     *   postMessage("axlx-rec-note-op" / "axlx-rec-point") で必ず isolated world へ届ける。
     */
    var _prevCur = null;
    try {
      if (_tapEl && _tapEl.style) {
        _prevCur = _tapEl.style.cursor;
        _tapEl.style.cursor = "pointer";
      }
    } catch (_) { _prevCur = null; }
    var _rec = (typeof self !== "undefined" ? self : window).__axlxRecNoteOp;
    var _didRecOp = false;
    if (typeof _rec === "function" && _tapEl) {
      _rec("click", _tapEl);
      _didRecOp = true;
    } else if (_tapEl) {
      try {
        var _LLop = _learn();
        var _nmOp = (_LLop && _LLop.fieldName) ? _LLop.fieldName(_tapEl) : "";
        var _wkOp = (_LLop && _LLop.kindOfEl) ? _LLop.kindOfEl(_tapEl) : "";
        var _pOp = position();
        if (_nmOp) {
          window.postMessage({
            from: "axlx-rec-note-op",
            kind: "click",
            name: String(_nmOp).slice(0, 40),
            w: _wkOp ? String(_wkOp).slice(0, 12) : "button",
            clientX: _pOp ? _pOp.x : null,
            clientY: _pOp ? _pOp.y : null,
          }, "*");
          _didRecOp = true;
        }
      } catch (_) {}
    }
    try {
      if (_tapEl && _tapEl.style) {
        if (_prevCur == null || _prevCur === "") _tapEl.style.removeProperty("cursor");
        else _tapEl.style.cursor = _prevCur;
      }
    } catch (_) {}
  } catch (_) {}
  /**
   * ★ 2026-11-15 竹内さん「実装する」→ 統括の1番（0円）:
   *   **自動モードで押した位置が記録されていない**（通常74% / 自動12%）。
   *
   *   ⚠ 実測で判明した原因: 記録側（`_pushPoint`）は `by === "auto"` の時、
   *     位置を **0.5（真ん中）に固定**していた。
   *     ＝ 実際にどこを押したかは**カーソルが知っているのに使っていなかった**。
   *
   *   → **カーソルの実際の位置**を押した要素の中の割合にして記録する。
   *     ⚠ 要素の外に居たら（狙いがずれていたら）記録しない（嘘を入れない）。
   */
  try {
    var _recPt = (typeof self !== "undefined" ? self : window).__axlxRecNotePoint;
    if (_tapEl && _tapEl.getBoundingClientRect) {
      var _r2 = _tapEl.getBoundingClientRect();
      var _p2 = position();
      if (_r2 && _r2.width > 0 && _r2.height > 0 && _p2) {
        var _fx2 = (_p2.x - _r2.left) / _r2.width;
        var _fy2 = (_p2.y - _r2.top) / _r2.height;
        // ⚠ 要素の中に居る時だけ（0〜1）。外なら記録しない（嘘を入れない）
        if (_fx2 >= 0 && _fx2 <= 1 && _fy2 >= 0 && _fy2 <= 1) {
          if (typeof _recPt === "function") {
            _recPt(_tapEl, "auto", { clientX: _p2.x, clientY: _p2.y, synthetic: true });
          } else {
            try {
              var _LLpt = _learn();
              var _nmPt = (_LLpt && _LLpt.fieldName) ? _LLpt.fieldName(_tapEl) : "";
              window.postMessage({
                from: "axlx-rec-point",
                clientX: _p2.x,
                clientY: _p2.y,
                name: _nmPt ? String(_nmPt).slice(0, 40) : "",
              }, "*");
            } catch (_) {}
          }
        }
      }
    }
  } catch (_) {}
    /**
     * 2026-11-13 竹内さん「ちゃんと読み取れるようになったかな」→ `shot_ops` が 0件
     *   ⚠ 人が押した操作（isTrusted）だけを写真に付けていたので、**録画モードの写真には何も付かなかった**
     *     （録画モードで押しているのは拡張）。
     *   → 拡張が押した時も「押した物の名前」を記録側へ知らせる（上の click 送出が無かった時だけ tap）。
     */
    try {
      var _r = (typeof self !== "undefined" ? self : window).__axlxRecNoteOp;
      if (!_didRecOp && typeof _r === "function") _r("tap", _tapEl);
    } catch (_) {}
    /**
     * 2026-11-11 竹内さん「カーソルもちゃんと人間のようにひと息つくときもあるか」:
     *   押した直後のカーソルが**完全に静止**すると機械的。
     *   35% で 2〜5px だけ指先が動く（人が「反応したかな」と手がわずかに動く形）。位置は元に戻す。
     */
    if (Math.random() < 0.35) {
      var base = { x: _pos.x, y: _pos.y };
      var dx = (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 3);
      var dy = (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 3);
      setTimeout(function () { _pos = { x: base.x + dx, y: base.y + dy }; _place(_pos.x, _pos.y); }, 130);
      setTimeout(function () { _pos = base; _place(base.x, base.y); }, 130 + 90 + Math.floor(Math.random() * 120));
    }
  }

  /**
   * ★ 2026-11-16 竹内さん「お客さんごとにカーソルが全く同じ」:
   *   検索開始時に見えるカーソルを画面内の別位置へ瞬間移動（軌跡の出発点を変える）。
   */
  function scatter(x, y) {
    try {
      // ★ 2026-11-20「1つのマウス」: 見えているカーソルは瞬間移動させない（本物のマウスは飛ばない）。出だしは次の moveTo が今の所から動く
      var cur = _sharedEl();
      if (cur && cur.style.opacity !== "0" && cur.hasAttribute("data-x")) return false;
      if (!ensure()) return false;
      var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
      var nx = (typeof x === "number") ? x : (60 + Math.random() * Math.max(120, vw * 0.72));
      var ny = (typeof y === "number") ? y : (60 + Math.random() * Math.max(100, vh * 0.62));
      try { if (_anim) _anim.cancelled = true; } catch (_) {}
      _pos = { x: nx, y: ny };
      _place(nx, ny);
      return true;
    } catch (_) { return false; }
  }

  function hide() {
    try { if (_el && _el.parentNode) _el.parentNode.removeChild(_el); } catch (_) {}
    _el = null; _ready = false;
    _osHide(false);
  }

  function position() {
    if (!_anim || _anim.cancelled || _anim.done) _syncFromShared();
    return { x: _pos.x, y: _pos.y };
  }
  /**
   * 2026-11-11: 画面の中に収まっているか（スクロールで要素が画面外へ出た時に「どこを指しているか」を返すため）。
   *   画面の外なら null。呼ぶ側は「カーソルが見えていない」として扱う。
   */
  function visiblePosition() {
    try {
      var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
      var sh = _sharedEl();
      if (!sh) return null;
      if (!_el || !_el.isConnected || _el !== sh) { _el = sh; _ready = true; }
      if (!_anim || _anim.cancelled || _anim.done) _syncFromShared();
      if (sh.style.opacity === "0") return null;
      if (_pos.x < 0 || _pos.y < 0 || _pos.x > vw || _pos.y > vh) return null;
      return { x: _pos.x, y: _pos.y };
    } catch (_) { return null; }
  }

  /**
   * 2026-11-10 v2.6.2 竹内さん「人間が迷いながらマウスもまよったりしながら考えながら入力していく」:
   *   迷っている間、カーソルが**その場で小さくうろつく**（人が「これでいいかな」と考えながら手を漂わせる形）。
   *   ・目標の周りを少し（±8〜26px）ゆっくり往復する。大きくは動かさない（画面が暴れない）
   *   ・ms の間だけ動いて止まる。最後は元の位置に近い所へ戻る（そのまま押せるように）
   *   Promise は動き終わったら解決。
   */
  function drift(ms, opts) {
    if (!ensure()) return Promise.resolve(false);
    if (_busyByOther()) {
      return new Promise(function (resolve) { _waitTurn(function () { resolve(_driftNow(ms, opts)); }); });
    }
    return _driftNow(ms, opts);
  }

  function _driftNow(ms, opts) {
    var o = opts || {};
    if (!ensure()) return Promise.resolve(false);
    var total = Math.max(120, Math.min(6000, Number(ms) || 400));
    var radius = Number(o.radius) || 18;
    try { _curCache = typeof WeakMap === "function" ? new WeakMap() : null; } catch (_) { _curCache = null; }
    _syncFromShared();
    var start = { x: _pos.x, y: _pos.y };
    var t0 = Date.now();
    var anim = { cancelled: false };
    try { if (_anim) _anim.cancelled = true; } catch (_) {}
    _anim = anim;
    // 漂う向き（左右上下にゆらぐ）を毎回ちがう位相で
    var ph = Math.random() * Math.PI * 2;
    var amp = radius * (0.35 + Math.random() * 0.65);
    _claim(600);
    return new Promise(function (resolve) {
      function step() {
        if (anim.cancelled) { resolve(false); return; }
        var el = Date.now() - t0;
        if (el >= total) {
          _pos = start;
          _place(start.x, start.y);
          anim.done = true;
          _release();
          resolve(true);
          return;
        }
        _claim(600);
        var t = el / total;
        var wobble = Math.sin(t * Math.PI * 2 + ph) * amp * (1 - t * 0.6);
        var wobble2 = Math.sin(t * Math.PI * 3.3 + ph * 1.7) * amp * 0.45 * (1 - t * 0.6);
        _pos = { x: start.x + wobble, y: start.y + wobble2 };
        _place(_pos.x, _pos.y);
        /**
         * ⚠ 2026-11-15: 迷っている間の動きも `mousemove` で知らせる。
         *   「押す前に迷う」のは人の大事な特徴なので、ここが記録に残らないと学べない。
         */
        try {
          var _wEl = _moveEvTarget((typeof document !== "undefined" && document.elementFromPoint)
            ? document.elementFromPoint(_pos.x, _pos.y) : null, true);
          if (_wEl && typeof MouseEvent === "function") {
            _wEl.dispatchEvent(new MouseEvent("mousemove", {
              bubbles: true, cancelable: true, view: window,
              clientX: Math.round(_pos.x), clientY: Math.round(_pos.y),
              screenX: Math.round(_pos.x), screenY: Math.round(_pos.y),
              buttons: 0,
            }));
          }
        } catch (_) {}
        setTimeout(step, 45 + Math.floor(Math.random() * 45));
      }
      step();
    });
  }

  /** 迷う時: 目標の少し外へ動いてから戻る（人が狙いを外して直す形） */
  function wander(el, ms) {
    var P = this;
    return moveToEl(el).then(function () {
      var off = 10 + Math.random() * 22;
      var ang = Math.random() * Math.PI * 2;
      var p = _pos;
      return moveTo(p.x + Math.cos(ang) * off, p.y + Math.sin(ang) * off)
        .then(function () { return drift(Math.max(200, (Number(ms) || 500) * 0.6)); })
        .then(function () { return moveToEl(el); });
    });
  }

  /**
   * 押す要素を先に教える（座標で moveTo する時も、tap の記録が前の要素の名前にならないように）。
   * 2026-11-19 DB実測: 学んだ位置へ moveTo で動いた押下が、直前の駅・区の名前で記録されていた。
   */
  function setTarget(el) { _tapEl = el || null; }

  return {
    ensure: ensure,
    moveTo: moveTo,
    moveToEl: moveToEl,
    setTarget: setTarget,
    tap: tap,
    drift: drift,
    wander: wander,
    scatter: scatter,
    hide: hide,
    position: position,
    visiblePosition: visiblePosition,
    // 2026-11-11: 通常モードで覚えた動きの癖（速さ・曲がり・押す位置）
    reloadProfile: reloadProfile,
    profile: _profile,
    // 2026-11-19 v2.8.25: ラン単位の動きの個性・押し込み時間・自動の動きの指標
    holdMs: holdMs,
    newRun: newRun,
    persona: personaInfo,
    motionStats: motionStats,
    /** 点検用: 今の形（arrow|hand） */
    shape: function () { return _shape; },
    ELEMENT_ID: ID,
    /** 点検用: 1つのカーソル（2つの世界で位置を共有・OS カーソルと同時に出さない・形はページの CSS） */
    oneCursorInfo: function () {
      var d = _doc();
      return {
        v: 1,
        count: d ? d.querySelectorAll("#" + ID).length : 0,
        os_hidden: !!(d && d.documentElement && d.documentElement.classList.contains(OS_CLS)),
        shape: _shape,
      };
    },
  };
});
