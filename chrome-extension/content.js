"use strict";

// リアプロ 左サイドバー強制表示スクリプト v8 - 包括対策版
(function () {
  const SIDEBAR_MARKERS = ["リスト検索", "所在地絞り込み", "沿線・駅絞り込み", "管理会社絞り込み"];

  // ══════════════════════════════════════════════════
  // STEP 1: ページのJSコンテキストに直接注入
  // content scriptのisolated worldではリアプロのJSに効かないため
  // scriptタグを使ってページ本体のJSとして実行させる
  // ══════════════════════════════════════════════════
  (function injectPageScript() {
    const s = document.createElement("script");
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
    [200, 600, 1500].forEach(function (d) { setTimeout(fix, d); });
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
    fetch("https://sumora-ai-ui.vercel.app/api/property-customers", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (list) {
        var c = Array.isArray(list)
          ? list.find(function (x) { return String(x.id) === String(_cid); })
          : null;
        if (!c) {
          console.warn("[content] sumora_cid not found:", _cid);
          return;
        }
        // page-script.js がリスナーを登録し終わるまで余裕を持たせてから送信
        setTimeout(function () {
          window.postMessage({ from: "aixlinx-fill", conditions: _buildConditions(c) }, "*");
        }, 1000);
      })
      .catch(function (e) {
        console.warn("[content] URLパラメータ自動入力エラー:", e);
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _run);
  } else {
    setTimeout(_run, 300);
  }
})();
