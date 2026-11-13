// chrome-extension/learn-order.js
// 人の押す順番を、自動モードの「押す順」に活かす部品（純関数・chrome.* を使わない）。
//
// 2026-11-13 竹内さん「つなぐ」（学習担当のブレインで学んだ「押す順番」を自動モードに繋ぐ）
//
// 何をするか:
//   学んだ順番（next: 「A の次は B」）を使って、**押す物の並びを人が押した順に近づける**。
//
// ⚠ 一番大事な安全の決まり:
//   **順番は「並べ替え」にだけ使う。足したり消したりしない。**
//   ・自動モードが決めた「押す物の集合」は絶対に変えない（条件の取りこぼし＝検索漏れを防ぐ）
//   ・同じ集合の中で**順番だけ**を学んだ順に近づける
//   ・学んだ順が無い物は**元の順のまま**
//   → 条件が違うお客様でも、押す物が変わる事は無い（順番だけが変わる）。
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (root) { root.AxlxLearnOrder = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  /**
   * 学んだ順番で並べ替える（**同じ集合の中だけ**・足し引きしない）。
   *
   * 2026-11-13 竹内さん「人間の動きにするのが絶対やで」:
   *   ⚠ 学んだ順に**完全に固定するとロボット的**（毎回まったく同じ順＝人が見て分かる）。
   *   → 人が実際にやっている**揺らぎ**を入れる:
   *     ・**8割**は学んだ順（人が無意識に守る順）
   *     ・**2割**は少し入れ替える（人が「今日はこっち先」と変える形）
   *     ・入れ替えるのは**隣り合う2つだけ**（大きく崩さない＝押し忘れの見た目にしない）
   *   ⚠ 順番は「並べ替え」にだけ使う。足したり消したりしない（検索漏れを出さない）。
   *
   * @param {Array<any>} items 自動モードが決めた押す物（順番を変えるだけ）
   * @param {(item:any)=>string|null} nameOf その物の「欄の名前」を返す関数（無ければ null）
   * @param {Object<string,{next:string,n:number,total:number}>} next 学んだ順番
   * @param {{min?:number, wobble?:number, rand?:()=>number}} [opt]
   *   wobble … 入れ替える割合（既定 0.2）。0 にすると完全固定（テスト用）
   * @returns {{items:Array<any>, changed:boolean, used:string[], wobbled:boolean}}
   */
  function orderByLearned(items, nameOf, next, opt) {
    var list = Array.isArray(items) ? items.slice() : [];
    var o = opt || {};
    var min = o.min == null ? 2 : o.min;              // 2回以上そろった物だけ信じる
    var wobble = o.wobble == null ? 0.2 : o.wobble;   // 人が時々順番を変える分
    var rand = typeof o.rand === "function" ? o.rand : Math.random;
    var map = (next && typeof next === "object") ? next : {};
    if (list.length < 2) return { items: list, changed: false, used: [], wobbled: false };

    var names = list.map(function (it) {
      var n = null;
      try { n = nameOf ? nameOf(it) : null; } catch (_) { n = null; }
      return n ? String(n) : null;
    });

    // ── 学んだ順を当てる（「A は B より前」を直接かなえる）──
    /**
     * 2026-11-13 竹内さん「人間の動きにするのが絶対やで」:
     *   ⚠ 旧は「rank を付けて後ろへ動かす」方式で、**鎖（A→B→C）が解けなかった**
     *     （B が A より前にある時、B を後ろに送るだけで C との関係が崩れる）。
     *   → **「A は B より前」を1つずつ確実にかなえる**（B が A より前に居たら、B を A の直後へ動かす）。
     *     これを数回くり返す（鎖が長くても収束する）。
     *   ⚠ 動かすだけで**増減しない**（数を変えない）。
     */
    var out = list.slice();
    var used = [];
    var nameAt = function (arr, k) { return names[list.indexOf(arr[k])] || null; };
    for (var pass = 0; pass < 6; pass++) {
      var moved = false;
      for (var f in map) {
        if (!Object.prototype.hasOwnProperty.call(map, f)) continue;
        var e2 = map[f];
        if (!e2 || !e2.next) continue;
        if (Number(e2.n) < min) continue;
        var to2 = String(e2.next);
        var ia = out.findIndex(function (it) { return names[list.indexOf(it)] === f; });
        var ib = out.findIndex(function (it) { return names[list.indexOf(it)] === to2; });
        if (ia < 0 || ib < 0) continue;     // 片方がこの集合に無い＝使わない
        if (ia < ib) continue;              // もう正しい順
        // B を A の直後へ動かす（A は B より前、をかなえる）
        var item = out.splice(ib, 1)[0];
        var ia2 = out.findIndex(function (it) { return names[list.indexOf(it)] === f; });
        out.splice(ia2 + 1, 0, item);
        moved = true;
        var tag = f + " → " + to2;
        if (used.indexOf(tag) < 0) used.push(tag);
      }
      if (!moved) break;
    }
    void nameAt;

    /**
     * 人の揺らぎ（2026-11-13 竹内さん「人間の動きにするのが絶対やで」）:
     *   2割の確率で、隣り合う2つを入れ替える（大きく崩さない）。
     *   ⚠ 入れ替えるのは**学んだ組が無い所**だけ（学んだ順を壊さない）。
     */
    var wobbled = false;
    if (wobble > 0 && out.length >= 3 && rand() < wobble) {
      /**
       * 入れ替えてよい所 = **学んだ組に関係しない隣り合う2つ**。
       *   どちらも「学んだ組の from でも to でもない」所だけ（学んだ順を壊さない）。
       */
      var touching = {};
      Object.keys(map).forEach(function (f) {
        if (!map[f] || !map[f].next) return;
        touching[f] = true;
        touching[String(map[f].next)] = true;
      });
      var cand = [];
      for (var w = 0; w + 1 < out.length; w++) {
        var na = names[list.indexOf(out[w])], nb = names[list.indexOf(out[w + 1])];
        if (na && nb && !touching[na] && !touching[nb]) cand.push(w);
      }
      if (cand.length) {
        var pick = cand[Math.floor(rand() * cand.length)];
        var tmp = out[pick]; out[pick] = out[pick + 1]; out[pick + 1] = tmp;
        wobbled = true;
      }
    }

    var changed = out.some(function (it, k) { return it !== list[k]; });
    // ⚠ 数を変えていない事を必ず確かめる（増減したら元の順を返す＝安全側）
    if (out.length !== list.length) return { items: list, changed: false, used: [], wobbled: false };
    return { items: out, changed: changed, used: used, wobbled: wobbled };
  }

  /**
   * 「この欄の次はこれ」を1つ返す（無ければ null）。報告・点検用。
   */
  function nextAfter(next, name, opt) {
    var o = opt || {};
    var min = o.min == null ? 2 : o.min;
    if (!next || typeof next !== "object" || !name) return null;
    var e = next[String(name)];
    if (!e || !e.next) return null;
    if (Number(e.n) < min) return null;
    return { next: String(e.next), n: Number(e.n), total: Number(e.total) || 0 };
  }

  /** 学んだ順番の数（画面・報告用） */
  function countEdges(next) {
    if (!next || typeof next !== "object") return 0;
    return Object.keys(next).filter(function (k) { return next[k] && next[k].next; }).length;
  }

  return { orderByLearned: orderByLearned, nextAfter: nextAfter, countEdges: countEdges };
});
