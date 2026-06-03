"use strict";

// underbar（フローティングパネル）を使うサイト → サイドパネルを無効化
const UNDERBAR_SITES = ["realnetpro.com"];

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
    if (chrome.runtime.lastError) return;
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

// ── PDF取得用クッキー収集 ──────────────────────────────
// ブラウザのfetch/XHRはSameSite制限でクッキーが送れないケースがある。
// サーバー側でPDFを代理取得するため、chrome.cookies APIでセッションクッキーを収集して渡す。
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.type !== "axlx-fetch-pdfs") return false;

  // domain指定でwwwあり/なし両方のクッキーを取得
  chrome.cookies.getAll({ domain: "realnetpro.com" }, function (cookies) {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: "Cookie取得エラー: " + chrome.runtime.lastError.message });
      return;
    }
    var cookieStr = (cookies || []).map(function (c) { return c.name + "=" + c.value; }).join("; ");
    if (!cookieStr) {
      sendResponse({ ok: false, error: "リアプロのセッションクッキーが見つかりません。リアプロにログインしてから再試行してください。" });
      return;
    }
    sendResponse({ ok: true, cookie_str: cookieStr });
  });

  return true; // 非同期レスポンス
});
