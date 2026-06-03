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

// ── PDF一括取得（コンテンツスクリプトからのリクエストを処理） ──────────────
// コンテンツスクリプトでのfetchはCORS制限を受けるため
// バックグラウンドスクリプト経由でfetchすることで回避する
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.type !== "axlx-fetch-pdfs") return false;

  var urls = msg.urls || [];

  Promise.all(urls.map(function (url) {
    return fetch(url, { credentials: "include" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) {
        // ArrayBuffer → base64
        var bytes = new Uint8Array(buf);
        var binary = "";
        var chunk = 8192;
        for (var i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
      });
  }))
    .then(function (pdf_data) { sendResponse({ ok: true, pdf_data: pdf_data }); })
    .catch(function (e) { sendResponse({ ok: false, error: e.message }); });

  return true; // 非同期レスポンスを示すためにtrueを返す
});
