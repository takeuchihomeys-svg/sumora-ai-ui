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

// ── PDF一括取得（ページコンテキストに注入してSameSiteクッキー問題を回避） ──
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.type !== "axlx-fetch-pdfs") return false;

  var tabId = sender.tab && sender.tab.id;
  if (!tabId) { sendResponse({ ok: false, error: "tabId不明" }); return true; }

  // ページのコンテキストで実行（セッションクッキーが確実に使われる）
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    world: "MAIN",
    func: function (urls) {
      function toBase64(buf) {
        var bytes = new Uint8Array(buf);
        var binary = "";
        var chunk = 8192;
        for (var i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
        }
        return btoa(binary);
      }
      return Promise.all(urls.map(function (url) {
        // まずsame-origin credentials付きで試行
        return fetch(url, { credentials: "same-origin" })
          .then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            var ct = r.headers.get("content-type") || "";
            // PDFでない場合（HTMLリダイレクト等）
            if (ct.includes("text/html")) {
              throw new Error("PDFではなくHTMLが返されました（ログイン切れの可能性）");
            }
            return r.arrayBuffer();
          })
          .then(function (buf) { return toBase64(buf); })
          .catch(function (e) {
            // fallback: includeで再試行
            console.warn("[AXLX] same-origin失敗、includeで再試行:", e.message);
            return fetch(url, { credentials: "include" })
              .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.arrayBuffer();
              })
              .then(function (buf) { return toBase64(buf); });
          });
      }));
    },
    args: [msg.urls],
  })
    .then(function (results) {
      var result = results && results[0] && results[0].result;
      if (!result) throw new Error("結果が空です");
      sendResponse({ ok: true, pdf_data: result });
    })
    .catch(function (e) {
      sendResponse({ ok: false, error: e.message });
    });

  return true;
});
