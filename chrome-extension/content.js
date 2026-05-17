"use strict";

// リアプロ 左サイドバー強制表示スクリプト v4
// CSS は manifest の content.css で注入済み（JSからの注入は廃止）
(function () {
  const SIDEBAR_MARKERS = ["リスト検索", "所在地絞り込み", "沿線・駅絞り込み", "管理会社絞り込み"];

  // ── Strategy 1: テキストからサイドバーを特定して強制表示 ──
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

  // ── Strategy 2: window.innerWidth をリアプロに大きく見せる ──
  try {
    const origInner = Object.getOwnPropertyDescriptor(Window.prototype, "innerWidth");
    if (origInner && origInner.get) {
      Object.defineProperty(window, "innerWidth", {
        get: function () { return Math.max(origInner.get.call(window), 1300); },
        configurable: true,
      });
    }
  } catch (e) {}

  try {
    const origOuter = Object.getOwnPropertyDescriptor(Window.prototype, "outerWidth");
    if (origOuter && origOuter.get) {
      Object.defineProperty(window, "outerWidth", {
        get: function () { return Math.max(origOuter.get.call(window), 1300); },
        configurable: true,
      });
    }
  } catch (e) {}

  // ── Strategy 3: resizeイベント後に強制再表示 ──
  // Chromeサイドパネルが開くと resize が発火してリアプロがサイドバーを隠す
  window.addEventListener("resize", function () {
    setTimeout(forceShowSidebar, 150);
    setTimeout(forceShowSidebar, 600);
  });

  // ── DOM変化・属性変更を監視して都度適用 ──
  const observer = new MutationObserver(forceShowSidebar);

  function start() {
    forceShowSidebar();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    // 3秒ごとの定期強制表示（JSによる遅延非表示の最終対策）
    setInterval(forceShowSidebar, 3000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  window.addEventListener("load", forceShowSidebar);

  setTimeout(forceShowSidebar, 500);
  setTimeout(forceShowSidebar, 1500);
  setTimeout(forceShowSidebar, 3000);
})();
