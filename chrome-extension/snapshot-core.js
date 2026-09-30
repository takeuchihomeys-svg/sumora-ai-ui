// chrome-extension/snapshot-core.js
// 拡張の「今の画面」（画面の写真＋ページの文字＋拡張の状態）と、一括検索の見張り（時間切れ）の決まり。self.AxlxSnapshotCore。
//
// 2026-09-29 v2.5.40 竹内「ブレインのAIX検索モードが隼斗さんで止まってしまっている。なぜ固まっているのか」
//   「拡張ツールでひらいているページの画面をみて判断できる事もできるのか？ …画面開いているのも目で見ることができるのが理想」
//   調べると検索は 10:57 に正常に終わっていて、帯（score-overlay の「隼斗: 家賃〜10.5万…」）が消されずに残っていただけ。
//   16:32 の午後の便の見送りは v2.5.38 より前の拡張（再読み込みしていない PC）の動き。どちらも「その PC が今どの版で何をしているか」
//   が分かれば画面を見る前に分かった → 心拍（版・モード・実行中の回）と、止まった時／頼まれた時の画面の写真を置く。
//
// 決まり（テスト: tests/chrome-extension/snapshot-core.test.js）:
//   ・止まりの見張り: 一括の回が動いていて、6分（bulk-dl の無進捗5分より少し長い）進みが無い → 撮る（同じ回×お客様×サイトで1回だけ）
//   ・撮る回数: PC ごとに1日20回まで・同じきっかけは3分に1回まで（頼まれた時は上限を見ない）
//   ・撮り方: 前に出ているタブはそのまま撮る。裏のタブはスタッフモードでない PC だけ前に出して撮り、元に戻す（activated_for_capture に残す）。
//     最小化の窓・許可（<all_urls>）が無い時は撮らない（ページの文字と拡張の状態だけ送る）
//   ・ページの文字は content script（この1ファイルの下の受け口）で取る。サイトへのアクセスは増えない（読み込み直し・クリックはしない）
//   ・1回の検索（お客様×サイト×パス）の上限（PASS_DEADLINE_MS）を過ぎたら、その回を「見張りの時間切れ」で閉じて次のお客様へ進む
//   ・2026-09-29 見張り（サーバー app/lib/screen-watch*.ts）: readDom に件数の数（count_number）と写真で塗る位置（mask_rects＝拡張の要素 axlx-・画面の大きさ viewport）。
//     watchStopApplies＝サーバーの stop_site（ログイン切れ・サイトのエラー）が次のお客様に効くか（2時間・サイトの呼び名はそろえる）。watchBody＝見張りに送る本文
// 読み込む所: background.js（import）・manifest の content_scripts（3サイト・document_start）
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (root) { root.AxlxSnapshotCore = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var STALL_MS = 6 * 60 * 1000;
  var DAILY_MAX = 20;
  var SAME_TRIGGER_GAP_MS = 3 * 60 * 1000;
  var LOG_MAX = 80;
  var LOG_LINE_MAX = 300;
  var CAPTURE_SETTLE_MS = 800;  // 裏のタブを前に出してから撮るまで
  var CAPTURE_GAP_MS = 600;     // captureVisibleTab は1秒に2回まで
  var IMAGE_MAX_WIDTH = 1280;
  var IMAGE_MAX_BYTES = 1200 * 1024; // サーバーの上限（extension-snapshots.ts の IMAGE_MAX_BYTES）と同じ
  var TOTAL_IMAGE_MAX_BYTES = 3000000; // 合計（base64 で 4.0MB＝Vercel の本文 4.5MB に収まる・extension-snapshots.ts と同じ）
  var RUN_STATE_TTL_MS = 15 * 60 * 1000; // background の BATCH_LOCK_TTL_MS と同じ（これより古い「実行中」は信じない）
  // 1回の検索（お客様×サイト×パス）の上限。fill-done（リアプロ90秒・itandi 245秒）＋全ページの送信（無進捗5分で延長）が収まる長さ。
  //   これを過ぎるのは「進みの合図は来るのに終わらない」「応答の無い待ち」＝固まり。ロックの15分は進みのたびに延ばす（background）
  var PASS_DEADLINE_MS = { realnetpro: 20 * 60 * 1000, itandi: 25 * 60 * 1000, reins: 8 * 60 * 1000 };
  var TRIGGERS = ["stall", "pass_deadline", "waiter_timeout", "fill_timeout", "request", "run_end"];
  var SITE_ORDER = ["realpro", "itandi", "reins"];
  var SITE_JA = { realpro: "リアプロ", realnetpro: "リアプロ", itandi: "itandi", reins: "レインズ" };

  function siteOfUrl(url) {
    var u = String(url || "");
    var m = u.match(/^https?:\/\/([^\/?#]+)/i);
    if (!m) return null;
    var h = m[1].toLowerCase();
    if (h === "realnetpro.com" || /\.realnetpro\.com$/.test(h)) return "realpro";
    if (h === "itandibb.com" || /\.itandibb\.com$/.test(h)) return "itandi";
    if (/(^|\.)reins\.jp$/.test(h)) return "reins";
    return null;
  }

  // JST の日付（1日の上限の数え直し）
  function dayKey(now) {
    return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  function hhmm(ms) {
    if (!ms) return "";
    var d = new Date(ms + 9 * 60 * 60 * 1000);
    var h = d.getUTCHours(), m = d.getUTCMinutes();
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }

  // 同じ回×お客様×サイト×パスの鍵（止まりの写真は1つの鍵で1回だけ）
  function stallKey(w) {
    if (!w) return "";
    return [w.commandId || "-", w.customerId || "-", w.site || "-", w.pass || "-"].join("|");
  }

  // 止まりの見張り: st = { running, lastProgressAt, key, snappedKeys }
  function shouldSnapStall(st, now) {
    var s = st || {};
    if (!s.running) return { snap: false, reason: "idle" };
    if (!s.lastProgressAt) return { snap: false, reason: "no_progress_info" };
    var idle = now - s.lastProgressAt;
    if (idle < STALL_MS) return { snap: false, reason: "moving", idle_ms: idle };
    if (s.key && Array.isArray(s.snappedKeys) && s.snappedKeys.indexOf(s.key) >= 0) return { snap: false, reason: "already", idle_ms: idle };
    return { snap: true, reason: "stall", idle_ms: idle };
  }

  // 撮る回数の上限。hist = { day, count, last: {trigger: ms} }。戻り値の hist を保存する（元は変えない）
  function rateGate(hist, trigger, now) {
    var day = dayKey(now);
    var h = hist && hist.day === day
      ? { day: day, count: hist.count || 0, last: Object.assign({}, hist.last || {}) }
      : { day: day, count: 0, last: {} };
    var requested = trigger === "request";
    if (!requested && h.count >= DAILY_MAX) return { ok: false, reason: "daily_limit", hist: h };
    if (!requested && h.last[trigger] && now - h.last[trigger] < SAME_TRIGGER_GAP_MS) return { ok: false, reason: "too_soon", hist: h };
    h.count += 1;
    h.last[trigger] = now;
    return { ok: true, reason: null, hist: h };
  }

  // 撮るタブ: サイトごとに1つ（前に出ているタブ → 最後に触ったタブ）・リアプロ／itandi／レインズの順
  function pickTabs(tabs) {
    var best = {};
    (tabs || []).forEach(function (t) {
      var s = t ? siteOfUrl(t.url) : null;
      if (!s) return;
      var cur = best[s];
      if (!cur) { best[s] = t; return; }
      if (t.active && !cur.active) { best[s] = t; return; }
      if (t.active === cur.active && (t.lastAccessed || 0) > (cur.lastAccessed || 0)) best[s] = t;
    });
    return SITE_ORDER.filter(function (s) { return !!best[s]; }).map(function (s) { return { site: s, tab: best[s] }; });
  }

  // 撮り方: visible（前に出ているのでそのまま）／activate（前に出して撮り元に戻す）／none（撮らない）
  function capturePlan(tab, win, opts) {
    var o = opts || {};
    if (!o.canCapture) return { how: "none", reason: "no_permission" };
    if (!tab) return { how: "none", reason: "no_tab" };
    if (!win || win.state === "minimized") return { how: "none", reason: "minimized" };
    if (tab.active) return { how: "visible", reason: null };
    // スタッフが使っている PC は画面を動かさない（人の作業を邪魔しない）
    if (o.staffMode) return { how: "none", reason: "background_tab_staff" };
    if (o.allowActivate === false) return { how: "none", reason: "background_tab" };
    return { how: "activate", reason: null };
  }

  function stringifyArg(a) {
    if (a == null) return String(a);
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.message || String(a);
    if (typeof a === "object") {
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }
    return String(a);
  }

  function logLine(level, args, now) {
    var parts = [];
    for (var i = 0; i < (args ? args.length : 0); i++) parts.push(stringifyArg(args[i]));
    return { t: now, l: level, m: parts.join(" ").slice(0, LOG_LINE_MAX) };
  }

  function trimLog(buf, max) {
    var m = typeof max === "number" ? max : LOG_MAX;
    var b = Array.isArray(buf) ? buf : [];
    return b.length > m ? b.slice(b.length - m) : b.slice();
  }

  // 帯（score-overlay）の状態の札。meta = { at }（条件を書いた時刻）/ run = { running, at, customerName, site }
  //   一括の回が動いている時だけ「一括検索中」。それ以外は「待機中・最終の条件 hh:mm」＝この帯は今のページの検索と関係ない
  function bandStatus(meta, run, now) {
    var running = !!(run && run.running && run.at && now - run.at < RUN_STATE_TTL_MS);
    if (running) {
      var who = run.customerName ? "（" + run.customerName + "・" + (SITE_JA[run.site] || run.site || "") + "）" : "";
      return { state: "running", label: "▶ 一括検索中" + who };
    }
    var at = meta && meta.at;
    return { state: "idle", label: at ? "待機中・最終の条件 " + hhmm(at) : "待機中（前回の条件）" };
  }

  function passDeadlineMs(site) {
    return PASS_DEADLINE_MS[site] || PASS_DEADLINE_MS.realnetpro;
  }

  // 止まった理由の1行（ログ・命令の error_message・写真の stall に同じ文）
  function describeStall(w, now, kind) {
    if (!w) return "一括の回の記録が無い（拡張の作り直し等でロックだけ残っている可能性）";
    var who = (w.customerName || w.customerId || "?") + "さん・" + (SITE_JA[w.site] || w.site || "?") + (w.pass ? "・" + w.pass : "");
    var idleMin = w.lastProgressAt ? Math.round((now - w.lastProgressAt) / 60000) : null;
    var tookMin = w.passStartedAt ? Math.round((now - w.passStartedAt) / 60000) : null;
    var head = kind === "pass_deadline" ? "見張りの時間切れ（" + (tookMin != null ? tookMin + "分" : "?") + "）" : "動きなし" + (idleMin != null ? idleMin + "分" : "");
    return head + ": " + who + "・待っていた物=" + (w.waitingFor || "?") + (w.lastEvent ? "・最後の合図=" + w.lastEvent : "");
  }

  // 心拍の中身（サーバーの x-snap-state・extension-snapshots.ts sanitizeHeartbeat と同じ名前）
  function heartbeatState(o) {
    var x = o || {};
    return {
      ext_version: x.extVersion || null,
      mode: x.mode || null,
      device_label: x.deviceLabel || null,
      batch_running: !!x.batchRunning,
      batch_command_id: x.batchCommandId || null,
      batch_started_at: x.batchStartedAt || null,
      last_progress_at: x.lastProgressAt || null,
      current_customer_id: x.customerId || null,
      current_site: x.site || null,
      waiting_for: x.waitingFor ? String(x.waitingFor).slice(0, 120) : null,
      can_capture: !!x.canCapture,
      staff_mode: !!x.staffMode,
    };
  }

  // 動作モードの札（brain_aix / aix / brain_normal / normal / brain_staff / staff）
  function modeKey(state) {
    if (!state) return null;
    var m = state.mode || "normal";
    return (state.brain ? "brain_" : "") + m;
  }

  function bytesToBase64(u8) {
    var CH = 0x8000;
    var s = "";
    for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }

  // 縮小後の大きさ（幅だけ見る）
  function scaledSize(w, h, maxW) {
    var mw = maxW || IMAGE_MAX_WIDTH;
    if (!w || !h || w <= mw) return { w: w, h: h };
    return { w: mw, h: Math.round(h * mw / w) };
  }

  // ── ページの文字（content script の中で呼ぶ・doc はテストでは作り物） ──
  function clip(s, n) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n); }

  function visible(el) {
    if (!el) return false;
    if (el.hidden) return false;
    try {
      var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (r && (r.width === 0 || r.height === 0)) return false;
    } catch (_) {}
    return true;
  }

  var PAGE_RE = /(\d+\s*[\/／]\s*\d+\s*ページ|\d+\s*ページ目|ページ\s*\d+\s*[\/／]\s*\d+)/;
  var COUNT_RE = /(該当(?:する)?物件(?:は|が)?\s*(?:ありません|見つかりません|0\s*件)|検索結果\s*[:：]?\s*[\d,]+\s*件|該当\s*[:：]?\s*[\d,]+\s*件|全\s*[\d,]+\s*件|[\d,]+\s*件中|[\d,]+\s*棟|[\d,]+\s*件\s*(?:見つかりました|ヒット))/;
  var ALERT_RE = /(ログイン(?:して|が必要|画面)|セッション(?:が切れ|の有効期限)|タイムアウト|エラーが発生|アクセスが集中|メンテナンス)/;
  var MODAL_SEL = "[role=dialog], [aria-modal=true], .modal.show, .modal.in, .MuiDialog-root, .MuiModal-root, .ui-dialog, .swal2-popup";
  // 2026-09-29 見張り: 拡張が画面に足した要素（帯・一括DLの帯・点数の札。お客様の名前がページに出るのはこれらだけ）＝写真では塗る
  var MASK_SEL = "[id^='axlx-'], [class^='axlx-'], [class*=' axlx-']";
  var MASK_MAX = 20;

  // 件数の文 → 数（「該当物件はありません」＝0・「16,042棟」＝16042・「検索結果 1,234件中」＝1234）。読めなければ null
  function countNumberOf(text) {
    var t = String(text == null ? "" : text);
    if (!t) return null;
    if (/ありません|見つかりません/.test(t)) return 0;
    var m = t.match(/([\d,]+)\s*(?:件|棟)/);
    if (!m) return null;
    var n = Number(m[1].replace(/,/g, ""));
    return isFinite(n) ? n : null;
  }

  // 塗る位置（CSS の px・画面の左上から）→ 写真の px（縮めた後の幅・高さ）。はみ出しは切る・少し広めに（2px）
  function maskRectsScaled(rects, viewport, imgW, imgH) {
    if (!Array.isArray(rects) || !rects.length || !viewport || !viewport.w || !viewport.h || !imgW || !imgH) return [];
    var sx = imgW / viewport.w, sy = imgH / viewport.h, out = [];
    for (var i = 0; i < rects.length && i < MASK_MAX; i++) {
      var r = rects[i];
      if (!r || !(r.w > 0) || !(r.h > 0)) continue;
      var x = Math.max(0, Math.floor(r.x * sx) - 2), y = Math.max(0, Math.floor(r.y * sy) - 2);
      var x2 = Math.min(imgW, Math.ceil((r.x + r.w) * sx) + 2), y2 = Math.min(imgH, Math.ceil((r.y + r.h) * sy) + 2);
      if (x2 > x && y2 > y) out.push({ x: x, y: y, w: x2 - x, h: y2 - y });
    }
    return out;
  }

  // 見張りの「止める」（サーバーの答え stop_site）が、このサイトの次のお客様に効くか（2時間まで・サイトの呼び名はそろえて比べる）
  var WATCH_STOP_TTL_MS = 2 * 60 * 60 * 1000;
  function siteNorm(s) {
    var v = String(s || "").toLowerCase();
    if (v === "realnetpro" || v === "realpro" || v === "リアプロ") return "realpro";
    if (v === "reins" || v === "レインズ") return "reins";
    return v;
  }
  function watchStopApplies(stop, site, now) {
    if (!stop || !stop.site || !site) return false;
    if (siteNorm(stop.site) !== siteNorm(site)) return false;
    if (stop.at && typeof now === "number" && now - stop.at >= WATCH_STOP_TTL_MS) return false;
    return true;
  }
  // サーバーの答え → 止める印（無ければ null）
  function watchStopFrom(json, now) {
    var s = json && json.stop_site;
    if (!s || !s.site) return null;
    return { site: siteNorm(s.site), label: s.label || null, reason: String(s.reason || "").slice(0, 200), at: now };
  }
  // 見張りに送る本文（ページの文字はフォームの値・塗る位置を落とした小さな形）
  function watchBody(checkpoint, ctx, dom) {
    var c = ctx || {};
    var d = dom ? {
      url: dom.url || null, title: dom.title || null, count_text: dom.count_text || null,
      count_number: typeof dom.count_number === "number" ? dom.count_number : countNumberOf(dom.count_text),
      page_text: dom.page_text || null, alert_text: dom.alert_text || null, modal_text: dom.modal_text || null,
      text_head: dom.text_head || null, band_text: dom.band_text || null, visibility: dom.visibility || null,
      update_ages: dom.update_ages || null,
    } : null;
    return {
      brain: true, checkpoint: checkpoint, run_id: c.runId || null, command_id: c.commandId != null ? String(c.commandId) : null,
      property_customer_id: c.customerId != null ? String(c.customerId) : null, site: c.site ? siteNorm(c.site) : null,
      install_id: c.installId || null, ext_version: c.extVersion || null, dom: d, dom_error: c.domError || null,
      filled: c.filled || null, error: c.error ? String(c.error).slice(0, 500) : null,
    };
  }

  /**
   * 2026-09-29 v2.5.41 リアプロの一覧の行の更新日（見出し「部屋名更新日」の「309 4日前 閲覧済」）の経過の日数（見張りの C2）。
   *   行の頭が号室＋「N日前／N時間前／N分前」の形だけ数える（他の文の「3日前」は数えない）。サーバーの search-update-days.ageDaysOfCell と同じ読み
   */
  var ROW_AGE_RE = /^\s*[A-Za-z]?-?\d{1,5}[A-Za-z]?\s+(\d{1,4})\s*(分|時間|日|週間|ヶ月|か月|カ月)前/;
  function updateAgesOf(lines) {
    var n = 0, max = null, sample = [];
    for (var i = 0; i < lines.length && i < 4000; i++) {
      var s = String(lines[i] || "");
      if (s.normalize) s = s.normalize("NFKC");
      var m = s.match(ROW_AGE_RE);
      if (!m) continue;
      var k = Number(m[1]), u = m[2];
      var d = u === "分" ? k / 1440 : u === "時間" ? k / 24 : u === "日" ? k : u === "週間" ? k * 7 : k * 30;
      if (!isFinite(d)) continue;
      n++; max = max == null ? d : Math.max(max, d);
      if (sample.length < 150) sample.push(Math.round(d * 100) / 100);
    }
    return n ? { n: n, max_days: max, sample: sample } : null;
  }

  function readDom(doc, loc) {
    var d = doc || {};
    var href = loc && loc.href ? String(loc.href) : "";
    var bodyText = "";
    try { bodyText = d.body ? String(d.body.innerText || d.body.textContent || "") : ""; } catch (_) {}
    var lines = bodyText.split(/\n+/);
    var countText = null, pageText = null, alertText = null;
    for (var i = 0; i < lines.length && i < 3000; i++) {
      var ln = lines[i];
      if (ln.length > 200 || ln.indexOf("を選択中") >= 0) continue; // 拡張の一括DLの帯（0件を選択中）は件数ではない
      if (!countText) { var m1 = ln.match(COUNT_RE); if (m1) countText = clip(ln, 80); }
      if (!pageText) { var m2 = ln.match(PAGE_RE); if (m2) pageText = clip(m2[1], 40); }
      if (!alertText) { var m3 = ln.match(ALERT_RE); if (m3) alertText = clip(ln, 120); }
      if (countText && pageText && alertText) break;
    }
    var modalText = null;
    try {
      var ms = d.querySelectorAll ? d.querySelectorAll(MODAL_SEL) : [];
      for (var j = 0; j < ms.length; j++) {
        if (visible(ms[j])) { modalText = clip(ms[j].innerText || ms[j].textContent, 300); if (modalText) break; }
      }
    } catch (_) {}
    function textOf(id) {
      try { var el = d.getElementById ? d.getElementById(id) : null; return el ? clip(el.innerText || el.textContent, 200) : null; } catch (_) { return null; }
    }
    function shown(id) {
      try { var el = d.getElementById ? d.getElementById(id) : null; return !!el && el.style && el.style.display !== "none"; } catch (_) { return false; }
    }
    // 主なフォームの値（画面の検索条件の読み戻し・パスワードと隠し欄は読まない）
    var form = { checked: 0, filled: [] };
    try {
      var els = d.querySelectorAll ? d.querySelectorAll("input, select, textarea") : [];
      for (var k = 0; k < els.length && k < 2000; k++) {
        var e = els[k];
        var type = String(e.type || "").toLowerCase();
        if (type === "password" || type === "hidden" || type === "file") continue;
        if (type === "checkbox" || type === "radio") { if (e.checked) form.checked++; continue; }
        var v = e.value;
        if (v == null || v === "") continue;
        if (form.filled.length < 20) form.filled.push({ name: clip(e.name || e.id || e.getAttribute && e.getAttribute("placeholder") || "", 40), value: clip(v, 40) });
      }
    } catch (_) {}
    // 写真で塗る位置（拡張の要素・入れ子は外側だけ）と画面の大きさ（写真の px に直すため）
    var maskRects = [];
    try {
      var mk = d.querySelectorAll ? d.querySelectorAll(MASK_SEL) : [];
      for (var q = 0; q < mk.length && maskRects.length < MASK_MAX; q++) {
        var el2 = mk[q];
        var par = el2.parentElement;
        if (par && par.closest && par.closest(MASK_SEL)) continue;
        if (!visible(el2)) continue;
        var rr = el2.getBoundingClientRect ? el2.getBoundingClientRect() : null;
        if (rr && rr.width > 0 && rr.height > 0) maskRects.push({ x: Math.round(rr.left), y: Math.round(rr.top), w: Math.round(rr.width), h: Math.round(rr.height) });
      }
    } catch (_) {}
    var viewport = null;
    try {
      var wv = d.defaultView || null;
      if (wv && wv.innerWidth) viewport = { w: wv.innerWidth, h: wv.innerHeight, dpr: wv.devicePixelRatio || 1 };
    } catch (_) {}
    return {
      site: siteOfUrl(href),
      url: href.slice(0, 500),
      title: clip(d.title, 120),
      visibility: d.visibilityState || null,
      count_text: countText,
      count_number: countNumberOf(countText),
      page_text: pageText,
      alert_text: alertText,
      modal_text: modalText,
      band_text: textOf("axlx-score-bar"),
      selected_count: textOf("axlx-count") || textOf("axlx-itandi-count"),
      bulk_bar_shown: shown("axlx-bar") || shown("axlx-itandi-bar"),
      text_head: clip(bodyText, 300),
      update_ages: siteOfUrl(href) === "realpro" ? updateAgesOf(lines) : null,
      form: form,
      mask_rects: maskRects,
      viewport: viewport,
    };
  }

  // ── 受け口（3サイトの content script の中だけ。background・テストでは何もしない） ──
  try {
    if (typeof document !== "undefined" && typeof location !== "undefined" && siteOfUrl(location.href)
        && typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
        if (!msg || msg.type !== "axlx-snap-dom") return false;
        try { sendResponse({ ok: true, dom: readDom(document, location) }); }
        catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 200) }); }
        return false;
      });
      // 2026-09-30 v2.5.43 同時に動かせるかの実測（parallel-sites.js）: このタブの見え方と、1秒のタイマーが戻るまでの遅れ（背面のタブは間引かれて遅れる）。
      //   サイトには触らない（読み込み直し・クリックなし）。答えは非同期（return true）
      chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
        if (!msg || msg.type !== "axlx-lane-probe") return false;
        try {
          var P = (typeof self !== "undefined" ? self : window).AxlxParallelSites || null;
          var timerMs = (P && P.PROBE_TIMER_MS) || 1000;
          var startedAt = Date.now();
          setTimeout(function () {
            try {
              var vs = document.visibilityState || null;
              sendResponse(P ? P.probeResult(vs, startedAt, Date.now()) : { ok: true, visibilityState: vs, lagMs: Math.max(0, Date.now() - startedAt - timerMs) });
            } catch (e) { try { sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 120) }); } catch (_) {} }
          }, timerMs);
        } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 120) }); return false; }
        return true;
      });
    }
  } catch (_) { /* 受け口が作れなくてもページは止めない */ }

  return {
    STALL_MS: STALL_MS,
    DAILY_MAX: DAILY_MAX,
    SAME_TRIGGER_GAP_MS: SAME_TRIGGER_GAP_MS,
    LOG_MAX: LOG_MAX,
    CAPTURE_SETTLE_MS: CAPTURE_SETTLE_MS,
    CAPTURE_GAP_MS: CAPTURE_GAP_MS,
    IMAGE_MAX_WIDTH: IMAGE_MAX_WIDTH,
    IMAGE_MAX_BYTES: IMAGE_MAX_BYTES,
    TOTAL_IMAGE_MAX_BYTES: TOTAL_IMAGE_MAX_BYTES,
    RUN_STATE_TTL_MS: RUN_STATE_TTL_MS,
    PASS_DEADLINE_MS: PASS_DEADLINE_MS,
    TRIGGERS: TRIGGERS,
    siteOfUrl: siteOfUrl,
    dayKey: dayKey,
    hhmm: hhmm,
    stallKey: stallKey,
    shouldSnapStall: shouldSnapStall,
    rateGate: rateGate,
    pickTabs: pickTabs,
    capturePlan: capturePlan,
    logLine: logLine,
    trimLog: trimLog,
    bandStatus: bandStatus,
    passDeadlineMs: passDeadlineMs,
    describeStall: describeStall,
    heartbeatState: heartbeatState,
    modeKey: modeKey,
    bytesToBase64: bytesToBase64,
    scaledSize: scaledSize,
    readDom: readDom,
    updateAgesOf: updateAgesOf,
    MASK_SEL: MASK_SEL,
    WATCH_STOP_TTL_MS: WATCH_STOP_TTL_MS,
    countNumberOf: countNumberOf,
    maskRectsScaled: maskRectsScaled,
    watchStopApplies: watchStopApplies,
    watchStopFrom: watchStopFrom,
    watchBody: watchBody,
  };
});
