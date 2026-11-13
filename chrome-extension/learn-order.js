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
  /**
   * 2026-11-13 竹内さん「site_flow と weak を実際に使う」:
   *   サイトごとの手順（`site_flow`）から「**A は B より前**」の組を作る。
   *
   *   なぜ要るか:
   *     `next`（A の次は B）だけだと、**並べ替えに使える組が3通りしかなかった**
   *     （残り9通りはモーダルの中などで、`_basicQueue` の集合に居ない）。
   *     だが `site_flow` は**手順全体の鎖**を持っている（確定→徒歩→賃料→…）。
   *     → 鎖を「A は B より前」に開けば、**離れた2つでも順番を決められる**。
   *
   *   ⚠ 使うのは**回数が min 以上の組だけ**（1回だけの偶然を採らない）。
   *   ⚠ `next` に既にある組は**上書きしない**（`next` の方が「直後」を正確に持っている）。
   *
   * @param {Object<string,Array<{from:string,to:string,n:number}>>} siteFlow
   * @param {{site?:string, min?:number}} [opt]
   * @returns {Object<string,{next:string,n:number,total:number}>}
   */
  function beforePairsFromFlow(siteFlow, opt) {
    var o = opt || {};
    var min = o.min == null ? 2 : o.min;
    var sf = (siteFlow && typeof siteFlow === "object") ? siteFlow : {};
    var arr = [];
    if (o.site && Array.isArray(sf[o.site])) arr = arr.concat(sf[o.site]);
    // site の指定が無い・その site が無い時は、全部を合わせる
    if (!arr.length) {
      Object.keys(sf).forEach(function (k) { if (Array.isArray(sf[k])) arr = arr.concat(sf[k]); });
    }
    var out = {};
    // 「from → to」の回数（同じ from から複数の to がある時は、回数の多い順に鎖とみなす）
    var byFrom = {};
    arr.forEach(function (x) {
      if (!x || !x.from || !x.to || x.from === x.to) return;
      var n = Number(x.n) || 0;
      if (n < min) return;
      (byFrom[x.from] = byFrom[x.from] || []).push({ to: String(x.to), n: n });
    });
    Object.keys(byFrom).forEach(function (f) {
      byFrom[f].sort(function (a, b) { return b.n - a.n; });
      var top = byFrom[f][0];
      var total = byFrom[f].reduce(function (s, x) { return s + x.n; }, 0);
      out[f] = { next: top.to, n: top.n, total: total };
    });
    return out;
  }

  /**
   * 2026-11-13: 「離れた2つ」の前後関係を、鎖をたどって作る（集合の中の物だけで作る）。
   *
   *   なぜ要るか:
   *     `site_flow` の組は「確定してリストへ → required_time」のように、
   *     **`_basicQueue` に居ない名前**が混ざる。そのままでは並べ替えに使えない。
   *     だが鎖をたどれば「確定 → 徒歩 → 賃料上限 → …」から
   *     **「rental_cost2 は rental_cost1 より後」**のような組が作れる。
   *
   *   ⚠ 作るのは**渡された集合（names）の中の物どうし**の組だけ（外の物は無視）。
   *   ⚠ 回数は「鎖の一番弱い所」（途中で1回しか通らない道は信用しない）。
   *
   * @param {string[]} names 並べ替える対象（自動モードが押す物の名前）
   * @param {Object<string,Array<{from:string,to:string,n:number}>>} siteFlow
   * @param {{site?:string}} [opt]
   * @returns {Object<string,string>} 「A → B」（A は B より前）
   */
  function chainOrderWithin(names, siteFlow, opt) {
    var set = {};
    (Array.isArray(names) ? names : []).forEach(function (n) { if (n) set[String(n)] = true; });
    var sf = (siteFlow && typeof siteFlow === "object") ? siteFlow : {};
    var arr = [];
    if (opt && opt.site && Array.isArray(sf[opt.site])) arr = arr.concat(sf[opt.site]);
    if (!arr.length) Object.keys(sf).forEach(function (k) { if (Array.isArray(sf[k])) arr = arr.concat(sf[k]); });

    // 「from → to」（回数の多い1本だけ）の地図
    var best = {};
    arr.forEach(function (x) {
      if (!x || !x.from || !x.to || x.from === x.to) return;
      var n = Number(x.n) || 0;
      if (n < 2) return;
      if (!best[x.from] || n > best[x.from].n) best[x.from] = { to: String(x.to), n: n };
    });

    // 集合の中の物から出発して鎖をたどり、出会った集合内の物を順に並べる
    var out = {};
    var starts = Object.keys(best).filter(function (f) { return set[f]; });
    starts.forEach(function (start) {
      var cur = start;
      var seen = {};
      var prev = null;
      for (var guard = 0; guard < 20; guard++) {
        seen[cur] = true;
        var nx = best[cur];
        if (!nx) break;
        var nxt = nx.to;
        if (set[nxt] && nxt !== start) {
          // 集合内の物が出たら「prev は nxt より前」
          out[prev || start] = nxt;
          if (prev) break;      // 1つ見つかれば十分（鎖の先まで追わない＝誤りを増やさない）
        }
        if (seen[nxt]) break;
        prev = prev || (set[nxt] ? nxt : prev);
        cur = nxt;
      }
    });
    return out;
  }

  /**
   * 2026-11-13: `next` と `site_flow` の鎖を**1つに合わせる**。
   *   ⚠ `next` を優先（直後を正確に持っている）。集合内の前後関係は `chainOrderWithin` で補う。
   */
  function mergeLearnedOrder(next, siteFlow, opt) {
    var base = (next && typeof next === "object") ? next : {};
    var add = beforePairsFromFlow(siteFlow, opt);
    var out = {};
    Object.keys(add).forEach(function (k) { out[k] = add[k]; });
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    // 鎖から「集合の中だけ」の前後関係も足す（`next` にある物は上書きしない）
    var names = (opt && Array.isArray(opt.names)) ? opt.names : [];
    if (names.length) {
      var chain = chainOrderWithin(names, siteFlow, opt);
      Object.keys(chain).forEach(function (a) {
        if (out[a]) return;                  // next が既に持っている
        out[a] = { next: chain[a], n: 2, total: 2 };
      });
    }
    return out;
  }

  /**
   * 2026-11-13 竹内さん「site_flow を実際に使う」:
   *   **人の手順と、自動の手順がどこで違うか**を返す（点検用・動きは変えない）。
   *
   *   なぜ「並べ替え」ではなく「点検」なのか（実測で分かった事）:
   *     `_basicQueue` の集合（賃料・面積・共益費の5つ）に対しては、
   *     `next`（直後の組）が**すでに全部カバー**していて、`site_flow` を足しても
   *     使える組は **3通りのまま**だった（実測）。
   *     残りの9通りはモーダルの中にあり、**人の手順を崩すと検索が漏れる**ので並べ替えない。
   *   → `site_flow` は**順番を変える**のではなく「**人の順と違う所を見つける**」のに使う。
   *     記録（点検）に残せば、後で「ここは人の順にした方がよいか」を判断できる。
   *
   * @param {string[]} actualNames 自動が押した順
   * @param {Object<string,Array<{from:string,to:string,n:number}>>} siteFlow
   * @param {{site?:string, min?:number}} [opt]
   * @returns {Array<{earlier:string, later:string, n:number}>} 人の順では「earlier が先」なのに actual では後の物
   */
  function flowMismatches(actualNames, siteFlow, opt) {
    var o = opt || {};
    var min = o.min == null ? 2 : o.min;
    var seq = Array.isArray(actualNames) ? actualNames.map(String) : [];
    if (seq.length < 2) return [];
    var pos = {};
    seq.forEach(function (n, i) { if (!(n in pos)) pos[n] = i; });

    var sf = (siteFlow && typeof siteFlow === "object") ? siteFlow : {};
    var arr = [];
    if (o.site && Array.isArray(sf[o.site])) arr = arr.concat(sf[o.site]);
    if (!arr.length) Object.keys(sf).forEach(function (k) { if (Array.isArray(sf[k])) arr = arr.concat(sf[k]); });

    var out = [];
    var seen = {};
    arr.forEach(function (x) {
      if (!x || !x.from || !x.to) return;
      var n = Number(x.n) || 0;
      if (n < min) return;
      var a = String(x.from), b = String(x.to);
      if (!(a in pos) || !(b in pos)) return;   // 片方が今回の集合に無い＝比べられない
      if (pos[a] > pos[b]) {                     // 人の順では a が先。実際は b が先
        var k = a + ">" + b;
        if (seen[k]) return;
        seen[k] = true;
        out.push({ earlier: a, later: b, n: n });
      }
    });
    return out;
  }

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

  return {
    orderByLearned: orderByLearned, nextAfter: nextAfter, countEdges: countEdges,
    beforePairsFromFlow: beforePairsFromFlow, chainOrderWithin: chainOrderWithin, mergeLearnedOrder: mergeLearnedOrder,
    flowMismatches: flowMismatches,
  };
});
