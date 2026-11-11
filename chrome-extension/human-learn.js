// chrome-extension/human-learn.js
// 2026-11-11 竹内さん「必要なら人間の動きをちゃんとおしえるので画面録画や監視して動きちゃんと理解できるように。
//   通常モードのところで動きこっちで行うからそこ把握できれば理想。普通モードはスタッフの動きを学習する形でもよい」
//
// 何をするか:
//   通常モード（とスタッフモード）の間、**人が本当に押した・打った・選んだ**操作を画面から見張って覚える。
//   覚えるのは「どの欄を・どの順で・どれくらい間をあけて触ったか」だけ。**入力した中身（値）は残さない**。
//   覚えた物は集計（回数・間の中央値・触った欄の順）にして chrome.storage.local に溜める。
//   自動モードの「人のような間」を、この実測に寄せていくための材料（今は貯める所まで）。
//
// 2026-11-11 竹内さん「普通モードでのマウスの動かし方やボタンのどこ押すかもちゃんとたまるんかな。
//   画面のうごかしかたも」:
//   ① **マウスの動かし方**も覚える（`moves`）: 1回の移動ごとに
//        距離・時間・速さ（平均／最大）・まっすぐ具合（曲がり）・始点と終点・形（点を8個まで）
//      → 「どれくらいの速さで・どれくらい曲がって動くか」が分かる（pointer-ui.js の軌跡を実測に寄せる材料）
//   ② **ボタンのどこを押したか**も覚える（`points`）: 押した要素の中の位置を 0〜1 の割合で
//      → 「真ん中ではなく左寄りを押す」のような癖が分かる（_fireAt の狙う点を実測に寄せる材料）
//   ③ **画面の動かし方**も覚える（scroll の `dy`・`y`）: 1回のスクロール量と、その時のページ内の位置（％）
//      → 「一度にどれくらい動かすか・どこまで送ってから押すか」が分かる
//   座標は**画面（ビューポート）の％**で持つ（画面の大きさが違っても比べられる）。
//
// 見分け方:
//   ブラウザが本当に人が起こしたイベントは isTrusted === true。拡張が作った物は false。
//   → 通常モードでは拡張は押さないので、数えられるのは人の操作だけ（拡張の動きは混ざらない）。
//
// このファイルは chrome.* を使わない純関数（テストしやすい）。保存は human-learn-record.js が行う。
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (root) { root.AxlxHumanLearn = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var MAX_OPS = 150;          // 1ページで覚える操作の上限（古い物から捨てる）
  var SAME_KIND_MIN_MS = 250; // 同じ種類が続く時は間引く（スクロールや連続キーで溢れないように）
  var MAX_FIELDS = 40;        // 覚える欄の名前の種類の上限
  var MAX_GAPS = 80;          // 間（ms）の見本の上限（中央値を出すため）
  // 2026-11-11 竹内さん「マウスの動かし方やボタンのどこ押すか、画面のうごかしかたも」:
  var MAX_MOVES = 40;         // 1ページで覚える「1回の移動」の上限
  var MAX_MOVE_PTS = 24;      // 1回の移動で貯める点の上限（多すぎると重い）
  var MOVE_GAP_MS = 350;      // 指が止まってこれだけ経ったら「1回の移動」を締める
  var MAX_POINTS = 40;        // 押した場所の上限
  var MAX_SCROLLS = 40;       // 画面の動かし方の上限

  /**
   * 2026-11-11 竹内さん「これでボタン物件検索でおすばしょ理解できたかな？」→
   *   「押した場所は分かるが、**何というボタンか**が分からない」（リアプロの検索ボタンは名前の無い DIV）:
   *   旧は name → id → 文字（BUTTON/A/LABEL/OPTION だけ）→ class → タグ の順。
   *   → **DIV/SPAN/TD の文字も拾う**（「検索」「駅の設定へ進む」など）。加えて class も必ず残す。
   *
   *   名前の作り方（人が読んで分かる形にする）:
   *     "検索｜div.go_search"      … 文字が取れた時（文字｜タグ.クラス）
   *     "go_search"               … 文字が無くて class がある時（その class）
   *     "rental_cost2"            … name がある時（欄の名前を最優先）
   *     "#btn-mode-ward"          … id がある時
   *   ⚠ 入力した中身（値）は入れない。文字は**ボタンや見出しの表示文言**だけ（30字まで）。
   */
  var TEXT_TAGS = /^(BUTTON|A|LABEL|OPTION|LI|SPAN|DIV|TD|TH|P|H1|H2|H3|H4)$/;
  function fieldName(el) {
    if (!el) return null;
    try {
      var tag = String(el.tagName || "").toUpperCase();
      // ① 欄の名前（input/select はこれが一番確実）
      var name = el.getAttribute && el.getAttribute("name");
      if (name) return String(name).slice(0, 30);
      // ② 表示の文字（人が「何を押したか」分かる形）＋ class（サイト側の目印）
      var cls = (el.className && typeof el.className === "string") ? el.className.trim().split(/\s+/)[0] : "";
      var mark = tag.toLowerCase() + (cls ? "." + cls : "");
      if (TEXT_TAGS.test(tag)) {
        var txt = directText(el).slice(0, 20);
        if (txt) return (txt + "｜" + mark).slice(0, 30);
      }
      // ③ id
      var id = el.id;
      if (id) return ("#" + id + (cls ? "｜" + mark : "")).slice(0, 30);
      // ④ class だけ
      if (cls) return mark.slice(0, 24);
      // ⑤ タグだけ
      return tag.toLowerCase();
    } catch (_) { return null; }
  }
  /**
   * その要素**自身**の文字（子の文字は混ぜない）。ボタンの中の入れ子で
   * 「検索」ではなく「検索条件をすべてクリア」のような長い文字になるのを防ぐ。
   */
  function directText(el) {
    try {
      var t = "";
      var kids = el.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].nodeType === 3) t += kids[i].nodeValue || "";
        if (t.replace(/\s+/g, "").length >= 12) break;
      }
      t = t.replace(/[\s\u3000]+/g, "");
      if (t) return t;
      // 自身の直下に文字が無ければ、全体の文字（短い時だけ）
      var all = String(el.textContent || "").replace(/[\s\u3000]+/g, "");
      return all.length <= 16 ? all : all.slice(0, 12);
    } catch (_) { return ""; }
  }

  /** 操作の種類（click / key / change / scroll） */
  function kindOf(type) {
    if (type === "click") return "click";
    if (type === "keydown" || type === "key") return "key";
    if (type === "change" || type === "input") return "change";
    if (type === "scroll" || type === "wheel") return "scroll";
    return "other";
  }

  /**
   * 覚える器を作る（1ページに1つ）。
   * @param {{now?:()=>number, doc?:Document, win?:Window}} opt
   */
  function create(opts) {
    var o = opts || {};
    var now = typeof o.now === "function" ? o.now : function () { return Date.now(); };
    var D = o.doc || (typeof document !== "undefined" ? document : null);
    var W = o.win || (typeof window !== "undefined" ? window : null);
    var ops = [];
    var lastKind = null, lastAt = 0;
    // マウスの移動を1回としてまとめるための作業場所（点を貯めて、止まったら1件にする）
    var move = null;
    var moves = [];      // 1回の移動の記録（MAX_MOVES まで）
    var points = [];     // 押した場所（要素の中の割合・MAX_POINTS まで）
    var scrolls = [];    // 画面の動かし方（量と位置・MAX_SCROLLS まで）
    var vw = function () { try { return (W && W.innerWidth) || 1200; } catch (_) { return 1200; } };
    var vh = function () { try { return (W && W.innerHeight) || 800; } catch (_) { return 800; } };

    /**
     * 2026-11-11 竹内さん「ボタン物件検索でおすばしょ理解できたかな」:
     *   押した場所と要素の名前だけでは「**どの段階で**押したか」が分からない。
     *   例）「検索」ボタンは条件入力の最後に押す。物件の行は検索結果で押す。駅はモーダルの中で押す。
     *   → 記録の1件ごとに**段階**を付ける（見た目で分かる印だけを見る・サイトは触らない）。
     *     form   … 条件を入れている画面（検索の欄がある）
     *     modal  … 小窓（所在地・沿線の選択）が開いている
     *     result … 検索結果の一覧（物件の行がある）
     *     other  … どれでもない
     */
    function stageOf() {
      try {
        var d = D;
        if (!d || !d.querySelector) return "other";
        // 小窓が開いているか（リアプロは .this_window、ITANDI は role=dialog）
        if (d.querySelector(".this_window, [role='dialog'], .modal")) {
          var w = d.querySelector(".this_window, [role='dialog'], .modal");
          if (w && w.offsetParent !== null) return "modal";
        }
        // 検索結果の一覧か（物件の行がある）
        if (d.querySelector(".building_tr, .building_list, .property_list, [class*='building_tr']")) return "result";
        // 条件の欄があるか
        if (d.querySelector("select[name='rental_cost2'], input[name='city_code[]'], div.go_search, div.go_search_submit")) return "form";
        return "other";
      } catch (_) { return "other"; }
    }

    /** 1件覚える。間引きで捨てたら false */
    function record(type, el) {
      var k = kindOf(type);
      var t = now();
      if (k === lastKind && t - lastAt < SAME_KIND_MIN_MS) { lastAt = t; return false; }
      ops.push({ t: t, k: k, f: fieldName(el), s: stageOf() });
      if (ops.length > MAX_OPS) ops.shift();
      lastKind = k; lastAt = t;
      return true;
    }

    /**
     * 押した場所（要素の中のどこか）を0〜1の割合で覚える。
     *   人が「真ん中ではなく左寄り・上の方」を押す癖を測るため。要素が取れない時は覚えない。
     */
    function recordPoint(e) {
      try {
        var el = e && e.target;
        if (!el || !el.getBoundingClientRect) return;
        var r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) return;
        var fx = (e.clientX - r.left) / r.width;
        var fy = (e.clientY - r.top) / r.height;
        if (!(fx >= -0.2 && fx <= 1.2 && fy >= -0.2 && fy <= 1.2)) return; // 枠の外（別の要素の上）は捨てる
        points.push({
          f: fieldName(el),
          x: Math.round(Math.max(0, Math.min(1, fx)) * 100) / 100,
          y: Math.round(Math.max(0, Math.min(1, fy)) * 100) / 100,
          w: Math.round(r.width), h: Math.round(r.height),
          s: stageOf(),   // 2026-11-11: どの段階で押したか（form/modal/result）
        });
        if (points.length > MAX_POINTS) points.shift();
      } catch (_) {}
    }

    /** スクロール（画面の動かし方）。量と、動かした後のページ内の位置（％）を覚える */
    function recordScroll(dy, pageY, pageH, viewH) {
      try {
        if (!dy) return;
        scrolls.push({
          dy: Math.round(dy),
          dir: dy > 0 ? "down" : "up",
          // ページ全体のどこに居るか（0＝一番上・1＝一番下）
          y: (pageH > viewH) ? Math.round(Math.max(0, Math.min(1, pageY / (pageH - viewH))) * 100) / 100 : 0,
        });
        if (scrolls.length > MAX_SCROLLS) scrolls.shift();
      } catch (_) {}
    }

    /**
     * マウスの動きを1点ぶん覚える（mousemove のたびに呼ぶ）。
     *   押していない時の動きと、押しながらの動き（ドラッグ）を区別する。
     *   指を止めて 350ms 経ったら「1回の移動」として締める。
     */
    function recordMove(x, y, buttons, t) {
      try {
        var tt = typeof t === "number" ? t : now();
        if (!move || tt - move.lastAt > MOVE_GAP_MS) {
          closeMove(); // 前の移動を締める
          move = { t0: tt, lastAt: tt, pts: [], drag: !!buttons };
        }
        move.lastAt = tt;
        if (buttons) move.drag = true;
        // 点は最大 MOVE_SAMPLES 個（間引いて残す＝形が分かる程度）
        if (move.pts.length < MAX_MOVE_PTS) move.pts.push({ x: Math.round(x), y: Math.round(y), t: tt, b: buttons ? 1 : 0 });
      } catch (_) {}
    }

    /** 貯めていた移動を1件に締める（距離・時間・速さ・曲がり・形） */
    function closeMove() {
      if (!move || move.pts.length < 2) { move = null; return; }
      var pts = move.pts;
      var a = pts[0], b = pts[pts.length - 1];
      var dist = 0, maxSeg = 0;
      for (var i = 1; i < pts.length; i++) {
        var d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        dist += d;
        if (d > maxSeg) maxSeg = d;
      }
      var ms = Math.max(1, b.t - a.t);
      var straight = Math.hypot(b.x - a.x, b.y - a.y);
      moves.push({
        ms: Math.round(ms),
        dist: Math.round(dist),
        // 速さ（px/秒）。遅い動き・速い動きの目安
        px_s: Math.round(dist / (ms / 1000)),
        peak_px_s: Math.round(maxSeg / (ms / 1000)), // 一番速かった瞬間の目安
        // 曲がり具合: 実際に動いた距離 ÷ まっすぐの距離（1.0＝まっすぐ・大きいほど曲がる）
        curve: straight > 6 ? Math.round((dist / straight) * 100) / 100 : null,
        from: { x: Math.round((a.x / vw()) * 100) / 100, y: Math.round((a.y / vh()) * 100) / 100 },
        to: { x: Math.round((b.x / vw()) * 100) / 100, y: Math.round((b.y / vh()) * 100) / 100 },
        drag: !!move.drag,
        // 形（画面の％・最大8点）＝どう曲がったか
        shape: shapeOf(pts),
      });
      if (moves.length > MAX_MOVES) moves.shift();
      move = null;
    }

    /** 軌跡の点を最大8個に間引いて、画面の％で返す */
    function shapeOf(pts) {
      var n = Math.min(MAX_MOVE_PTS, 8);
      var out = [];
      if (pts.length <= n) {
        for (var i = 0; i < pts.length; i++) out.push([Math.round((pts[i].x / vw()) * 100) / 100, Math.round((pts[i].y / vh()) * 100) / 100]);
        return out;
      }
      for (var j = 0; j < n; j++) {
        var idx = Math.round((j / (n - 1)) * (pts.length - 1));
        out.push([Math.round((pts[Math.min(idx, pts.length - 1)].x / vw()) * 100) / 100, Math.round((pts[Math.min(idx, pts.length - 1)].y / vh()) * 100) / 100]);
      }
      return out;
    }

    /** 画面（document）に付ける。戻り値は外す関数 */
    function attach(doc, win) {
      var d = doc || D;
      var w = win || W;
      if (!d || !d.addEventListener) return function () {};
      /**
       * 2026-11-11 竹内さん「画面の動き方もちゃんと把握できているのかな録画のような形で」:
       *   操作のたびに**画面の写真を1枚**撮れるよう、`onOp(kind, el, pt)` を呼ぶ口を作った。
       *   呼ぶ側（human-learn-record.js）が写真を撮る。無ければ何もしない（学習だけ続く）。
       */
      var onOp = typeof o.onOp === "function" ? o.onOp : null;
      var pointOf = function (e) {
        try {
          var el = e && e.target;
          if (!el || !el.getBoundingClientRect) return null;
          var r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) return null;
          return { x: e.clientX, y: e.clientY, fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height };
        } catch (_) { return null; }
      };
      var guarded = function (type) {
        return function (e) {
          // 人が起こした物だけ（拡張が dispatch した物は数えない＝学習を汚さない）
          if (!e || !e.isTrusted) return;
          var added = record(type, e.target);
          var pt = null;
          if (type === "click") { recordPoint(e); pt = pointOf(e); } // ボタンのどこを押したか
          // 間引かれた操作では撮らない（同じ所を連打しても写真は増やさない）
          if (added && onOp) { try { onOp(type, e.target, pt); } catch (_) {} }
        };
      };
      var hClick = guarded("click");
      var hKey = guarded("keydown");
      var hChange = guarded("change");
      var hWheel = function (e) {
        if (!e || !e.isTrusted) return;
        var added = record("wheel", null);
        // 画面の動かし方（1回の量と、その時のページ内の位置）
        try {
          var p = (w && w.pageYOffset) || 0;
          var ph = (d.documentElement && d.documentElement.scrollHeight) || 0;
          var vhh = (w && w.innerHeight) || 800;
          recordScroll(e.deltaY, p, ph, vhh);
        } catch (_) {}
        // 2026-11-11: スクロールも「画面の動き方」なので、その後の画面を1枚撮る
        if (added && onOp) { try { onOp("wheel", null, null); } catch (_) {} }
      };
      var hMove = function (e) {
        if (!e || !e.isTrusted) return;
        // 押していない時の動きと、押しながらの動き（ドラッグ）を区別して覚える
        recordMove(e.clientX, e.clientY, e.buttons, now());
      };
      var hScroll = function () {
        // ホイール以外（キー・バー・指）でも位置だけ覚える（量は分からないので 0＝位置だけ）
        try {
          if (!w) return;
          var p = w.pageYOffset || 0;
          var ph = (d.documentElement && d.documentElement.scrollHeight) || 0;
          var vhh = w.innerHeight || 800;
          if (ph > vhh) {
            var y = Math.round(Math.max(0, Math.min(1, p / (ph - vhh))) * 100) / 100;
            if (scrolls.length === 0 || scrolls[scrolls.length - 1].y !== y) {
              scrolls.push({ dy: 0, dir: null, y: y });
              if (scrolls.length > MAX_SCROLLS) scrolls.shift();
            }
          }
        } catch (_) {}
      };
      var on = function (type, fn, opt) { try { d.addEventListener(type, fn, opt || true); } catch (_) {} };
      on("click", hClick);
      on("keydown", hKey);
      on("change", hChange);
      on("mousemove", hMove, { passive: true, capture: true });
      try { if (w && w.addEventListener) w.addEventListener("wheel", hWheel, { passive: true, capture: true }); } catch (_) {}
      try { if (w && w.addEventListener) w.addEventListener("scroll", hScroll, { passive: true }); } catch (_) {}
      return function detach() {
        try {
          d.removeEventListener("click", hClick, true);
          d.removeEventListener("keydown", hKey, true);
          d.removeEventListener("change", hChange, true);
          d.removeEventListener("mousemove", hMove, true);
        } catch (_) {}
        try { if (w) { w.removeEventListener("wheel", hWheel, true); w.removeEventListener("scroll", hScroll); } } catch (_) {}
        closeMove(); // 残っている移動を締める
      };
    }

    function list() { return ops.slice(); }
    function count() { return ops.length; }
    /** 貯めた動き・押した場所・スクロール（読み出し用。締め忘れを締めてから返す） */
    function detail() {
      closeMove();
      return { moves: moves.slice(), points: points.slice(), scrolls: scrolls.slice() };
    }
    function reset() {
      ops = []; lastKind = null; lastAt = 0; move = null;
      moves = []; points = []; scrolls = [];
    }

    return { attach: attach, record: record, recordPoint: recordPoint, recordMove: recordMove, recordScroll: recordScroll,
             closeMove: closeMove, list: list, count: count, detail: detail, reset: reset };
  }

  /** 中央値（空なら null） */
  function median(arr) {
    if (!arr || !arr.length) return null;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
  }

  /**
   * 2026-11-11: 小数を保つ中央値（曲がり具合・押した位置の割合など）。
   *   ⚠ `median` は整数に丸めるので、1.2 が 1 に・0.25 が 0 に潰れる（実測が消える）。
   *   小数第2位まで残す。
   */
  function medianF(arr) {
    if (!arr || !arr.length) return null;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    var v = a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    return Math.round(v * 100) / 100;
  }

  /**
   * 覚えた操作を集計する（純関数）。
   * @returns {{n:number, kinds:Object, gap_ms:number|null, gaps:number[], fields:string[], order:string[]}}
   */
  function summarize(ops) {
    var list = Array.isArray(ops) ? ops : [];
    var kinds = {};
    var gaps = [];
    var fields = [];
    var order = [];
    for (var i = 0; i < list.length; i++) {
      var op = list[i] || {};
      var k = op.k || "other";
      kinds[k] = (kinds[k] || 0) + 1;
      if (op.f) {
        if (fields.indexOf(op.f) < 0 && fields.length < MAX_FIELDS) fields.push(op.f);
        if (order.length < MAX_FIELDS) order.push(op.f);
      }
      if (i > 0 && typeof op.t === "number" && typeof list[i - 1].t === "number") {
        var g = op.t - list[i - 1].t;
        if (g >= 0 && g <= 120000) gaps.push(g); // 2分超えは「離席」なので間の見本に入れない
      }
    }
    var sample = gaps.length > MAX_GAPS ? gaps.slice(-MAX_GAPS) : gaps;
    return { n: list.length, kinds: kinds, gap_ms: median(gaps), gaps: sample, fields: fields, order: order };
  }

  /**
   * 2026-11-11 竹内さん「マウスの動かし方やボタンのどこ押すか、画面のうごかしかたも」:
   *   動き（moves）・押した場所（points）・画面の動かし方（scrolls）を集計する（純関数）。
   *   残すのは**傾向**（中央値など）と**見本**（形・押した割合）。
   * @returns {{moves:Object, points:Object, scrolls:Object}}
   */
  function summarizeMotion(detail) {
    var d = detail && typeof detail === "object" ? detail : {};
    var mv = Array.isArray(d.moves) ? d.moves : [];
    var pt = Array.isArray(d.points) ? d.points : [];
    var sc = Array.isArray(d.scrolls) ? d.scrolls : [];

    // ── マウスの動かし方 ──
    var speeds = [], curves = [], durs = [], dists = [];
    var drags = 0, shapes = [];
    mv.forEach(function (m) {
      if (!m) return;
      if (typeof m.px_s === "number") speeds.push(m.px_s);
      if (typeof m.curve === "number") curves.push(m.curve);
      if (typeof m.ms === "number") durs.push(m.ms);
      if (typeof m.dist === "number") dists.push(m.dist);
      if (m.drag) drags++;
      if (Array.isArray(m.shape) && m.shape.length >= 2 && shapes.length < 6) shapes.push(m.shape);
    });
    var moves = {
      n: mv.length,
      drag_n: drags,
      speed_px_s: median(speeds),          // ふだんの速さ
      curve: medianF(curves),              // 曲がり具合（1.0＝まっすぐ）※小数を保つ
      ms: median(durs),                    // 1回の移動にかける時間
      dist: median(dists),                 // 1回の距離（px）
      shapes: shapes,                      // どう曲がったかの見本（画面の％・最大6本）
    };

    // ── ボタンのどこを押したか ──
    var xs = [], ys = [], byField = {};
    pt.forEach(function (p) {
      if (!p || typeof p.x !== "number" || typeof p.y !== "number") return;
      xs.push(p.x); ys.push(p.y);
      var f = p.f || "?";
      if (!byField[f]) byField[f] = { n: 0, xs: [], ys: [], stages: {} };
      byField[f].n++;
      // 2026-11-11: どの段階で押したかも数える（form/modal/result）
      var sg = p.s || "other";
      byField[f].stages[sg] = (byField[f].stages[sg] || 0) + 1;
      if (byField[f].xs.length < 20) { byField[f].xs.push(p.x); byField[f].ys.push(p.y); }
    });
    var fieldSpread = {};
    Object.keys(byField).slice(0, 20).forEach(function (f) {
      fieldSpread[f] = { n: byField[f].n, x: medianF(byField[f].xs), y: medianF(byField[f].ys) };
      // 一番多かった段階（この要素をどの場面で押すか）
      var st = byField[f].stages, best = null, bestN = -1;
      Object.keys(st).forEach(function (k) { if (st[k] > bestN) { best = k; bestN = st[k]; } });
      if (best) fieldSpread[f].stage = best;
    });
    var points = {
      n: pt.length,
      x: medianF(xs),                      // ふだんは横のどこを押すか（0＝左端・0.5＝真ん中）
      y: medianF(ys),                      // 縦のどこか（0＝上端・0.5＝真ん中）
      fields: fieldSpread,                 // 欄ごとの癖
    };

    // ── 画面の動かし方 ──
    var dys = [], ysPos = [], downs = 0, ups = 0;
    sc.forEach(function (s) {
      if (!s) return;
      if (typeof s.dy === "number" && s.dy !== 0) { dys.push(Math.abs(s.dy)); if (s.dy > 0) downs++; else ups++; }
      if (typeof s.y === "number") ysPos.push(s.y);
    });
    var scrolls = {
      n: sc.length,
      dy: median(dys),                     // 1回に動かす量
      down: downs, up: ups,
      y: medianF(ysPos),                   // よく居るページ内の位置（0＝上・1＝下）※小数を保つ
      y_samples: ysPos.slice(-20),         // どこまで送ってから押すか の見本
    };

    return { moves: moves, points: points, scrolls: scrolls };
  }

  /** 数の中央値を前の値と合わせる（見本の配列をまとめて中央値を出し直す） */
  function _mergeArr(prev, add, cap) {
    var out = (Array.isArray(prev) ? prev : []).concat(Array.isArray(add) ? add : []);
    if (cap && out.length > cap) out = out.slice(-cap);
    return out;
  }

  /**
   * 動きの集計を前と合わせる（純関数）。見本（shapes・y_samples・欄ごと）は新しい方を優先して足す。
   */
  function mergeMotion(prev, add) {
    var p = prev && typeof prev === "object" ? prev : {};
    var a = add && typeof add === "object" ? add : {};
    var pm = p.moves || {}, am = a.moves || {};
    var pp = p.points || {}, ap = a.points || {};
    var psc = p.scrolls || {}, asc = a.scrolls || {};

    // 中央値は「前の中央値」と「今の中央値」を回数で重み付けして寄せる（見本を全部持ち回らないため）
    //   ⚠ 1.2 のような小数を潰さないこと（曲がり具合・押した位置の割合）
    var blend = function (pv, av, pn, an) {
      var hasP = typeof pv === "number", hasA = typeof av === "number";
      if (hasP && hasA) {
        var wp = Math.max(1, Number(pn) || 1), wa = Math.max(1, Number(an) || 1);
        return Math.round(((pv * wp + av * wa) / (wp + wa)) * 100) / 100;
      }
      return hasA ? av : (hasP ? pv : null);
    };

    var fieldSpread = {};
    var pf = pp.fields || {}, af = ap.fields || {};
    Object.keys(af).forEach(function (f) {
      var pre = pf[f] || null;
      fieldSpread[f] = pre ? { n: (Number(pre.n) || 0) + (Number(af[f].n) || 0), x: blend(pre.x, af[f].x, pre.n, af[f].n), y: blend(pre.y, af[f].y, pre.n, af[f].n) } : af[f];
    });
    Object.keys(pf).forEach(function (f) {
      if (!fieldSpread[f] && Object.keys(fieldSpread).length < 20) fieldSpread[f] = pf[f];
    });

    return {
      moves: {
        n: (Number(pm.n) || 0) + (Number(am.n) || 0),
        drag_n: (Number(pm.drag_n) || 0) + (Number(am.drag_n) || 0),
        speed_px_s: blend(pm.speed_px_s, am.speed_px_s, pm.n, am.n),
        curve: (typeof pm.curve === "number" && typeof am.curve === "number")
          ? Math.round(((pm.curve * Math.max(1, pm.n || 1) + am.curve * Math.max(1, am.n || 1)) / (Math.max(1, pm.n || 1) + Math.max(1, am.n || 1))) * 100) / 100
          : (typeof am.curve === "number" ? am.curve : (typeof pm.curve === "number" ? pm.curve : null)),        ms: blend(pm.ms, am.ms, pm.n, am.n),
        dist: blend(pm.dist, am.dist, pm.n, am.n),
        shapes: _mergeArr(pm.shapes, am.shapes, 6),
      },
      points: {
        n: (Number(pp.n) || 0) + (Number(ap.n) || 0),
        x: blend(pp.x, ap.x, pp.n, ap.n),
        y: blend(pp.y, ap.y, pp.n, ap.n),
        fields: fieldSpread,
      },
      scrolls: {
        n: (Number(psc.n) || 0) + (Number(asc.n) || 0),
        dy: blend(psc.dy, asc.dy, psc.n, asc.n),
        down: (Number(psc.down) || 0) + (Number(asc.down) || 0),
        up: (Number(psc.up) || 0) + (Number(asc.up) || 0),
        y: blend(psc.y, asc.y, psc.n, asc.n),
        y_samples: _mergeArr(psc.y_samples, asc.y_samples, 20),
      },
    };
  }

  /**
   * 前の集計と今の集計を1つに（純関数・元は変えない）。
   *   回数は足す・間の見本は新しい物を残して上限まで・欄の順は新しい回を先に。
   */
  function mergeAggregate(prev, add) {
    var p = prev && typeof prev === "object" ? prev : {};
    var a = add && typeof add === "object" ? add : {};
    var kinds = {};
    var pk = p.kinds || {}, ak = a.kinds || {};
    Object.keys(pk).forEach(function (k) { kinds[k] = (kinds[k] || 0) + (Number(pk[k]) || 0); });
    Object.keys(ak).forEach(function (k) { kinds[k] = (kinds[k] || 0) + (Number(ak[k]) || 0); });
    var gaps = (Array.isArray(p.gaps) ? p.gaps : []).concat(Array.isArray(a.gaps) ? a.gaps : []);
    if (gaps.length > MAX_GAPS) gaps = gaps.slice(-MAX_GAPS);
    var fields = (Array.isArray(a.fields) ? a.fields : []).slice();
    (Array.isArray(p.fields) ? p.fields : []).forEach(function (f) {
      if (fields.indexOf(f) < 0 && fields.length < MAX_FIELDS) fields.push(f);
    });
    var order = (Array.isArray(a.order) ? a.order : []).slice(0, MAX_FIELDS);
    // 2026-11-11: マウスの動かし方・押した場所・画面の動かし方も合わせる
    var motion = mergeMotion({ moves: p.moves, points: p.points, scrolls: p.scrolls },
                             { moves: a.moves, points: a.points, scrolls: a.scrolls });
    return {
      v: 1,
      n: (Number(p.n) || 0) + (Number(a.n) || 0),
      sessions: (Number(p.sessions) || 0) + 1,
      kinds: kinds,
      gaps: gaps,
      gap_ms: median(gaps),
      fields: fields,
      order: order,
      moves: motion.moves,
      points: motion.points,
      scrolls: motion.scrolls,
    };
  }

  /** 集計から「前より人の間が測れたか」を1行で（点検・画面に出す用） */
  function reportLine(agg) {
    if (!agg || !agg.n) return "まだ人の動きを覚えていません（通常モードで操作すると貯まります）";
    var g = agg.gap_ms == null ? "?" : Math.round(agg.gap_ms);
    var s = "人の動き: " + agg.n + "回・" + (agg.sessions || 0) + "回分／操作の間 約" + g + "ms";
    // 2026-11-11: マウスの動かし方・ボタンのどこ・画面の動かし方も1行に足す
    var mv = agg.moves, pt = agg.points, sc = agg.scrolls;
    if (mv && mv.n) s += "／マウス " + mv.n + "回分（速さ 約" + (mv.speed_px_s || "?") + "px/s・曲がり" + (mv.curve || "?") + "）";
    if (pt && pt.n) s += "／押した所 横" + (pt.x == null ? "?" : pt.x) + "・縦" + (pt.y == null ? "?" : pt.y);
    if (sc && sc.n) s += "／スクロール " + sc.n + "回（1回 約" + (sc.dy == null ? "?" : sc.dy) + "px）";
    return s;
  }

  /** 貯めた物の中身を人に見せる1行ずつ（確認用） */
  function describe(agg) {
    var out = [];
    if (!agg) return ["まだ何も貯まっていません"];
    var mv = agg.moves || {}, pt = agg.points || {}, sc = agg.scrolls || {};
    if (mv.n) {
      out.push("マウス: " + mv.n + "回分を覚えました");
      out.push("  ふだんの速さ 約" + (mv.speed_px_s || "?") + "px/秒・1回にかける時間 約" + (mv.ms || "?") + "ms・距離 約" + (mv.dist || "?") + "px");
      out.push("  まっすぐ具合 " + (mv.curve || "?") + "（1.00に近いほどまっすぐ・大きいほど曲がる）" + (mv.drag_n ? "・押しながら動かした回 " + mv.drag_n : ""));
    } else out.push("マウス: まだ");
    if (pt.n) out.push("押した場所: " + pt.n + "回分／ふだんは横 " + (pt.x == null ? "?" : pt.x) + "・縦 " + (pt.y == null ? "?" : pt.y) + "（0＝左/上端・0.5＝真ん中）");
    else out.push("押した場所: まだ");
    if (sc.n) out.push("画面の動かし方: " + sc.n + "回分／1回 約" + (sc.dy == null ? "?" : sc.dy) + "px（下へ " + (sc.down || 0) + "・上へ " + (sc.up || 0) + "）");
    else out.push("画面の動かし方: まだ");
    return out;
  }

  /**
   * 2026-11-11 竹内さん「通常モードの動きから学ぶのか」「これで画面から動き把握できるようになったてことかな？」
   *   貯めた実測（`axlx_human_learn`）から、**自動モードの動きに使う値**を作る（純関数）。
   *
   *   何を学ぶか:
   *     ・速さ（px/秒）        → カーソルを動かす時間を実測に合わせる
   *     ・曲がり具合（1.0〜）  → 軌跡の曲げ方を実測に合わせる
   *     ・押した位置（0〜1）   → ボタンのどこを狙うかを実測に合わせる
   *     ・スクロール量（px）   → 一度に送る量を実測に合わせる
   *
   *   ⚠ 実測が無い・少なすぎる時は **null を返す**（呼ぶ側は今まで通りの値を使う＝急に動きが変わらない）。
   *   ⚠ 極端な値は丸める（速すぎ・遅すぎ・端すぎで不自然にならないように）。
   *
   * @param {Object} agg  axlx_human_learn の中身
   * @param {{minMoves?:number, minPoints?:number, minScrolls?:number}} opt
   * @returns {{speed_px_s:number, curve:number, aim:{x:number,y:number}, scroll_dy:number|null,
   *            sample:{moves:number, points:number, scrolls:number}, at:number}|null}
   */
  function profileFrom(agg, opt) {
    var o = opt || {};
    var minMoves = o.minMoves == null ? 3 : o.minMoves;
    var minPoints = o.minPoints == null ? 3 : o.minPoints;
    var minScrolls = o.minScrolls == null ? 2 : o.minScrolls;
    if (!agg || typeof agg !== "object") return null;
    var mv = agg.moves || {}, pt = agg.points || {}, sc = agg.scrolls || {};

    // 速さ: 100〜4000px/秒の範囲に丸める（人が見て自然な範囲）
    var sp = typeof mv.speed_px_s === "number" && mv.speed_px_s > 0 ? mv.speed_px_s : null;
    if (sp != null) sp = Math.max(100, Math.min(4000, Math.round(sp)));
    // 曲がり: 1.0〜2.0（1.0＝まっすぐ）。実測が 1.0 未満（誤差）は 1.0 に
    var cv = typeof mv.curve === "number" && mv.curve >= 1 ? mv.curve : null;
    if (cv != null) cv = Math.round(Math.max(1, Math.min(2, cv)) * 100) / 100;
    // 押す位置: 0.5〜0.5 を中心に 0.2〜0.8 に丸める（端すぎる所は押さない＝押し間違いを防ぐ）
    var ax = typeof pt.x === "number" ? Math.max(0.2, Math.min(0.8, pt.x)) : null;
    var ay = typeof pt.y === "number" ? Math.max(0.2, Math.min(0.8, pt.y)) : null;
    // スクロール量: 50〜1500px に丸める
    var sd = typeof sc.dy === "number" && sc.dy > 0 ? Math.max(50, Math.min(1500, Math.round(sc.dy))) : null;

    var enoughMoves = (Number(mv.n) || 0) >= minMoves;
    var enoughPoints = (Number(pt.n) || 0) >= minPoints;
    var enoughScrolls = (Number(sc.n) || 0) >= minScrolls;

    if (!enoughMoves && !enoughPoints && !enoughScrolls) return null; // 材料が足りない＝今まで通り
    return {
      speed_px_s: enoughMoves ? sp : null,
      curve: enoughMoves ? cv : null,
      aim: (enoughPoints && ax != null && ay != null) ? { x: Math.round(ax * 100) / 100, y: Math.round(ay * 100) / 100 } : null,
      scroll_dy: enoughScrolls ? sd : null,
      sample: { moves: Number(mv.n) || 0, points: Number(pt.n) || 0, scrolls: Number(sc.n) || 0 },
      at: Number(agg.at) || 0,
    };
  }

  /** プロファイルから「この距離を動く時間」を出す（実測の速さ・無ければ null） */
  function moveMsFor(profile, dist) {
    if (!profile || typeof profile.speed_px_s !== "number" || !(dist > 0)) return null;
    var ms = (dist / profile.speed_px_s) * 1000;
    // 速さから出した時間を 120〜1600ms に丸める（0ms で飛ばない・長すぎて止まらない）
    return Math.max(120, Math.min(1600, Math.round(ms)));
  }

  /** 段階の日本語名（画面に出す用） */
  var STAGE_JA = { form: "条件の入力", modal: "小窓（選択）", result: "検索結果", other: "その他" };
  function stageJa(s) { return STAGE_JA[s] || STAGE_JA.other; }

  /**
   * 2026-11-11 竹内さん「これでボタン物件検索でおすばしょ理解できたかな？ある程度は」:
   *   押した場所を**人が読める形**にする（記録の全体像から）。
   *   「物件検索のボタンは条件の入力の最後に、横62%・縦78%で押した」のように出す。
   *
   * @param {Object} agg  axlx_human_learn の中身
   * @returns {string[]} 1行ずつ（多すぎないように上位8件まで）
   */
  function buttonReport(agg) {
    var out = [];
    var pt = (agg && agg.points) || {};
    var fields = pt.fields || {};
    var names = Object.keys(fields);
    if (!names.length) return ["押した場所の記録がまだありません（通常モードで操作すると貯まります）"];
    // 押した回数の多い順
    names.sort(function (a, b) { return (Number(fields[b].n) || 0) - (Number(fields[a].n) || 0); });
    out.push("押した場所（多い順・" + (pt.n || 0) + "回分）:");
    names.slice(0, 8).forEach(function (f) {
      var v = fields[f] || {};
      var pct = function (x) { return x == null ? "?" : Math.round(x * 100) + "%"; };
      var st = v.stage ? "／" + stageJa(v.stage) : "";
      // 名前は "検索｜div.go_search" の形。長い時はそのまま（30字まで）
      out.push("  ・" + f + " … " + (v.n || 0) + "回・横" + pct(v.x) + "・縦" + pct(v.y) + st);
    });
    if (names.length > 8) out.push("  （ほか " + (names.length - 8) + "件）");
    return out;
  }

  /** 集計から「何を学んだか」を1行ずつ（画面に出す用） */
  function learnedLines(profile) {
    if (!profile) return ["まだ学べていません（通常モードでもう少し操作すると学び始めます）"];
    var out = [];
    out.push("速さ: " + (profile.speed_px_s != null ? "約" + profile.speed_px_s + "px/秒（カーソルの動きに使います）" : "まだ"));
    out.push("曲がり: " + (profile.curve != null ? profile.curve + "（1.00＝まっすぐ）" : "まだ"));
    out.push("押す位置: " + (profile.aim ? "横" + profile.aim.x + "・縦" + profile.aim.y + "（ボタンのどこを狙うか）" : "まだ"));
    out.push("スクロール: " + (profile.scroll_dy != null ? "1回 約" + profile.scroll_dy + "px" : "まだ"));
    return out;
  }

  return {
    create: create,
    summarize: summarize,
    summarizeMotion: summarizeMotion,
    mergeAggregate: mergeAggregate,
    mergeMotion: mergeMotion,
    profileFrom: profileFrom,
    moveMsFor: moveMsFor,
    learnedLines: learnedLines,
    buttonReport: buttonReport,
    stageJa: stageJa,
    reportLine: reportLine,
    describe: describe,
    fieldName: fieldName,
    kindOf: kindOf,
    median: median,
    medianF: medianF,
    MAX_OPS: MAX_OPS,
    MAX_GAPS: MAX_GAPS,
    SAME_KIND_MIN_MS: SAME_KIND_MIN_MS,
    MAX_MOVES: MAX_MOVES,
    MAX_MOVE_PTS: MAX_MOVE_PTS,
    MOVE_GAP_MS: MOVE_GAP_MS,
    MAX_POINTS: MAX_POINTS,
    MAX_SCROLLS: MAX_SCROLLS,
  };
});
