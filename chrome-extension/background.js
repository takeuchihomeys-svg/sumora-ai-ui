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

// ── ページの fetch() でPDFを直接取得 ──────────────────────────────────────
// MAIN world で実行 → ページの認証クッキーをそのまま使える
// CDPデバッガ不要（DevTools 開いていても問題なし）・ファイルピッカー不要
async function fetchPdfsViaPageFetch(tabId, urls) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (urlList) => {
      const pdfs = [];
      for (const url of urlList) {
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) {
          throw new Error("HTTP " + resp.status + " (" + url + ")");
        }
        const ct = resp.headers.get("content-type") || "";
        if (ct.includes("text/html")) {
          throw new Error("PDFではなくHTMLが返されました。リアプロに再ログインしてください。");
        }
        const buffer = await resp.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        // base64 変換（8KB チャンク方式でスタックオーバーフロー防止）
        const chunks = [];
        for (let i = 0; i < bytes.length; i += 8192) {
          chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
        }
        pdfs.push(btoa(chunks.join("")));
      }
      return pdfs;
    },
    args: [urls],
  });

  const pdf_data = result?.[0]?.result;
  if (!Array.isArray(pdf_data) || pdf_data.length === 0) {
    throw new Error("PDFが取得できませんでした");
  }
  return pdf_data;
}

// ── メッセージハンドラ ─────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "axlx-fetch-pdfs") return false;

  const tabId = sender.tab?.id;
  if (!tabId) {
    sendResponse({ ok: false, error: "tabId不明。リアプロのページで操作してください。" });
    return true;
  }

  (async () => {
    try {
      const pdf_data = await fetchPdfsViaPageFetch(tabId, msg.urls);
      if (!pdf_data?.length) throw new Error("PDFが取得できませんでした。");
      sendResponse({ ok: true, pdf_data });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();

  return true;
});
