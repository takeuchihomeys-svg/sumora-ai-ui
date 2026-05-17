"use strict";

// リアプロ 左サイドバー強制表示スクリプト v7
// 「検索条件を表示」ボタンを自動クリックするアプローチ
(function () {
  const SIDEBAR_MARKERS = ["リスト検索", "所在地絞り込み", "沿線・駅絞り込み", "管理会社絞り込み"];

  // サイドバーが現在表示されているか確認
  function isSidebarVisible() {
    if (!document.body) return false;
    for (const marker of SIDEBAR_MARKERS) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.textContent.includes(marker)) continue;
        // テキストが見つかった → 非表示の祖先があるか確認
        let el = node.parentElement;
        while (el && el !== document.body) {
          const cs = window.getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") return false;
          el = el.parentElement;
        }
        return true; // 可視状態
      }
    }
    return false; // マーカー未検出（ページが未読込など）
  }

  // リアプロ自身の「検索条件を表示」ボタンをクリック
  function clickShowConditionsBtn() {
    if (!document.body) return false;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (!text.includes("検索条件を表示")) continue;
      // ボタン自体が可視かチェック
      let el = node.parentElement;
      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      // クリック可能な要素を上に遡って探す
      let target = el;
      for (let i = 0; i < 6; i++) {
        if (!target || target === document.body) break;
        const tag = target.tagName.toLowerCase();
        if (
          tag === "a" || tag === "button" ||
          target.onclick || target.getAttribute("onclick") ||
          target.style.cursor === "pointer" ||
          window.getComputedStyle(target).cursor === "pointer"
        ) {
          target.click();
          return true;
        }
        target = target.parentElement;
      }
      // cursor が見つからなくても試しにクリック
      el.click();
      return true;
    }
    return false;
  }

  // メイン処理：サイドバーが閉じていたら自動で開く
  function fixSidebar() {
    if (!document.body) return;
    if (!isSidebarVisible()) {
      clickShowConditionsBtn();
    }
  }

  // window.innerWidth / outerWidth を常に1300px以上に見せる（JSによる非表示対策）
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

  // Chromeサイドパネル開閉でresizeが発火 → 自動で「検索条件を表示」クリック
  window.addEventListener("resize", function () {
    setTimeout(fixSidebar, 300);
    setTimeout(fixSidebar, 800);
    setTimeout(fixSidebar, 1500);
  });

  // DOM変化を監視（リアプロがサイドバーを隠したら即再クリック）
  let observerLock = false;
  const observer = new MutationObserver(function () {
    if (observerLock) return;
    observerLock = true;
    setTimeout(function () {
      fixSidebar();
      observerLock = false;
    }, 200);
  });

  function start() {
    fixSidebar();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    setInterval(fixSidebar, 3000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  window.addEventListener("load", function () {
    setTimeout(fixSidebar, 500);
    setTimeout(fixSidebar, 1500);
  });
})();
