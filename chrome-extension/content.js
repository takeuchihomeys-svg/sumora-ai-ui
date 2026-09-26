"use strict";

// 2026-09-27 竹内「拡張ツールは人間らしい動きをするために全て時間ランダムにする」: 人の操作の間（human-wait.js・manifest で先に読む）。
//   読めない時は元の値。_axContentHd＝人の操作の間（0.8〜1.5倍）／_axContentSd＝画面が落ち着くのを待つ固定の秒数（元より短くしない）
function _axContentHd(ms) { var H = (typeof self !== "undefined" ? self : window).AxlxHumanWait; return H ? H.humanDelay(ms) : ms; }
function _axContentSd(ms) { var H = (typeof self !== "undefined" ? self : window).AxlxHumanWait; return H ? H.settleDelay(ms) : ms; }

// リアプロ 左サイドバー強制表示スクリプト v8 - 包括対策版
(function () {
  const SIDEBAR_MARKERS = ["リスト検索", "所在地絞り込み", "沿線・駅絞り込み", "管理会社絞り込み"];

  // ══════════════════════════════════════════════════
  // STEP 1: ページのJSコンテキストに直接注入
  // content scriptのisolated worldではリアプロのJSに効かないため
  // scriptタグを使ってページ本体のJSとして実行させる
  // ══════════════════════════════════════════════════
  (function injectPageScript() {
    // 2026-09-27 待ち時間のばらつき（self.AxlxHumanWait）を page-script.js より先にページへ入れる。
    //   動的に足した <script> は既定で async（読み終わった順に動く）ので、async=false で入れた順に動かす。
    //   読めなくても page-script.js は元の値で動く（予備あり）。
    try {
      const hw = document.createElement("script");
      hw.src = chrome.runtime.getURL("human-wait.js");
      hw.async = false;
      hw.onload = function() { this.remove(); };
      (document.head || document.documentElement).appendChild(hw);
    } catch (_) { /* 予備で動く */ }
    const s = document.createElement("script");
    s.async = false;
    s.src = chrome.runtime.getURL("page-script.js");
    s.onload = function() { this.remove(); };
    (document.head || document.documentElement).appendChild(s);
  })();

  // ══════════════════════════════════════════════════
  // STEP 2: CSSメディアクエリをスキャンして隠し規則を上書き
  // リアプロが @media (max-width: Npx) で隠している要素を !important で復元
  // ══════════════════════════════════════════════════
  function overrideHidingMQRules() {
    if (!document.head) return;
    if (document.getElementById("aixlinx-mq-fix")) return;

    const overrides = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSMediaRule)) continue;
        const m = rule.media.mediaText.match(/max-width:\s*(\d+(?:\.\d+)?)px/i);
        if (!m || +m[1] < 900 || +m[1] > 1400) continue;
        for (const inner of Array.from(rule.cssRules)) {
          if (!(inner instanceof CSSStyleRule)) continue;
          if (inner.style.display === "none" || inner.style.visibility === "hidden") {
            overrides.push(
              `${inner.selectorText} { display: revert !important; visibility: visible !important; }`
            );
          }
        }
      }
    }

    if (overrides.length) {
      const el = document.createElement("style");
      el.id = "aixlinx-mq-fix";
      el.textContent = overrides.join("\n");
      document.head.appendChild(el);
    }
  }

  // ══════════════════════════════════════════════════
  // STEP 3: content scriptからもサイドバー監視＋クリック（二重対策）
  // ══════════════════════════════════════════════════
  function isSidebarVisible() {
    if (!document.body) return false;
    for (const marker of SIDEBAR_MARKERS) {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      let n;
      while ((n = w.nextNode())) {
        if (!n.textContent.includes(marker)) continue;
        let el = n.parentElement;
        while (el && el !== document.body) {
          const cs = window.getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") return false;
          el = el.parentElement;
        }
        return true;
      }
    }
    return false;
  }

  function clickShowBtn() {
    if (!document.body) return false;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let n;
    while ((n = w.nextNode())) {
      if (!n.textContent.trim().includes("検索条件を表示")) continue;
      let el = n.parentElement;
      if (window.getComputedStyle(el).display === "none") continue;
      let t = el;
      for (let i = 0; i < 6 && t && t !== document.body; t = t.parentElement, i++) {
        if (["A", "BUTTON"].includes(t.tagName) || t.onclick || t.getAttribute("onclick") ||
            window.getComputedStyle(t).cursor === "pointer") {
          t.click();
          return true;
        }
      }
      el.click();
      return true;
    }
    return false;
  }

  function fix() {
    if (!document.body) return;
    if (!isSidebarVisible()) clickShowBtn();
  }

  // resizeイベント（content scriptからも二重対策）
  window.addEventListener("resize", function () {
    [200, 600, 1500].forEach(function (d) { setTimeout(fix, _axContentHd(d)); });
  });

  // MutationObserver（ループ防止ロック付き）
  let lock = false;
  const obs = new MutationObserver(function () {
    if (lock) return;
    lock = true;
    setTimeout(function () { fix(); lock = false; }, 400);
  });

  function start() {
    fix();
    overrideHidingMQRules();
    obs.observe(document.documentElement, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ["style", "class"],
    });
    setInterval(fix, 3000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  window.addEventListener("load", function () {
    overrideHidingMQRules();
    [500, 1500, 3000].forEach(function (d) { setTimeout(fix, d); });
  });
})();

// URLパラメータ検知：?sumora_cid=<ID> でページを開いたとき自動入力をトリガー
// page-script.js はこのファイルの冒頭ですでに注入済みのため直接 postMessage する
(function () {
  "use strict";
  var _cid = new URLSearchParams(window.location.search).get("sumora_cid");
  if (!_cid) return;

  function _buildConditions(c) {
    return {
      rent_max:     c.rent_max || c.max_rent || null,
      rent_min:     c.rent_min || null,
      walk_minutes: c.walk_minutes || null,
      building_age: c.building_age || null,
      floor_plan:   c.floor_plan || c.layout || null,
      is_wide:      false,
      area_min:     c.floor_area_min || c.area_min || c.min_area || null,
      area_max:     c.floor_area_max || c.area_max || c.max_area || null,
      pet_ok:       !!(c.pet),
    };
  }

  function _run() {
    // CSP対策: content scriptから直接fetchするとリアプロのCSPでブロックされるため
    // background.js (Service Worker) 経由でfetchしてもらう
    chrome.runtime.sendMessage(
      { type: "axlx-fetch-customer", customerId: _cid },
      function (resp) {
        if (chrome.runtime.lastError) {
          console.warn("[content] sendMessage error:", chrome.runtime.lastError.message);
          return;
        }
        var c = resp && resp.customer;
        if (!c) {
          console.warn("[content] sumora_cid not found:", _cid);
          return;
        }
        // page-script.js がリスナーを登録し終わるまで余裕を持たせてから送信
        setTimeout(function () {
          window.postMessage({ from: "aixlinx-fill", conditions: _buildConditions(c) }, "*");
        }, _axContentSd(1000));
      }
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _run);
  } else {
    setTimeout(_run, 300);
  }
})();

// background.js からの自動入力トリガー（executeScript を使わずに sendMessage 経由で呼ぶ）
var _pendingFillCustomerId = null; // axlx-set-fill-customer で設定される現在処理中の顧客ID
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.type === "axlx-ping") {
      sendResponse({ ok: true });
      return true;
    }
    // fill-done relay に customerId を付与するため、autofill 前に顧客IDをセットしておく
    if (msg.type === "axlx-set-fill-customer") {
      _pendingFillCustomerId = msg.customerId || null;
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type !== "axlx-realnetpro-autofill") return;
    // 2026-09-18 竹内（一括検索で違うお客さんの条件が送られるバグ）:
    //   「誰の自動入力か」を依頼と一緒に page-script へ渡す。page-script はこの ID をそのまま
    //   fill-done に載せて返すので、遅れて届いたシグナルに**次の顧客の ID が付く**ことがなくなる。
    //   （旧: fill-done を中継する時に「その時点の _pendingFillCustomerId」を付けていた）
    var _fillCid = msg.customerId || _pendingFillCustomerId || null;
    setTimeout(function () {
      window.postMessage({ from: "axlx-autofill-initiated" }, "*");
      window.postMessage({ from: "aixlinx-fill", conditions: msg.conditions, customerId: _fillCid }, "*");
    }, _axContentHd(500)); // 自動入力を始めるまでの間（毎回ばらつかせる）
    sendResponse({ ok: true });
  });
}

// 修正4+CRITICAL1: page-script.js の検索実行完了シグナル（aixlinx-fill-done）を background.js へ中継する
// customerId を含めることで、別顧客のウェイターを誤解決するバグを防止する
window.addEventListener("message", function (e) {
  if (e.source !== window || !e.data || e.data.from !== "aixlinx-fill-done") return;
  try {
    chrome.runtime.sendMessage({
      type: "axlx-fill-done",
      site: "realnetpro",
      // 2026-09-18: シグナルに載っている ID（＝その入力を始めた時の顧客）を最優先。
      //   「今の _pendingFillCustomerId」は、遅れて届いた時に次の顧客を指してしまう
      customerId: e.data.customerId || _pendingFillCustomerId || null,
      // 2026-09-25 検索の点検（ブレインの時だけ page-script が載せる）: その回の run_id と audit をそのまま中継
      runId: e.data.runId || null,
      audit: e.data.audit || null,
      // ⚠ error ではなく pageError（点検の記録だけに使う）。error で渡すと _notifyFillDone が検索を止める動きに変わる（今まで中継していなかった＝動きは変えない）
      pageError: e.data.error || null,
    }, function () {
      void chrome.runtime.lastError;
    });
  } catch (err) {
    // 拡張リロード等で context が失われた場合は無視
  }
});
