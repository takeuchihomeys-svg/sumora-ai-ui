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

// ── PDF取得：ページコンテキストで fetch → base64配列を返す ───────────────
// 診断結果: fetch(url, {credentials:"include"}) → 200 application/x-download ✅
// ページのセッションクッキーが自然に使われるため認証問題なし。
// async/await で SW が suspend されないようにする（MV3 module SW の既知問題対策）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "axlx-fetch-pdfs") return false;

  const tabId = sender.tab?.id;
  if (!tabId) {
    sendResponse({ ok: false, error: "tabId不明。リアプロのページで操作してください。" });
    return true;
  }

  (async () => {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: function (urls) {
          function toBase64(buf) {
            const bytes = new Uint8Array(buf);
            let binary = "";
            const chunk = 8192;
            for (let i = 0; i < bytes.length; i += chunk) {
              binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
            }
            return btoa(binary);
          }
          return Promise.all(
            urls.map((url) =>
              fetch(url, { credentials: "include" })
                .then((r) => {
                  if (!r.ok) throw new Error("HTTP " + r.status + " (" + url + ")");
                  return r.arrayBuffer();
                })
                .then((buf) => toBase64(buf))
            )
          );
        },
        args: [msg.urls],
      });

      const pdf_data = results?.[0]?.result;
      if (!Array.isArray(pdf_data) || pdf_data.length === 0) {
        throw new Error("PDFデータが空でした。ページを再読み込みして再試行してください。");
      }
      sendResponse({ ok: true, pdf_data });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();

  return true;
});
