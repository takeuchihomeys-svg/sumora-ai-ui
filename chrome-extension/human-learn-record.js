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
  var SAVE_EVERY_MS = 60000;   // 1分ごとに書き出す（操作のたびに書かない）
  var MIN_OPS_TO_SAVE = 5;     // 5回未満は書かない（誤操作・一瞬のクリックだけを貯めない）
  var LEARN_LOCK = "human-learn-record.js";

  var L = (typeof self !== "undefined" ? self : window).AxlxHumanLearn;
  if (!L) return;

  var rec = L.create({});
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
    try {
      chrome.storage.local.get([KEY], function (r) {
        try {
          var next = L.mergeAggregate(r && r[KEY], add);
          next.at = Date.now();
          next.site = site;
          var o = {}; o[KEY] = next;
          chrome.storage.local.set(o, function () {
            _saving = false;
            rec.reset();
            try { void chrome.runtime.lastError; } catch (_) {}
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
    if (watching) save(false);
  }, SAVE_EVERY_MS);

  // タブを閉じる・離れる時に書き出す
  window.addEventListener("pagehide", function () { save(true); });
  document.addEventListener("visibilitychange", function () { if (document.hidden) save(false); });

  // 外から集計を読めるように（点検・画面用）
  window.__axlxHumanLearnReport = function () {
    return { watching: watching, site: site, ops: rec.count(), lock: LEARN_LOCK };
  };
})();
