// floor-ijou.js — 間取りの「〇〇以上」をどこまで広げるか（2026-10-06 v2.5.82・リアプロ／ITANDI の自動入力と案内の4か所が同じ決まり）
//
// 竹内「1LDK以上の場合でこんな5LDKまでえらぶことはない 1LDKから2LDKで調べる」（ゆなまるさん・1LDK以上で 2K〜6LDK まで光っていた）:
//   旧: 「〇〇以上」はその間取りから一番上（メゾネット・5K以上）まで全部に印を付けていた（page-script.js・itandi-page-script.js・2つの案内の手順表）。
//   → 一つ上の大きさまで: nLDK以上 → (n+1)LDK まで（1LDK以上＝1LDK・2K・2DK・2LDK）／nK・nDK以上 → nLDK まで（1K以上＝1K・1DK・1LDK）／1R以上 → 1K まで。
//   実データ（売上サポに送った部屋・お客様の希望が「〇〇以上」）: 1LDK以上 198部屋＝1LDK 94・2LDK 39・2DK 15・2K 7（3DK 以上は 23＝旧の全部選びの時の物）／
//   2LDK以上 12部屋＝2LDK 8・3DK 3・3LDK 1／1K以上 44部屋＝1K 40・1DK 1・1LDK 1。
//   ページ（MAIN の世界）にも読み込む（リアプロは content.js が page-script.js の前に入れる・ITANDI は manifest の MAIN の段）
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root && !root.AxlxFloorIjou) root.AxlxFloorIjou = api;
})(typeof self !== "undefined" ? self : this, function () {
  /** 「base以上」の一番上の間取り（決まらない時は null＝呼ぶ側は旧の広げ方） */
  function ijouUpper(base) {
    var b = String(base || "").trim().toUpperCase();
    if (/^(1R|ワンルーム|スタジオ|スタジオタイプ)$/.test(b)) return "1K";
    var m = b.match(/^(\d)LDK$/);
    if (m) return (Number(m[1]) + 1) + "LDK";
    m = b.match(/^(\d)S?(K|DK)$/);
    if (m) return m[1] + "LDK";
    m = b.match(/^(\d)SLDK$/);
    if (m) return (Number(m[1]) + 1) + "LDK";
    return null;
  }
  /**
   * 並び（rank）の中で base から上の印を付ける範囲 [from, to]（両端を含む）。
   *   上の間取りが並びに無い（ITANDI は 4LDK の次が「5K以上」）時は並びの最後まで
   */
  function ijouRange(rank, base, aliasOf) {
    var k = aliasOf ? (aliasOf(base) || base) : base;
    var from = rank.indexOf(k);
    if (from < 0) return null;
    var up = ijouUpper(base);
    if (!up) return [from, rank.length - 1];
    var upKey = aliasOf ? (aliasOf(up) || up) : up;
    var to = rank.indexOf(upKey);
    if (to < 0) to = rank.length - 1;
    if (to < from) to = from;
    return [from, to];
  }
  return { ijouUpper: ijouUpper, ijouRange: ijouRange };
});
