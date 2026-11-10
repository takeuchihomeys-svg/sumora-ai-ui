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

  // ── 2026-11-10 自動モードの「人の速さ」: 対数正規の間隔＋ときどき休憩 ──
  //   竹内「固定周期は検知されやすい。ばらつきが必要。中央値0.9秒、12操作ごとに8秒の休憩が目安」
  //   上の humanDelay は一様乱数（0.8〜1.5倍）。人の操作の間はそれより「短い事が多く、たまに大きく伸びる」形（右に裾が長い）なので、
  //   自動モードの連続した操作には対数正規を使う。同じ検索でも毎回ちがう間になり、等間隔にならない。
  //   既存の humanDelay／settleDelay／pollDelay の範囲は変えない（人が押す所の動きは今まで通り・テストで固定）。
  var PACER_BASE_MS = 900;      // 中央値（人が1つの操作に移る間）
  var PACER_BREAK_EVERY = 12;   // 何操作ごとに休むか
  var PACER_BREAK_MS = 8000;    // 休憩の中央値
  var PACER_SIGMA = 0.35;       // 対数の広がり（0.35 で「ふつうは 0.6〜1.3秒・たまに2秒超」）

  /** 標準正規（Box-Muller）。rng は 0〜1 を返す関数（テストで固定できる） */
  function _gauss(rng) {
    var u1 = _rand(rng), u2 = _rand(rng);
    if (u1 <= 1e-12) u1 = 1e-12;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /**
   * 中央値 medianMs・対数の広がり sigma の対数正規。
   *   下の端 = max(200ms, 中央値の1/4)・上の端 = 中央値の6倍で切る（極端な外れで止まらないように）
   */
  function logNormalDelay(medianMs, sigma, rng) {
    var m = _num(medianMs);
    if (!m) return 0;
    var s = (typeof sigma === "number" && isFinite(sigma) && sigma > 0) ? sigma : PACER_SIGMA;
    var v = m * Math.exp(s * _gauss(rng));
    var lo = Math.max(200, m * 0.25), hi = m * 6;
    return Math.round(Math.min(hi, Math.max(lo, v)));
  }

  /**
   * 自動モードの間隔を作る（連続した操作に使う）。
   *   var p = createPacer({ baseMs: 900, breakEvery: 12, breakMs: 8000 });
   *   p.next() → { ms, isBreak, n }   n は通しの操作の数（1から）
   *   12操作ごとに 8秒の休憩（中央値）を挟む。休憩も対数正規なので同じ長さにならない。
   *   状態はこの中だけ（呼び出し側の検索・お客様をまたいで持ち回らない）
   */
  function createPacer(opt) {
    var o = opt || {};
    var base = _num(o.baseMs) || PACER_BASE_MS;
    var every = Math.max(1, Math.floor(Number(o.breakEvery) || PACER_BREAK_EVERY));
    var breakMs = _num(o.breakMs) || PACER_BREAK_MS;
    var sigma = (typeof o.sigma === "number" && isFinite(o.sigma) && o.sigma > 0) ? o.sigma : PACER_SIGMA;
    var n = 0, breaks = 0;
    function next(rng) {
      n++;
      var isBreak = (n % every) === 0;
      if (isBreak) breaks++;
      return { ms: logNormalDelay(isBreak ? breakMs : base, sigma, rng), isBreak: isBreak, n: n };
    }
    return {
      next: next,
      nextMs: function (rng) { return next(rng).ms; },
      count: function () { return n; },
      breaks: function () { return breaks; },
      reset: function () { n = 0; breaks = 0; },
    };
  }

  /**
   * 2026-11-10 人間的な動き: マウスの軌跡（まっすぐではなく、少し曲がる）。
   *   buildClickPath の代わりに、このリポジトリの作法（依存ゼロ・純関数）で持つ。
   *   from / to は { x, y }。返り値は { x, y } の配列（出発点を含む）。steps は点の数。
   *   曲がりは3次ベジェ（制御点を経路の左右にランダムにずらす）＋最後に少しだけ手ぶれを足す。
   */
  function pointerPath(from, to, steps, rng) {
    var a = from && typeof from === "object" ? from : { x: 0, y: 0 };
    var b = to && typeof to === "object" ? to : { x: 0, y: 0 };
    var n = Math.max(2, Math.min(60, Math.floor(Number(steps) || 12)));
    var dx = b.x - a.x, dy = b.y - a.y;
    var dist = Math.sqrt(dx * dx + dy * dy) || 1;
    // 経路に直角な向きへ、距離の 8〜22% ずらした制御点を2つ（同じ側に寄りすぎないよう片方は逆へ小さく）
    var nx = -dy / dist, ny = dx / dist;
    var off1 = dist * (0.08 + _rand(rng) * 0.14) * (_rand(rng) < 0.5 ? -1 : 1);
    var off2 = dist * (0.02 + _rand(rng) * 0.08) * (_rand(rng) < 0.5 ? -1 : 1);
    var c1 = { x: a.x + dx * 0.3 + nx * off1, y: a.y + dy * 0.3 + ny * off1 };
    var c2 = { x: a.x + dx * 0.7 + nx * off2, y: a.y + dy * 0.7 + ny * off2 };
    var out = [];
    for (var i = 0; i <= n; i++) {
      var t = i / n, mt = 1 - t;
      var x = mt * mt * mt * a.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * b.x;
      var y = mt * mt * mt * a.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * b.y;
      // 手ぶれ（終点では 0 に寄せる＝狙った所に着く）
      var wob = (1 - t) * 0.6;
      if (wob > 0) { x += (_rand(rng) - 0.5) * wob; y += (_rand(rng) - 0.5) * wob; }
      out.push({ x: Math.round(x), y: Math.round(y) });
    }
    out[n] = { x: Math.round(b.x), y: Math.round(b.y) };
    return out;
  }

  /** 軌跡の各点の待ち（ミリ秒）。移動の速さは一定にせず、最初と最後をゆっくりにする（人の加速・減速） */
  function pointerDelays(n, totalMs, rng) {
    var N = Math.max(2, Math.floor(Number(n) || 12));
    var total = _num(totalMs) || 400;
    var w = [];
    var sum = 0;
    for (var i = 0; i < N; i++) {
      var t = (i + 1) / N;
      // 端（0 と 1 の近く）ほど重い＝ゆっくり。中ほどは速い
      var v = 0.35 + 2.6 * Math.pow(Math.abs(t - 0.5) * 2, 2);
      v *= 0.8 + _rand(rng) * 0.4;
      w.push(v); sum += v;
    }
    return w.map(function (x) { return Math.max(8, Math.round(total * x / sum)); });
  }

  // ── 2026-11-10 v2.5.98 竹内さん「人間なので休憩するときもある」──
  //   人は連続で作業し続けない。決まった回数ごとではなく、**作業の続き具合で抽選**して休む。
  //   ・短い休憩 … 12〜30秒（水分・伸び・画面から目を離す）。だいたい 20〜35分の作業ごとに 1回ほど
  //   ・長い休憩 … 60〜180秒（昼休みの前後・一区切り）。だいたい 2〜3時間ごとに 1回ほど
  //   ⚠ サイトへのアクセスは増えない（次の操作を待つだけ）。自動モードの勤務時間のゲート（9〜21時・12〜13時休憩）とは別物で、
  //     その中で「人のように休む」ための物。抽選なので同じ間隔にならない（等間隔は機械らしい）。
  var REST_SHORT_MS = 12000, REST_SHORT_MAX_MS = 30000;
  var REST_LONG_MS = 60000, REST_LONG_MAX_MS = 180000;
  /** 次の操作までに休むか（作業の経過時間から抽選）。workedSinceMs から今までの時間で確率が上がる */
  function restDue(workedSinceMs, nowMs, rng) {
    var s = Number(workedSinceMs) || 0;
    var t = typeof nowMs === "number" ? nowMs : Date.now();
    if (!s || t < s) return { rest: false, ms: 0, kind: null };
    var mins = (t - s) / 60000;
    // 長い休憩: 120分を超えたら 1回の判定で 18%（およそ 2〜3時間に1回）
    if (mins >= 120 && _rand(rng) < 0.18) {
      var longMs = Math.round(REST_LONG_MS + _rand(rng) * (REST_LONG_MAX_MS - REST_LONG_MS));
      return { rest: true, ms: longMs, kind: "long" };
    }
    // 短い休憩: 20分を超えたら 1回の判定で 8%（およそ 20〜35分に1回）
    if (mins >= 20 && _rand(rng) < 0.08) {
      var shortMs = Math.round(REST_SHORT_MS + _rand(rng) * (REST_SHORT_MAX_MS - REST_SHORT_MS));
      return { rest: true, ms: shortMs, kind: "short" };
    }
    return { rest: false, ms: 0, kind: null };
  }

  function restRange(kind) {
    if (kind === "long") return { lo: REST_LONG_MS, hi: REST_LONG_MAX_MS };
    return { lo: REST_SHORT_MS, hi: REST_SHORT_MAX_MS };
  }

  return {
    PACER_BASE_MS: PACER_BASE_MS,
    PACER_BREAK_EVERY: PACER_BREAK_EVERY,
    PACER_BREAK_MS: PACER_BREAK_MS,
    PACER_SIGMA: PACER_SIGMA,
    REST_SHORT_MS: REST_SHORT_MS,
    REST_SHORT_MAX_MS: REST_SHORT_MAX_MS,
    REST_LONG_MS: REST_LONG_MS,
    REST_LONG_MAX_MS: REST_LONG_MAX_MS,
    restDue: restDue,
    restRange: restRange,
    logNormalDelay: logNormalDelay,
    createPacer: createPacer,
    pointerPath: pointerPath,
    pointerDelays: pointerDelays,
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
