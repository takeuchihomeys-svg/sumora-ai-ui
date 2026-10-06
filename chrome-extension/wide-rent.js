// wide-rent.js — 「広げて検索」の家賃の上限（2026-10-06 v2.5.79）
//
// ⑫ の決定: お客様の家賃の上限が「必ず」（property_customers.requirement_strength.rent_max.strength === "must"・例 KAORI「管理費込みで12万上限」）の時は、
//   広げて検索でも家賃の上限を上げない（エリア・駅・築年数などの広げ方は今まで通り）。
//   旧: 広げて検索は家賃の上限に 10万以下 +5,000円・それ以上 +10,000円を足していた（popup の3か所・resolution-core の1か所）
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root && !root.AxlxWideRent) root.AxlxWideRent = api;
})(typeof self !== "undefined" ? self : this, function () {
  /** 家賃の上限が「必ず」か */
  function rentMust(c) {
    var rs = c && c.requirement_strength;
    if (typeof rs === "string") { try { rs = JSON.parse(rs); } catch (_) { rs = null; } }
    return !!(rs && rs.rent_max && rs.rent_max.strength === "must");
  }
  /** 広げた時に足す額（10万以下 5,000円・それ以上 10,000円） */
  function wideBuffer(rentMax) { return Number(rentMax) <= 100000 ? 5000 : 10000; }
  /** 検索に使う家賃の上限（広げて・必ずでない時だけ足す） */
  function searchRentMax(rentMax, isWide, c) {
    var n = Number(rentMax);
    if (rentMax == null || rentMax === "" || !isFinite(n) || n <= 0) return null;
    if (!isWide || rentMust(c)) return n;
    return n + wideBuffer(n);
  }
  return { rentMust: rentMust, wideBuffer: wideBuffer, searchRentMax: searchRentMax };
});
