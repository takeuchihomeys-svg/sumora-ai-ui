"use strict";

// underbar（フローティングパネル）を使うサイト → サイドパネルを無効化
const UNDERBAR_SITES = ["realnetpro.com", "itandibb.com"];

function isUnderbarSite(url) {
  return !!url && UNDERBAR_SITES.some(function (s) { return url.includes(s); });
}

function setupSidePanel() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(function (e) { console.error("sidePanel setup error:", e); });
  }
}

function configureSidePanelForTab(tabId, url) {
  if (!chrome.sidePanel || !chrome.sidePanel.setOptions) return;
  chrome.sidePanel.setOptions({
    tabId: tabId,
    enabled: !isUnderbarSite(url),
  }).catch(function () {});
}

chrome.runtime.onInstalled.addListener(setupSidePanel);
chrome.runtime.onStartup.addListener(setupSidePanel);
setupSidePanel();

// タブがアクティブになったとき
chrome.tabs.onActivated.addListener(function ({ tabId }) {
  chrome.tabs.get(tabId, function (tab) {
    if (chrome.runtime.lastError) return; // タブが既に閉じられている場合など
    if (tab && tab.url) configureSidePanelForTab(tabId, tab.url);
  });
});

// タブのURLが変わったとき
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (changeInfo.url) {
    configureSidePanelForTab(tabId, changeInfo.url);
  } else if (changeInfo.status === "complete" && tab.url) {
    configureSidePanelForTab(tabId, tab.url);
  }
});
