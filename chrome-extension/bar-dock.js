// bar-dock.js — 拡張の浮いている枠（一括のバー）がサイトの固定のボタンに重ならないようにする（2026-10-06 v2.5.74）
//
// 竹内「itandiの本来あるまとめて図面取得が押せない 拡張ツールが原因してるのかな？ 原因みつける」:
//   原因: ITANDI の一括のバー（itandi-bulk-dl.js・○件を選択中／全選択／売上番長に送る／全ページ送る）が画面の右下に
//   position:fixed・z-index 最大で固定されていて、ITANDI が行にチェックした時に下に出す自前の帯（すべて選択・まとめて図面取得）の
//   右側のボタンの上に重なっていた＝押しても拡張の枠に当たる。拡張が ITANDI のボタンを止めたり押さえたりしている所は無い
//   （全ページ送るの止めは拡張の自分のボタンだけ・チェックボックスは物件資料の横に足すだけで ITANDI のチェックとは別）。
//   → 枠の下にあるサイトの固定（fixed・sticky）のボタン・リンクを見つけたら、枠をその上へ上げる。重ならない時は元の位置。
//     枠は「▾」で1行に畳める（畳んだかはこの PC に覚える）。
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root && !root.AxlxBarDock) root.AxlxBarDock = api;
})(typeof self !== "undefined" ? self : this, function () {
  var OWN_RE = /^(axlx|aixlinx|sumora-)/;
  function isOwn(el) {
    for (var n = el, k = 0; n && n.nodeType === 1 && k < 12; n = n.parentElement, k++) {
      if (n.id && OWN_RE.test(n.id)) return true;
      var c = typeof n.className === "string" ? n.className : "";
      if (c && c.split(/\s+/).some(function (x) { return OWN_RE.test(x); })) return true;
    }
    return false;
  }
  /**
   * 純: 枠の下にある固定のボタンの上端（hitTops）から、枠の bottom（画面の下からの px）を決める。
   *   重なりが無ければ base（元の bottom）。あれば一番上のボタンの上端の margin 上。画面からはみ出さない（上は 8px まで）
   */
  function dockBottom(p) {
    var base = p.base, vh = p.vh, margin = p.margin == null ? 10 : p.margin;
    if (!p.hitTops || !p.hitTops.length) return base;
    var minTop = Math.min.apply(null, p.hitTops);
    var b = Math.max(base, Math.round(vh - minTop + margin));
    var maxB = Math.max(base, vh - (p.barH || 0) - 8);
    return Math.min(b, maxB);
  }
  /** 純: 2つの四角が重なるか */
  function overlaps(a, b) {
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  }
  /** el かその上（8段まで）が fixed・sticky か（サイトの帯の中のボタン） */
  function inFixedBar(el) {
    for (var n = el, k = 0; n && n.nodeType === 1 && n !== document.body && k < 8; n = n.parentElement, k++) {
      var pos = getComputedStyle(n).position;
      if (pos === "fixed" || pos === "sticky") return true;
    }
    return false;
  }
  /**
   * 枠（bar）の下にあるサイトの固定のボタン・リンクの上端を集める。枠の四角の中の 4×3 の点で elementsFromPoint を見る
   *   （枠より下に重なっている要素も返る）。拡張の物は除く。
   */
  function hitTopsUnder(bar) {
    if (!bar || !document.elementsFromPoint) return [];
    var r = bar.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return [];
    var tops = [], seen = [];
    for (var ix = 0; ix < 4; ix++) for (var iy = 0; iy < 3; iy++) {
      var x = r.left + (r.width * (ix + 0.5)) / 4, y = r.top + (r.height * (iy + 0.5)) / 3;
      var els = document.elementsFromPoint(x, y) || [];
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el === bar || bar.contains(el) || isOwn(el)) continue;
        var btn = el.closest ? el.closest("button,a,[role=button],input[type=button],input[type=submit]") : null;
        if (!btn || seen.indexOf(btn) >= 0 || isOwn(btn)) continue;
        seen.push(btn);
        if (!inFixedBar(btn)) continue;
        var br = btn.getBoundingClientRect();
        if (br.width > 0 && br.height > 0 && overlaps(r, br)) tops.push(br.top);
      }
    }
    return tops;
  }
  /**
   * 枠を重ならない所へ。base＝元の bottom（px）。重なりを見るために一度元の位置に戻してから測る（上げたままだと重なりが見えない）
   *   返す: 決めた bottom
   */
  function applyBottom(bar, base, margin) {
    if (!bar || bar.style.display === "none") return base;
    bar.style.bottom = base + "px";
    var tops = hitTopsUnder(bar);
    var b = dockBottom({ base: base, vh: window.innerHeight, hitTops: tops, margin: margin, barH: bar.getBoundingClientRect().height });
    if (b !== base) bar.style.bottom = b + "px";
    return b;
  }
  /** リアプロの枠（縦の真ん中・transform）用: 重なりがあれば、重なったボタンの上端の上へ top を置く */
  function applyTopAvoid(bar, margin) {
    if (!bar || bar.style.display === "none") return false;
    var tops = hitTopsUnder(bar);
    if (!tops.length) return false;
    var r = bar.getBoundingClientRect();
    var top = Math.max(8, Math.min.apply(null, tops) - r.height - (margin == null ? 10 : margin));
    bar.style.transform = "none";
    bar.style.top = top + "px";
    return true;
  }
  return { dockBottom: dockBottom, overlaps: overlaps, hitTopsUnder: hitTopsUnder, applyBottom: applyBottom, applyTopAvoid: applyTopAvoid, isOwn: isOwn };
});
