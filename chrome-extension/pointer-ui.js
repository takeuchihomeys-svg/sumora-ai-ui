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
      // 2026-11-11: 60ms の transition は、毎フレーム位置を書く時に**遅れが積もって軌跡がずれる**。
      //   縮み（押した時）だけ transition を使い、位置は即座に反映する（transform の translate は transition の対象外にする）
      "transition:transform 0ms linear",
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
    /**
     * 2026-11-11 竹内さん「マウスちゃんとした場所にうごくようになっているか」:
     *   ① SVG の矢印の**先端は (4,2.5)**（22px の中で左上寄り）。要素の left/top に来た点が「先端」になるよう、
     *      先端の分だけ戻して置く（旧は要素の左上に点を合わせていたので、**実際に指している場所と 4〜2.5px ずれていた**）。
     *   ② transition を 60ms → **0ms に近く**（毎フレーム transform を書くので、CSS の遅れが積もると軌跡が遅れて見える）。
     */
    _el.style.transform = "translate3d(" + Math.round(x - 4) + "px," + Math.round(y - 2.5) + "px,0)";
  }

  function _press(down) {
    if (!_el) return;
    _el.style.transform = _el.style.transform.replace(/\s*scale\([^)]*\)/, "");
    _el.style.transform += down ? " scale(0.86)" : " scale(1)";
  }

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
  /**
   * 2026-11-11: 画面の中に収まっているか（スクロールで要素が画面外へ出た時に「どこを指しているか」を返すため）。
   *   画面の外なら null。呼ぶ側は「カーソルが見えていない」として扱う。
   */
  function visiblePosition() {
    try {
      var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
      if (_pos.x < 0 || _pos.y < 0 || _pos.x > vw || _pos.y > vh) return null;
      if (!_el || !_el.isConnected) return null;
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
    var o = opts || {};
    if (!ensure()) return Promise.resolve(false);
    var total = Math.max(120, Math.min(6000, Number(ms) || 400));
    var radius = Number(o.radius) || 18;
    var start = { x: _pos.x, y: _pos.y };
    var t0 = Date.now();
    var anim = { cancelled: false };
    try { if (_anim) _anim.cancelled = true; } catch (_) {}
    _anim = anim;
    // 漂う向き（左右上下にゆらぐ）を毎回ちがう位相で
    var ph = Math.random() * Math.PI * 2;
    var amp = radius * (0.35 + Math.random() * 0.65);
    return new Promise(function (resolve) {
      function step() {
        if (anim.cancelled) { resolve(false); return; }
        var el = Date.now() - t0;
        if (el >= total) {
          _pos = start;
          _place(start.x, start.y);
          resolve(true);
          return;
        }
        var t = el / total;
        var wobble = Math.sin(t * Math.PI * 2 + ph) * amp * (1 - t * 0.6);
        var wobble2 = Math.sin(t * Math.PI * 3.3 + ph * 1.7) * amp * 0.45 * (1 - t * 0.6);
        _pos = { x: start.x + wobble, y: start.y + wobble2 };
        _place(_pos.x, _pos.y);
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

  return {
    ensure: ensure,
    moveTo: moveTo,
    moveToEl: moveToEl,
    tap: tap,
    drift: drift,
    wander: wander,
    hide: hide,
    position: position,
    visiblePosition: visiblePosition,
    ELEMENT_ID: ID,
  };
});
