// chrome-extension/human-learn-record.js
// 2026-11-11 竹内さん「普通モードはスタッフの動きを学習する形でもよい。画面録画や監視して動きちゃんと理解できるように」
//
// human-learn.js（純関数）で覚えた人の動きを、**通常モード・スタッフモードの時だけ** chrome.storage.local に貯める。
//   storage のキー: axlx_human_learn = { v:1, n, sessions, kinds, gaps, gap_ms, fields, order, at, site }
//   → 自動モードの「人のような間」（human-wait.js の logNormalDelay）を実測に寄せる材料にする。
//
// ⚠ 自動モード・AIX では**覚えない**（拡張の動きが混ざって「人の動き」でなくなるため）。
//     モードが自動に変わったら、その場で見張りを外して貯めるのを止める。
// ⚠ 入力した中身（値）は残さない。欄の名前・操作の種類・間だけ。
(function () {
  "use strict";
  if (window.__axlxHumanLearnRecord) return;
  window.__axlxHumanLearnRecord = true;

  var KEY = "axlx_human_learn";
  // 2026-11-11 竹内さん「データたまって理解するたび反映」: 貯まるたびに作り直す「動きの癖」（カーソルがこれを見て動く）
  var PROFILE_KEY = "axlx_human_profile";
  /**
   * 2026-11-13: 要素ごとの押した位置（人がどこを押したか）。
   *   pointer-ui.js と同じ鍵（`axlx_human_points`）を読み書きする。
   *   ここで貯めた物を、次に同じボタンを押す時に**狙う場所**として使う。
   */
  var POINTS_KEY2 = "axlx_human_points";
  var SAVE_EVERY_MS = 60000;   // 1分ごとに書き出す（操作のたびに書かない）
  var MIN_OPS_TO_SAVE = 5;     // 5回未満は書かない（誤操作・一瞬のクリックだけを貯めない）
  var LEARN_LOCK = "human-learn-record.js";

  var L = (typeof self !== "undefined" ? self : window).AxlxHumanLearn;
  if (!L) return;

  var rec = L.create({
    doc: document, win: window,
    // 2026-11-11 竹内さん「録画のような形で」: 操作のたびに画面の写真を1枚撮る
    onOp: function (kind, el, pt) { shootAfter(kind, el, pt); },
  });
  var detach = null;
  var watching = false;
  var timer = null;
  var site = (function () {
    try {
      var h = String(location.hostname || "");
      if (/realnetpro/.test(h)) return "realpro";
      if (/itandibb/.test(h)) return "itandi";
      if (/reins/.test(h)) return "reins";
    } catch (_) {}
    return "unknown";
  })();

  /**
   * 2026-11-11 竹内さん「写真ちゃんと送られたかな？」→ 0枚のまま。
   *
   * ⚠ 原因: `shouldLearn` は**通常・スタッフの時だけ true**（自動・AIX は false）。
   *   写真は学習（`onOp`）の中から撮っているので、**自動モード・AIXモードでは一度も撮られていなかった**。
   *   だが竹内さんが写真で確かめたいのは**まさに自動モードで「検索を押せたか」**。
   *
   * → 分ける:
   *   ・**学習（人の動きを覚える）** … 今まで通り 通常・スタッフの時だけ（拡張の動きを混ぜない）
   *   ・**写真（画面の記録）**       … どのモードでも撮る（自動で押した画面こそ残したい）
   *   写真は `onOp` ではなく**自前の見張り**（人が押した時＋拡張が押した時）から撮る。
   */
  function shouldLearn(st) {
    var s = st || {};
    var at = s.staffModeAt || 0;
    var staffOn = !!s.staffMode && (!at || Date.now() - at <= 2 * 60 * 60 * 1000);
    if (staffOn) return true;
    var chosen = Number(s.autoModeAt) > 0;
    var autoOn = chosen && (!!s.aixMode || !!s.aiMode);
    return !autoOn; // 自動の印が無ければ通常
  }
  /** 写真を撮るモードか（＝どのモードでも撮る。止める設定がある時だけ止める） */
  function shouldShoot(st) {
    var s = st || {};
    try { if (s.axlxShotOff === true) return false; } catch (_) {}
    return true;
  }

  /** 覚えている最中の印（同じページで二重に見張らない・他の部品からも分かる） */
  function lock() { try { document.documentElement.setAttribute("data-axlx-learn", "1"); } catch (_) {} }
  function unlock() { try { document.documentElement.removeAttribute("data-axlx-learn"); } catch (_) {} }

  function startWatching() {
    if (watching) return;
    watching = true;
    try { lock(); } catch (_) {}
    detach = rec.attach(document, window);
    console.log("[AX] 通常モード: 人の動きを覚えます（" + site + "）");
  }
  function stopWatching() {
    if (!watching) return;
    watching = false;
    try { if (detach) detach(); } catch (_) {}
    detach = null;
    try { unlock(); } catch (_) {}
    console.log("[AX] 自動モード: 人の動きを覚えるのを止めました（" + site + "）");
    save(true); // 止める時に残りを書き出す
  }

  /** 画面に「見張っています」の小さな印（消せる・邪魔にならない） */
  function ensureBadge() {
    try {
      if (document.getElementById("axlx-learn-badge")) return;
      var d = document.createElement("div");
      d.id = "axlx-learn-badge";
      d.style.cssText = "position:fixed;left:10px;bottom:10px;z-index:2147483000;background:rgba(22,163,74,.92);color:#fff;"
        + "font:700 11px/1.4 -apple-system,system-ui,sans-serif;padding:4px 8px;border-radius:8px;pointer-events:none;opacity:.85";
      d.textContent = "👀 人の動きを学習中";
      (document.body || document.documentElement).appendChild(d);
    } catch (_) {}
  }
  /**
   * 2026-11-11 竹内さん「普通モードでのマウスの動かし方やボタンのどこ押すかもちゃんとたまるんかな」:
   *   貯まっているかを**その場で見える**ようにする（数が増えていくのが分かる）。
   *   印に「マウス◯回・押した所◯・スクロール◯」を出す。
   */
  function paintBadge() {
    try {
      var d = document.getElementById("axlx-learn-badge");
      if (!d) return;
      var det = rec.detail();
      var n = rec.count();
      d.textContent = "👀 学習中 操作" + n + "・マウス" + (det.moves || []).length
        + "・押した所" + (det.points || []).length + "・スクロール" + (det.scrolls || []).length;
    } catch (_) {}
  }
  /**
   * 2026-11-11 竹内さん「データたまって理解するたび反映」:
   *   貯まるたびに「こう理解した（速さ・曲がり・押す位置）」を**画面の印に出す**。
   *   → 反映されていることが目で分かる（数字が動く）。
   */
  function paintLearned(prof) {
    try {
      var d = document.getElementById("axlx-learn-badge");
      if (!d || !prof) return;
      var parts = [];
      if (prof.speed_px_s != null) parts.push("速さ" + prof.speed_px_s);
      if (prof.curve != null) parts.push("曲がり" + prof.curve);
      if (prof.aim) parts.push("押す所" + prof.aim.x + "/" + prof.aim.y);
      if (!parts.length) return;
      d.textContent = "👀 学習中｜理解した動き: " + parts.join("・");
      d.style.background = "rgba(21,128,61,.95)";
    } catch (_) {}
  }
  function removeBadge() {
    try { var d = document.getElementById("axlx-learn-badge"); if (d) d.remove(); } catch (_) {}
  }

  var _saving = false;
  function save(force) {
    if (_saving) return;
    var ops = rec.list();
    if (!ops.length) return;
    if (!force && ops.length < MIN_OPS_TO_SAVE) return;
    _saving = true;
    var add = L.summarize(ops);
    // 2026-11-11 竹内さん「マウスの動かし方やボタンのどこ押すか、画面のうごかしかたも」:
    //   動き・押した場所・スクロールも一緒に集計して貯める（detail() が締め忘れを締めてから返す）
    try {
      var det = rec.detail();
      var motion = L.summarizeMotion(det);
      add.moves = motion.moves; add.points = motion.points; add.scrolls = motion.scrolls;
    } catch (_) {}
  /**
   * 2026-11-11 竹内さん「画面の動き方もちゃんと把握できているのかな録画のような形で」→「操作のたびに1枚」
   *
   *   操作の**たびに**画面の写真を1枚撮って Storage に置く（1検索で30〜80枚）。
   *   並べると操作の流れ（録画に近い物）になる。
   *   ・撮るのは人が操作した時だけ（拡張の動きは撮らない）
   *   ・撮りすぎない（最短 350ms はあける・background 側でも間引く）
   *   ・写真の中身は DB に送らない（Storage 内・名前だけ DB へ）
   */
  var _shotPending = false;
  var _shotPendingAt = 0;
  var _shotLast = 0;
  var _shotCount = 0;
  /**
   * 2026-11-13 竹内さん「写真から学習する。押す場所や押す順番などもりかいできるから」:
   *   直近の操作を**小さな輪**に残しておき、写真を撮る時に一緒に送る。
   *   → 写真1枚に「その直前までに何を押したか（順番・時刻）」が付く。
   *     「この画面で次に何を押すか」を後から学べる材料になる。
   *   ⚠ 入れるのは**欄の名前・操作の種類・時刻だけ**（入力した中身・文字は入れない）。
   *   ⚠ 上限 40件（古い物から捨てる）。ページを離れると消える（それでよい）。
   */
  var _opsRing = [];
  var OPS_RING_MAX = 40;
  function _pushOp(kind, el) {
    try {
      var nm = el && L && L.fieldName ? L.fieldName(el) : null;
      _opsRing.push({ t: Date.now(), k: String(kind || "?").slice(0, 10), f: nm ? String(nm).slice(0, 30) : null });
      while (_opsRing.length > OPS_RING_MAX) _opsRing.shift();
    } catch (_) {}
  }
  /** 写真と一緒に送る「直前までの操作」（新しい順に最大40件） */
  function _recentOps() {
    try { return _opsRing.slice(-OPS_RING_MAX); } catch (_) { return null; }
  }
  /**
   * 2026-11-13 竹内さん「録画から学習できるのか」:
   *   録画モードの写真にも**押した操作**を付ける（押す順番の材料）。
   *   background が「直近の操作をください」と聞いてくるので答える。
   *   ⚠ 送るのは**欄の名前・操作の種類・時刻だけ**（入力した中身は送らない）。
   */
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (msg, _s, sendResponse) {
        if (!msg || msg.type !== "axlx-recent-ops") return;
        try { sendResponse({ ok: true, ops: _recentOps() || [] }); } catch (_) {}
        return true;
      });
    }
  } catch (_) {}
  var SHOT_MIN_GAP_MS = 400;   // これより短い間隔では撮らない
  var SHOT_MAX_PER_SESSION = 300; // 1ページで撮る上限（暴走しないように）
  function shootAfter(kind, el, pt) {
    try {
      /**
       * 2026-11-11 竹内さん「このお客さんちゃんと保存されてたかな？」→ 学習は入るが写真が0枚。
       *   どこで止まっているか分からないと直せないので、**試した回数と結果**を残す。
       *   storage: axlx_human_shot_diag = { tried, ok, last_error, last_at }
       */
      var diag = function (ok, err) {
        try {
          chrome.storage.local.get(["axlx_human_shot_diag"], function (r) {
            var d = (r && r.axlx_human_shot_diag) || { tried: 0, ok: 0 };
            d.tried = (Number(d.tried) || 0) + 1;
            if (ok) d.ok = (Number(d.ok) || 0) + 1;
            d.last_error = ok ? null : String(err || "?");
            d.last_at = Date.now();
            var o = {}; o.axlx_human_shot_diag = d;
            try { chrome.storage.local.set(o); } catch (_) {}
          });
        } catch (_) {}
      };
      // 2026-11-11 竹内さん「写真ちゃんと送られたかな？」:
      //   旧は `if (!watching)` で弾いていた（＝自動・AIX では撮らない）。写真はモードに関係なく撮る。
      if (!_shooting && !watching) { diag(false, "not_shooting"); return; }
      var now = Date.now();
      /**
       * 2026-11-11 竹内さん「写真撮ってるかな？」→ 0枚のまま。
       *   `_shotPending` は応答が返らないと**永久に true**になり、以降すべて弾かれていた
       *   （＝1回失敗すると二度と撮らない）。3秒たったら諦めて次を撮る。
       */
      if (_shotPending && now - _shotPendingAt < 3000) return;   // 撮っている最中（3秒まで）
      if (_shotPending) { _shotPending = false; diag(false, "timeout_stuck"); }  // 張り付きを解く
      if (now - _shotLast < SHOT_MIN_GAP_MS) return;   // 間引きは「失敗」ではない（数えない）
      if (_shotCount >= SHOT_MAX_PER_SESSION) { diag(false, "max_reached"); return; }
      _shotLast = now;
      _shotCount++;
      _shotPending = true;
      _shotPendingAt = now;
      chrome.runtime.sendMessage({
        type: "axlx-human-shot",
        site: site,
        kind: kind,
        what: el ? (L.fieldName ? L.fieldName(el) : null) : null,
        x: pt && typeof pt.x === "number" ? pt.x : null,
        y: pt && typeof pt.y === "number" ? pt.y : null,
        /**
         * 2026-11-13 竹内さん「写真から学習する。押す場所や押す順番などもりかいできるから」
         *   「おしかたのボタンの仕様の理解の為にも」:
         *   この写真の**直前までの操作の並び**を一緒に送る（時刻・種類・どの欄か）。
         *   → 写真と「何を押した直後か」が結びつき、後から
         *     「この画面では次にこれを押す」を学べる。
         *   ⚠ 送るのは**欄の名前と操作の種類・時刻だけ**（入力した中身・文字は送らない）。
         */
        ops: _recentOps(),
      }, function (res) {
        void chrome.runtime.lastError;
        _shotPending = false;
        if (res && res.ok) {
          diag(true, null);
          try {
            var so = {};
            so.axlx_human_shot = { key: res.shot_key, at: Date.now(), seq: res.seq, run_id: res.run_id };
            chrome.storage.local.set(so);
          } catch (_) {}
        } else {
          diag(false, (res && res.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "no_response");
        }
      });
    } catch (e) {
      _shotPending = false;
      diag(false, "send_error: " + String((e && e.message) || e));
    }
  }
    try {
      chrome.storage.local.get([KEY], function (r) {
        try {
          var next = L.mergeAggregate(r && r[KEY], add);
          next.at = Date.now();
          next.site = site;
          var o = {}; o[KEY] = next;
          /**
           * 2026-11-11 竹内さん「データたまって理解するたび反映」:
           *   貯まった**その場で**「動きの癖」を作り直して別のキー（axlx_human_profile）に置く。
           *   → 見えるカーソル（pointer-ui.js）がこのキーの変化を見て、**次の動きから**新しい癖で動く。
           *     ページを開き直さなくても、操作するほど動きが人の実測に寄っていく。
           */
          try {
            var prof = L.profileFrom(next);
            if (prof) o[PROFILE_KEY] = prof;
          } catch (_) {}
          /**
           * 2026-11-13 竹内さん「撮影したところからぼたんの押す場所の確認や移動の部分で学習した部分あるか」:
           *   押した位置を**要素ごと**に残す（`axlx_human_points`）。
           *   次に同じボタン・同じ欄を押す時、見えるカーソルが**その人の押した場所**を狙う。
           *   例: rental_cost2 → { x:0.10, y:0.14, n:6 }
           *   ⚠ 押した**回数（n）が2以上の物だけ**使う（1回だけは偶然かもしれない）。
           */
          try {
            var pf = (next.points && next.points.fields) || null;
            if (pf && typeof pf === "object") {
              chrome.storage.local.get([POINTS_KEY2], function (rr) {
                try {
                  var cur = (rr && rr[POINTS_KEY2]) || {};
                  var changed = false;
                  Object.keys(pf).slice(0, 60).forEach(function (k) {
                    var v = pf[k];
                    if (!v || typeof v.x !== "number" || typeof v.y !== "number") return;
                    var old = cur[k] || null;
                    var nOld = old ? Number(old.n) || 0 : 0;
                    var nNew = Number(v.n) || 0;
                    if (nNew <= nOld) return;
                    // 回数の多い方（新しい実測）に寄せる
                    cur[k] = { x: v.x, y: v.y, n: nNew };
                    changed = true;
                  });
                  if (changed) {
                    var oo = {}; oo[POINTS_KEY2] = cur;
                    try { chrome.storage.local.set(oo); } catch (_) {}
                  }
                } catch (_) {}
              });
            }
          } catch (_) {}
          chrome.storage.local.set(o, function () {
            _saving = false;
            rec.reset(); // 操作・動き・押した場所・スクロールをまとめて空にする
            try { void chrome.runtime.lastError; } catch (_) {}
            // 2026-11-11: 理解した内容をその場で見せる（反映されていることが分かる）
            try { if (o[PROFILE_KEY]) paintLearned(o[PROFILE_KEY]); else paintBadge(); } catch (_) {}
            /**
             * 2026-11-11 竹内さん「今このお客さんを普通モードでやったんやけど動き理解できているかな」:
             *   貯めた直後に**その場で**DB へ送る（別のスクリプトの変化待ちに頼らない＝確実に届く）。
             *   送る係（human-learn-upload.js）が居れば、それに頼む。居なければ何もしない（貯まるだけ）。
             */
            try {
              var U = (typeof self !== "undefined" ? self : window).__axlxHumanMotionUploadNow;
              if (typeof U === "function") U(next);
            } catch (_) {}
            console.log("[AX] 人の動きを貯めました:", "操作" + next.n + "・マウス" + (next.moves ? next.moves.n : 0)
              + "・押した所" + (next.points ? next.points.n : 0) + "・スクロール" + (next.scrolls ? next.scrolls.n : 0)
              + (o[PROFILE_KEY] ? "／理解した動き: 速さ" + o[PROFILE_KEY].speed_px_s : "（まだ材料不足）"));
          });
        } catch (_) { _saving = false; }
      });
    } catch (_) { _saving = false; }
  }

  /**
   * 2026-11-11 竹内さん「動きも学習させたい」:
   *   自動モードでも**拡張自身の動き**（見えるカーソルの移動・押した位置・間隔）を覚える。
   *   ⚠ 人の動きとは**別の入れ物**に入れる（混ぜると「人の速さ」の実測が壊れる）。
   *   ・`axlx_auto_motion` に集計（速さ・曲がり・押した位置・スクロール・間隔）
   *   ・自動モードで動いた時だけ書く。通常・スタッフでは今まで通り `axlx_human_learn`（人の実測）
   */
  var AUTO_KEY = "axlx_auto_motion";
  var _autoOps = [];
  var _autoLastAt = 0;
  var _autoLastEl = null;
  var _autoSaving = false;
  /** 拡張が押す直前に呼ぶ（pointer-ui の位置と要素を残す） */
  function noteAutoOp(kind, el, extra) {
    try {
      var t = Date.now();
      var gap = _autoLastAt ? Math.min(120000, t - _autoLastAt) : null;
      _autoLastAt = t;
      var P = (typeof self !== "undefined" ? self : window).AxlxPointerUi;
      var pos = (P && P.visiblePosition) ? P.visiblePosition() : null;
      var r = null, fx = null, fy = null;
      try {
        if (el && el.getBoundingClientRect) {
          r = el.getBoundingClientRect();
          // 押す位置は「カーソルが居た所」を要素の中の割合にする（人が見た点）
          if (pos && r.width > 0 && r.height > 0) {
            fx = Math.round(Math.max(0, Math.min(1, (pos.x - r.left) / r.width)) * 100) / 100;
            fy = Math.round(Math.max(0, Math.min(1, (pos.y - r.top) / r.height)) * 100) / 100;
          }
        }
      } catch (_) {}
      _autoOps.push({
        t: t, k: String(kind || "click").slice(0, 12),
        f: (L && L.fieldName) ? L.fieldName(el) : null,
        gap: gap, x: fx, y: fy,
        scroll: (extra && typeof extra.dy === "number") ? Math.round(extra.dy) : null,
      });
      if (_autoOps.length > 200) _autoOps.shift();
      if (_autoOps.length >= 20 && !_autoSaving) {
        _autoSaving = true;
        flushAuto();
      }
    } catch (_) {}
  }
  /** 自動モードの動きを集計して貯める */
  function flushAuto() {
    try {
      if (!_autoOps.length) { _autoSaving = false; return; }
      var adds = L.summarize(_autoOps);
      var det = { moves: [], points: [], scrolls: [] };
      // 押した位置（拡張が狙った点）
      _autoOps.forEach(function (o) {
        if (o.x != null && o.y != null) det.points.push({ f: o.f || "?", x: o.x, y: o.y, s: "auto" });
        if (o.scroll != null) det.scrolls.push({ dy: o.scroll, dir: o.scroll > 0 ? "down" : "up", y: 0 });
      });
      var motion = L.summarizeMotion(det);
      adds.moves = motion.moves; adds.points = motion.points; adds.scrolls = motion.scrolls;
      chrome.storage.local.get([AUTO_KEY], function (r) {
        try {
          var prev = r && r[AUTO_KEY];
          var next = L.mergeAggregate(prev, adds);
          next.at = Date.now();
          next.site = site;
          next.source = "extension_auto";   // ← 人の実測と区別する印
          var o = {}; o[AUTO_KEY] = next;
          chrome.storage.local.set(o, function () {
            _autoOps = [];
            _autoSaving = false;
            try { void chrome.runtime.lastError; } catch (_) {}
          });
        } catch (_) { _autoSaving = false; }
      });
    } catch (_) { _autoSaving = false; }
  }
  try { window.__axlxNoteAutoOp = noteAutoOp; } catch (_) {}

  // ── モードを見る（学習は通常・スタッフの時だけ／写真はどのモードでも）──
  var KEYS = ["staffMode", "staffModeAt", "aixMode", "autoModeAt", "aiMode", "axlxShotOff"];
  var _shooting = false;
  function apply(st) {
    if (shouldLearn(st)) { startWatching(); ensureBadge(); }
    else { stopWatching(); removeBadge(); }
    /**
     * 2026-11-11 竹内さん「写真ちゃんと送られたかな？」→ 0枚。
     *   写真は学習（onOp）の中から撮っていたので、**自動・AIX では一度も撮られなかった**。
     *   → 写真は**どのモードでも**撮る（自前の見張り）。学習とは別にする。
     */
    if (shouldShoot(st)) startShooting();
    else stopShooting();
  }

  /** 写真を撮る見張り（モードに関係なく動く。人も拡張も押したら撮る） */
  function startShooting() {
    if (_shooting) return;
    _shooting = true;
    try {
      var h = function (e) {
        if (!e || !e.isTrusted) return;   // 人が押した時（拡張の dispatch は対象外）
        _noteShotDiag("trusted_" + (e.type || "?"));
        _pushOp(e.type || "click", e.target);   // 2026-11-13: 写真と一緒に送る操作の並び
        shootAfter(e.type, e.target, null);
      };
      // 人が押した時・打った時・選んだ時（拡張の自動操作はここに入らない）
      document.addEventListener("click", h, true);
      document.addEventListener("change", h, true);
      window.addEventListener("wheel", function (e) {
        if (e && e.isTrusted) { _noteShotDiag("trusted_wheel"); shootAfter("wheel", null, null); }
      }, { passive: true, capture: true });
      _shootDetach = function () {
        try { document.removeEventListener("click", h, true); document.removeEventListener("change", h, true); } catch (_) {}
      };
      console.log("[AX] 画面の写真: どのモードでも撮ります（" + site + "）");
      // 起動直後に1枚（「撮れるか」を確かめられるように）
      try { setTimeout(function () { shootAfter("startup", null, null); }, 1500); } catch (_) {}
    } catch (_) {}
  }
  var _shootDetach = null;
  function stopShooting() {
    if (!_shooting) return;
    _shooting = false;
    try { if (_shootDetach) _shootDetach(); } catch (_) {}
    _shootDetach = null;
  }
  /** 写真の通り道を残す（どこで止まるか分かるように） */
  function _noteShotDiag(why) {
    try {
      chrome.storage.local.get(["axlx_human_shot_diag"], function (r) {
        var d = (r && r.axlx_human_shot_diag) || { tried: 0, ok: 0 };
        d.last_why = why;
        d.last_why_at = Date.now();
        try { chrome.storage.local.set({ axlx_human_shot_diag: d }); } catch (_) {}
      });
    } catch (_) {}
  }
  try {
    chrome.storage.local.get(KEYS, function (r) { apply(r || {}); });
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== "local" || !ch) return;
      if (!("staffMode" in ch) && !("aixMode" in ch) && !("autoModeAt" in ch) && !("aiMode" in ch) && !("axlxShotOff" in ch)) return;
      chrome.storage.local.get(KEYS, function (r) { apply(r || {}); });
    });
  } catch (_) {}

  // 1分ごとに書き出す（見えていないタブでは書き出さない＝裏のタブを止めない）
  timer = setInterval(function () {
    if (document.hidden) return;
    if (!watching) return;
    paintBadge();   // 貯まっている数を更新（増えていくのが見える）
    save(false);
  }, SAVE_EVERY_MS);

  // タブを閉じる・離れる時に書き出す
  window.addEventListener("pagehide", function () { save(true); });
  document.addEventListener("visibilitychange", function () { if (document.hidden) save(false); else paintBadge(); });

  // 外から集計を読めるように（点検・確かめ用）
  window.__axlxHumanLearnReport = function () {
    var det = { moves: [], points: [], scrolls: [] };
    try { det = rec.detail(); } catch (_) {}
    return {
      watching: watching, site: site, ops: rec.count(), lock: LEARN_LOCK,
      shooting: _shooting,   // 2026-11-11: 写真を撮る見張りが動いているか（モードに関係なく動く）
      moves: (det.moves || []).length, points: (det.points || []).length, scrolls: (det.scrolls || []).length,
      detail: det,          // 中身（何をどう覚えたか）も見られるように
      summarizeMotion: function () { try { return L.summarizeMotion(det); } catch (_) { return null; } },
    };
  };
  /**
   * 2026-11-11 竹内さん「動き理解できているかな」:
   *   いま貯まっている物と、DB に貯まっている物を**その場で**確かめられるようにする。
   *   コンソールで `__axlxLearnNow()` と打つと全部出る。
   */
  window.__axlxLearnNow = function (cb) {
    var out = { この画面: window.__axlxHumanLearnReport() };
    try {
      chrome.storage.local.get([KEY, PROFILE_KEY, "axlx_human_learn_uploaded_at"], function (r) {
        out.貯まった合計 = r && r[KEY] ? { 操作: r[KEY].n, マウス: r[KEY].moves && r[KEY].moves.n, 押した所: r[KEY].points && r[KEY].points.n, スクロール: r[KEY].scrolls && r[KEY].scrolls.n } : null;
        out.理解した動き = (r && r[PROFILE_KEY]) || null;
        out.最後に送った時刻 = r && r.axlx_human_learn_uploaded_at ? new Date(r.axlx_human_learn_uploaded_at).toLocaleString("ja-JP") : "まだ";
        console.log("[AX] 学習の状態:", out);
        if (typeof cb === "function") cb(out);
      });
    } catch (_) { console.log("[AX] 学習の状態:", out); if (typeof cb === "function") cb(out); }
    return out;
  };
  /** いま貯まっている物を、その場で DB へ送る（確かめたい時） */
  window.__axlxLearnSendNow = function () {
    try {
      chrome.storage.local.get([KEY], function (r) {
        var agg = r && r[KEY];
        if (!agg || !agg.n) { console.warn("[AX] 送る物がありません（まだ貯まっていない）"); return; }
        var U = (typeof self !== "undefined" ? self : window).__axlxHumanMotionUploadNow;
        if (typeof U !== "function") { console.warn("[AX] 送る係（human-learn-upload.js）が居ません"); return; }
        U(agg);
        console.log("[AX] DB へ送りました:", agg.n + "回分");
      });
    } catch (_) {}
  };
})();
