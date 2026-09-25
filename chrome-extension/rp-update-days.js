// chrome-extension/rp-update-days.js
// リアプロの「更新日」（N日以内）をお客様ごとに1つに決める純関数（background.js の一括検索が使う）。
// ⚠ app/lib/rp-update-days.ts（＋ auto-search-schedule.ts の lastPropertyTouchAt / rpUpdateDaysFor）の写し。
//   app/lib/__tests__/rp-update-days.test.ts が2つの答えが一字一句同じことを確かめる（直したら両方直す）。
//
// 2026-09-25 竹内「更新日も拡張ツールと連動」:
//   手で決めた値（rp_update_days・拡張の更新日の select／ウェブの切替で書く）→ 無ければ前回そのお客様に物件を出した日
//   （送った日 last_property_sent_at と確認した日 property_viewed_at の新しい方・JST の日付）から 1/3/7/14。初めては null（絞らない）。
//   popup.js の preloadAdjForm（c.rp_update_days || calcUpdateDays(lastPropertyTouchDateJst(c))）と同じ線。
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (root) { root.AxlxRpUpdateDays = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var DAY_MS = 86400000;

  function jstDateStr(ms) { return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10); }

  // 前回から何日か（JST の日付で数える）。読めなければ null
  function jstDaysSince(iso, nowMs) {
    if (!iso) return null;
    var t = Date.parse(iso);
    if (!isFinite(t)) return null;
    var a = Date.parse(jstDateStr(t) + "T00:00:00+09:00");
    var b = Date.parse(jstDateStr(nowMs) + "T00:00:00+09:00");
    return Math.round((b - a) / DAY_MS);
  }

  // 送った日と確認した日の新しい方
  function lastPropertyTouchAt(c) {
    var s = c && c.last_property_sent_at ? Date.parse(c.last_property_sent_at) : NaN;
    var v = c && c.property_viewed_at ? Date.parse(c.property_viewed_at) : NaN;
    var okS = isFinite(s), okV = isFinite(v);
    if (!okS && !okV) return null;
    if (okS && okV) return s >= v ? c.last_property_sent_at : c.property_viewed_at;
    return okS ? c.last_property_sent_at : c.property_viewed_at;
  }

  function rpUpdateDaysFor(iso, nowMs) {
    var d = jstDaysSince(iso, nowMs);
    if (d === null) return null;
    if (d <= 1) return 1;
    if (d <= 3) return 3;
    if (d <= 7) return 7;
    return 14;
  }

  function manualRpUpdateDays(c) {
    var v = c ? c.rp_update_days : null;
    return typeof v === "number" && isFinite(v) && v > 0 ? v : null;
  }

  function autoRpUpdateDays(c, nowMs) {
    if (!c) return null;
    return rpUpdateDaysFor(lastPropertyTouchAt(c), typeof nowMs === "number" ? nowMs : Date.now());
  }

  function effectiveRpUpdateDays(c, nowMs) {
    var m = manualRpUpdateDays(c);
    return m !== null ? m : autoRpUpdateDays(c, nowMs);
  }

  return {
    manualRpUpdateDays: manualRpUpdateDays,
    autoRpUpdateDays: autoRpUpdateDays,
    effectiveRpUpdateDays: effectiveRpUpdateDays,
  };
});
