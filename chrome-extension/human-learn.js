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

  /** その要素を「どの欄か」の短い名前にする（値は入れない・個人の情報を残さない） */
  function fieldName(el) {
    if (!el) return null;
    try {
      var tag = String(el.tagName || "").toUpperCase();
      var name = el.getAttribute && el.getAttribute("name");
      if (name) return String(name).slice(0, 30);
      var id = el.id;
      if (id) return ("#" + id).slice(0, 30);
      // 文字が取れる物（ボタン・リンク）は先頭12字まで（人が何を押したか分かるように）
      if (tag === "BUTTON" || tag === "A" || tag === "LABEL" || tag === "OPTION") {
        var t = String(el.textContent || "").replace(/\s+/g, "").slice(0, 12);
        if (t) return t;
      }
      var cls = el.className && typeof el.className === "string" ? el.className.split(/\s+/)[0] : "";
      if (cls) return (tag.toLowerCase() + "." + cls).slice(0, 30);
      return tag.toLowerCase();
    } catch (_) { return null; }
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
   * @param {{now?:()=>number}} opt
   */
  function create(opts) {
    var o = opts || {};
    var now = typeof o.now === "function" ? o.now : function () { return Date.now(); };
    var ops = [];
    var lastKind = null, lastAt = 0;

    /** 1件覚える。間引きで捨てたら false */
    function record(type, el) {
      var k = kindOf(type);
      var t = now();
      if (k === lastKind && t - lastAt < SAME_KIND_MIN_MS) { lastAt = t; return false; }
      ops.push({ t: t, k: k, f: fieldName(el) });
      if (ops.length > MAX_OPS) ops.shift();
      lastKind = k; lastAt = t;
      return true;
    }

    /** 画面（document）に付ける。戻り値は外す関数 */
    function attach(doc, win) {
      var d = doc || (typeof document !== "undefined" ? document : null);
      var w = win || (typeof window !== "undefined" ? window : null);
      if (!d || !d.addEventListener) return function () {};
      var guarded = function (type) {
        return function (e) {
          // 人が起こした物だけ（拡張が dispatch した物は数えない＝学習を汚さない）
          if (!e || !e.isTrusted) return;
          record(type, e.target);
        };
      };
      var hClick = guarded("click");
      var hKey = guarded("keydown");
      var hChange = guarded("change");
      var hWheel = function (e) { if (e && e.isTrusted) record("wheel", null); };
      var on = function (type, fn) { try { d.addEventListener(type, fn, true); } catch (_) {} };
      on("click", hClick); on("keydown", hKey); on("change", hChange);
      try { if (w && w.addEventListener) w.addEventListener("wheel", hWheel, { passive: true, capture: true }); } catch (_) {}
      return function detach() {
        try {
          d.removeEventListener("click", hClick, true);
          d.removeEventListener("keydown", hKey, true);
          d.removeEventListener("change", hChange, true);
        } catch (_) {}
        try { if (w) w.removeEventListener("wheel", hWheel, true); } catch (_) {}
      };
    }

    function list() { return ops.slice(); }
    function count() { return ops.length; }
    function reset() { ops = []; lastKind = null; lastAt = 0; }

    return { attach: attach, record: record, list: list, count: count, reset: reset };
  }

  /** 中央値（空なら null） */
  function median(arr) {
    if (!arr || !arr.length) return null;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
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
    return {
      v: 1,
      n: (Number(p.n) || 0) + (Number(a.n) || 0),
      sessions: (Number(p.sessions) || 0) + 1,
      kinds: kinds,
      gaps: gaps,
      gap_ms: median(gaps),
      fields: fields,
      order: order,
    };
  }

  /** 集計から「前より人の間が測れたか」を1行で（点検・画面に出す用） */
  function reportLine(agg) {
    if (!agg || !agg.n) return "まだ人の動きを覚えていません（通常モードで操作すると貯まります）";
    var g = agg.gap_ms == null ? "?" : Math.round(agg.gap_ms);
    return "人の動き: " + agg.n + "回・" + (agg.sessions || 0) + "回分／操作の間 約" + g + "ms";
  }

  return {
    create: create,
    summarize: summarize,
    mergeAggregate: mergeAggregate,
    reportLine: reportLine,
    fieldName: fieldName,
    kindOf: kindOf,
    median: median,
    MAX_OPS: MAX_OPS,
    MAX_GAPS: MAX_GAPS,
    SAME_KIND_MIN_MS: SAME_KIND_MIN_MS,
  };
});
