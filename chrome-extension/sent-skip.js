// chrome-extension/sent-skip.js（self.AxlxSentSkip・純関数・chrome.* を使わない）
// 一度そのお客様に送った部屋は、検索の一覧で選ばない（＝資料の PDF をダウンロードしない・読み取らない）。
//
// 2026-09-29 竹内「一度送ったことがある物件はダウンロードもしないようにすれば更に問題なく物件検索できる。人間の動きのように」
//
// 決まり（迷ったら飛ばさない＝新着を漏らさない）:
//   ・同じ部屋＝建物名が同じ（正規化して完全一致）かつ号室が同じ（先頭の 0 を落として一致）。どちらかが無い行は飛ばさない
//   ・同じ建物の別の部屋は別物（送ってよい）。名前が似ているだけ（Ⅱ と Ⅲ・「サウス」と「サウスタワー」）も飛ばさない
//   ・名前が読めない既定値（「物件」等）・1文字の名前は飛ばさない
//   ・スタッフモードでは飛ばさない（スタッフが選んで送る時は1件も減らさない＝サーバーの merge-pdfs と同じ）
//   サーバー（merge-pdfs）は今まで通り送る前に建物ごとに外す（こちらはその手前で「確実に同じ部屋」だけをダウンロードしない）。
// 名前の正規化は app/lib/property-name-match.ts normalizePropertyName・号室は sent-property-record.ts normalizeRoomNo の写し
//   （四者同名: tests/chrome-extension/sent-skip.test.js が TS の関数と同じ答えかを実物の名前で確かめる）
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AxlxSentSkip = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var STORAGE_KEY = "axlx_sent_rooms";
  /** 読んだ送付済みの部屋を信じる長さ（1人の検索は長くても 20分） */
  var TTL_MS = 30 * 60 * 1000;
  var UNUSABLE = { "物件": 1, "設備・詳細": 1, "詳細": 1, "お気に入り": 1, "印刷用pdf": 1, "図面": 1, "-": 1, "ー": 1, "―": 1 };

  function toHalf(s) {
    return String(s == null ? "" : s).replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); });
  }

  /** property-name-match.ts normalizePropertyName の写し */
  function normName(s) {
    var t = String(s == null ? "" : s).trim();
    if (!t) return "";
    t = t.replace(/^\s*(?:【\s*[0-9０-９]{1,2}\s*】|[①-⑳]|[0-9０-９]{1,2}\s*[.．)）])\s*/, "");
    t = toHalf(t);
    t = t.replace(/[・･、。,，（）()「」『』\[\]【】\-−ー_/／　\s]/g, "");
    return t.toLowerCase();
  }

  /** sent-property-record.ts normalizeRoomNo の写し（数字だけの号室は先頭の 0 を落とす・それ以外はそのまま） */
  function normRoom(raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return "";
    var m = s.match(/([0-9０-９]{1,5})\s*号?室?\s*$/);
    var digits = toHalf(m ? m[1] : s);
    var trimmed = digits.replace(/^0+(?=\d)/, "");
    return /^\d+$/.test(trimmed) ? trimmed : s;
  }

  function usableName(name) {
    var t = String(name == null ? "" : name).trim();
    if (!t || UNUSABLE[t.toLowerCase()]) return false;
    if (/^[\d\s,，.円万¥]+$/.test(t)) return false;
    return normName(t).length >= 2;
  }

  /** リアプロの一覧の行の先頭のセル（見出し「部屋名更新日」）「309 4日前 閲覧済」「0405 4時間前」→ 号室。無ければ null */
  function roomFromRealproCell(cell) {
    var s = String(cell == null ? "" : cell);
    s = s.normalize ? s.normalize("NFKC") : toHalf(s);
    var m = s.match(/^\s*([A-Za-z]?-?\d{1,5}[A-Za-z]?)(?=\s|$)/);
    return m ? m[1] : null;
  }

  /** 同じ行の「4日前」「4時間前」「30分前」→ 経過の日数（小数）。app/lib/search-update-days.ts ageDaysOfCell の写し */
  function ageDaysOfCell(cell) {
    var s = String(cell == null ? "" : cell);
    if (s.normalize) s = s.normalize("NFKC");
    var m = s.match(/(\d{1,4})\s*(分|時間|日|週間|ヶ月|か月|カ月)前/);
    if (!m) return null;
    var n = Number(m[1]);
    var u = m[2];
    var d = u === "分" ? n / 1440 : u === "時間" ? n / 24 : u === "日" ? n : u === "週間" ? n * 7 : n * 30;
    return isFinite(d) ? d : null;
  }

  /**
   * 引く時の号室の鍵（normRoom より厳しい）: 英字の付く号室（「A0205」「B101」「005B」）は英字ごと比べる
   *   （normRoom は末尾の数字だけを取るので「A0205」と「B0205」が同じ「205」になる＝別の棟の部屋を飛ばしてしまう。迷ったら飛ばさない）
   */
  function roomKey(room) {
    var s = toHalf(String(room == null ? "" : room)).replace(/\s+/g, "").replace(/号室?$/, "").toUpperCase();
    if (!s) return "";
    if (/[A-Z]/.test(s)) return s.replace(/(^|[^0-9])0+(?=\d)/g, "$1");
    return normRoom(room);
  }

  function key(name, room) {
    var n = normName(name), r = roomKey(room);
    if (!n || !r || !usableName(name)) return null;
    return n + "|" + r;
  }

  /** サーバーの一覧（[{name, room}]）→ 引く形。号室の無い行・名前の読めない行は入れない */
  function buildIndex(rooms) {
    var idx = {};
    var n = 0;
    (Array.isArray(rooms) ? rooms : []).forEach(function (x) {
      var k = x ? key(x.name, x.room) : null;
      if (k && !idx[k]) { idx[k] = String(x.name || "").slice(0, 60) + " " + String(x.room || ""); n++; }
    });
    return { map: idx, size: n };
  }

  /** その行（建物名・号室）が送付済みの部屋か。どちらかが無い・名前が読めない → false（飛ばさない） */
  function isSentRoom(index, name, room) {
    if (!index || !index.map) return false;
    var k = key(name, room);
    return !!(k && index.map[k]);
  }

  /** storage に置いた物が「このお客様の・新しい」物なら引く形を返す。違う・古い・スタッフモード → null（飛ばさない） */
  function indexFor(stored, customerId, nowMs) {
    if (!stored || typeof stored !== "object" || customerId == null) return null;
    if (String(stored.customerId) !== String(customerId)) return null;
    if (stored.staff) return null;
    var age = (Number(nowMs) || 0) - (Number(stored.at) || 0);
    if (!(age >= 0) || age > TTL_MS) return null;
    var idx = buildIndex(stored.rooms);
    return idx.size ? idx : null;
  }

  return {
    STORAGE_KEY: STORAGE_KEY, TTL_MS: TTL_MS,
    normName: normName, normRoom: normRoom, roomKey: roomKey, usableName: usableName,
    roomFromRealproCell: roomFromRealproCell, ageDaysOfCell: ageDaysOfCell,
    buildIndex: buildIndex, isSentRoom: isSentRoom, indexFor: indexFor,
  };
});
