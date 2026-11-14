// chrome-extension/room-dedupe.js
// 2026-11-14 竹内さん「同じ建物の場合平米数が同じなら一番低い家賃の物件1件だけにする。
//   同じマンションでも同じ間取りで大量に募集されている場合。ここもともとは設定していたのに今すべてダウンロードしているので改善する」
//
// なぜ要るか:
//   1つの建物で「1LDK 29.28㎡」が10〜20部屋いっしょに募集されている事がある（階だけ違う）。
//   全部の資料を取ると **PDF が10倍**になり、お客様に見せる時も同じ部屋が並ぶだけ。
//   → **同じ建物・同じ間取り・同じ平米数**なら、**いちばん安い1件だけ**を残す。
//
// ⚠ 守る事:
//   ・**間取りが違う**／**平米数が違う**なら別の部屋として残す（同じにしない）
//   ・読めない項目がある時は**絞らない**（迷ったら残す＝資料を落とさない）
//   ・家賃が読めない時も絞らない（安い方を選べないため）
//   ・元の順番（一覧の並び）は変えない（残す物の順序はそのまま）
(function () {
  "use strict";

  /** 全角→半角（空白は**残す**・区切りとして使う） */
  function half(s) {
    return String(s == null ? "" : s)
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); })
      .replace(/[．]/g, ".");
  }

  /** 全角→半角 + 空白除去（数値の読み取り用） */
  function norm(s) {
    return half(s).replace(/[\s\u3000]+/g, "");
  }

  /**
   * 平米数を読む（"29.28m²" "29.28㎡" "29.28" "３２．５㎡" など）。
   * @returns {number|null} 読めなければ null
   */
  function areaOf(text) {
    var s = norm(text);
    var m = s.match(/([0-9]+(?:\.[0-9]+)?)(?:m2|m²|㎡|平米)/i);
    if (m) return Math.round(parseFloat(m[1]) * 100) / 100;
    // 「29.28」だけの時（㎡ の記号が無い）は、10〜300 の範囲なら平米とみなす
    var m2 = s.match(/^([0-9]{1,3}(?:\.[0-9]{1,2})?)$/);
    if (m2) {
      var v = parseFloat(m2[1]);
      if (v >= 10 && v <= 300) return Math.round(v * 100) / 100;
    }
    return null;
  }

  /**
   * 間取りを読む（"1LDK" "2DK" "ワンルーム" "1R" など）。
   * @returns {string|null}
   */
  function layoutOf(text) {
    /**
     * 2026-11-14: ⚠ **空白を消してから読むと**号室と間取りがくっついて
     *   「0701 1LDK」→ `07011LDK` → `11LDK` と誤読する（実測で発生）。
     *   → 空白を**残したまま**（`half`）号室の塊を消してから間取りを探す。
     */
    var s = half(text).toUpperCase();
    var cleaned = s.replace(/(^|[^0-9])([0-9]{3,5})(?=[^0-9]|$)/g, function (_m, a) { return a + " "; });
    var m = cleaned.match(/([0-9]{1,2}(?:SLDK|LDK|DK|K)|ワンルーム|1R)/);
    if (!m) {
      // 空白が無い形（「07011LDK」）でも読めるように、空白無しでも試す
      var s2 = norm(text).toUpperCase().replace(/([0-9]{3,5})(?=[0-9]{1,2}(?:SLDK|LDK|DK|K))/g, "");
      m = s2.match(/([0-9]{1,2}(?:SLDK|LDK|DK|K)|ワンルーム|1R)/);
    }
    if (!m) return null;
    var v = m[1];
    if (v === "ワンルーム") return "1R";
    return v;
  }

  /**
   * 家賃を読む（"102,600円" "10.26万円" "102600" など）。
   *   ⚠ 「管理費 10,000円」のような**別の金額**を家賃と取り違えないよう、
   *     「万円」が付く物を最優先し、次に「円」付きで**最初に出てくる物**を採る。
   * @returns {number|null} 円（整数）。読めなければ null
   */
  function rentOf(text) {
    var s = norm(text);
    // ① 「10.26万円」形式
    var man = s.match(/([0-9]+(?:\.[0-9]+)?)万円/);
    if (man) return Math.round(parseFloat(man[1]) * 10000);
    // ② 「102,600円」形式（カンマは norm で消えないので個別に消す）
    var yen = s.replace(/,/g, "").match(/([0-9]{4,7})円/);
    if (yen) {
      var v = parseInt(yen[1], 10);
      if (v >= 10000 && v <= 10000000) return v;
    }
    // ③ 「賃料102600」のような数字だけ（4〜7桁）
    var bare = s.replace(/,/g, "").match(/(?:賃料|家賃)[^0-9]{0,4}([0-9]{4,7})/);
    if (bare) return parseInt(bare[1], 10);
    return null;
  }

  /** 号室を読む（"0701" "504" など）。読めなければ null */
  function roomOf(text) {
    var s = norm(text);
    var m = s.match(/(?:^|[^0-9])([0-9]{3,5})(?:号室|[^0-9]|$)/);
    return m ? m[1] : null;
  }

  /**
   * 1件分の材料を1つの形にそろえる。
   * @param {{name?:string, cells?:string[], texts?:string[]}} card
   * @returns {{name:string, layout:string|null, area:number|null, rent:number|null, room:string|null}}
   */
  function factsOf(card) {
    var c = card || {};
    var all = []
      .concat(Array.isArray(c.cells) ? c.cells : [])
      .concat(Array.isArray(c.texts) ? c.texts : []);
    var joined = all.map(function (x) { return String(x == null ? "" : x); }).join(" ");
    return {
      name: String(c.name == null ? "" : c.name).trim(),
      layout: layoutOf(joined),
      area: areaOf(joined),
      rent: rentOf(joined),
      room: roomOf(Array.isArray(c.cells) && c.cells.length ? c.cells[0] : joined),
    };
  }

  /**
   * **同じ建物・同じ間取り・同じ平米数**なら、いちばん安い1件だけ残す。
   *
   * @param {Array<{name?:string, cells?:string[], texts?:string[], [k:string]:unknown}>} items 一覧の行（順番そのまま）
   * @param {{keepUnknown?:boolean}} [opts]
   * @returns {{keep:number[], drop:number[], groups:Array<{key:string, keep:number, dropped:number[], rents:number[]}>}}
   *   keep/drop は**元の配列の添字**。`keep` は元の順番のまま。
   */
  function cheapestPerBuildingLayoutSize(items, opts) {
    var list = Array.isArray(items) ? items : [];
    var o = opts || {};
    var keepUnknown = o.keepUnknown !== false;   // 既定は「迷ったら残す」
    var out = { keep: [], drop: [], groups: [] };
    var best = Object.create(null);   // key → { idx, rent }
    var groups = Object.create(null); // key → { idxs, rents }

    for (var i = 0; i < list.length; i++) {
      var f = factsOf(list[i]);
      /**
       * ⚠ 建物名・間取り・平米のどれかが読めない → **絞らない**（残す）。
       *   読めない物を同じと決めつけると、別の部屋の資料を落としてしまう。
       */
      if (!f.name || !f.layout || f.area == null) {
        if (keepUnknown) out.keep.push(i);
        else out.drop.push(i);
        continue;
      }
      var key = f.name + "|" + f.layout + "|" + f.area;
      if (!groups[key]) groups[key] = { idxs: [], rents: [] };
      groups[key].idxs.push(i);
      if (f.rent != null) groups[key].rents.push(f.rent);

      /**
       * ⚠ 家賃が読めない → その部屋は**残す**（安い方を選べないので落とせない）。
       *   ただし「読めた物の中で一番安い1件」は別に残す。
       */
      if (f.rent == null) {
        if (keepUnknown) out.keep.push(i);
        continue;
      }
      if (!best[key] || f.rent < best[key].rent) {
        best[key] = { idx: i, rent: f.rent };
      }
    }

    // グループごとに「一番安い1件」を残す
    for (var k in groups) {
      if (!Object.prototype.hasOwnProperty.call(groups, k)) continue;
      var b = best[k];
      if (b) out.keep.push(b.idx);
      var dropped = groups[k].idxs.filter(function (x) { return !b || x !== b.idx; });
      out.drop = out.drop.concat(dropped);
      out.groups.push({ key: k, keep: b ? b.idx : -1, dropped: dropped, rents: groups[k].rents.slice() });
    }

    // 元の順番に戻す（重複なし）
    out.keep = uniq(out.keep).sort(function (a, b2) { return a - b2; });
    out.drop = uniq(out.drop).sort(function (a, b2) { return a - b2; });
    // ⚠ keep と drop が両方に入らないようにする（安全）
    out.drop = out.drop.filter(function (x) { return out.keep.indexOf(x) < 0; });
    return out;
  }

  function uniq(arr) {
    var seen = Object.create(null), res = [];
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (seen[v]) continue;
      seen[v] = true;
      res.push(v);
    }
    return res;
  }

  var api = {
    norm: norm,
    areaOf: areaOf,
    layoutOf: layoutOf,
    rentOf: rentOf,
    roomOf: roomOf,
    factsOf: factsOf,
    cheapestPerBuildingLayoutSize: cheapestPerBuildingLayoutSize,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof self !== "undefined") self.AxlxRoomDedupe = api;
  if (typeof window !== "undefined") window.AxlxRoomDedupe = api;
})();
