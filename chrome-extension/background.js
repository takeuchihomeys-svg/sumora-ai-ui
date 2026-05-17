"use strict";

// サイドパネルをアイコンクリックで開く設定
// onInstalled・onStartup・即時の3箇所で呼ぶ（service worker 再起動対策）
function setupSidePanel() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((e) => console.error("sidePanel setup error:", e));
  }
}

chrome.runtime.onInstalled.addListener(setupSidePanel);
chrome.runtime.onStartup.addListener(setupSidePanel);
setupSidePanel(); // 即時実行（初回対策）
