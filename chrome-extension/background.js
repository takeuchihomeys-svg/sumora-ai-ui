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

// ── chrome.debugger (Fetch CDP) でPDFを直接取得 ──────────────────────────
//
// 仕組み:
//   Fetch.enable(requestStage:"Response") でタブの全HTTPレスポンスを一時停止
//   → Fetch.getResponseBody で確実にボディ取得（JS/CORS/CSP を完全に迂回）
//   → PDF判定（%PDF- の base64 = "JVBERi"）で目的のPDFを識別
//   → Fetch.continueRequest でリクエストを続行（ダウンロードも正常に動く）
//
// NetworkドメインではなくFetchドメインを使う理由:
//   Network.getResponseBody はダウンロードインターセプトされたレスポンスで
//   失敗することがある。Fetch.requestPaused は必ずボディを持つ。
async function fetchPdfsViaDebugger(tabId, urls) {
  const debuggee = { tabId };
  await chrome.debugger.attach(debuggee, "1.3");

  try {
    // 全レスポンスをPauseしてボディを読む（URL/リダイレクト問わず捕捉）
    await chrome.debugger.sendCommand(debuggee, "Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Response" }],
    });

    const capturedPdfs = [];

    const pdfData = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.debugger.onEvent.removeListener(handler);
        reject(new Error(
          "PDF取得タイムアウト（30秒）。\n" +
          "リアプロのページを再読み込みしてから再試行してください。"
        ));
      }, 30000);

      async function handler(source, method, params) {
        if (source.tabId !== tabId) return;
        if (method !== "Fetch.requestPaused") return;

        // 200以外は即continue（ブロックしない）
        if ((params.responseStatusCode ?? 0) !== 200) {
          chrome.debugger.sendCommand(debuggee, "Fetch.continueRequest", {
            requestId: params.requestId,
          });
          return;
        }

        // レスポンスボディを取得
        let body = null;
        try {
          const r = await chrome.debugger.sendCommand(debuggee, "Fetch.getResponseBody", {
            requestId: params.requestId,
          });
          body = r.base64Encoded ? r.body : btoa(r.body);
        } catch (_) {
          // ボディ取得失敗は無視して continue
        }

        // %PDF- の base64 先頭 = "JVBERi" → PDFと判定
        if (body && body.startsWith("JVBERi")) {
          capturedPdfs.push(body);
        }

        // リクエストを続行（ダウンロードも正常に進む）
        chrome.debugger.sendCommand(debuggee, "Fetch.continueRequest", {
          requestId: params.requestId,
        });

        // 指定件数分のPDFが揃ったら完了
        if (capturedPdfs.length >= urls.length) {
          clearTimeout(timer);
          chrome.debugger.onEvent.removeListener(handler);
          resolve(capturedPdfs);
        }
      }

      chrome.debugger.onEvent.addListener(handler);

      // MAIN world から XHR を発火（JS 側の応答は不要）
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
    // 必ず即 detach（デバッガバナーを消す）
    try {
      await chrome.debugger.sendCommand(debuggee, "Fetch.disable");
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
      if (!pdf_data?.length) throw new Error("PDFが取得できませんでした。");
      sendResponse({ ok: true, pdf_data });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();

  return true;
});
