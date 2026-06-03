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

chrome.tabs.onActivated.addListener(function ({ tabId }) {
  chrome.tabs.get(tabId, function (tab) {
    if (chrome.runtime.lastError) return;
    if (tab && tab.url) configureSidePanelForTab(tabId, tab.url);
  });
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (changeInfo.url) {
    configureSidePanelForTab(tabId, changeInfo.url);
  } else if (changeInfo.status === "complete" && tab.url) {
    configureSidePanelForTab(tabId, tab.url);
  }
});

// ── PDF取得用クッキー収集 ──────────────────────────────
// 戦略: 3段階フォールバック
//   1. chrome.cookies.getAll（HttpOnly含む全クッキー）
//   2. scripting.executeScript MAIN世界でdocument.cookie（非HttpOnlyのみ）
//   3. 両方失敗 → エラー
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.type !== "axlx-fetch-pdfs") return false;

  var tabId = sender.tab && sender.tab.id;

  // ── Step 1: chrome.cookies API（ドット付きドメイン込みで全取得）──
  chrome.cookies.getAll({ domain: "realnetpro.com" }, function (cookies) {
    if (chrome.runtime.lastError) {
      console.warn("[AXLX] cookies.getAll error:", chrome.runtime.lastError.message);
    }

    var cookieStr = (cookies || [])
      .map(function (c) { return c.name + "=" + c.value; })
      .join("; ");

    if (cookieStr) {
      console.log("[AXLX] cookies API で取得成功:", (cookies || []).length, "件");
      sendResponse({ ok: true, cookie_str: cookieStr });
      return;
    }

    // ── Step 2: ページのdocument.cookieをフォールバックとして使用 ──
    // chrome.cookies APIが空の場合（ドメイン権限の不一致等）でも
    // 非HttpOnlyなクッキーはページコンテキストから取得できる
    if (!tabId) {
      sendResponse({ ok: false, error: "tabId不明・クッキー取得不可" });
      return;
    }

    console.warn("[AXLX] cookies API が空 → scripting fallback を試みます");

    chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: "MAIN",
      func: function () { return document.cookie; },
    })
      .then(function (results) {
        var docCookie = results && results[0] && results[0].result;
        if (docCookie) {
          console.log("[AXLX] document.cookie fallback 成功");
          sendResponse({ ok: true, cookie_str: docCookie });
        } else {
          sendResponse({
            ok: false,
            error: "クッキーが取得できませんでした。\nリアプロに再ログインしてから再試行してください。",
          });
        }
      })
      .catch(function (e) {
        sendResponse({ ok: false, error: "クッキー取得エラー: " + e.message });
      });
  });

  return true; // 非同期レスポンス
});
