"use strict";

const UNDERBAR_SITES = ["realnetpro.com"];

// ── レインズ新タブ監視（window.openで開かれるタブからPDFを取得）────────────
// openerTabId → { senderTabId, timerId }
const reinsTabWatchers = new Map();

chrome.tabs.onCreated.addListener((tab) => {
  if (!tab.openerTabId || !reinsTabWatchers.has(tab.openerTabId)) return;
  const { senderTabId, timerId } = reinsTabWatchers.get(tab.openerTabId);
  clearTimeout(timerId);
  reinsTabWatchers.delete(tab.openerTabId);

  const newTabId = tab.id;
  console.log("[AXLX BG] レインズ新タブ検知 id=" + newTabId);

  // タブのロード完了後にPDFを取得して元のタブに送信する
  function captureFromTab(updatedTab) {
    const url = updatedTab.url || "";
    console.log("[AXLX BG] 新タブ完了:", url.slice(0, 80));

    // MAIN worldにスクリプトを注入してfetch経由でPDFデータを取得
    chrome.scripting.executeScript({
      target: { tabId: newTabId },
      world: "MAIN",
      func: () => {
        return fetch(location.href)
          .then((r) => {
            const ct = r.headers.get("content-type") || "";
            if (!ct.includes("pdf") && !ct.includes("octet")) {
              return null; // PDFでない場合はスキップ
            }
            return r.arrayBuffer();
          })
          .then((buf) => {
            if (!buf) return null;
            const bytes = new Uint8Array(buf);
            const chunks = [];
            for (let i = 0; i < bytes.length; i += 8192) {
              chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
            }
            return btoa(chunks.join(""));
          })
          .catch(() => null);
      },
    }).then((results) => {
      const b64 = results?.[0]?.result;
      // 新タブを閉じる
      chrome.tabs.remove(newTabId).catch(() => {});
      if (b64) {
        console.log("[AXLX BG] 新タブPDF取得成功 → 元タブに送信");
        chrome.tabs.sendMessage(senderTabId, {
          type: "axlx-reins-pdf-captured",
          b64,
          ts: Date.now(),
        }).catch((e) => console.error("[AXLX BG] sendMessage error:", e.message));
      } else {
        console.warn("[AXLX BG] 新タブからPDF取得失敗（null）");
      }
    }).catch((e) => {
      console.error("[AXLX BG] 新タブ注入エラー:", e.message);
      chrome.tabs.remove(newTabId).catch(() => {});
    });
  }

  // タブ更新リスナー
  const onUpdated = (tabId, changeInfo, updatedTab) => {
    if (tabId !== newTabId || changeInfo.status !== "complete") return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    captureFromTab(updatedTab);
  };
  chrome.tabs.onUpdated.addListener(onUpdated);

  // タブが既にcomplete状態の場合のフォールバック
  setTimeout(() => {
    chrome.tabs.get(newTabId, (t) => {
      if (chrome.runtime.lastError) return;
      if (t?.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        captureFromTab(t);
      }
    });
  }, 500);
});

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

// ── ヘルパー: PDF 1件をVercel Blobにアップロードして公開URLを返す ──────────
// base64→binary変換して送信（base64より33%軽量・413回避）
async function uploadPdfToBlob(b64, fileName) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  // タイムスタンプをファイル名に付与してCDNキャッシュを完全に回避
  // 同名ファイルをallowOverwrite:trueで上書きしてもCDNが古いキャッシュを返すため
  const uniqueName = fileName.replace(/\.pdf$/i, "") + `_${Date.now()}.pdf`;
  const url = `https://sumora-ai-ui.vercel.app/api/blob-upload?name=${encodeURIComponent(uniqueName)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: bytes,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Blobアップロード失敗 HTTP ${resp.status}: ${text.slice(0, 120)}`);
  }
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || "Blobアップロードエラー");
  return data.url;
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

  // ── レインズ新タブ監視開始 ───────────────────────────────────────────────
  if (msg.type === "axlx-reins-watch-tab") {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false }); return true; }
    const timerId = setTimeout(() => reinsTabWatchers.delete(tabId), 35000);
    reinsTabWatchers.set(tabId, { senderTabId: tabId, timerId });
    console.log("[AXLX BG] 新タブ監視開始 tabId=" + tabId);
    sendResponse({ ok: true });
    return true;
  }

  // ── itandi CSP回避: MAIN worldにPDFキャプチャフックを注入 ─────────────────
  // <script>タグ注入はCSPでブロックされるため chrome.scripting.executeScript を使う
  if (msg.type === "axlx-inject-pdf-hook") {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false }); return true; }
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        // v3: window.open抑制 + XHRフック追加（レインズ対応）
        // v2フックが入っていても v3は別フラグで追加注入する
        if (!window.__axlxItandiHookV2) {
          window.__axlxItandiHookV2 = true;
          window.__axlxCapturePending = false;

          // axlx-start-pdf-capture シグナルを受信してキャプチャ許可
          window.addEventListener("message", function (e) {
            if (e.data && e.data.from === "axlx-start-pdf-capture") {
              window.__axlxCapturePending = true;
            }
          });

          // Blob URL フック（createObjectURL でPDFを作る場合）
          const origCreate = URL.createObjectURL;
          URL.createObjectURL = function (blob) {
            const url = origCreate.call(URL, blob);
            const t = (blob && blob.type) || "";
            // 診断: PDF/octetのblob作成を全てログ（capturePending問わず）
            if (t.includes("pdf") || t === "application/octet-stream") {
              console.log("[AXLX DIAG] createObjectURL PDF:", t, Math.round(blob.size / 1024) + "KB", "pending:", window.__axlxCapturePending);
            }
            if ((t.includes("pdf") || t === "application/octet-stream") && window.__axlxCapturePending) {
              window.__axlxCapturePending = false;
              window.__axlxLastBlobUrl = url; // window.open 抑制用に URL を保存
              console.log("[AXLX V2] PDF blob captured:", Math.round(blob.size / 1024) + "KB");
              const r = new FileReader();
              r.onload = (e) => {
                window.postMessage({ from: "axlx-itandi-pdf", b64: e.target.result.split(",")[1], ts: Date.now() }, "*");
              };
              r.readAsDataURL(blob);
            }
            return url;
          };

          // fetch フック（application/pdf を直接返す場合）
          const origFetch = window.fetch;
          window.fetch = function (...args) {
            return origFetch.apply(this, args).then((resp) => {
              const ct = resp.headers.get("content-type") || "";
              if (ct.includes("application/pdf") && window.__axlxCapturePending) {
                window.__axlxCapturePending = false;
                resp.clone().arrayBuffer().then((buf) => {
                  const bytes = new Uint8Array(buf);
                  const chunks = [];
                  for (let i = 0; i < bytes.length; i += 8192) {
                    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
                  }
                  window.postMessage({ from: "axlx-itandi-pdf", b64: btoa(chunks.join("")), ts: Date.now() }, "*");
                });
              }
              return resp;
            });
          };
        }

        // v3: window.open フック（レインズがblobURLの新タブを開くのを抑制）
        // 新タブが開くと後続のクリックがフォーカスの問題で機能しなくなるため抑制
        if (!window.__axlxOpenHookV3) {
          window.__axlxOpenHookV3 = true;
          const origOpen = window.open;
          window.open = function (...args) {
            const url = String(args[0] || "");
            // 診断: 全window.open呼び出しをログ
            console.log("[AXLX DIAG] window.open:", url.slice(0, 80), "| target:", args[1], "| pending:", window.__axlxCapturePending);
            const isBlobPdf = url.startsWith("blob:") || /\.pdf(\?|$)/i.test(url);
            // ケース1: createObjectURLで既にキャプチャ済みのblob URL → 抑制のみ
            // createObjectURL後はcapturePending=falseになるため別フラグで判定する
            if (url && url === window.__axlxLastBlobUrl) {
              window.__axlxLastBlobUrl = null;
              console.log("[AXLX V3] window.open 抑制（キャプチャ済みblob）:", url.slice(0, 40));
              return null;
            }
            // ケース2: capturePending=true でblob/PDF URL → 抑制 + blob fetchでキャプチャ
            // ※ capturePendingはここではリセットしない（createObjectURLが後で呼ばれる場合も取得できるよう）
            if (window.__axlxCapturePending && isBlobPdf) {
              console.log("[AXLX V3] window.open 抑制 + blob fetch:", url.slice(0, 60));
              if (url.startsWith("blob:")) {
                // blob:URLはそのままfetchで取得（同一オリジンのため可能）
                fetch(url).then(r => r.arrayBuffer()).then(buf => {
                  if (!window.__axlxCapturePending) return; // createObjectURL側が先にキャプチャした場合はスキップ
                  window.__axlxCapturePending = false;
                  const bytes = new Uint8Array(buf);
                  const chunks = [];
                  for (let i = 0; i < bytes.length; i += 8192) {
                    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
                  }
                  window.postMessage({ from: "axlx-itandi-pdf", b64: btoa(chunks.join("")), ts: Date.now() }, "*");
                }).catch(e => console.error("[AXLX V3] blob fetch error:", e));
              }
              return null;
            }
            return origOpen.apply(this, args);
          };

          // XHR フック（fetchを使わずXHRでPDFを取得する場合）
          const origXHROpen = XMLHttpRequest.prototype.open;
          const origXHRSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function (method, url) {
            this._axlxUrl = url;
            return origXHROpen.apply(this, arguments);
          };
          XMLHttpRequest.prototype.send = function () {
            if (window.__axlxCapturePending) {
              // responseTypeが未設定の場合はarraybufferに強制（バイナリデータを確実に受取る）
              if (!this.responseType || this.responseType === "") {
                try { this.responseType = "arraybuffer"; } catch (e) {}
              }
              this.addEventListener("load", function () {
                if (!window.__axlxCapturePending) return;
                const ct = this.getResponseHeader("content-type") || "";
                if (!ct.includes("pdf") && !ct.includes("octet")) return;
                window.__axlxCapturePending = false;
                if (this.responseType === "blob" && this.response) {
                  const r = new FileReader();
                  r.onload = (e) => {
                    window.postMessage({ from: "axlx-itandi-pdf", b64: e.target.result.split(",")[1], ts: Date.now() }, "*");
                  };
                  r.readAsDataURL(this.response);
                  return;
                }
                if (this.responseType === "arraybuffer" && this.response) {
                  const bytes = new Uint8Array(this.response);
                  const chunks = [];
                  for (let i = 0; i < bytes.length; i += 8192) {
                    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
                  }
                  window.postMessage({ from: "axlx-itandi-pdf", b64: btoa(chunks.join("")), ts: Date.now() }, "*");
                }
              });
            }
            return origXHRSend.apply(this, arguments);
          };
        }

        // 毎回の注入完了時に capturePending を true にセット
        // postMessage経由だとwindow.openとcreateObjectURLの呼び出し順によってはリセットされるため
        // 注入直後に直接セットして確実にキャプチャ待機状態にする
        window.__axlxCapturePending = true;
        console.log("[AXLX] capturePending = true (injection complete)");
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

  // ── itandi用: キャプチャ済みpdf_dataをBlobにアップ→URL取得→まとめてmerge ──
  // 旧: pdf_dataを全件まとめて送信 → 413エラー
  // 新: 1件ずつBlobアップ(binary送信)でURL取得 → URLだけmerge-pdfsに渡す → リアプロと同じ仕組み
  if (msg.type === "axlx-send-pdf-data-to-line") {
    (async () => {
      try {
        const today = new Date().toLocaleDateString("ja-JP").replace(/\//g, "-");
        const baseName = (msg.file_name || `物件まとめ_${today}`).replace(/\.pdf$/, "");

        // Step1: 1件ずつVercel BlobにアップロードしてURLを収集
        const blobUrls = [];
        for (let i = 0; i < msg.pdf_data.length; i++) {
          const name = `${baseName}_${i + 1}.pdf`;
          const url = await uploadPdfToBlob(msg.pdf_data[i], name);
          blobUrls.push(url);
          // タブにアップロード進捗を通知（ボタンテキスト更新のため）
          if (sender.tab?.id) {
            chrome.tabs.sendMessage(sender.tab.id, {
              type: "axlx-blob-upload-progress",
              current: i + 1,
              total: msg.pdf_data.length,
            }).catch(() => {});
          }
        }

        // Step2: URLでまとめてmerge → LINE送信（リアプロと同じ仕組み）
        const data = await callMergeApi({
          pdf_urls:           blobUrls,
          cookie_str:         "",   // 公開Blob URLはcookie不要
          file_name:          `${baseName}.pdf`,
          send_to_line:       true,
          customer_name:      msg.customer_name || null,
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
