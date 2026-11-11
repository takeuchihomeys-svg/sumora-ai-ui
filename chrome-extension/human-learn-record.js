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

  /** 通常・スタッフの時だけ覚える（自動・AIX は覚えない） */
  function shouldLearn(st) {
    var s = st || {};
    var at = s.staffModeAt || 0;
    var staffOn = !!s.staffMode && (!at || Date.now() - at <= 2 * 60 * 60 * 1000);
    if (staffOn) return true;
    var chosen = Number(s.autoModeAt) > 0;
    var autoOn = chosen && (!!s.aixMode || !!s.aiMode);
    return !autoOn; // 自動の印が無ければ通常
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
  var _shotLast = 0;
  var _shotCount = 0;
  var SHOT_MIN_GAP_MS = 400;   // これより短い間隔では撮らない
  var SHOT_MAX_PER_SESSION = 300; // 1ページで撮る上限（暴走しないように）
  function shootAfter(kind, el, pt) {
    try {
      if (!watching) return;
      var now = Date.now();
      if (now - _shotLast < SHOT_MIN_GAP_MS) return;
      if (_shotCount >= SHOT_MAX_PER_SESSION) return;
      if (_shotPending) return;   // 撮っている最中は重ねない
      _shotLast = now;
      _shotCount++;
      _shotPending = true;
      chrome.runtime.sendMessage({
        type: "axlx-human-shot",
        site: site,
        kind: kind,
        what: el ? (L.fieldName ? L.fieldName(el) : null) : null,
        x: pt && typeof pt.x === "number" ? pt.x : null,
        y: pt && typeof pt.y === "number" ? pt.y : null,
      }, function (res) {
        void chrome.runtime.lastError;
        _shotPending = false;
        if (res && res.ok) {
          try {
            var so = {};
            so.axlx_human_shot = { key: res.shot_key, at: Date.now(), seq: res.seq, run_id: res.run_id };
            chrome.storage.local.set(so);
          } catch (_) {}
        }
      });
    } catch (_) { _shotPending = false; }
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

  // ── モードを見る（通常・スタッフの時だけ覚える）──
  var KEYS = ["staffMode", "staffModeAt", "aixMode", "autoModeAt", "aiMode"];
  function apply(st) {
    if (shouldLearn(st)) { startWatching(); ensureBadge(); }
    else { stopWatching(); removeBadge(); }
  }
  try {
    chrome.storage.local.get(KEYS, function (r) { apply(r || {}); });
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== "local" || !ch) return;
      if (!("staffMode" in ch) && !("aixMode" in ch) && !("autoModeAt" in ch) && !("aiMode" in ch)) return;
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
