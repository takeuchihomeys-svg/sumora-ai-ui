// chrome-extension/autorun-note.js（純関数・chrome.* を使わない）
// 2026-11-11 竹内さん「自動検索日によって何時にスタートされるかもUIに表示されていたらわかりやすい。
//   UIに表示されてわかりやすい部分はUIに表示するようにする」
//
// 何をするか: **次回の自動便（10:15〜11:15 / 16:15〜17:15）の開始予定**を人が読める1行にする。
//   計算はサーバーの app/lib/auto-search-schedule.ts と**同じ式**（日付と便で決まる乱数・前の日から7〜53分ずらす）。
//   サーバーが積む時刻（payload.not_before）と一致させるため、式を変える時は両方そろえる。
//
// 表示する事:
//   ・今日の午前の便 / 午後の便の開始予定（もう過ぎていたら「終わった」）
//   ・次に始まるのはどれか（「次は 16:23 ごろ」）
//   ・土日は止まる・昼休み（12〜13時）は動かない・夜（23時〜9時）は止まる
//
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AxlxAutoRunNote = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var DAY_MS = 86400_000;
  var START_WINDOWS = {
    am: { fromMin: 10 * 60 + 15, toMin: 11 * 60 + 15 },
    pm: { fromMin: 16 * 60 + 15, toMin: 17 * 60 + 15 },
  };
  var MIN_DAY_TO_DAY_DIFF_SEC = 7 * 60;
  var START_EPOCH_JST = "2026-01-01";

  function hash32(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  function seededRandom(seed) {
    var a = hash32(seed) || 0x9e3779b9;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function jstDayIndex(jstDate) {
    return Math.round((Date.parse(jstDate + "T00:00:00+09:00") - Date.parse(START_EPOCH_JST + "T00:00:00+09:00")) / DAY_MS);
  }
  /** その日・その便の開始の秒（窓の始まりから）。サーバーの startOffsetSec と同じ */
  function startOffsetSec(mode, jstDate) {
    var w = START_WINDOWS[mode];
    var span = (w.toMin - w.fromMin) * 60;
    var n = jstDayIndex(jstDate);
    var off = Math.floor(seededRandom("auto-search|" + mode + "|start")() * span);
    if (!isFinite(n) || n <= 0) {
      return n === 0 ? off : Math.floor(seededRandom("auto-search|" + mode + "|" + jstDate)() * span);
    }
    for (var k = 1; k <= n; k++) {
      var step = MIN_DAY_TO_DAY_DIFF_SEC + Math.floor(seededRandom("auto-search|" + mode + "|step|" + k)() * (span - 2 * MIN_DAY_TO_DAY_DIFF_SEC + 1));
      off = (off + step) % span;
    }
    return off;
  }
  /** その日・その便の開始時刻（UTC ミリ秒） */
  function autoStartAtMs(mode, jstDate) {
    var w = START_WINDOWS[mode];
    var windowStart = Date.parse(jstDate + "T00:00:00+09:00") + w.fromMin * 60_000;
    return windowStart + startOffsetSec(mode, jstDate) * 1000;
  }
  /** JST の日付（YYYY-MM-DD） */
  function jstDateOf(nowMs) {
    var j = new Date((typeof nowMs === "number" ? nowMs : Date.now()) + 9 * 3600 * 1000);
    return j.toISOString().slice(0, 10);
  }
  function jstParts(nowMs) {
    var j = new Date((typeof nowMs === "number" ? nowMs : Date.now()) + 9 * 3600 * 1000);
    return { day: j.getUTCDay(), hour: j.getUTCHours(), min: j.getUTCMinutes() };
  }
  function hhmm(ms) {
    var j = new Date(ms + 9 * 3600 * 1000);
    var h = j.getUTCHours(), m = j.getUTCMinutes();
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }

  /**
   * 次の自動便（開始予定）。土日は飛ばす。今日の残り→明日→…と7日先まで見る。
   * 返す: { mode, atMs, date, label } ／ 見つからなければ null
   */
  function nextAutoRun(nowMs) {
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    var base = jstDateOf(now);
    var baseMs = Date.parse(base + "T00:00:00+09:00");
    for (var d = 0; d < 8; d++) {
      var dateMs = baseMs + d * DAY_MS;
      var date = jstDateOf(dateMs);
      var p = jstParts(dateMs + 12 * 3600 * 1000);
      if (p.day === 0 || p.day === 6) continue; // 土日は動かない
      for (var i = 0; i < 2; i++) {
        var mode = i === 0 ? "am" : "pm";
        var at = autoStartAtMs(mode, date);
        if (at > now + 60_000) { // 1分以上先だけ「次」に数える
          return { mode: mode, atMs: at, date: date, label: hhmm(at) };
        }
      }
    }
    return null;
  }

  /**
   * 帯に出す1行（人が読める形）。
   *   例「🕒 自動検索: 次は今日 16:23 ごろ（午後の便）／今日の午前は 10:52 に終わりました」
   *      「🕒 自動検索: 次は 11/13(金) 10:41 ごろ（午前の便）／土日は止まります」
   */
  function noteLine(nowMs) {
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    var nx = nextAutoRun(now);
    var today = jstDateOf(now);
    var p = jstParts(now);
    var parts = [];
    if (nx) {
      var isToday = nx.date === today;
      var isTomorrow = nx.date === jstDateOf(now + DAY_MS);
      var when = isToday ? "今日" : isTomorrow ? "明日" : (function () {
        var j = new Date(nx.atMs + 9 * 3600 * 1000);
        var wd = ["日", "月", "火", "水", "木", "金", "土"][j.getUTCDay()];
        return (j.getUTCMonth() + 1) + "/" + j.getUTCDate() + "(" + wd + ")";
      })();
      parts.push("次は " + when + " " + nx.label + " ごろ（" + (nx.mode === "am" ? "午前" : "午後") + "の便）");
    }
    // 今日の2回の予定（もう過ぎた物は「終わった」）
    var todayAm = autoStartAtMs("am", today);
    var todayPm = autoStartAtMs("pm", today);
    var doneToday = [];
    if (todayAm < now) doneToday.push("午前 " + hhmm(todayAm));
    if (todayPm < now) doneToday.push("午後 " + hhmm(todayPm));
    if (doneToday.length) parts.push("今日の" + doneToday.join("・") + " は終わり");
    // いま止まっている理由（あれば）
    if (p.day === 0 || p.day === 6) parts.push("土日は止まります");
    else if (p.hour >= 12 && p.hour < 13) parts.push("いまは昼休み（13:00まで）");
    else if (p.hour >= 23 || p.hour < 9) parts.push("いまは夜（9:00から）");
    return "🕒 自動検索: " + parts.join("／");
  }

  return {
    START_WINDOWS: START_WINDOWS,
    startOffsetSec: startOffsetSec,
    autoStartAtMs: autoStartAtMs,
    nextAutoRun: nextAutoRun,
    noteLine: noteLine,
    jstDateOf: jstDateOf,
    hhmm: hhmm,
  };
});
