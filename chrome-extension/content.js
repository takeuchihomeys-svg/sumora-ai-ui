"use strict";

// リアプロ 左サイドバー強制表示スクリプト v3
(function () {
  const STYLE_ID = "aixlinx-sidebar-fix";
  const SIDEBAR_MARKERS = ["リスト検索", "所在地絞り込み", "沿線・駅絞り込み", "管理会社絞り込み"];

  // ── Strategy 1: CSS注入 ──
  function injectCSS() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      html, body {
        min-width: 1200px !important;
        overflow-x: auto !important;
      }
      /* テーブルレイアウトの左列を強制表示 */
      td:first-child,
      th:first-child {
        display: table-cell !important;
        visibility: visible !important;
        width: auto !important;
      }
      /* よく使われる左メニュー系クラス・ID を網羅 */
      #left, #left_menu, #left_column, #left_nav, #left_panel,
      #leftMenu, #leftColumn, #searchPanel, #search_panel,
      #search_area, #searchArea, #sidebar, #side_bar,
      .left, .left_menu, .left_column, .left_nav,
      .leftMenu, .leftColumn, .searchPanel, .search_panel,
      .sidebar, .side_bar, .side-bar, #sidenav, .sidenav,
      [id^="left"], [class^="left_"],
      [id*="search"][id*="panel"], [id*="side"] {
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
        width: auto !important;
      }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  // ── Strategy 2: テキストからサイドバーを特定して強制表示 ──
  function forceShowSidebar() {
    if (!document.body) return;

    for (const marker of SIDEBAR_MARKERS) {
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent.includes(marker)) {
          let el = node.parentElement;
          for (let i = 0; i < 10; i++) {
            if (!el || el === document.body) break;
            const cs = window.getComputedStyle(el);
            if (
              cs.display === "none" ||
              cs.visibility === "hidden" ||
              cs.opacity === "0" ||
              cs.width === "0px"
            ) {
              el.style.setProperty("display", "block", "important");
              el.style.setProperty("visibility", "visible", "important");
              el.style.setProperty("opacity", "1", "important");
              if (cs.width === "0px") el.style.setProperty("width", "auto", "important");
            }
            el = el.parentElement;
          }
          return;
        }
      }
    }
  }

  // ── Strategy 3: window.innerWidth をリアプロに大きく見せる ──
  try {
    const origInner = Object.getOwnPropertyDescriptor(Window.prototype, "innerWidth");
    if (origInner && origInner.get) {
      Object.defineProperty(window, "innerWidth", {
        get: function () { return Math.max(origInner.get.call(window), 1300); },
        configurable: true,
      });
    }
  } catch (e) {}

  // outerWidth も上書き
  try {
    const origOuter = Object.getOwnPropertyDescriptor(Window.prototype, "outerWidth");
    if (origOuter && origOuter.get) {
      Object.defineProperty(window, "outerWidth", {
        get: function () { return Math.max(origOuter.get.call(window), 1300); },
        configurable: true,
      });
    }
  } catch (e) {}

  // ── Strategy 4: resizeイベント後に強制再表示 ──
  // Chromeサイドパネルが開くとresizeが発火してリアプロがサイドバーを隠す
  window.addEventListener("resize", function () {
    setTimeout(function () {
      injectCSS();
      forceShowSidebar();
    }, 150);
    setTimeout(function () {
      forceShowSidebar();
    }, 500);
  });

  // ── 実行 ──
  injectCSS();

  // DOM変化（childList・属性変更）を監視して都度適用
  const observer = new MutationObserver(() => {
    injectCSS();
    forceShowSidebar();
  });

  function start() {
    injectCSS();
    forceShowSidebar();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    // 3秒ごとの定期強制表示（JSによる遅延非表示の最終対策）
    setInterval(() => { forceShowSidebar(); }, 3000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  window.addEventListener("load", () => {
    injectCSS();
    forceShowSidebar();
  });

  setTimeout(() => { injectCSS(); forceShowSidebar(); }, 500);
  setTimeout(() => { injectCSS(); forceShowSidebar(); }, 1500);
  setTimeout(() => { injectCSS(); forceShowSidebar(); }, 3000);
  setTimeout(() => { injectCSS(); forceShowSidebar(); }, 5000);
})();
