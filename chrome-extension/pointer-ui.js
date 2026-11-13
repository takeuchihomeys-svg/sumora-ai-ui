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
  function _pointsFor(name) {
    if (!name) return null;
    var now = Date.now();
    // 30秒ごとに読み直す（貯まった分を次の動きから使う）
    if (!_points || now - _pointsLoadedAt > 30000) {
      _pointsLoadedAt = now;
      try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get([POINTS_KEY], function (r) {
            try { _points = (r && r[POINTS_KEY]) || {}; } catch (_) { _points = {}; }
          });
        }
      } catch (_) {}
    }
    var v = _points && _points[name];
    if (!v || typeof v.x !== "number" || typeof v.y !== "number") return null;
    // 何回も押した所だけ使う（1回だけは偶然かもしれない）
    if (Number(v.n) < 2) return null;
    return { x: v.x, y: v.y, n: Number(v.n) };
  }
  /** storage から読み直す（モードや貯まり方が変わった時） */
  function reloadProfile() {
    try {
      var LL = _learn();
      if (!LL || !LL.profileFrom) return;
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
      /**
       * 2026-11-11 竹内さん「データたまって理解するたび反映」:
       *   ① 貯まるたびに作り直された癖（axlx_human_profile）があれば**それをそのまま使う**（一番新しい理解）
       *   ② 無ければ、貯まった実測（axlx_human_learn）から今この場で作る
       */
      chrome.storage.local.get([PROF_LIVE_KEY, PROF_KEY], function (r) {
        try {
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
    if (_el && _el.isConnected) return _el;
    if (_el && _el.parentNode) _el.parentNode.removeChild(_el);
    // 2026-11-11: 最初に使う時に、通常モードで覚えた動きの癖を読む（読めなければ今まで通り）
    if (!_profLoaded) { _profLoaded = true; reloadProfile(); }
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
    if (Math.random() >= 0.18) return -1;     // 18%
    return Math.floor(n * (0.25 + Math.random() * 0.45)); // 25〜70% の所
  }
  function _pauseMs() {
    return 120 + Math.floor(Math.random() * 300); // 120〜420ms
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
    /**
     * 2026-11-11 竹内さん「通常モードの動きから学ぶのか」:
     *   通常モードで覚えた**実測の速さ**があれば、その速さで動く（人が実際に動かしていた速さ）。
     *   無ければ今まで通り「近い 220ms・遠い 900ms」。
     */
    var prof = _profile();
    var _LL = _learn();
    var _learned = (prof && _LL && _LL.moveMsFor) ? _LL.moveMsFor(prof, dist) : null;
    var total = _learned != null ? _learned : Math.min(900, Math.max(220, Math.round(dist * 1.6)));
    var steps = Math.min(28, Math.max(6, Math.round(dist / 26)));
    var pts = (H && H.pointerPath) ? H.pointerPath(from, t, steps) : [{ x: from.x, y: from.y }, t];
    // 2026-11-11: 覚えた**曲がり具合**に寄せる（1.0＝まっすぐ・大きいほど曲げる）
    if (prof && prof.curve > 1 && pts.length > 3) {
      try { pts = _bendLike(pts, from, t, prof.curve); } catch (_) {}
    }
    var waits = (H && H.pointerDelays) ? H.pointerDelays(pts.length, total) : null;
    var anim = { cancelled: false };
    _anim = anim;
    // 2026-11-11 竹内さん「カーソルもちゃんと人間のようにひと息つくときもあるか」: 途中で手を止める位置
    var _pauseAt = total > 400 ? _pausePointFor(pts.length) : -1;
    var _pauseMsVal = _pauseAt >= 0 ? _pauseMs() : 0;
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
        // ひと息（軌跡の途中で止まる）: 止まっている間はカーソルを動かさない
        if (i - 1 === _pauseAt && _pauseMsVal > 0) {
          setTimeout(step, w + _pauseMsVal);
          return;
        }
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
        fx = Math.max(0.15, Math.min(0.85, perEl.x + (Math.random() - 0.5) * 0.12));
        fy = Math.max(0.15, Math.min(0.85, perEl.y + (Math.random() - 0.5) * 0.12));
      } else if (prof && prof.aim) {
        // 実測の割合のまわりに少しだけ揺らす（毎回同じ点だと機械的）
        fx = Math.max(0.15, Math.min(0.85, prof.aim.x + (Math.random() - 0.5) * 0.16));
        fy = Math.max(0.15, Math.min(0.85, prof.aim.y + (Math.random() - 0.5) * 0.16));
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
    _press(true);
    setTimeout(function () { _press(false); }, 90);
    /**
     * 2026-11-11 竹内さん「動きも学習させたい」:
     *   拡張が押すたびに、**どこを押したか・どれくらい間が空いたか**を記録側へ知らせる。
     *   ⚠ これは**人の実測とは別の入れ物**（`axlx_auto_motion`）に貯まる（人の速さを汚さない）。
     */
    try {
      var _n = (typeof self !== "undefined" ? self : window).__axlxNoteAutoOp;
      if (typeof _n === "function") _n("tap", _tapEl, null);
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
    // 2026-11-11: 通常モードで覚えた動きの癖（速さ・曲がり・押す位置）
    reloadProfile: reloadProfile,
    profile: _profile,
    ELEMENT_ID: ID,
  };
});
