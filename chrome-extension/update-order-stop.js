// chrome-extension/update-order-stop.js（self.AxlxUpdateOrderStop・純関数・chrome.* を使わない）
// 2026-09-30 v2.5.43 竹内「前に送った物件かどうかは検索のページ一覧を監視していたら分かるのでは？それで前と同じ物件なら入れない形にすれば問題ない。
//   更新順で検索していたら、その更新順以降は見なくて大丈夫」
//
// 更新日順（新しい順）で並んでいる一覧では、行の更新日が「そのお客様×サイトの前回の検索の時刻」より古くなった行で止める。
//   以降の行は選ばず、次のページも開かない（ページの上限 5 より前に自然に終わる＝サイトへのアクセスが減る）。
//   ⚠ 止めるのは「前回の検索より古い行」であって「送付済みの行」ではない。送付済みでも新しく更新された部屋は見る（送付済みの飛ばしは sent-skip.js のまま）。
//
// 前回の検索の時刻の出所: サーバーの更新日の計画（payload.update_days_plan.by_customer[id]）の last_by_site[サイト]（無ければ止めない・前回の検索の後に条件が変わったサイトはサーバーが入れない）
//   ＝ app/lib/search-update-days(-server).ts の「そのお客様×サイトで最後に終わった回（search_audits finished・失敗なし）の開始時刻」と同じ出所。
//   background が auto-run.js の record に last_search_at として乗せ、bulk-dl／itandi-bulk-dl が forCustomer で読む。
//
// 行の更新日の読み方（newestPossibleMs）: 表示は切り捨て（「2時間前」＝2時間〜3時間前）なので、**一番新しくあり得る時刻**で比べる（狭い側に読まない）。
//   ・「N分前」「N時間前」→ 今から N 単位前
//   ・「N日前」→ 暦の日で数えている可能性があるので (N-1) 日前（「1日前」は 0 日前＝止める材料にしない）。「N週間前」「Nヶ月前」も同じ考えで 1日引く
//   ・絶対の日付「2026/09/29 12:34」「2026/09/29」（ITANDI の更新日の欄・「更新」の語の近くにある物だけ）→ 時刻があればその時刻・無ければその日の 23:59:59（JST）
//   ・読めない → null（その行は比べない・止めない）
// 止める条件（decideStop）: 前回の時刻がある・並びが更新日順（リアプロは URL の key で決める・ITANDI は並びが未確認なので、読めた行が
//   MIN_ROWS_FOR_INFERRED_ORDER 行以上そろって単調（新しい→古い）の時だけ「更新日順」とみなす）・読めた行がここまで単調・
//   その行の一番新しくあり得る時刻 < 前回の時刻 − 余裕（GRACE_MS 30分＝時計のずれ・表示の丸め）。
//   途中で単調でない行（前の行より新しい）が出たら、この回はもう止めない（並びが更新日順でない）。
//   境界: 同じ時刻・少し新しい行は止めない（次の行で確かめる）。
// 読めない時・前回の時刻が分からない時・AD 順など更新日順でない時は今まで通り（ページの上限まで）。
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AxlxUpdateOrderStop = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var MIN_MS = 60 * 1000, HOUR_MS = 60 * MIN_MS, DAY_MS = 24 * HOUR_MS;
  /** 前回の時刻との余裕（時計のずれ・表示の丸め）。これより古い行だけ止める */
  var GRACE_MS = 30 * MIN_MS;
  /** 並びが分からないサイト（ITANDI）で「更新日順」とみなすのに要る、読めて単調な行の数 */
  var MIN_ROWS_FOR_INFERRED_ORDER = 10;
  var JST_OFFSET_MS = 9 * HOUR_MS;

  function nfkc(s) { try { return String(s == null ? "" : s).normalize("NFKC"); } catch (_) { return String(s == null ? "" : s); } }

  /** 「N分前」「N時間前」「N日前」… → 一番新しくあり得る時刻（ms）。無ければ null */
  function relativeNewestMs(text, nowMs) {
    var s = nfkc(text);
    var m = s.match(/(\d{1,4})\s*(分|時間|日|週間|ヶ月|か月|カ月|ケ月)前/);
    if (!m) return null;
    var n = Number(m[1]);
    if (!isFinite(n) || n < 0) return null;
    var u = m[2];
    var back;
    if (u === "分") back = n * MIN_MS;
    else if (u === "時間") back = n * HOUR_MS;
    else if (u === "日") back = Math.max(0, n - 1) * DAY_MS;
    else if (u === "週間") back = Math.max(0, n * 7 - 1) * DAY_MS;
    else back = Math.max(0, n * 30 - 1) * DAY_MS;
    return nowMs - back;
  }

  /** JST の年月日（と時分）→ ms。時分が無ければその日の 23:59:59 */
  function jstMs(y, mo, d, h, mi) {
    var hasTime = h != null && mi != null;
    var t = Date.UTC(y, mo - 1, d, hasTime ? h : 23, hasTime ? mi : 59, hasTime ? 0 : 59) - JST_OFFSET_MS;
    return isFinite(t) ? t : null;
  }

  /**
   * 「更新」の見出し（ITANDI の行の全文から、入居可能日・築年月・「更新料」の日付や数字を拾わないための入口）。
   *   「更新料」「更新事務手数料」は見出しではない（「更新」の後ろが「料／事務／手数」なら読まない）
   */
  var UPDATE_LABEL_RE = /(?:最終|情報|掲載|募集条件)?更新(?:日時|日)?(?!料|事務|手数)\s*[:：]?\s*/g;
  var RELATIVE_BEFORE_LABEL_RE = /(\d{1,4})\s*(分|時間|日|週間|ヶ月|か月|カ月|ケ月)前\s*(?:に)?更新(?!料|事務|手数)/;

  /** 見出しのすぐ後ろ（20文字）の文字。見出しが無ければ null */
  function afterLabel(s) {
    UPDATE_LABEL_RE.lastIndex = 0;
    var m = UPDATE_LABEL_RE.exec(s);
    UPDATE_LABEL_RE.lastIndex = 0;
    if (!m) return null;
    return s.slice(m.index + m[0].length, m.index + m[0].length + 20);
  }

  /**
   * 絶対の日付 → 一番新しくあり得る時刻（ms）。requireLabel の時は「更新」の見出しのすぐ後ろ（先頭から）にある日付だけ読む
   *   「2026/09/29 12:34」「2026-09-29」「2026年9月29日」「09/29 12:34」（年なし＝今年・未来なら去年）
   */
  function absoluteNewestMs(text, nowMs, requireLabel) {
    var s = nfkc(text);
    var src = s;
    if (requireLabel) {
      src = afterLabel(s);
      if (src == null) return null;
    }
    var m = requireLabel
      ? src.match(/^(20\d{2})[\/\-.年]\s*(\d{1,2})[\/\-.月]\s*(\d{1,2})日?(?:[\sT]+(\d{1,2}):(\d{2}))?/)
      : src.match(/(20\d{2})[\/\-.年]\s*(\d{1,2})[\/\-.月]\s*(\d{1,2})日?(?:[\sT]+(\d{1,2}):(\d{2}))?/);
    if (m) return jstMs(Number(m[1]), Number(m[2]), Number(m[3]), m[4] != null ? Number(m[4]) : null, m[5] != null ? Number(m[5]) : null);
    m = requireLabel
      ? src.match(/^()(\d{1,2})[\/月]\s*(\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?(?![\d\/])/)
      : src.match(/(^|[^\d\/])(\d{1,2})[\/月]\s*(\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?(?![\d\/])/);
    if (m) m = [m[0], m[2], m[3], m[4], m[5]];
    if (m) {
      var now = new Date(nowMs + JST_OFFSET_MS);
      var y = now.getUTCFullYear();
      var t = jstMs(y, Number(m[1]), Number(m[2]), m[3] != null ? Number(m[3]) : null, m[4] != null ? Number(m[4]) : null);
      if (t != null && t > nowMs + DAY_MS) t = jstMs(y - 1, Number(m[1]), Number(m[2]), m[3] != null ? Number(m[3]) : null, m[4] != null ? Number(m[4]) : null);
      return t;
    }
    return null;
  }

  /**
   * 行の文字 → 一番新しくあり得る更新の時刻（ms）。読めなければ null。
   * opts.requireLabel: true なら「更新」の見出しの近くにある物だけ読む（ITANDI の行の全文＝入居可能日・築年月・更新料を拾わない）:
   *   「3日前に更新」「更新日 3日前」「最終更新: 2026/09/29」「更新日 09/29」
   */
  function newestPossibleMs(text, nowMs, opts) {
    var o = opts || {};
    var s = nfkc(text);
    if (!s) return null;
    if (o.requireLabel) {
      var rb = s.match(RELATIVE_BEFORE_LABEL_RE);
      if (rb) return relativeNewestMs(rb[0], nowMs);
      var near = afterLabel(s);
      if (near == null) return null;
      if (/^\d{1,4}\s*(分|時間|日|週間|ヶ月|か月|カ月|ケ月)前/.test(near)) return relativeNewestMs(near, nowMs);
      return absoluteNewestMs(s, nowMs, true);
    }
    var r = relativeNewestMs(s, nowMs);
    if (r != null) return r;
    return absoluteNewestMs(s, nowMs, false);
  }

  /** リアプロの一覧の URL → 並び（key が無い＝既定＝更新順・key=ad＝AD 順・他は other） */
  function orderOfRealproUrl(url) {
    var u = String(url || "");
    var q = u.indexOf("?") >= 0 ? u.slice(u.indexOf("?") + 1) : "";
    var key = null;
    q.split("&").forEach(function (kv) {
      var p = kv.split("=");
      if (p[0] === "key") key = decodeURIComponent(p[1] || "");
    });
    if (!key) return "updated";
    if (key === "ad") return "ad";
    if (/upd|renew|new|date|time/i.test(key)) return "updated";
    return "other";
  }

  /**
   * bulk-dl が使う並び。URL に key=ad → "ad"。自動便の指定が「更新順」（opts.sort==="updated"）で URL が更新順 → "updated"。
   *   それ以外（key の無い既定の並び・指定なし）は並びを信じず "unknown"（読めた行が MIN_ROWS_FOR_INFERRED_ORDER 行以上そろって
   *   新しい→古いの時だけ更新順とみなす）。bulk-dl は多くの回で AD 高い順に並べ替える（allowAdSort）＝その回は止めない
   */
  function orderForRealpro(url, opts) {
    var o = orderOfRealproUrl(url);
    if (o === "ad" || o === "other") return o;
    var explicitKey = /[?&]key=/.test(String(url || ""));
    if (opts && opts.sort === "updated") return "updated";
    return explicitKey ? o : "unknown";
  }

  /**
   * 更新日の計画のそのお客様の分 → このサイトの前回の検索の時刻（ISO）。last_by_site[site] だけ（無ければ null＝止めない）。
   *   last_search_at（両サイトの古い方）には頼らない: サーバーは「前回の検索の後に条件が変わったサイト」を last_by_site から外している
   *   （search-update-days.ts stopLinesBySite）。last_search_at はその見分けをしていない＝使うと条件を変えた後の新しい条件で初めて見る行を止め得る。
   *   古いサーバーが積んだ命令（last_by_site が無い）・広げての回（search-widen-chain は last_search_at=null）も止めない
   */
  function lastSearchFor(entry, site) {
    if (!entry || typeof entry !== "object") return null;
    var k = site === "realnetpro" || site === "realpro" ? "realpro" : site === "itandi" ? "itandi" : null;
    var by = entry.last_by_site;
    if (k && by && typeof by === "object" && by[k]) return String(by[k]);
    return null;
  }

  /** 持ち越し（ページをまたぐ）の初期値 */
  function initCarry() {
    return { prevNewest: null, readable: 0, monotonic: true, stopped: null };
  }

  /**
   * このページの行で止める所を決める。
   * @param {object} i { rows: [{ newest: ms|null, text }], lastSearchMs, nowMs, order: "updated"|"ad"|"other"|"unknown", carry, page, graceMs }
   * @returns {{ stopIndex: number, reason: string, carry }}  stopIndex は -1（止めない）か、止める最初の行（この行から先は選ばない）
   */
  function decideStop(i) {
    var o = i || {};
    var rows = Array.isArray(o.rows) ? o.rows : [];
    var carry = Object.assign(initCarry(), o.carry || {});
    var grace = o.graceMs != null ? Number(o.graceMs) : GRACE_MS;
    var last = Number(o.lastSearchMs);
    var order = o.order || "unknown";
    var res = { stopIndex: -1, reason: "", carry: carry };
    if (carry.stopped) { res.reason = "already_stopped"; return res; }
    if (!isFinite(last) || !(last > 0)) { res.reason = "no_last_search"; return _scan(rows, carry, res, null, false); }
    if (order === "ad" || order === "other") { res.reason = "not_update_order:" + order; return _scan(rows, carry, res, null, false); }
    var allowByOrder = order === "updated";
    return _scan(rows, carry, res, last - grace, allowByOrder, order);
  }

  // 行を順に読み、単調（新しい→古い）を確かめながら、線より古い最初の行で止める
  function _scan(rows, carry, res, lineMs, allowByOrder, order) {
    for (var k = 0; k < rows.length; k++) {
      var r = rows[k] || {};
      var t = r.newest != null ? Number(r.newest) : null;
      if (t == null || !isFinite(t)) continue; // 読めない行は比べない
      if (carry.prevNewest != null && t > carry.prevNewest) {
        // 前の行より新しい＝並びが更新日順でない → この回はもう止めない
        carry.monotonic = false;
      }
      carry.prevNewest = t;
      carry.readable++;
      if (lineMs == null || !carry.monotonic) continue;
      var orderOk = allowByOrder || (order === "unknown" && carry.readable >= MIN_ROWS_FOR_INFERRED_ORDER);
      if (!orderOk) continue;
      if (t < lineMs) {
        res.stopIndex = k;
        res.reason = "older_than_last_search";
        carry.stopped = { index: k, page: null, row_text: String(r.text || "").slice(0, 60), newest_at: new Date(t).toISOString(), inferred_order: order === "unknown" };
        return res;
      }
    }
    if (!res.reason) res.reason = carry.monotonic ? "all_newer" : "not_sorted";
    return res;
  }

  /** 点検（result.stopped_at_last_search）に残す形 */
  function stopRecord(carry, page, lastSearchIso, site) {
    var s = carry && carry.stopped;
    if (!s) return null;
    return { site: site || null, page: page != null ? page : null, index: s.index, row_text: s.row_text, newest_at: s.newest_at, last_search_at: lastSearchIso || null, inferred_order: !!s.inferred_order };
  }

  /** ★物件出し★・ログの1行 */
  function describeStop(rec) {
    if (!rec) return null;
    var SITE_JA = { realpro: "リアプロ", realnetpro: "リアプロ", itandi: "itandi" };
    var last = rec.last_search_at ? String(rec.last_search_at).slice(0, 16).replace("T", " ") : "?";
    return "更新順で前回の検索（" + last + "）より古い行で止めた（" + (SITE_JA[rec.site] || rec.site || "") + (rec.page != null ? " " + rec.page + "ページ目" : "") + "・行「" + (rec.row_text || "") + "」）";
  }

  return {
    GRACE_MS: GRACE_MS, MIN_ROWS_FOR_INFERRED_ORDER: MIN_ROWS_FOR_INFERRED_ORDER,
    newestPossibleMs: newestPossibleMs, relativeNewestMs: relativeNewestMs, absoluteNewestMs: absoluteNewestMs,
    orderOfRealproUrl: orderOfRealproUrl, orderForRealpro: orderForRealpro, lastSearchFor: lastSearchFor, initCarry: initCarry, decideStop: decideStop, stopRecord: stopRecord, describeStop: describeStop,
  };
});
