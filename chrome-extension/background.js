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

// ── ヘルパー: リアプロのセッションクッキーを取得 ──────────────────────────
function getRealproCookies() {
  return new Promise((resolve, reject) => {
    chrome.cookies.getAll({ url: "https://www.realnetpro.com/" }, (cookies) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const cookie_str = (cookies || []).map((c) => `${c.name}=${c.value}`).join("; ");
      if (!cookie_str) {
        reject(new Error("リアプロのセッションが見つかりません。リアプロにログインしてください。"));
        return;
      }
      resolve(cookie_str);
    });
  });
}

// ── ヘルパー: /api/merge-pdfs を background から呼ぶ（CSP/CORS 完全回避）──
async function callMergeApi(payload) {
  const resp = await fetch("https://sumora-ai-ui.vercel.app/api/merge-pdfs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`サーバーエラー HTTP ${resp.status}: ${text.slice(0, 120)}`);
  }
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || "APIエラー");
  return data;
}

// ── メッセージハンドラ ─────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── itandi CSP回避: MAIN worldにPDFキャプチャフックを注入 ─────────────────
  // <script>タグ注入はCSPでブロックされるため chrome.scripting.executeScript を使う
  if (msg.type === "axlx-inject-pdf-hook") {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false }); return true; }
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        // v2: キャプチャ許可フラグ追加（過去PDFの誤キャプチャを防止）
        if (window.__axlxItandiHookV2) return;
        window.__axlxItandiHookV2 = true;
        window.__axlxCapturePending = false;

        // コンテンツスクリプトから "PDFを出力クリック直前" に送られるシグナルを受信
        window.addEventListener("message", function (e) {
          if (e.data && e.data.from === "axlx-start-pdf-capture") {
            window.__axlxCapturePending = true;
          }
        });

        // Blob URL フック（itandi が createObjectURL でPDFを作る場合）
        const origCreate = URL.createObjectURL;
        URL.createObjectURL = function (blob) {
          const url = origCreate.call(URL, blob);
          const t = (blob && blob.type) || "";
          if ((t.includes("pdf") || t === "application/octet-stream") && window.__axlxCapturePending) {
            window.__axlxCapturePending = false; // 1回受け取ったらリセット
            const r = new FileReader();
            r.onload = (e) => {
              window.postMessage({ from: "axlx-itandi-pdf", b64: e.target.result.split(",")[1] }, "*");
            };
            r.readAsDataURL(blob);
          }
          return url;
        };

        // fetch フック（直接 application/pdf を返す場合）
        const origFetch = window.fetch;
        window.fetch = function (...args) {
          return origFetch.apply(this, args).then((resp) => {
            const ct = resp.headers.get("content-type") || "";
            if (ct.includes("application/pdf") && window.__axlxCapturePending) {
              window.__axlxCapturePending = false; // 1回受け取ったらリセット
              resp.clone().arrayBuffer().then((buf) => {
                const bytes = new Uint8Array(buf);
                const chunks = [];
                for (let i = 0; i < bytes.length; i += 8192) {
                  chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
                }
                window.postMessage({ from: "axlx-itandi-pdf", b64: btoa(chunks.join("")) }, "*");
              });
            }
            return resp;
          });
        };
      },
    }).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── LINE送信: 全件を1つのPDFに結合してURLで送信 ──────────────────────────
  if (msg.type === "axlx-send-to-line") {
    (async () => {
      try {
        const cookie_str = await getRealproCookies();
        const { urls, customer_name, property_summaries } = msg;
        const today = new Date().toLocaleDateString("ja-JP").replace(/\//g, "-");

        const data = await callMergeApi({
          pdf_urls: urls,
          cookie_str,
          file_name: `物件まとめ_${today}.pdf`,
          send_to_line: true,
          customer_name: customer_name || null,
          property_summaries: property_summaries || null,
        });

        sendResponse({ ok: true, line_sent: !!data.line_sent, url: data.url });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // ── itandi用: キャプチャ済みpdf_dataをそのまま結合してLINE送信 ──────────
  // クッキー不要（ブラウザ側でPDFを取得済み）
  if (msg.type === "axlx-send-pdf-data-to-line") {
    (async () => {
      try {
        const data = await callMergeApi({
          pdf_data: msg.pdf_data,
          file_name: msg.file_name,
          send_to_line: true,
          customer_name: msg.customer_name || null,
          property_summaries: msg.property_summaries || null,
        });
        sendResponse({ ok: true, line_sent: !!data.line_sent, url: data.url });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // ── PDF結合ダウンロード ───────────────────────────────────────────────────
  if (msg.type === "axlx-merge-pdf") {
    (async () => {
      try {
        const cookie_str = await getRealproCookies();
        const data = await callMergeApi({
          pdf_urls: msg.urls,
          cookie_str,
          file_name: msg.file_name,
          send_to_line: false,
          customer_name: msg.customer_name || null,
          property_summaries: null,
        });
        sendResponse({ ok: true, pdf: data.pdf, fileName: msg.file_name });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  return false;
});
