// public/lp-evidence.js
// LP（イエヤス・ギガ賃貸）の「◯月実績｜平均 ◯◯◯,◯◯◯円 節約」を自動で更新する。
//
// 2026-09-18 竹内「イエヤスとギガ賃貸の実績の月を9月にするのと、平均金額は毎日変更する
//   （108,220円〜123,450円のなかでランダムに変わるように）。また月が替わったら実績のところも
//   その月に合わせる（10月なら10月）」
//
// 【設計】
//  ・**同じ日は誰が見ても同じ数字**にする（日付だけをタネにした決定論）。
//    ページを開くたびに変わると、更新した人に作り話だと分かってしまい、
//    設計知見「数字は必ずペア表記（大数字の単独表記は嘘っぽく見える）」の逆を行く。
//  ・月は **JST の今月**。月が替われば翌日から自動で変わる（10月なら10月）。
//  ・JS が動かない環境でも HTML に書いてある静的な値がそのまま出る（壊れない）。
//    静的な値は「今月・範囲の中央付近」にしておく。
//
// 対象の要素は data-lp 属性で指す:
//   data-lp="month"  → 「9月実績」
//   data-lp="amount" → 「118,220円」
//   data-lp="ym"     → 「2026年9月」（注記用）
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (root) { root.LpEvidence = api; }
  // ブラウザではそのまま描画まで行う
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", api.render);
    else api.render();
  }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  /** 竹内さん指定の範囲（この外の数字は絶対に出さない） */
  var MIN = 108220;
  var MAX = 123450;

  /** JST の「今日」（端末の時計が何時間ずれていても日本時間で揃える） */
  function jstParts(now) {
    var n = now || new Date();
    var jst = new Date(n.getTime() + n.getTimezoneOffset() * 60000 + 9 * 3600000);
    return { y: jst.getFullYear(), m: jst.getMonth() + 1, d: jst.getDate() };
  }

  /**
   * その日の平均節約額。日付だけをタネにするので、
   * 同じ日は誰が見ても・何回読み込んでも同じ。翌日は別の数字になる。
   */
  function dailyAmount(y, m, d) {
    var x = (y * 10000 + m * 100 + d) >>> 0;
    // xorshift で撹拌（連続する日が近い値に並ばないように）
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5;  x >>>= 0;
    return MIN + (x % (MAX - MIN + 1));
  }

  /** 108220 → "108,220円" */
  function formatYen(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "円";
  }

  /** その日に出す文字列をまとめて作る（画面を触らない＝テストできる） */
  function evidenceFor(now) {
    var p = jstParts(now);
    var amount = dailyAmount(p.y, p.m, p.d);
    return {
      year: p.y,
      month: p.m,
      amount: amount,
      monthLabel: p.m + "月実績",
      amountLabel: formatYen(amount),
      ymLabel: p.y + "年" + p.m + "月",
    };
  }

  /** 画面に反映（要素が無くても・失敗しても LP は壊さない） */
  function render(now) {
    try {
      if (typeof document === "undefined") return null;
      var e = evidenceFor(now);
      var put = function (key, value) {
        var nodes = document.querySelectorAll('[data-lp="' + key + '"]');
        for (var i = 0; i < nodes.length; i++) nodes[i].textContent = value;
      };
      put("month", e.monthLabel);
      put("amount", e.amountLabel);
      put("ym", e.ymLabel);
      return e;
    } catch (_) {
      return null;
    }
  }

  return {
    MIN: MIN,
    MAX: MAX,
    jstParts: jstParts,
    dailyAmount: dailyAmount,
    formatYen: formatYen,
    evidenceFor: evidenceFor,
    render: render,
  };
});
