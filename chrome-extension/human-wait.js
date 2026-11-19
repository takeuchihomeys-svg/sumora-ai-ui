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
  // ★ 2026-11-17 統括Pro: 人間 CV≈0.64。旧0.35は裾が狭く等間隔っぽい → 0.55
  var PACER_SIGMA = 0.55;

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
  function logNormalDelay(medianMs, sigma, rng, opts) {
    var m = _num(medianMs);
    if (!m) return 0;
    var s = (typeof sigma === "number" && isFinite(sigma) && sigma > 0) ? sigma : PACER_SIGMA;
    var v = m * Math.exp(s * _gauss(rng));
    /**
     * 2026-11-11 竹内さん「間隔もちゃんとばらばらで不規則に」:
     *   旧の下の端は `Math.max(200, m*0.25)` ＝**中央値が200ms未満だと全部200msに張り付いていた**
     *   （クリックの間 80〜200ms で 400回中64種類・同じ値が20回連続）。
     *   対策: 下の端を `max(20, m*0.3)` にする（短い間隔でも潰れない）。上の端は今まで通り m*6。
     *   ⚠ 200ms を下回らせたくない所（ページの読み込み待ち等）は、呼ぶ側で Math.max(200, ...) する。
     */
    var floor = (opts && typeof opts.minGapMs === "number" && opts.minGapMs > 0) ? opts.minGapMs : 20;
    var lo = Math.max(floor, m * 0.3), hi = m * 6;
    return Math.round(Math.min(hi, Math.max(lo, v)) * 10) / 10;
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
      var _opFloor = (typeof o.minOpGapMs === "number" && o.minOpGapMs > 0) ? o.minOpGapMs : 400;
      return {
        ms: logNormalDelay(isBreak ? breakMs : base, sigma, rng, isBreak ? null : { minGapMs: _opFloor }),
        isBreak: isBreak,
        n: n,
      };
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
  function pointerPath(from, to, steps, rng, persona) {
    var a = from && typeof from === "object" ? from : { x: 0, y: 0 };
    var b = to && typeof to === "object" ? to : { x: 0, y: 0 };
    var n = Math.max(2, Math.min(60, Math.floor(Number(steps) || 12)));
    // 2026-11-19 v2.8.25: persona（ラン単位のクセ）を渡した時だけ「人の実測に近い」曲がり（ほぼ直線＋小さな弧）で作る。
    //   引数無し（従来）の時は下の今までの作り方のまま（既存の呼び出し・テストを壊さない）。
    if (persona && typeof persona === "object") return _personaPath(a, b, n, rng, persona).pts;
    var dx = b.x - a.x, dy = b.y - a.y;
    var dist = Math.sqrt(dx * dx + dy * dy) || 1;
    // ★ 2026-11-16: 曲がり幅を広げ、たまにオーバーシュートして戻る（毎回同じ弧に見えない）
    var nx = -dy / dist, ny = dx / dist;
    var off1 = dist * (0.12 + _rand(rng) * 0.28) * (_rand(rng) < 0.5 ? -1 : 1);
    var off2 = dist * (0.04 + _rand(rng) * 0.18) * (_rand(rng) < 0.5 ? -1 : 1);
    var c1 = { x: a.x + dx * (0.22 + _rand(rng) * 0.2) + nx * off1, y: a.y + dy * (0.22 + _rand(rng) * 0.2) + ny * off1 };
    var c2 = { x: a.x + dx * (0.58 + _rand(rng) * 0.22) + nx * off2, y: a.y + dy * (0.58 + _rand(rng) * 0.22) + ny * off2 };
    // 18% で少し行き過ぎてから戻る（人が狙いを外して直す）
    var overshoot = dist > 40 && _rand(rng) < 0.18;
    var ox = overshoot ? nx * dist * (0.04 + _rand(rng) * 0.08) * (_rand(rng) < 0.5 ? -1 : 1) : 0;
    var oy = overshoot ? ny * dist * (0.04 + _rand(rng) * 0.08) * (_rand(rng) < 0.5 ? -1 : 1) : 0;
    var end = overshoot ? { x: b.x + ox, y: b.y + oy } : b;
    var out = [];
    for (var i = 0; i <= n; i++) {
      var t = i / n, mt = 1 - t;
      var tgt = (overshoot && t > 0.82) ? b : end; // 終盤で本命へ戻す
      var x = mt * mt * mt * a.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * tgt.x;
      var y = mt * mt * mt * a.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * tgt.y;
      // 手ぶれ（終点では 0 に寄せる＝狙った所に着く）
      var wob = (1 - t) * (1.2 + _rand(rng) * 1.8);
      if (wob > 0) { x += (_rand(rng) - 0.5) * wob; y += (_rand(rng) - 0.5) * wob; }
      out.push({ x: Math.round(x), y: Math.round(y) });
    }
    out[n] = { x: Math.round(b.x), y: Math.round(b.y) };
    return out;
  }

  /** 軌跡の各点の待ち（ミリ秒）。移動の速さは一定にせず、最初と最後をゆっくりにする（人の加速・減速） */
  function pointerDelays(n, totalMs, rng, persona) {
    var N = Math.max(2, Math.floor(Number(n) || 12));
    var total = _num(totalMs) || 400;
    // 2026-11-19 v2.8.25: persona を渡した時は、端の遅さを控えめにした釣鐘の速さ（ピーク速度 ≒ 平均の2倍前後）で配る。
    //   途中の「ためらい」は planMove 側で決める（ここでは足さない＝合計は total にそろう）。
    if (persona && typeof persona === "object") {
      var pw = [], psum = 0;
      for (var pi = 0; pi < N; pi++) {
        var pt = (pi + 1) / N;
        var pv = (0.55 + 1.9 * Math.pow(Math.abs(pt - 0.5) * 2, 2)) * (0.75 + _rand(rng) * 0.5);
        pw.push(pv); psum += pv;
      }
      return pw.map(function (x) { return Math.max(4, Math.round(((total * x) / psum) * 10) / 10); });
    }
    /**
     * 2026-11-11 竹内さん「マウスとクリックと選択の間隔等も人間のようになっているのか。間隔もちゃんとばらばらで不規則に」:
     *   旧は Math.round で ms に丸めていたため、**24点で18種類**しか無く「ほぼ等速」に見えていた。
     *   対策: ① 1ms まで残す（丸めを減らす）② 点ごとに ±40% の揺らぎを足す ③ たまに「止まって見る」（2%で+120〜400ms）
     *   合計は total にそろえる（サイトへの負荷・所要時間は変えない）。
     */
    var w = [];
    var sum = 0;
    for (var i = 0; i < N; i++) {
      var t = (i + 1) / N;
      // 端（0 と 1 の近く）ほど重い＝ゆっくり。中ほどは速い
      var v = 0.35 + 2.6 * Math.pow(Math.abs(t - 0.5) * 2, 2);
      v *= 0.6 + _rand(rng) * 0.8;   // ±40%の揺らぎ（旧は 0.8〜1.2 ＝ ±20%）
      w.push(v); sum += v;
    }
    // 合計を total にそろえ、1ms 単位で残す（丸めで同じ値が並ばないように）
    var out = w.map(function (x) { return Math.max(4, (total * x) / sum); });
    // たまに「途中で少し止まる」（人が一瞬ためらう）: 2点ほどに足して、他から少しずつ引く
    if (_rand(rng) < 0.02) {
      var k = 1 + Math.floor(_rand(rng) * (N - 2));
      out[k] += 120 + Math.floor(_rand(rng) * 280);
    }
    var back = out.reduce(function (a, b) { return a + b; }, 0) / total;
    return out.map(function (x) { return Math.max(4, Math.round((x / back) * 10) / 10); });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 2026-11-19 v2.8.25 自動モードのカーソルを「人の実測分布」に寄せる＋検索（ラン）ごとの動きの個性（persona）
  //
  //   ★ 本番DBの実測（human_motion_learn・通常モード・リアプロ・直近150行）
  //       速さ px/s: p10/p50/p90 = 130/375/478・CV 0.64   曲がり（道のり÷直線）: p50 1.02・CV 0.16（ほぼ直線）
  //       1回の移動時間: p50 284ms・CV 0.91                 移動距離: p50 116px
  //     自動モード（mode=aix）の行は 150行すべて moves_n=0＝自動の動きは今まで測れていなかった。
  //   ★ 旧の自動の動き: 曲がり 1.18〜1.46＋ベジェ 4〜40%＋行き過ぎ 18%＋72%（8〜36px）・移動は最低320ms・押し込み 90ms 固定。
  //   ★ ここ（依存ゼロ・純関数・rng を引数に取れる）: seededRng / makePersona / sanitizePlan / moveMsSample / planMove /
  //     pressMs / motionSummary。pointerPath・pointerDelays は persona を任意引数で受ける（無ければ従来のまま）。
  //   ⚠ 人の記録（human-learn.js の hMove の !isTrusted 除外）は変えない＝自動の動きが人の学習に混ざらない。
  // ══════════════════════════════════════════════════════════════════════════

  /** 文字列・数を 32bit の整数にする（FNV-1a）。seed が文字列（客IDなど）でも使えるように */
  function hashSeed(s) {
    var str = String(s == null ? "" : s), h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  /** seed 固定の乱数（mulberry32）。同じ seed なら同じ列・seed が違えば違う列。0以上1未満 */
  function seededRng(seed) {
    var a = (typeof seed === "number" && isFinite(seed)) ? (Math.floor(seed) >>> 0) : hashSeed(seed);
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // persona の値の範囲（計画・外から来た値もここへ丸める）
  var PERSONA_RANGE = {
    speed_scale: [0.6, 1.7],     // 速さの倍率（1.0＝人の実測の中央値 375px/s）
    curve_gain: [0.4, 1.5],      // 曲がりの強さ（1.0＝実測の p50 付近・小さいほど直線）
    overshoot_p: [0.08, 0.28],   // 80px 超の移動で行き過ぎる確率
    hesitate_p: [0.10, 0.30],    // 途中で一息つく確率
    press_ms: [60, 120],         // 押し込みの中央値(ms)
    tremor: [0.4, 1.6],          // 手ぶれ(px)
    dwell_scale: [0.6, 1.6],     // 一息・止まりの長さの倍率
  };
  var PERSONA_KEYS = ["speed_scale", "curve_gain", "overshoot_p", "hesitate_p", "press_ms", "tremor", "dwell_scale"];
  /** 個性の無い中立の persona（persona を渡されなかった時・壊れた時の既定） */
  var NEUTRAL_PERSONA = { seed: 0, speed_scale: 1, curve_gain: 1, overshoot_p: 0.16, hesitate_p: 0.18, press_ms: 90, tremor: 1.0, dwell_scale: 1, source: "neutral" };

  function _clampKey(key, v) {
    var r = PERSONA_RANGE[key];
    var x = Number(v);
    if (!isFinite(x)) return null;
    return Math.max(r[0], Math.min(r[1], x));
  }
  function _round3(x) { return Math.round(x * 1000) / 1000; }

  /**
   * サーバーの「動き計画」を安全な形にして返す（無効なら null＝無視してローカルで作る）。
   *   形: { v:1, plan_id, expires_at(ISO), run_seed?, persona?:{...} }
   *   ・v が 1 でない／plan_id が無い／expires_at が読めない・過ぎている → null
   *   ・persona の各値は範囲に丸める・数でない値は捨てる
   */
  function sanitizePlan(plan, nowMs) {
    try {
      if (!plan || typeof plan !== "object") return null;
      if (Number(plan.v) !== 1) return null;
      var id = (typeof plan.plan_id === "string" || typeof plan.plan_id === "number") ? String(plan.plan_id).slice(0, 64) : "";
      if (!id) return null;
      var exp = Date.parse(plan.expires_at);
      var now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now();
      if (!isFinite(exp) || exp <= now) return null;
      var out = { v: 1, plan_id: id, expires_at: String(plan.expires_at), run_seed: null, persona: {} };
      var rs = Number(plan.run_seed);
      if (plan.run_seed != null && plan.run_seed !== "" && isFinite(rs)) out.run_seed = Math.floor(rs) >>> 0;
      var pp = (plan.persona && typeof plan.persona === "object") ? plan.persona : null;
      if (pp) {
        for (var i = 0; i < PERSONA_KEYS.length; i++) {
          var k = PERSONA_KEYS[i];
          if (pp[k] == null || pp[k] === "") continue;
          var c = _clampKey(k, pp[k]);
          if (c != null) out.persona[k] = c;
        }
      }
      return out;
    } catch (_) { return null; }
  }

  /**
   * ラン（検索）単位の「動きのクセ」を seed から作る。同じ seed → 同じ値・seed が違えば違う値。
   *   乱数の引く順は固定（計画で一部を上書きしても、他の値は seed から変わらない）。
   *   plan（任意）: 有効なら run_seed を seed に使い、persona の値があればそれを（範囲に丸めて）優先。
   *   中心: speed_scale は対数正規 σ0.25（中心1.0）・curve_gain は対数正規 σ0.25（中心1.0・上限1.5）。
   */
  function makePersona(seed, plan, nowMs) {
    var sp = sanitizePlan(plan, nowMs);
    var s = (sp && sp.run_seed != null) ? sp.run_seed : seed;
    var rng = seededRng((s == null) ? 0 : s);
    var p = {
      seed: (typeof s === "number" && isFinite(s)) ? (Math.floor(s) >>> 0) : hashSeed(s),
      speed_scale: _clampKey("speed_scale", Math.exp(0.25 * _gauss(rng))),
      curve_gain: _clampKey("curve_gain", Math.exp(0.25 * _gauss(rng))),
      overshoot_p: 0.08 + 0.20 * _rand(rng),
      hesitate_p: 0.10 + 0.20 * _rand(rng),
      press_ms: 60 + 60 * _rand(rng),
      tremor: 0.4 + 1.2 * _rand(rng),
      dwell_scale: _clampKey("dwell_scale", Math.exp(0.25 * _gauss(rng))),
      source: "local",
    };
    if (sp) {
      for (var k in sp.persona) { if (Object.prototype.hasOwnProperty.call(sp.persona, k)) p[k] = sp.persona[k]; }
      p.source = "plan";
      p.plan_id = sp.plan_id;
    }
    for (var i = 0; i < PERSONA_KEYS.length; i++) p[PERSONA_KEYS[i]] = _round3(p[PERSONA_KEYS[i]]);
    return p;
  }

  /** persona に欠け・壊れた値があっても中立で埋める（呼ぶ側が毎回守らなくてよいように） */
  function _fixPersona(persona) {
    var p = (persona && typeof persona === "object") ? persona : NEUTRAL_PERSONA;
    var o = {};
    for (var i = 0; i < PERSONA_KEYS.length; i++) {
      var k = PERSONA_KEYS[i];
      var c = _clampKey(k, p[k]);
      o[k] = (c == null) ? NEUTRAL_PERSONA[k] : c;
    }
    return o;
  }

  // ── 1回の移動の分布（人の実測に寄せる） ──
  var HUMAN_SPEED_PX_S = 375;     // 中央値（実測 p50）
  var HUMAN_SPEED_SIGMA = 0.5;    // 対数のばらつき（距離の効果と合わせて CV≈0.6）
  var HUMAN_REF_DIST = 116;       // 実測の移動距離の中央値
  var HUMAN_FITTS_EXP = 0.3;      // 遠いほど速く動く（Fitts 的）＝移動時間は距離の 0.7 乗で伸びる
  var MOVE_MS_MIN = 90, MOVE_MS_MAX = 1600;
  var BEND_BASE_EXCESS = 0.04;    // 曲がり（道のり÷直線−1）の中央値（gain=1 のとき）
  var BEND_SIGMA = 1.1;

  /**
   * 1回の移動にかかる時間(ms)を引く。速さを対数正規で引く（学習した速さがあっても一定にしない）。
   *   中央の速さ = (speedPxS || 375) × persona.speed_scale × (距離/116)^0.3・σ0.5。90〜1600ms に丸める。
   */
  function moveMsSample(dist, persona, rng, speedPxS) {
    var d = Math.max(1, Number(dist) || 1);
    var p = _fixPersona(persona);
    var base = (typeof speedPxS === "number" && isFinite(speedPxS) && speedPxS >= 100 && speedPxS <= 1200) ? speedPxS : HUMAN_SPEED_PX_S;
    var med = base * p.speed_scale * Math.pow(d / HUMAN_REF_DIST, HUMAN_FITTS_EXP);
    var v = med * Math.exp(HUMAN_SPEED_SIGMA * _gauss(rng));
    var ms = (d / v) * 1000;
    return Math.round(Math.max(MOVE_MS_MIN, Math.min(MOVE_MS_MAX, ms)));
  }

  /** persona 付きの軌跡: ほぼ直線＋小さな弧（3次ベジェ）＋まれな行き過ぎ＋終点へ向かって減る手ぶれ。終点は必ず狙い点 */
  function _personaPath(a, b, n, rng, persona) {
    var p = _fixPersona(persona);
    var dx = b.x - a.x, dy = b.y - a.y;
    var dist = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / dist, uy = dy / dist;
    var nx = -uy, ny = ux;
    // 曲がり（道のり÷直線−1）を対数正規で引く→弧の深さ d/L=√(excess×3/8)→ベジェの制御点のずれ h=d/0.75
    var excess = Math.min(0.3, BEND_BASE_EXCESS * p.curve_gain * Math.exp(BEND_SIGMA * _gauss(rng)));
    var h = dist * Math.sqrt(excess * 3 / 8) / 0.75;
    var side = _rand(rng) < 0.5 ? -1 : 1;
    var h1 = h * (0.8 + 0.5 * _rand(rng)) * side;
    var h2 = h * (0.8 + 0.5 * _rand(rng)) * side * (_rand(rng) < 0.18 ? -0.5 : 1); // たまに S 字
    var f1 = 0.26 + _rand(rng) * 0.12, f2 = 0.62 + _rand(rng) * 0.12;
    var c1 = { x: a.x + dx * f1 + nx * h1, y: a.y + dy * f1 + ny * h1 };
    var c2 = { x: a.x + dx * f2 + nx * h2, y: a.y + dy * f2 + ny * h2 };
    // 行き過ぎ: 80px 超で persona.overshoot_p・量は 4〜14px（旧は 72% で 8〜36px）
    var over = dist > 80 && _rand(rng) < p.overshoot_p;
    var op = over ? Math.max(4, Math.min(14, dist * (0.04 + 0.06 * _rand(rng)))) : 0;
    var lat = over ? (_rand(rng) - 0.5) * 0.5 * op : 0;
    var end = over ? { x: b.x + ux * op + nx * lat, y: b.y + uy * op + ny * lat } : b;
    if (over) { c2 = { x: c2.x + ux * op * 0.6, y: c2.y + uy * op * 0.6 }; }
    var out = [];
    function jit(x, y, t) {
      var wob = (1 - t) * p.tremor * (0.5 + _rand(rng));
      if (wob > 0) { x += (_rand(rng) - 0.5) * wob; y += (_rand(rng) - 0.5) * wob; }
      return { x: Math.round(x), y: Math.round(y) };
    }
    for (var i = 0; i <= n; i++) {
      var t = i / n, mt = 1 - t;
      var x = mt * mt * mt * a.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * end.x;
      var y = mt * mt * mt * a.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * end.y;
      out.push(i === 0 ? { x: Math.round(a.x), y: Math.round(a.y) } : jit(x, y, t));
    }
    if (over) {
      // 行き過ぎた点から本命へ短く戻す（3点・だんだん遅くなる動き）
      var k = 3;
      var ex = out[n].x, ey = out[n].y;
      for (var j = 1; j <= k; j++) {
        var u = j / k, e = 1 - Math.pow(1 - u, 2);
        out.push({ x: Math.round(ex + (b.x - ex) * e), y: Math.round(ey + (b.y - ey) * e) });
      }
    }
    out[out.length - 1] = { x: Math.round(b.x), y: Math.round(b.y) };
    return { pts: out, overshoot: over, excess: excess };
  }

  function _pathLen(pts) {
    var s = 0;
    for (var i = 1; i < pts.length; i++) {
      var ddx = pts[i].x - pts[i - 1].x, ddy = pts[i].y - pts[i - 1].y;
      s += Math.sqrt(ddx * ddx + ddy * ddy);
    }
    return s;
  }

  /**
   * 1回の移動を丸ごと作る（純関数）。pointer-ui.js の moveTo はこの結果をそのまま再生する。
   *   from / to: { x, y }   opts: { persona, rng, speedPxS（学習した速さ・中央値に使う）, curve（学習した曲がり・1付近なら直線寄り） }
   *   返り値: { pts, waits, ms, dist, pathLen, straight, curve, overshoot, paused, pauseAt, pauseMs, peakRatio, speed }
   *     ms は移動の時間（一息の止まりは含めない）・pauseAt は pts の添字（無ければ -1）。
   */
  function planMove(from, to, opts) {
    var o = opts || {};
    var rng = o.rng;
    var persona = _fixPersona(o.persona);
    var a = from && typeof from === "object" ? from : { x: 0, y: 0 };
    var b = to && typeof to === "object" ? to : { x: 0, y: 0 };
    var dist = Math.sqrt(Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2));
    if (!(dist >= 1)) {
      return { pts: [{ x: Math.round(b.x), y: Math.round(b.y) }], waits: [], ms: 0, dist: 0, pathLen: 0, straight: 0, curve: 1, overshoot: false, paused: false, pauseAt: -1, pauseMs: 0, peakRatio: 1, speed: 0 };
    }
    var ms = moveMsSample(dist, persona, rng, o.speedPxS);
    var steps = Math.min(48, Math.max(8, Math.round(dist / 14)));
    // 学習した曲がり（1.0＝直線）が 1 付近なら弧を小さく（c=1.05 で 1.0 倍・上限 2 倍・下限 0.25 倍）
    var eff = {};
    for (var k in persona) { if (Object.prototype.hasOwnProperty.call(persona, k)) eff[k] = persona[k]; }
    var c = Number(o.curve);
    if (isFinite(c) && c > 0) eff.curve_gain = persona.curve_gain * Math.max(0.25, Math.min(2.0, (Math.max(1, c) - 1) / BEND_BASE_EXCESS));
    var built = _personaPath(a, b, steps, rng, eff);
    var pts = built.pts;
    if (built.overshoot) {
      // 行き過ぎを直す分の時間（対数正規 中央値 90ms・50〜220ms）
      ms += Math.round(Math.max(50, Math.min(220, 90 * Math.exp(0.4 * _gauss(rng)))));
    }
    var waits = pointerDelays(pts.length, ms, rng, persona);
    // ためらい（途中で一息）: 確率は persona.hesitate_p（短い移動は 1/4）・長さは対数正規（中央値 320ms×dwell_scale・140〜900ms）
    var long = dist >= 60;
    var pauseAt = -1, pauseMs = 0;
    if (pts.length >= 8 && _rand(rng) < persona.hesitate_p * (long ? 1 : 0.25)) {
      pauseAt = Math.floor(pts.length * (0.22 + _rand(rng) * 0.5));
      pauseMs = Math.round(Math.max(140, Math.min(900, 320 * persona.dwell_scale * Math.exp(0.45 * _gauss(rng)))));
    }
    var pathLen = _pathLen(pts);
    var sumW = 0, peak = 0;
    for (var i = 0; i < pts.length - 1; i++) {
      var w = waits[i] || 4;
      var sx = pts[i + 1].x - pts[i].x, sy = pts[i + 1].y - pts[i].y;
      var sp = Math.sqrt(sx * sx + sy * sy) / w;
      if (sp > peak) peak = sp;
      sumW += w;
    }
    var mean = sumW > 0 ? pathLen / sumW : 0;
    return {
      pts: pts, waits: waits, ms: ms, dist: dist, pathLen: pathLen, straight: dist,
      curve: pathLen / dist, overshoot: !!built.overshoot, paused: pauseAt >= 0, pauseAt: pauseAt, pauseMs: pauseMs,
      peakRatio: mean > 0 ? peak / mean : 1, speed: (dist / ms) * 1000,
    };
  }

  /** 押し込み（見えるカーソルの縮み）の時間(ms): persona.press_ms を中央値とする対数正規（σ0.3・45〜180ms） */
  function pressMs(persona, rng) {
    var p = _fixPersona(persona);
    var v = p.press_ms * Math.exp(0.3 * _gauss(rng));
    return Math.round(Math.max(45, Math.min(180, v)));
  }

  function _pct(sorted, q) {
    if (!sorted.length) return null;
    var idx = (sorted.length - 1) * q, lo = Math.floor(idx), hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }
  function _cv(arr) {
    if (arr.length < 2) return null;
    var m = 0, i;
    for (i = 0; i < arr.length; i++) m += arr[i];
    m /= arr.length;
    if (!(m > 0)) return null;
    var v = 0;
    for (i = 0; i < arr.length; i++) v += (arr[i] - m) * (arr[i] - m);
    return Math.sqrt(v / arr.length) / m;
  }
  function _r2(x) { return x == null ? null : Math.round(x * 100) / 100; }
  /**
   * 自動の動きの記録（{ dist, ms, curve, overshoot, paused, peakRatio }の配列）を要約する。
   *   監査（search_audits）に載せる用。軌跡の点そのものは持たない（サイズ・プライバシー）。
   */
  function motionSummary(moves) {
    var arr = Array.isArray(moves) ? moves.filter(function (m) { return m && Number(m.ms) > 0 && Number(m.dist) > 0; }) : [];
    var sp = [], ms = [], cv = [], di = [], pk = [], over = 0, pause = 0;
    arr.forEach(function (m) {
      sp.push((Number(m.dist) / Number(m.ms)) * 1000);
      ms.push(Number(m.ms)); di.push(Number(m.dist));
      cv.push(Number(m.curve) > 0 ? Number(m.curve) : 1);
      if (Number(m.peakRatio) > 0) pk.push(Number(m.peakRatio));
      if (m.overshoot) over++;
      if (m.paused) pause++;
    });
    function s(a) { return a.slice().sort(function (x, y) { return x - y; }); }
    var n = arr.length;
    return {
      n: n,
      speed_p50: n ? Math.round(_pct(s(sp), 0.5)) : null, speed_cv: _r2(_cv(sp)),
      ms_p50: n ? Math.round(_pct(s(ms), 0.5)) : null, ms_cv: _r2(_cv(ms)),
      curve_p50: n ? _r2(_pct(s(cv), 0.5)) : null, curve_p90: n ? _r2(_pct(s(cv), 0.9)) : null, curve_cv: _r2(_cv(cv)),
      dist_p50: n ? Math.round(_pct(s(di), 0.5)) : null,
      peak_p50: pk.length ? _r2(_pct(s(pk), 0.5)) : null,
      over_pct: n ? Math.round((over / n) * 1000) / 10 : null,
      pause_pct: n ? Math.round((pause / n) * 1000) / 10 : null,
    };
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
    // 2026-11-19 v2.8.25: ラン単位のクセ（persona）と人の実測に寄せた1回の移動
    hashSeed: hashSeed,
    seededRng: seededRng,
    PERSONA_RANGE: PERSONA_RANGE,
    sanitizePlan: sanitizePlan,
    makePersona: makePersona,
    moveMsSample: moveMsSample,
    planMove: planMove,
    pressMs: pressMs,
    motionSummary: motionSummary,
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
