"use strict";

// underbar（フローティングパネル）を使うサイト → サイドパネルを無効化
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

// ── PDF取得用クッキー収集 ──────────────────────────────────────────────────
// 【根本修正】MV3 module SW + callback = SW suspend 既知不具合
//   → 全て async/await (Promise) に統一して SW が suspend されないようにする
//
// 3段階フォールバック:
//   1. chrome.cookies.getAll({ domain }) → HttpOnly 含む全クッキー
//   2. document.cookie を executeScript MAIN world で取得 → 非HttpOnlyのみ
//   3. 両方失敗 → 詳細エラー
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "axlx-fetch-pdfs") return false;

  const tabId = sender.tab?.id ?? null;

  // async/await で書くことで SW の lifecycle に追跡させる
  (async () => {
    try {
      // ── Step 1: chrome.cookies API (Promise形式) ─────────────────
      const cookies = await chrome.cookies.getAll({ domain: "realnetpro.com" });
      const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

      if (cookieStr) {
        sendResponse({ ok: true, cookie_str: cookieStr });
        return;
      }

      // ── Step 2: document.cookie fallback ─────────────────────────
      if (!tabId) throw new Error("tabId不明: リアプロのタブで操作してください");

      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => document.cookie,
      });

      const docCookie = results?.[0]?.result ?? "";
      if (docCookie) {
        sendResponse({ ok: true, cookie_str: docCookie });
        return;
      }

      // ── Step 3: 両方空 → 詳細エラー ─────────────────────────────
      throw new Error(
        "クッキーが見つかりません（chrome.cookies: 0件, document.cookie: 空）\n" +
        "リアプロにログインしてから再試行してください。"
      );
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();

  return true; // チャンネルを非同期で保持
});
