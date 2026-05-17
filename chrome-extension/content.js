"use strict";

// リアプロ左サイドバー常時表示フィックス
(function () {
  const STYLE_ID = "aixlinx-sidebar-fix";

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      /* AiXLINX Fix: サイドパネル併用時も左サイドバーを常に表示 */
      body, html {
        min-width: 1050px !important;
        overflow-x: auto !important;
      }
      /* リアプロ左メニューを強制表示 */
      #left_menu,
      .left_menu,
      #searchPanel,
      .search-panel,
      [id*="left"],
      [class*="left_nav"],
      [class*="side_menu"],
      [class*="search_menu"] {
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
        width: auto !important;
        max-height: none !important;
        overflow: visible !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // 即時注入
  injectStyle();

  // DOMが変わっても維持（リアプロはページ内遷移でheadを書き換えることがある）
  const observer = new MutationObserver(() => injectStyle());
  const target = document.head || document.documentElement;
  observer.observe(target, { childList: true, subtree: false });

  // ページロード後にも再確認
  document.addEventListener("DOMContentLoaded", injectStyle);
  window.addEventListener("load", injectStyle);
})();
