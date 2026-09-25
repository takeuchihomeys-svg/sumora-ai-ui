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
//   実物（2026-09-24 竹内さんのコンソール出力）をそのままテストに使う: tests/chrome-extension/itandi-row-parse.test.js
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
  /** 敷金・礼金の欄: 「なし」→ 0ヶ月 / 「1ヶ月」→ 1 / 「50,000円」→ 円 / 「入力なし」・読めない → null */
  function depositOf(v) {
    var s = toHalf(v).replace(/\s+/g, "");
    if (!s || s === "入力なし") return null;
    if (/^(なし|無し|-|－|ー|0)$/.test(s)) return { months: 0, yen: null };
    var m = s.match(/^(\d+(?:\.\d+)?)[ヶかカケヵ]?月$/);
    if (m) return { months: parseFloat(m[1]), yen: null };
    var y = yenOf(s);
    return y != null ? { months: null, yen: y } : null;
  }

  var RENT_RE = /^[\d０-９.．]+万円$|^[\d０-９,，]+円$/;
  var LAYOUT_RE = /^(ワンルーム|1R|[1-9１-９]\s*S?\s*[LDK]{1,3}|[1-9１-９]\s*[LDKS]+)$/i;
  var AREA_RE = /^([\d０-９.．]+)\s*(㎡|m²|m2)$/;

  /** 部屋の段の文字 → { room, rentYen, adminYen, layout, areaSqm, ad, adMonths, adYen } */
  function parseRoomText(text) {
    var ls = lines(text);
    var out = { room: null, rentYen: null, adminYen: null, layout: null, areaSqm: null, ad: null, adMonths: null, adYen: null,
      depositMonths: null, depositYen: null, keyMoneyMonths: null, keyMoneyYen: null };
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
    var li = -1;
    for (var k = 0; k < ls.length; k++) {
      var h = toHalf(ls[k]).replace(/\s+/g, "");
      if (!out.layout && LAYOUT_RE.test(h)) { out.layout = h.toUpperCase().replace("ワンルーム", "1R"); li = k; }
      var am = h.match(AREA_RE);
      if (out.areaSqm == null && am) out.areaSqm = parseFloat(am[1]);
    }
    // 2026-09-25 竹内「候補の記憶を太くする」: 敷金・礼金。表の並びは 賃料｜管理費｜共益費｜敷金｜礼金｜保証金｜間取り
    //   （実物 612: 5.7万円／なし／8,000円／なし／なし／入力なし／1K）。**賃料と間取りの間がちょうど6つの時だけ**読む
    //   （並びが違う画面で別の欄を敷礼と読まない）。「なし」= 0・「入力なし」= 分からない（null）
    if (ri >= 0 && li === ri + 6) {
      var dep = depositOf(ls[ri + 3]), key = depositOf(ls[ri + 4]);
      if (dep) { out.depositMonths = dep.months; out.depositYen = dep.yen; }
      if (key) { out.keyMoneyMonths = key.months; out.keyMoneyYen = key.yen; }
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
    var out = { name: null, address: null, stations: [], walkMin: null, builtYm: null, buildingAge: null, totalFloors: null };
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
    // 2026-09-25: 階建・築年月・築年数（実物: 「15階建」「/ 2008年6月」「(築18年)」）
    head.forEach(function (l) {
      var h = toHalf(l).replace(/\s+/g, "");
      var tf = h.match(/^(\d{1,2})階建/);
      if (tf && out.totalFloors == null) out.totalFloors = parseInt(tf[1], 10);
      var by = h.match(/^\/?((?:19|20)\d{2})年(\d{1,2})月$/);
      if (by && out.builtYm == null) out.builtYm = by[1] + "-" + (by[2].length === 1 ? "0" + by[2] : by[2]);
      var ag = h.match(/^[(（]?築(\d{1,3})年[)）]?$/);
      if (ag && out.buildingAge == null) out.buildingAge = parseInt(ag[1], 10);
      if (/^[(（]?新築[)）]?$/.test(h) && out.buildingAge == null) out.buildingAge = 0;
    });
    return out;
  }

  /**
   * 候補の記録（property_pool の1件・/api/log-property-candidates）に残す形。2026-09-25 竹内「候補の記憶を太くする」:
   *   旧は { rank, name, ad_months } だけで、家賃・徒歩・敷礼・築年が候補の記録に無かった（24件中 0件）。
   *   画面から読めた値を全部入れ、サーバー（candidate-facts.ts）が読み直せるように交通の行もそのまま残す
   */
  function toPoolData(rank, nameFromPdf, info, pdfUrl) {
    info = info || {};
    var name = nameFromPdf || (info.name && info.name !== "物件" ? info.name : null) || ("物件" + rank);
    var d = { rank: rank, name: name };
    var put = function (k, v) { if (v !== null && v !== undefined && v !== "") d[k] = v; };
    put("rent", info.rentYen);
    put("admin_fee_yen", info.adminYen);
    put("deposit_months", info.depositMonths);
    put("deposit_yen", info.depositYen);
    put("key_money_months", info.keyMoneyMonths);
    put("key_money_yen", info.keyMoneyYen);
    put("floor_plan", info.layout);
    put("area_sqm", info.areaSqm);
    put("room_no", info.room);
    put("address", info.address);
    if (info.stations && info.stations.length) d.stations = info.stations.slice(0, 5);
    put("walk_minutes", info.walkMin);
    put("built_ym", info.builtYm);
    put("building_age", info.buildingAge);
    put("total_floors", info.totalFloors);
    put("ad_months", info.adMonths);
    put("ad_yen", info.adYen);
    put("pdf_url", pdfUrl || null);
    return d;
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
      builtYm: b.builtYm, buildingAge: b.buildingAge, totalFloors: b.totalFloors,
      room: r.room, rentYen: r.rentYen, adminYen: r.adminYen, layout: r.layout, areaSqm: r.areaSqm,
      depositMonths: r.depositMonths, depositYen: r.depositYen, keyMoneyMonths: r.keyMoneyMonths, keyMoneyYen: r.keyMoneyYen,
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

  return { parseRoomText: parseRoomText, parseBuildingText: parseBuildingText, readFromButton: readFromButton, merge: merge, buildSummary: buildSummary, yenOf: yenOf, toPoolData: toPoolData };
});
