// chrome-extension/itandi-row-parse.js
// itandi の検索結果の1行（部屋の段）と、その上の建物の段の「見えている文字」から物件の事実を読む。
//
// 2026-09-24 竹内「賃料と間取りも㎡数取り入れるようにする。そうじゃないとちゃんと判断できないので」
//   「駅名や徒歩数もリアプロ itandi ともに読み取れているのか」
//   旧 extractPropertyInfo は class 名（h3・[class*='name'] 等）で物件名を探し、itandi の画面（class は css-xxxx の自動生成）
//   では当たらず全件「物件」になっていた。賃料・間取り・㎡・駅・徒歩は読んでもいなかった。
//   さらに AD は 12 段上（＝一覧全体・7,000字超）まで遡って最初の「AD/広告費」を拾うため、別の物件の AD を拾い得た。
//   直し: class 名に頼らず、「物件資料」ボタンから上にたどって
//     部屋の段 = 最初に「円」と「㎡」が両方入る所（例: 612／5.7万円／なし／8,000円／…／1K／20.88㎡／…／13枚／100%／代理／可）
//     建物の段 = 最初に「徒歩」が入る所（例: 6枚／物件名／所在地／交通の行…／15階建…）
//   の文字の並びから読む。AD は部屋の段の「画像枚数（N枚）」の次の値だけを見る（他の物件の AD を拾わない）。
//   実物（2026-09-24 竹内さんのコンソール出力）をそのままテストに使う: chrome-extension/__tests__/itandi-row-parse.test.js
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (root) { root.AxlxItandiRowParse = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  function lines(text) {
    return String(text || "").split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function toHalf(s) {
    return String(s || "").replace(/[０-９．，]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
  }
  /** 「5.7万円」「57,000円」「8,000円」→ 円。「なし」「入力なし」「-」→ 0 ではなく null（値が無い） */
  function yenOf(v) {
    var s = toHalf(v).replace(/[,\s]/g, "");
    var m = s.match(/^(\d+(?:\.\d+)?)万円$/);
    if (m) return Math.round(parseFloat(m[1]) * 10000);
    m = s.match(/^(\d+)円$/);
    if (m) return parseInt(m[1], 10);
    return null;
  }
  function isNone(v) { return /^(なし|無し|入力なし|-|－|ー)$/.test(String(v || "").trim()); }

  var RENT_RE = /^[\d０-９.．]+万円$|^[\d０-９,，]+円$/;
  var LAYOUT_RE = /^(ワンルーム|1R|[1-9１-９]\s*S?\s*[LDK]{1,3}|[1-9１-９]\s*[LDKS]+)$/i;
  var AREA_RE = /^([\d０-９.．]+)\s*(㎡|m²|m2)$/;

  /** 部屋の段の文字 → { room, rentYen, adminYen, layout, areaSqm, ad, adMonths, adYen } */
  function parseRoomText(text) {
    var ls = lines(text);
    var out = { room: null, rentYen: null, adminYen: null, layout: null, areaSqm: null, ad: null, adMonths: null, adYen: null };
    var ri = -1;
    for (var i = 0; i < ls.length; i++) { if (/万円$/.test(ls[i]) && yenOf(ls[i]) != null) { ri = i; break; } }
    if (ri < 0) for (var j = 0; j < ls.length; j++) { if (RENT_RE.test(ls[j]) && yenOf(ls[j]) != null) { ri = j; break; } }
    if (ri >= 0) {
      out.rentYen = yenOf(ls[ri]);
      // 賃料の直前が部屋番号（「612」「B101」「2-301」）。「3日前」「物確不要」などは除く
      var prev = ri > 0 ? ls[ri - 1] : "";
      if (/^[0-9A-Za-z０-９Ａ-Ｚａ-ｚ\-－]{1,8}$/.test(prev) && !/日前$/.test(prev)) out.room = toHalf(prev);
      // 賃料の次の2つが 管理費・共益費（どちらも値があれば足す）
      var fees = [ls[ri + 1], ls[ri + 2]].map(yenOf).filter(function (n) { return n != null; });
      out.adminYen = fees.length ? fees.reduce(function (a, b) { return a + b; }, 0) : (isNone(ls[ri + 1]) ? 0 : null);
    }
    for (var k = 0; k < ls.length; k++) {
      var h = toHalf(ls[k]).replace(/\s+/g, "");
      if (!out.layout && LAYOUT_RE.test(h)) out.layout = h.toUpperCase().replace("ワンルーム", "1R");
      var am = h.match(AREA_RE);
      if (out.areaSqm == null && am) out.areaSqm = parseFloat(am[1]);
    }
    // AD: 画像枚数（N枚）の次の値だけ（100% / 1ヶ月 / 30,000円 / 入力なし）
    for (var p = 0; p < ls.length - 1; p++) {
      if (/^\d+枚$/.test(toHalf(ls[p]))) {
        var v = toHalf(ls[p + 1]).replace(/\s+/g, "");
        if (isNone(v)) break;
        var pct = v.match(/^(\d+(?:\.\d+)?)%$/);
        var mon = v.match(/^(\d+(?:\.\d+)?)[ヶかカケ]?月(?:分)?$/);
        var yen = yenOf(v);
        if (pct) { out.adMonths = Math.round(parseFloat(pct[1])) / 100; out.ad = "AD " + out.adMonths + "ヶ月"; }
        else if (mon) { out.adMonths = parseFloat(mon[1]); out.ad = "AD " + out.adMonths + "ヶ月"; }
        else if (yen != null) { out.adYen = yen; out.ad = "AD " + yen.toLocaleString("ja-JP") + "円"; }
        break;
      }
    }
    return out;
  }

  var PREF_RE = /^(北海道|東京都|京都府|大阪府|.{2,3}県)/;
  /** 建物の段の文字 → { name, address, stations: ["JR京都線 新大阪駅 徒歩8分", …], walkMin } */
  function parseBuildingText(text) {
    var ls = lines(text);
    var out = { name: null, address: null, stations: [], walkMin: null };
    // 表の見出し（募集状況）より前だけを見る（下の部屋の段の文字を混ぜない）
    var end = ls.indexOf("募集状況");
    var head = end >= 0 ? ls.slice(0, end) : ls;
    var ai = -1;
    for (var i = 0; i < head.length; i++) { if (PREF_RE.test(head[i])) { ai = i; break; } }
    if (ai >= 0) {
      out.address = head[ai];
      // 所在地の直前が物件名（その前の「6枚」＝写真の枚数は名前ではない）
      for (var j = ai - 1; j >= 0; j--) {
        if (/^\d+枚$/.test(toHalf(head[j]))) continue;
        out.name = head[j].slice(0, 60);
        break;
      }
    }
    head.forEach(function (l) {
      var m = toHalf(l).match(/徒歩\s*(\d+)\s*分/);
      if (!m) return;
      out.stations.push(l.replace(/\s+/g, " "));
      var w = parseInt(m[1], 10);
      if (out.walkMin == null || w < out.walkMin) out.walkMin = w;
    });
    return out;
  }

  /** 「物件資料」ボタンから部屋の段・建物の段を探して読む（DOM が要る。テストでは parseRoomText / parseBuildingText を直接使う） */
  function readFromButton(btn) {
    var room = btn, bld = btn;
    for (var i = 0; i < 14 && room && !(/円/.test(room.innerText || "") && /㎡/.test(room.innerText || "")); i++) room = room.parentElement;
    for (var k = 0; k < 16 && bld && !/徒歩/.test(bld.innerText || ""); k++) bld = bld.parentElement;
    var r = room ? parseRoomText(room.innerText) : parseRoomText("");
    var b = bld ? parseBuildingText(bld.innerText) : parseBuildingText("");
    return merge(r, b);
  }
  function merge(r, b) {
    return {
      name: b.name, address: b.address, stations: b.stations, walkMin: b.walkMin,
      room: r.room, rentYen: r.rentYen, adminYen: r.adminYen, layout: r.layout, areaSqm: r.areaSqm,
      ad: r.ad, adMonths: r.adMonths, adYen: r.adYen,
    };
  }

  /** 説明文（リアプロと同じ並び: 名前／賃料 管理費／間取り ㎡／号室／交通／AD）。サーバーの parsePropertyFacts が読める形 */
  function buildSummary(rank, nameFromPdf, info) {
    info = info || {};
    var name = nameFromPdf || info.name || ("物件" + rank);
    var out = ["【" + rank + "】" + name];
    if (info.rentYen != null) out.push(info.rentYen.toLocaleString("ja-JP") + "円" + (info.adminYen ? " " + info.adminYen.toLocaleString("ja-JP") + "円" : ""));
    var la = [info.layout, info.areaSqm != null ? info.areaSqm + "㎡" : null].filter(Boolean).join(" ");
    if (la) out.push(la);
    if (info.room) out.push(info.room + "号室");
    (info.stations || []).slice(0, 3).forEach(function (s) { out.push(s); });
    if (info.ad) out.push(info.ad);
    return out.join("\n");
  }

  return { parseRoomText: parseRoomText, parseBuildingText: parseBuildingText, readFromButton: readFromButton, merge: merge, buildSummary: buildSummary, yenOf: yenOf };
});
