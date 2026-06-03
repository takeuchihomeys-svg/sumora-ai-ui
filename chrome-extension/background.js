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

// ── chrome.debugger 経由でPDFを取得 ───────────────────────────────────────
// fetch/XHR はブラウザがダウンロードレスポンスをスクリプトから遮断するため失敗する。
// chrome.debugger (Network CDP) はそれより低レベルで動くため確実に取得できる。
// 手順:
//   1. debugger をタブにアタッチ
//   2. Network.enable で通信を監視
//   3. MAIN world で XHR を発火（JS 側は失敗してよい）
//   4. Network.loadingFinished → Network.getResponseBody で base64 取得
//   5. debugger をデタッチ
async function fetchPdfsViaDebugger(tabId, urls) {
  const debuggee = { tabId };

  await chrome.debugger.attach(debuggee, "1.3");

  try {
    await chrome.debugger.sendCommand(debuggee, "Network.enable", {});

    const urlToRid = new Map();   // url → requestId
    const ridToBody = new Map();  // requestId → base64

    const pdfData = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.debugger.onEvent.removeListener(onEvent);
        reject(new Error("PDF取得タイムアウト（30秒）。リアプロを再読み込みして再試行してください。"));
      }, 30000);

      async function onEvent(source, method, params) {
        if (source.tabId !== tabId) return;

        // リクエスト開始 → URL と requestId を紐付け
        if (method === "Network.requestWillBeSent") {
          const matched = urls.find((u) => params.request.url === u);
          if (matched) urlToRid.set(matched, params.requestId);
        }

        // リクエスト完了 → レスポンスボディを取得
        if (method === "Network.loadingFinished") {
          const isOurs = [...urlToRid.values()].includes(params.requestId);
          if (!isOurs) return;

          try {
            const r = await chrome.debugger.sendCommand(debuggee, "Network.getResponseBody", {
              requestId: params.requestId,
            });
            ridToBody.set(params.requestId, r.base64Encoded ? r.body : btoa(r.body));
          } catch (_) {}

          // 全 URL のボディが揃ったら完了
          const allDone = urls.every((u) => {
            const rid = urlToRid.get(u);
            return rid && ridToBody.has(rid);
          });

          if (allDone) {
            clearTimeout(timer);
            chrome.debugger.onEvent.removeListener(onEvent);
            const result = urls.map((u) => {
              const rid = urlToRid.get(u);
              return rid ? ridToBody.get(rid) : null;
            }).filter(Boolean);
            resolve(result);
          }
        }

        // ネットワークエラー
        if (method === "Network.loadingFailed") {
          const isOurs = [...urlToRid.values()].includes(params.requestId);
          if (isOurs) {
            clearTimeout(timer);
            chrome.debugger.onEvent.removeListener(onEvent);
            reject(new Error("PDFの読み込みに失敗しました: " + (params.errorText || "不明なエラー")));
          }
        }
      }

      chrome.debugger.onEvent.addListener(onEvent);

      // MAIN world から XHR を発火（JS 側のレスポンス受信は不要）
      chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (urlList) => {
          urlList.forEach((url) => {
            var xhr = new XMLHttpRequest();
            xhr.open("GET", url, true);
            xhr.withCredentials = true;
            xhr.send();
          });
        },
        args: [urls],
      });
    });

    return pdfData;

  } finally {
    // 必ずデタッチ（バナーを即解除）
    try {
      await chrome.debugger.sendCommand(debuggee, "Network.disable");
      await chrome.debugger.detach(debuggee);
    } catch (_) {}
  }
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
      const pdf_data = await fetchPdfsViaDebugger(tabId, msg.urls);
      if (!pdf_data?.length) throw new Error("PDFデータが空でした。");
      sendResponse({ ok: true, pdf_data });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();

  return true;
});
