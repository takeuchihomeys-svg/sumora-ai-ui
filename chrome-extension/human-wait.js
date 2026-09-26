// chrome-extension/human-wait.js
// 拡張の「待ち時間」を人のようにばらつかせる共通の関数（UMD・self.AxlxHumanWait）。
//
// 2026-09-27 竹内「拡張ツールで物件検索を押してから並び替えを変える所、毎回一定の時間になっているか？
//   なっていたら全て不規則にする（時間ランダム）。拡張ツールは人間らしい動きをするために全て時間ランダムにする」
//
// 使い分け（呼ぶ側が「何を待っているか」で選ぶ。全部を機械的に変えない）:
//   humanDelay(ms)  … 人の操作の間（クリックの前後・入力・並び替えの選択・検索ボタン・次のページ・1件ずつ取る間隔）。
//                     base×0.8〜1.5 の一様乱数（平均 ≒ base×1.15）。
//   settleDelay(ms) … 固定の秒数で「ページが落ち着くのを待つ」所（タブを開いた後・次のページの読み込み後）。
//                     元より短くしない（base〜base×1.35・大きい値は上の幅を狭める）＝速くして壊さない。
//   pollDelay(ms)   … 条件を満たすまで見る間隔（要素が出るまでの polling）。base×0.85〜1.15（平均は元と同じ）
//                     ＝回数で打ち切る待ちの「止まったと判断する時間」は平均で変えない。
//   humanWait / settleWait … 上の値だけ待つ Promise（async の中で使う）。
// 置き換えない物: タイムアウトの上限（止まったと判断する時間）・Chrome の alarm・サーバーへの送信の待ち・
//   5分の待ち切れ・検索の点検の20分など業務の時間・画面の表示を消すだけのタイマー。
//
// 読み込む所（どこでも同じ self.AxlxHumanWait）:
//   background.js（import）・popup.html（popup.js より前）・manifest の content_scripts（search-audit.js と同じ先頭の段）・
//   ページの中で動く物: itandi-page-script.js は manifest の world:MAIN の段で先に、page-script.js / reins-page-script.js は
//   content.js / reins-content.js が <script>（async=false）で先に入れる。ページの中で読めなかった時に備えて、
//   ページの中の物は「無ければ元の値」の予備を持つ（止まらない）。
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (root) { root.AxlxHumanWait = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var LOW = 0.8;          // 人の間の下の倍率
  var HIGH = 1.5;         // 人の間の上の倍率
  var SMALL_FLOOR_MS = 50; // 小さい値の下限（50ms 以下の待ちは元より短くしない＝画面の反映待ちを削らない）
  var WIDE_FROM_MS = 2000; // これより大きい値は上の幅を狭める
  var WIDE_EXTRA_MAX_MS = 1000; // 2秒を超えた分の上の幅: min(base×0.5, 1000 + base×0.1)
  var SETTLE_HIGH = 1.35;
  var POLL_LOW = 0.85;
  var POLL_HIGH = 1.15;

  function _num(ms) {
    var b = Number(ms);
    return (isFinite(b) && b > 0) ? b : 0;
  }
  function _rand(rng) {
    var r = (typeof rng === "function") ? rng() : Math.random();
    if (!(r >= 0)) r = 0;
    if (r >= 1) r = 0.999999;
    return r;
  }
  function _between(lo, hi, rng) {
    return Math.round(lo + (hi - lo) * _rand(rng));
  }
  // 上の端（大きい値ほど幅を狭める）
  function _upper(b, mult) {
    var up = b * (mult - 1);
    if (b > WIDE_FROM_MS) up = Math.min(up, WIDE_EXTRA_MAX_MS + b * 0.1);
    return b + up;
  }

  // 人の操作の間: base×0.8〜1.5（小さい値は下限・大きい値は上の幅を狭める）
  function humanRange(ms) {
    var b = _num(ms);
    if (!b) return { lo: 0, hi: 0 };
    var lo = Math.max(b * LOW, Math.min(b, SMALL_FLOOR_MS));
    return { lo: lo, hi: _upper(b, HIGH) };
  }
  function humanDelay(ms, rng) {
    var r = humanRange(ms);
    return r.hi ? _between(r.lo, r.hi, rng) : 0;
  }

  // ページが落ち着くのを待つ固定の秒数: 元より短くしない
  function settleRange(ms) {
    var b = _num(ms);
    if (!b) return { lo: 0, hi: 0 };
    return { lo: b, hi: _upper(b, SETTLE_HIGH) };
  }
  function settleDelay(ms, rng) {
    var r = settleRange(ms);
    return r.hi ? _between(r.lo, r.hi, rng) : 0;
  }

  // 条件を見る間隔: 平均は元と同じ（±15%）
  function pollRange(ms) {
    var b = _num(ms);
    if (!b) return { lo: 0, hi: 0 };
    return { lo: b * POLL_LOW, hi: b * POLL_HIGH };
  }
  function pollDelay(ms, rng) {
    var r = pollRange(ms);
    return r.hi ? _between(r.lo, r.hi, rng) : 0;
  }

  function _wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function humanWait(ms) { return _wait(humanDelay(ms)); }
  function settleWait(ms) { return _wait(settleDelay(ms)); }
  function pollWait(ms) { return _wait(pollDelay(ms)); }

  return {
    humanRange: humanRange,
    humanDelay: humanDelay,
    settleRange: settleRange,
    settleDelay: settleDelay,
    pollRange: pollRange,
    pollDelay: pollDelay,
    humanWait: humanWait,
    settleWait: settleWait,
    pollWait: pollWait,
  };
});
