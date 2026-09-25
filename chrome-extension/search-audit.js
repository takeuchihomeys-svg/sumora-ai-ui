// chrome-extension/search-audit.js
// 検索の点検（拡張側）: ブレインモードで検索した1回ごとに「入れようとした条件・実際に入った値・結果」を
// /api/search-audits に送る。純関数＋送信の1関数＋1回ごとの記録（tracker）。self.AxlxSearchAudit。
//
// 2026-09-25 竹内「ブレインモードで物件自動検索や一括検索した際に、検索がちゃんとされていなかったら原因を見つけられるようにする。
//   0件だった場合ちゃんと検索されていない可能性があるし、お客さんの条件とずれた検索をしていた可能性がある。
//   ブレインモードに拡張ツール連携していた時。DeepSeek の API で行う。そうすればずっと拡張ツール側も成長していく」
//
// 決まり:
//   ・送るのはブレインの時だけ（AxlxModeCore.behavior の searchAudit）。サーバーも brain!==true なら何もしない（二重の歯止め）
//   ・送信は5秒で切る・失敗しても検索は止めない（戻り値で成否だけ返す・例外を投げない）
//   ・お客様の名前・電話は送らない（customer_snapshot は条件の欄だけ・自由記述の中の長い数字は伏せる）
//   ・page-script の audit は 8KB まで（見本の配列から削る）
// 読み込む所: background.js（import）・popup.html（script）・manifest の content_scripts の先頭（bulk-dl.js が件数表示の読み取りに使う）
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (root) { root.AxlxSearchAudit = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var API_BASE = "https://sumora-ai-ui.vercel.app";
  var SEND_TIMEOUT_MS = 5000;
  var MAX_STEPS = 40;
  var MAX_AUDIT_BYTES = 8192;

  // お客様の条件のうち写す欄（名前・電話・LINE の ID は入れない）
  var SNAPSHOT_FIELDS = [
    "desired_area", "area_mode", "rent_max", "max_rent", "rent_min", "floor_plan", "layout", "walk_minutes", "building_age",
    "floor_area_min", "commute_station", "commute_minutes", "pet", "rp_update_days", "last_property_sent_at", "property_viewed_at",
    "status", "preferences", "ng_points",
  ];
  // 入れようとした条件のうち写す欄
  var INTENDED_FIELDS = [
    "area_mode", "rent_max", "rent_min", "walk_minutes", "building_age", "floor_plan", "rp_update_days", "is_wide",
    "station_names", "route_ids", "city_codes", "detail_ward", "detail_area", "town_names", "itandi_lines", "ward_names", "ward_name",
    "reins_station_pairs", "reins_line", "unknown_tokens", "area_min", "area_max", "structure_types", "pet_ok", "shikirei_free",
    "select_all_line_stations", "sort_order", "max_pages",
  ];

  function newRunId(now) {
    var t = typeof now === "number" ? now : Date.now();
    return "sa_" + t.toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }

  // 自由記述の中の電話番号らしい数字（10桁以上・ハイフン込み）を伏せる
  function maskDigits(s) {
    return String(s).replace(/\d[\d\-‐－ー ]{8,}\d/g, "＊＊＊");
  }

  function snapshotCustomer(c) {
    if (!c || typeof c !== "object") return null;
    var out = {};
    for (var i = 0; i < SNAPSHOT_FIELDS.length; i++) {
      var k = SNAPSHOT_FIELDS[i];
      var v = c[k];
      if (v === undefined || v === null || v === "") continue;
      if (typeof v === "string") v = maskDigits(v).slice(0, 400);
      out[k] = v;
    }
    return out;
  }

  function capArray(a, n) {
    return Array.isArray(a) ? a.slice(0, n) : a;
  }

  function pickIntended(cond) {
    if (!cond || typeof cond !== "object") return null;
    var out = {};
    for (var i = 0; i < INTENDED_FIELDS.length; i++) {
      var k = INTENDED_FIELDS[i];
      var v = cond[k];
      if (v === undefined) continue;
      if (Array.isArray(v)) v = capArray(v, 80);
      else if (typeof v === "string") v = v.slice(0, 300);
      out[k] = v;
    }
    return out;
  }

  // 段の記録（最大40件・古い物から落とす）
  function pushStep(steps, k, d, now) {
    var list = Array.isArray(steps) ? steps : [];
    list.push({ at: typeof now === "number" ? now : Date.now(), k: String(k).slice(0, 40), d: d == null ? null : String(d).slice(0, 160) });
    while (list.length > MAX_STEPS) list.shift();
    return list;
  }

  function byteLen(obj) {
    try { return JSON.stringify(obj).length; } catch (_) { return Infinity; }
  }

  // page-script の audit を 8KB に収める（見本・読み戻しの配列を短くしていく）
  function clampAudit(audit, maxBytes) {
    var lim = maxBytes || MAX_AUDIT_BYTES;
    if (!audit || typeof audit !== "object") return null;
    var a;
    try { a = JSON.parse(JSON.stringify(audit)); } catch (_) { return null; }
    if (byteLen(a) <= lim) return a;
    var caps = [12, 6, 3, 0];
    for (var ci = 0; ci < caps.length && byteLen(a) > lim; ci++) {
      var n = caps[ci];
      ["stations_missing", "lines_missing", "click_fails"].forEach(function (key) {
        if (!Array.isArray(a[key])) return;
        a[key] = a[key].slice(0, Math.max(n, 1)).map(function (m) {
          if (m && Array.isArray(m.sample)) m.sample = m.sample.slice(0, n);
          return m;
        });
      });
      if (a.form) {
        ["stations", "lines", "wards", "layouts"].forEach(function (key) {
          if (Array.isArray(a.form[key]) && a.form[key].length > n * 4) a.form[key] = a.form[key].slice(0, Math.max(n * 4, 4));
        });
      }
      if (Array.isArray(a.stations_ok) && a.stations_ok.length > n * 4) a.stations_ok = a.stations_ok.slice(0, Math.max(n * 4, 4));
      if (Array.isArray(a.steps)) a.steps = a.steps.slice(-Math.max(n * 2, 4));
    }
    if (byteLen(a) > lim) return { v: a.v || 1, truncated: true, search_clicked: a.search_clicked, area_path: a.area_path || null };
    a.truncated = true;
    return a;
  }

  // 件数表示の生の文字を探す（画面の文字全体から・純関数）。
  //   リアプロ・itandi の件数表示の場所（DOM の名前）は確かめていないので、文字の形で探し、生の文字をそのまま残す（点検で人が確かめられるように）
  function readCountText(text) {
    var s = String(text || "").normalize ? String(text || "").normalize("NFKC") : String(text || "");
    if (!s) return { text: null, number: null };
    var lines = s.split(/\n+/);
    var pats = [
      /(該当(?:する)?物件(?:は|が)?\s*(?:ありません|見つかりません|0\s*件))/,
      /(検索結果\s*[:：]?\s*([\d,]+)\s*件)/,
      /(該当\s*[:：]?\s*([\d,]+)\s*件)/,
      /(全\s*([\d,]+)\s*件)/,
      /(([\d,]+)\s*件中)/,
      /(([\d,]+)\s*件\s*(?:見つかりました|ヒット))/,
    ];
    for (var p = 0; p < pats.length; p++) {
      for (var i = 0; i < lines.length && i < 4000; i++) {
        var line = lines[i];
        if (line.length > 200) continue;
        var m = line.match(pats[p]);
        if (m) {
          var num = p === 0 ? 0 : Number(String(m[2] || "").replace(/,/g, ""));
          return { text: line.trim().slice(0, 80), number: isFinite(num) ? num : null };
        }
      }
    }
    return { text: null, number: null };
  }

  // 動作モード → mode の札（brain_normal / brain_staff / brain_aix）。ブレインでなければ null
  function modeLabel(state) {
    if (!state || !state.brain) return null;
    return state.mode === "staff" ? "brain_staff" : state.mode === "aix" ? "brain_aix" : "brain_normal";
  }

  // 拡張の設定の automationApiKey（サーバーに AUTOMATION_API_KEY がある時の合言葉・background._automationHeaders と同じ）
  function automationKey() {
    return new Promise(function (resolve) {
      try {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) { resolve(null); return; }
        chrome.storage.local.get(["automationApiKey"], function (st) { resolve((st && st.automationApiKey) || null); });
      } catch (_) { resolve(null); }
    });
  }

  // 送る（5秒で切る・失敗しても投げない）
  function post(body, opts) {
    var o = opts || {};
    var base = o.apiBase || API_BASE;
    var f = o.fetch || (typeof fetch !== "undefined" ? fetch : null);
    if (!f || !body || !body.run_id) return Promise.resolve({ ok: false, reason: "no-fetch-or-id" });
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (_) {} }, o.timeoutMs || SEND_TIMEOUT_MS) : null;
    try {
      var keyP = o.fetch ? Promise.resolve(null) : automationKey();
      return keyP.then(function (key) {
        var headers = { "Content-Type": "application/json" };
        if (key) headers["x-automation-key"] = key;
        return f(base + "/api/search-audits", {
          method: "POST",
          headers: headers,
          body: JSON.stringify(body),
          signal: ctrl ? ctrl.signal : undefined,
        });
      }).then(function (res) {
        if (timer) clearTimeout(timer);
        return { ok: !!(res && res.ok), status: res && res.status };
      }, function (e) {
        if (timer) clearTimeout(timer);
        return { ok: false, reason: String((e && e.message) || e) };
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      return Promise.resolve({ ok: false, reason: String((e && e.message) || e) });
    }
  }

  function siteKey(site) {
    var s = String(site || "").toLowerCase();
    if (s === "realnetpro" || s === "realpro" || s === "リアプロ") return "realpro";
    if (s === "itandi") return "itandi";
    if (s === "reins" || s === "レインズ") return "reins";
    return s || null;
  }

  /**
   * 1回ごとの記録（background.js が1つ持つ）。
   *   opts.post(body) … 送る関数（既定は上の post）
   *   opts.now()      … 時刻
   *   opts.extVersion … 拡張の版
   * begin で started を送り、fill / result を足し、finish で finished を1回だけ送る。
   */
  function createTracker(opts) {
    var o = opts || {};
    var send = o.post || function (b) { return post(b); };
    var now = o.now || function () { return Date.now(); };
    var runs = new Map();

    function sweepOld() {
      var t = now();
      runs.forEach(function (r, id) { if (t - r.started_at > 60 * 60 * 1000) runs.delete(id); });
    }

    function begin(ctx) {
      sweepOld();
      var id = ctx.run_id || newRunId(now());
      var run = {
        run_id: id,
        site: siteKey(ctx.site),
        property_customer_id: ctx.customer_id != null ? String(ctx.customer_id) : null,
        trigger: ctx.trigger || "single",
        mode: ctx.mode || null,
        command_id: ctx.command_id || null,
        is_wide: !!ctx.is_wide,
        area_mode: ctx.area_mode || null,
        pass: ctx.pass || null,
        steps: [],
        started_at: now(),
        filled: null,
        result: null,
        finished: false,
      };
      pushStep(run.steps, "begin", run.trigger, now());
      runs.set(id, run);
      if (ctx.post_started !== false) {
        send({
          phase: "started", brain: true, run_id: id, site: run.site, mode: run.mode, trigger: run.trigger,
          property_customer_id: run.property_customer_id, command_id: run.command_id, is_wide: run.is_wide,
          area_mode: run.area_mode, pass: run.pass, ext_version: o.extVersion || null,
          customer_snapshot: ctx.customer ? snapshotCustomer(ctx.customer) : null,
          intended: ctx.intended ? pickIntended(ctx.intended) : null,
        });
      }
      return run;
    }

    function get(id) { return id ? runs.get(id) || null : null; }

    // まだ終わっていない一番新しい回（お客様・サイトで探す）
    function findOpen(customerId, site) {
      var best = null;
      var sk = siteKey(site);
      runs.forEach(function (r) {
        if (r.finished) return;
        if (customerId != null && r.property_customer_id !== String(customerId)) return;
        if (sk && r.site && r.site !== sk) return;
        if (!best || r.started_at > best.started_at) best = r;
      });
      return best;
    }

    function step(id, k, d) {
      var r = get(id);
      if (r) pushStep(r.steps, k, d, now());
    }

    function attachFill(id, fill) {
      var r = get(id);
      if (!r) return null;
      r.filled = fill && fill.audit ? clampAudit(fill.audit) : r.filled;
      if (fill && fill.error) r.fill_error = String(fill.error).slice(0, 300);
      pushStep(r.steps, "fill_done", fill && fill.error ? "error: " + String(fill.error).slice(0, 100) : "ok", now());
      if (r.filled && Array.isArray(r.filled.steps)) {
        r.filled.steps.forEach(function (s) { if (s && s.k) pushStep(r.steps, "page:" + s.k, s.d, s.at || now()); });
        delete r.filled.steps;
      }
      return r;
    }

    function attachResult(id, result) {
      var r = get(id);
      if (!r) return null;
      r.result = Object.assign({}, r.result || {}, result || {});
      pushStep(r.steps, "result", "rows=" + (result && result.read_rows) + " sent=" + (result && result.sent_count), now());
      return r;
    }

    function finish(id, extra) {
      var r = get(id);
      if (!r || r.finished) return Promise.resolve({ ok: false, reason: r ? "already" : "unknown" });
      r.finished = true;
      var x = extra || {};
      if (x.result) r.result = Object.assign({}, r.result || {}, x.result);
      var err = x.error || r.fill_error || null;
      pushStep(r.steps, "finish", err ? "error" : "ok", now());
      var body = {
        phase: "finished", brain: true, run_id: r.run_id, site: r.site, mode: r.mode, trigger: r.trigger,
        property_customer_id: r.property_customer_id, command_id: r.command_id, is_wide: r.is_wide, area_mode: r.area_mode, pass: r.pass,
        ext_version: o.extVersion || null,
        filled: r.filled, steps: r.steps.slice(-MAX_STEPS), result: r.result,
        error: err ? String(err).slice(0, 500) : null, error_kind: x.error_kind || null, page_url: x.page_url || (r.result && r.result.url) || null,
      };
      runs.delete(r.run_id);
      return send(body);
    }

    return { begin: begin, get: get, findOpen: findOpen, step: step, attachFill: attachFill, attachResult: attachResult, finish: finish, _runs: runs };
  }

  return {
    API_BASE: API_BASE,
    SEND_TIMEOUT_MS: SEND_TIMEOUT_MS,
    MAX_STEPS: MAX_STEPS,
    MAX_AUDIT_BYTES: MAX_AUDIT_BYTES,
    SNAPSHOT_FIELDS: SNAPSHOT_FIELDS,
    newRunId: newRunId,
    maskDigits: maskDigits,
    snapshotCustomer: snapshotCustomer,
    pickIntended: pickIntended,
    pushStep: pushStep,
    clampAudit: clampAudit,
    readCountText: readCountText,
    modeLabel: modeLabel,
    siteKey: siteKey,
    post: post,
    createTracker: createTracker,
  };
});
