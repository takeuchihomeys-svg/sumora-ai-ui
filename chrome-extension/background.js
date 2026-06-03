"use strict";

const UNDERBAR_SITES = ["realnetpro.com"];

function isUnderbarSite(url) {
  return !!url && UNDERBAR_SITES.some((s) => url.includes(s));
}

function setupSidePanel() {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}

function configureSidePanelForTab(tabId, url) {
  if (!chrome.sidePanel?.setOptions) return;
  chrome.sidePanel.setOptions({ tabId, enabled: !isUnderbarSite(url) }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(setupSidePanel);
chrome.runtime.onStartup.addListener(setupSidePanel);
setupSidePanel();

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.url) return;
    configureSidePanelForTab(tabId, tab.url);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || (changeInfo.status === "complete" ? tab.url : null);
  if (url) configureSidePanelForTab(tabId, url);
});

// ── メッセージハンドラ ─────────────────────────────────────────────────────
// コンテンツスクリプト（bulk-dl.js）は chrome.cookies API にアクセスできないため
// background 経由でリアプロのセッションクッキーを取得して返す。
// /api/merge-pdfs に pdf_urls + cookie_str を渡せば、
// Vercel サーバー側でリアプロ PDF を代理取得 → 結合 → LINE 送信できる。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "axlx-get-cookies") return false;

  const targetUrl = msg.url || "https://www.realnetpro.com/";
  chrome.cookies.getAll({ url: targetUrl }, (cookies) => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }
    const cookie_str = (cookies || []).map((c) => `${c.name}=${c.value}`).join("; ");
    if (!cookie_str) {
      sendResponse({ ok: false, error: "リアプロのクッキーが取得できません。リアプロにログインしてください。" });
      return;
    }
    sendResponse({ ok: true, cookie_str });
  });
  return true;
});
