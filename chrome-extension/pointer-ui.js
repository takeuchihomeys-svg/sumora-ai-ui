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
    if (_el && _el.isConnected) return _el;
    if (_el && _el.parentNode) _el.parentNode.removeChild(_el);
    var el = d.createElement("div");
    el.id = ID;
    el.setAttribute("aria-hidden", "true");
    // 白い縁取りの矢印（どんな背景でも見える）＋ 押した時に少し縮む
    el.style.cssText = [
      "position:fixed", "left:0", "top:0", "width:22px", "height:22px",
      "pointer-events:none", "z-index:2147483647",
      "transition:transform 60ms ease-out",
      "will-change:transform", "filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))",
    ].join(";");
    el.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M4 2.5 L4 19 L8.6 14.7 L11.3 21 L14.2 19.7 L11.6 13.6 L18 13.2 Z" ' +
      'fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    d.documentElement.appendChild(el);
    _el = el;
    _ready = true;
    // 最初は画面の左上外に置いておく（急に真ん中に出ない）
    if (!_pos.x && !_pos.y) { _pos = { x: 40, y: 80 }; _place(_pos.x, _pos.y); }
    return el;
  }

  function _place(x, y) {
    if (!_el) return;
    // transform は GPU で動くので、毎フレーム left/top を書き換えない（画面が重くならない）
    _el.style.transform = "translate3d(" + Math.round(x) + "px," + Math.round(y) + "px,0)";
  }

  function _press(down) {
    if (!_el) return;
    _el.style.transform = _el.style.transform.replace(/\s*scale\([^)]*\)/, "");
    _el.style.transform += down ? " scale(0.86)" : " scale(1)";
  }

  /** 画面の外に出さない（スクロールで要素が外れた時など） */
  function _clamp(p) {
    try {
      var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
      return {
        x: Math.min(Math.max(2, p.x), vw - 24),
        y: Math.min(Math.max(2, p.y), vh - 24),
      };
    } catch (_) { return p; }
  }

  /**
   * 今の位置から (x, y) へ人の軌跡で動かす。
   * Promise は「着いたら」解決（待たなくてもよい）。動きながら押すと不自然なので、押す前に await すると良い。
   */
  function moveTo(x, y) {
    var t = _clamp({ x: Number(x) || 0, y: Number(y) || 0 });
    if (!ensure()) return Promise.resolve(false);
    try { if (_anim) { _anim.cancelled = true; } } catch (_) {}
    var H = _hum();
    var from = { x: _pos.x, y: _pos.y };
    var dist = Math.sqrt(Math.pow(t.x - from.x, 2) + Math.pow(t.y - from.y, 2));
    // 近すぎる時は動かさない（同じ場所を押すたびに震えない）
    if (dist < 4) { _place(t.x, t.y); _pos = t; return Promise.resolve(true); }
    // 距離で時間を変える（近い 220ms・遠い 900ms・人より少し速い）
    var total = Math.min(900, Math.max(220, Math.round(dist * 1.6)));
    var steps = Math.min(28, Math.max(6, Math.round(dist / 26)));
    var pts = (H && H.pointerPath) ? H.pointerPath(from, t, steps) : [{ x: from.x, y: from.y }, t];
    var waits = (H && H.pointerDelays) ? H.pointerDelays(pts.length, total) : null;
    var anim = { cancelled: false };
    _anim = anim;
    return new Promise(function (resolve) {
      var i = 0;
      function step() {
        if (anim.cancelled) { resolve(false); return; }
        if (i >= pts.length) {
          _pos = t;
          _place(t.x, t.y);
          resolve(true);
          return;
        }
        var p = pts[i];
        _pos = { x: p.x, y: p.y };
        _place(p.x, p.y);
        var w = waits ? (waits[Math.min(i, waits.length - 1)] || 20) : Math.round(total / pts.length);
        i++;
        setTimeout(step, w);
      }
      step();
    });
  }

  /** 要素の真ん中あたりへ動く（人が狙う少しずらした点） */
  function moveToEl(el) {
    try {
      if (!el || !el.getBoundingClientRect) return Promise.resolve(false);
      var r = el.getBoundingClientRect();
      if (!r || (r.width <= 0 && r.height <= 0)) return Promise.resolve(false);
      var x = r.left + r.width * (0.4 + Math.random() * 0.2);
      var y = r.top + r.height * (0.4 + Math.random() * 0.2);
      return moveTo(x, y);
    } catch (_) { return Promise.resolve(false); }
  }

  /** 押した時の見た目（少し縮む→戻る）。本物のクリックの代わりではない */
  function tap() {
    if (!ensure()) return;
    _press(true);
    setTimeout(function () { _press(false); }, 90);
  }

  function hide() {
    try { if (_el && _el.parentNode) _el.parentNode.removeChild(_el); } catch (_) {}
    _el = null; _ready = false;
  }

  function position() { return { x: _pos.x, y: _pos.y }; }

  return {
    ensure: ensure,
    moveTo: moveTo,
    moveToEl: moveToEl,
    tap: tap,
    hide: hide,
    position: position,
    ELEMENT_ID: ID,
  };
});
