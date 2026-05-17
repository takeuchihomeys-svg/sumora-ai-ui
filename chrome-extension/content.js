"use strict";

// リアプロ 左サイドバー強制表示スクリプト v6
(function () {
  const SIDEBAR_MARKERS = ["リスト検索", "所在地絞り込み", "沿線・駅絞り込み", "管理会社絞り込み"];

  // 要素の種類に合った display 値を返す（td に block を設定するとテーブルが崩れる）
  function correctDisplay(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "td" || tag === "th") return "table-cell";
    if (tag === "tr") return "table-row";
    if (tag === "thead" || tag === "tbody" || tag === "tfoot") return "table-row-group";
    if (tag === "colgroup" || tag === "col") return "table-column";
    if (tag === "table") return "table";
    if (tag === "li") return "list-item";
    return "block";
  }

  // bodyまで全遡り → 最上位の隠し祖先を特定して正しい display で表示
  function forceShowSidebar() {
    if (!document.body) return;

    for (const marker of SIDEBAR_MARKERS) {
      const walker = document.createTreeWalker(
        document.body, NodeFilter.SHOW_TEXT, null, false
      );
      let node;
      while ((node = walker.nextNode())) {
        if (!node.textContent.includes(marker)) continue;

        // bodyまで全階層を遡り、最上位の非表示要素を特定
        let topHidden = null;
        let el = node.parentElement;
        while (el && el !== document.body && el !== document.documentElement) {
          const cs = window.getComputedStyle(el);
          if (
            cs.display === "none" ||
            cs.visibility === "hidden" ||
            cs.opacity === "0" ||
            parseFloat(cs.width) < 1
          ) {
            topHidden = el;
          }
          el = el.parentElement;
        }

        if (topHidden) {
          // td/tr/table などテーブル要素は正しい display 値で復元
          const dispVal = correctDisplay(topHidden);
          topHidden.style.setProperty("display", dispVal, "important");
          topHidden.style.setProperty("visibility", "visible", "important");
          topHidden.style.setProperty("opacity", "1", "important");
          topHidden.style.setProperty("width", "auto", "important");
          topHidden.style.setProperty("overflow", "visible", "important");
        }
        return;
      }
    }
  }

  // window.innerWidth / outerWidth を常に1300px以上に見せる
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

  // Chromeサイドパネルを開くとresizeが発火 → 発火後に強制再表示
  window.addEventListener("resize", function () {
    setTimeout(forceShowSidebar, 100);
    setTimeout(forceShowSidebar, 400);
    setTimeout(forceShowSidebar, 1000);
    setTimeout(forceShowSidebar, 2000);
  });

  // DOM変化・style/class属性変更を監視して即座に再表示
  const observer = new MutationObserver(forceShowSidebar);

  function start() {
    forceShowSidebar();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    setInterval(forceShowSidebar, 2000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  window.addEventListener("load", forceShowSidebar);
  setTimeout(forceShowSidebar, 300);
  setTimeout(forceShowSidebar, 800);
  setTimeout(forceShowSidebar, 2000);
  setTimeout(forceShowSidebar, 4000);
})();
