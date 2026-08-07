"use strict";

// ── ローカル条件解決コア（popup.js と同一ロジック）─────────────────────────
// manifest の background.type が "module" のため importScripts() は使えない。
// 静的 import で読み込み、resolution-core.js が公開する globalThis.SUMORA_RESOLUTION
// 経由で resolveConditionsLocal 等を参照する（_resolveLocalFirst 参照）。
import "./resolution-core.js";

const UNDERBAR_SITES = ["realnetpro.com", "system.reins.jp"];

// ── レインズ新タブ監視（window.openで開かれるタブからPDFを取得）────────────
// openerTabId → { senderTabId, timerId }
const reinsTabWatchers = new Map();

// ── itandi ダウンロード監視（JSフック失敗時のフォールバック）────────────────
// タブIDではなく時刻ベースで管理（window.openで開いた新タブのDLにも対応）
let itandiWatchExpiry     = 0; // epoch ms
let itandiWatchOriginalTab = 0; // 結果を返す元タブ

// ── レインズ一括PDFダウンロードをLINE送信に横取り ─────────────────────────────
// 図面一括取得 → 確認ダイアログOK → Chrome download bar
// JSフックでは捕捉できない場合（Content-Disposition: attachment の直DL）を chrome.downloads で補完
// ダウンロードはキャンセルしない（ユーザーのファイルはそのまま保存される）
chrome.downloads.onCreated.addListener((downloadItem) => {
  const url    = downloadItem.url || "";
  const dlTabId = downloadItem.tabId;

  // ── itandi PDF ダウンロードキャプチャ（時刻ベース・タブID不問）────────────
  // Bug fix: window.openで開いた新タブのdlTabIdは元タブと一致しないため時刻ベースで判定
  if (itandiWatchExpiry > 0 && Date.now() < itandiWatchExpiry) {
    const isMaybePdf =
      url.includes(".pdf") ||
      (downloadItem.mime || "").includes("pdf") ||
      (downloadItem.mime || "").includes("octet-stream");
    if (isMaybePdf) {
      const originalTabId = itandiWatchOriginalTab;
      itandiWatchExpiry     = 0;
      itandiWatchOriginalTab = 0;
      // LINEに送るだけなのでファイルを保存しない（Adobeが開くのを防ぐ）
      chrome.downloads.cancel(downloadItem.id).catch(() => {});
      console.log("[AXLX BG] itandi DL検知 url=" + url.slice(0, 80) + " → originalTab=" + originalTabId);

      // BGサービスワーカーからfetch（host_permissionsがあるitandibb.comはCORSなし）
      // S3/CDN URL はフォールバックで元タブのMAIN worldからfetch
      (async () => {
        let b64 = null;
        try {
          const r = await fetch(url, { credentials: "include" });
          const buf = await r.arrayBuffer();
          const bytes = new Uint8Array(buf);
          const chunks = [];
          for (let i = 0; i < bytes.length; i += 8192) {
            chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
          }
          b64 = btoa(chunks.join(""));
          console.log("[AXLX BG] itandi DL BG-fetch成功 " + Math.round(b64.length / 1024) + "KB");
        } catch (e1) {
          console.warn("[AXLX BG] itandi DL BG-fetch失敗:", e1.message, "→ MAIN world fallback");
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: originalTabId },
              world: "MAIN",
              func: (pdfUrl) => {
                return fetch(pdfUrl, { credentials: "include" })
                  .then((r) => r.arrayBuffer())
                  .then((buf) => {
                    const bytes = new Uint8Array(buf);
                    const chunks = [];
                    for (let i = 0; i < bytes.length; i += 8192) {
                      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
                    }
                    return btoa(chunks.join(""));
                  })
                  .catch(() => null);
              },
              args: [url],
            });
            b64 = results?.[0]?.result || null;
            if (b64) console.log("[AXLX BG] itandi DL MAIN-fetch成功 " + Math.round(b64.length / 1024) + "KB");
          } catch (e2) {
            console.error("[AXLX BG] itandi DL MAIN-fetch失敗:", e2.message);
          }
        }
        if (b64) {
          chrome.tabs.sendMessage(originalTabId, { type: "axlx-itandi-pdf-by-download", b64, ts: Date.now() })
            .catch((e) => console.error("[AXLX BG] itandi sendMessage error:", e.message));
        } else {
          console.warn("[AXLX BG] itandi DL capture null（全fetchパス失敗）");
        }
      })();
    }
  }

  // ── レインズ PDF ダウンロードキャプチャ ──────────────────────────────────────
  if (reinsTabWatchers.size === 0) return; // 監視中でない

  // blob:URL はJSフック側で捕捉済みのため除外、reins.jp ドメインのみ対象
  if (url.startsWith("blob:") || !url.includes("reins.jp")) return;

  // senderTabId（レインズを開いているタブ）を取得
  let senderTabId = null;
  for (const [, entry] of reinsTabWatchers) {
    senderTabId = entry.senderTabId;
    break;
  }
  if (!senderTabId) return;

  // ダウンロードをキャンセルしてAdobeが開くのを防ぐ（内容はMAIN world fetchで取得）
  chrome.downloads.cancel(downloadItem.id).catch(() => {});
  console.log("[AXLX BG] 一括DL検知 → キャンセル & MAINworld再fetch:", url.slice(0, 80));

  // レインズタブのMAIN worldでURLをfetch（ページのセッションCookieが自動的に使われる）
  chrome.scripting.executeScript({
    target: { tabId: senderTabId },
    world: "MAIN",
    func: (pdfUrl) => {
      return fetch(pdfUrl)
        .then((r) => {
          const ct = r.headers.get("content-type") || "";
          if (!ct.includes("pdf") && !ct.includes("octet")) return null;
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
    args: [url],
  }).then((results) => {
    const b64 = results?.[0]?.result;
    if (b64) {
      console.log("[AXLX BG] 一括PDF取得成功 → senderTab送信");
      chrome.tabs.sendMessage(senderTabId, {
        type: "axlx-reins-pdf-captured",
        b64,
        ts: Date.now(),
      }).catch((e) => console.error("[AXLX BG] sendMessage error:", e.message));
      reinsTabWatchers.clear(); // 一括完了 → 監視終了
    } else {
      console.warn("[AXLX BG] 一括PDF fetch null（URLが期限切れ or 非PDF）");
    }
  }).catch((e) => {
    console.error("[AXLX BG] 一括PDF executeScript error:", e.message);
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  const newTabId = tab.id;
  let senderTabId = null;
  let watcherKey  = null;

  if (tab.openerTabId && reinsTabWatchers.has(tab.openerTabId)) {
    // 正常パス: openerTabId が一致
    const entry = reinsTabWatchers.get(tab.openerTabId);
    senderTabId = entry.senderTabId;
    watcherKey  = tab.openerTabId;
  } else if (reinsTabWatchers.size > 0) {
    // フォールバック: 図面一括取得が window.open 以外の方法でタブを開く場合
    // ウォッチャーが有効なら最初のエントリを使う
    for (const [key, entry] of reinsTabWatchers) {
      senderTabId = entry.senderTabId;
      watcherKey  = key;
      break;
    }
  }

  if (!senderTabId) return;

  // タイマーをリセット（複数タブが連続で開く一括取得に対応）
  const existing = reinsTabWatchers.get(watcherKey);
  if (existing) clearTimeout(existing.timerId);
  const newTimer = setTimeout(() => reinsTabWatchers.delete(watcherKey), 35000);
  reinsTabWatchers.set(watcherKey, { senderTabId, timerId: newTimer });

  console.log("[AXLX BG] レインズ新タブ検知 id=" + newTabId + " openerTabId=" + tab.openerTabId + " senderTabId=" + senderTabId);

  // タブのロード完了後にPDFを取得して元のタブに送信する
  function captureFromTab(updatedTab) {
    const url = updatedTab.url || "";
    console.log("[AXLX BG] 新タブ完了:", url.slice(0, 80));

    // レインズ外のURLはスキップ（誤検知でユーザーのタブを閉じないため）
    if (url && !url.includes("system.reins.jp") && !url.startsWith("blob:") && url !== "about:blank") {
      console.log("[AXLX BG] レインズ外URL → スキップ（タブ維持）");
      return;
    }

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
  try {
    if (chrome.sidePanel?.setPanelBehavior) {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    }
  } catch (e) {
    // サービスワーカー起動クラッシュを防ぐ（sidePanel API の同期エラーを吸収）
    console.warn("[AXLX BG] setupSidePanel error:", e.message);
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
    signal: AbortSignal.timeout(60000),
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
    signal: AbortSignal.timeout(60000),
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
    // 既存watcherの旧タイマーを解除（逐次モードで旧タイマーが新watcherを削除するレース防止）
    const existing = reinsTabWatchers.get(tabId);
    if (existing) clearTimeout(existing.timerId);
    const timerId = setTimeout(() => reinsTabWatchers.delete(tabId), 35000);
    reinsTabWatchers.set(tabId, { senderTabId: tabId, timerId });
    console.log("[AXLX BG] 新タブ監視開始 tabId=" + tabId);
    sendResponse({ ok: true });
    return true;
  }

  // ── itandi: ダウンロード監視開始（JSフック失敗時フォールバック）────────────
  if (msg.type === "axlx-itandi-watch-download") {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false }); return true; }
    itandiWatchExpiry      = Date.now() + 30000;
    itandiWatchOriginalTab = tabId;
    console.log("[AXLX BG] itandi DL watch開始 originalTabId=" + tabId);
    sendResponse({ ok: true });
    return true;
  }

  // ── itandi CSP回避: MAIN worldにPDFキャプチャフックを注入 ─────────────────
  // <script>タグ注入はCSPでブロックされるため chrome.scripting.executeScript を使う
  if (msg.type === "axlx-inject-pdf-hook") {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false }); return true; }
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, // ← iframe内も注入（レインズはiframe内でPDFを処理）
      world: "MAIN",
      func: () => {
        // v3: window.open抑制 + XHRフック追加（レインズ対応）
        // v2フックが入っていても v3は別フラグで追加注入する
        if (!window.__axlxItandiHookV2) {
          window.__axlxItandiHookV2 = true;
          window.__axlxCapturePending = false;

          // axlx-start-pdf-capture シグナルを受信してcapturePendingを再セット
          // 自分自身のwindowで常に受信（content scriptからのiframe直接broadcastに対応）
          window.addEventListener("message", function (e) {
            if (e.data && e.data.from === "axlx-start-pdf-capture") {
              window.__axlxCapturePending = true;
            }
          });
          // 同一オリジンのiframe: window.topのメッセージも受信（追加保護）
          try {
            if (window.top && window.top !== window) {
              window.top.addEventListener("message", function (e) {
                if (e.data && e.data.from === "axlx-start-pdf-capture") {
                  window.__axlxCapturePending = true;
                }
              });
            }
          } catch (_ce) {} // cross-origin: own window listener が機能する

          // Blob URL フック（createObjectURL でPDFを作る場合）
          const origCreate = URL.createObjectURL;
          URL.createObjectURL = function (blob) {
            const url = origCreate.call(URL, blob);
            const t = (blob && blob.type) || "";
            // 診断: capturePending時 or PDF/octetのblob作成を全てログ
            if (window.__axlxCapturePending || t.includes("pdf") || t.includes("octet-stream")) {
              console.log("[AXLX DIAG] createObjectURL:", t || "(empty)", Math.round(blob.size / 1024) + "KB", "pending:", window.__axlxCapturePending);
            }
            // PDF判定: 明示的なPDF/octetタイプ OR capturePending中の空タイプ大きめblob（≥30KB = itandi PDFの最小サイズ）
            const isPdfBlob = t.includes("pdf") || t.includes("octet-stream") || (!t && blob.size >= 30000);
            if (isPdfBlob && window.__axlxCapturePending) {
              window.__axlxCapturePending = false;
              window.__axlxLastBlobUrl = url; // window.open 抑制用に URL を保存
              console.log("[AXLX V2] PDF blob captured:", Math.round(blob.size / 1024) + "KB");
              const r = new FileReader();
              r.onload = (ev) => {
                const b64 = ev.target.result.split(",")[1];
                const ts  = Date.now();
                console.log("[AXLX V2] FileReader完了 → 送信 " + Math.round(b64.length / 1024) + "KB (iframe=" + (window !== window.top) + ")");
                const payload = { from: "axlx-itandi-pdf", b64, ts };
                // トップレベルwindowに送信（iframeからでも届く）
                const _top = window.top || window;
                _top.postMessage(payload, "*");
                // フォールバック: トップレベルdocumentにCustomEvent
                try {
                  const _doc = _top.document || document;
                  _doc.dispatchEvent(new CustomEvent("axlx-pdf-ready", { detail: payload, bubbles: false }));
                } catch (err) {
                  console.error("[AXLX V2] CustomEvent error:", err);
                }
              };
              r.onerror = (err) => console.error("[AXLX V2] FileReader エラー:", err);
              r.readAsDataURL(blob);
            }
            return url;
          };

          // fetch フック（application/pdf を直接返す場合）
          const origFetch = window.fetch;
          window.fetch = function (...args) {
            return origFetch.apply(this, args).then((resp) => {
              const ct = resp.headers.get("content-type") || "";
              if ((ct.includes("application/pdf") || ct.includes("application/octet-stream")) && window.__axlxCapturePending) {
                window.__axlxCapturePending = false;
                resp.clone().arrayBuffer().then((buf) => {
                  const bytes = new Uint8Array(buf);
                  const chunks = [];
                  for (let i = 0; i < bytes.length; i += 8192) {
                    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
                  }
                  (window.top || window).postMessage({ from: "axlx-itandi-pdf", b64: btoa(chunks.join("")), ts: Date.now() }, "*");
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
            // ケース1: createObjectURLで既にキャプチャ済みのblob URL → 抑制のみ
            // createObjectURL後はcapturePending=falseになるため別フラグで判定する
            if (url && url === window.__axlxLastBlobUrl) {
              window.__axlxLastBlobUrl = null;
              console.log("[AXLX V3] window.open 抑制（キャプチャ済みblob）:", url.slice(0, 40));
              return null;
            }
            // ケース2: capturePending=true で blob: URL → 抑制 + blob fetchでキャプチャ
            if (window.__axlxCapturePending && url.startsWith("blob:")) {
              console.log("[AXLX V3] window.open 抑制 + blob fetch:", url.slice(0, 60));
              // blob:URLはそのままfetchで取得（同一オリジンのため可能）
              fetch(url).then(r => r.arrayBuffer()).then(buf => {
                if (!window.__axlxCapturePending) return; // createObjectURL側が先にキャプチャした場合はスキップ
                window.__axlxCapturePending = false;
                const bytes = new Uint8Array(buf);
                const chunks = [];
                for (let i = 0; i < bytes.length; i += 8192) {
                  chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
                }
                (window.top || window).postMessage({ from: "axlx-itandi-pdf", b64: btoa(chunks.join("")), ts: Date.now() }, "*");
              }).catch(e => console.error("[AXLX V3] blob fetch error:", e));
              return null;
            }
            // ケース3: capturePending=true でHTTPS URL → パススルー
            // background.jsのitandiWatchExpiry（時刻ベース）がchrome.downloads.onCreatedで捕捉する
            // 旧設計: MAIN worldからfetch＋window.open抑制 → CDN/S3 CORSで失敗しDLイベントも消えるバグあり
            if (window.__axlxCapturePending && (url.startsWith("https:") || url.startsWith("http:"))) {
              console.log("[AXLX V3] window.open HTTPS パススルー（DLウォッチャーに委譲）:", url.slice(0, 80));
              window.__axlxCapturePending = false; // 二重捕捉防止
              return origOpen.apply(this, args);   // ブラウザの自然なDLを発生させる
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
              // ⚠️ responseType を変更しない: itandi の XHR が responseText を読めなくなり
              // InvalidStateError が発生してボタンが壊れるため（2026-06-04 根本原因特定）
              var _self = this;
              var _savedType = this.responseType;
              this.addEventListener("load", function () {
                if (!window.__axlxCapturePending) return;
                const ct = _self.getResponseHeader("content-type") || "";
                if (!ct.includes("pdf") && !ct.includes("octet")) return;
                window.__axlxCapturePending = false;
                const _sendPdf = (b64) => (window.top || window).postMessage({ from: "axlx-itandi-pdf", b64, ts: Date.now() }, "*");
                if (_savedType === "blob" && _self.response) {
                  const r = new FileReader();
                  r.onload = (e) => _sendPdf(e.target.result.split(",")[1]);
                  r.readAsDataURL(_self.response);
                  return;
                }
                if (_savedType === "arraybuffer" && _self.response) {
                  const bytes = new Uint8Array(_self.response);
                  const chunks = [];
                  for (let i = 0; i < bytes.length; i += 8192) {
                    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
                  }
                  _sendPdf(btoa(chunks.join("")));
                  return;
                }
                // responseType="" or "text" の場合: URL を再 fetch してバイナリ取得
                var _url = _self._axlxUrl;
                if (_url) {
                  fetch(_url).then(function(r) { return r.arrayBuffer(); }).then(function(buf) {
                    var bytes = new Uint8Array(buf);
                    var chunks = [];
                    for (var i = 0; i < bytes.length; i += 8192) {
                      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
                    }
                    _sendPdf(btoa(chunks.join("")));
                  }).catch(function(e) { console.error("[AXLX XHR] re-fetch error:", e); });
                }
              });
            }
            return origXHRSend.apply(this, arguments);
          };
        }

        // <a download> フック（URLを直接ダウンロードする場合をキャプチャ）
        // 2パターン対応:
        //   (A) DOM上のアンカー要素をクリック → document の capture-phase click で捕捉
        //   (B) detached anchor の .click() → HTMLAnchorElement.prototype.click を上書き
        if (!window.__axlxAnchorHookV1) {
          window.__axlxAnchorHookV1 = true;

          function _axlxFetchAndSend(href) {
            window.__axlxCapturePending = false;
            console.log("[AXLX] anchor captured:", href.slice(0, 60));
            fetch(href).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
              var bytes = new Uint8Array(buf);
              var chunks = [];
              for (var i = 0; i < bytes.length; i += 8192) {
                chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
              }
              var b64 = btoa(chunks.join(""));
              var payload = { from: "axlx-itandi-pdf", b64: b64, ts: Date.now() };
              (window.top || window).postMessage(payload, "*");
              try {
                var _doc = (window.top || window).document || document;
                _doc.dispatchEvent(new CustomEvent("axlx-pdf-ready", { detail: payload }));
              } catch (e) { console.error("[AXLX] anchor CustomEvent:", e); }
            }).catch(function (e) { console.error("[AXLX] anchor fetch error:", e); });
          }

          // (A) DOM上のアンカークリック
          document.addEventListener("click", function (ev) {
            if (!window.__axlxCapturePending) return;
            var el = ev.target;
            while (el && el !== document && el.tagName !== "A") el = el.parentElement;
            if (!el || !el.getAttribute) return;
            if (el.getAttribute("download") === null) return;
            var href = el.href || "";
            if (!href || href.startsWith("javascript:")) return;
            ev.preventDefault();
            ev.stopPropagation();
            _axlxFetchAndSend(href);
          }, true);

          // (B) detached anchor の .click()（DOM外から呼ばれてもキャプチャ）
          // blob: URL も fetch で取得可能（同一オリジン）なので除外しない
          var _origAnchorClick = HTMLAnchorElement.prototype.click;
          HTMLAnchorElement.prototype.click = function () {
            if (window.__axlxCapturePending && this.getAttribute("download") !== null) {
              var href = this.href || "";
              if (href && !href.startsWith("javascript:")) {
                _axlxFetchAndSend(href);
                return; // ブラウザのダウンロードを抑制
              }
            }
            return _origAnchorClick.apply(this, arguments);
          };
        }

        // capturePending は axlx-start-pdf-capture メッセージで true にセット
        // 注入時の自動 ON は廃止: 常時 ON だと itandi の全 XHR に干渉してボタンを壊すため
        console.log("[AXLX] PDF hook ready. capturePending = false (waiting for axlx-start-pdf-capture)");
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

  // ── WebApp からの即時ポーリング要求（30秒アラーム待ちをスキップ）────────────
  if (msg.type === "axlx-poll-now") {
    (async () => {
      var st = await chrome.storage.local.get("batchRunning");
      var lock = st.batchRunning;
      if (lock) {
        var startedAt = (typeof lock === "object" && lock) ? lock.startedAt : 0;
        if (startedAt && Date.now() - startedAt < BATCH_LOCK_TTL_MS) {
          sendResponse({ ok: false, reason: "locked" });
          return;
        }
      }
      sendResponse({ ok: true });
      _pollAndRunBatch().catch(function(e) {
        console.warn("[poll-now] error:", e.message || e);
      });
    })();
    return true;
  }

  // ── WebApp（sumora-ai-ui）からの直接検索トリガー ──────────────────────────
  if (msg.type === "axlx-webapp-search") {
    const { site, conditions } = msg;
    console.log("[webapp-search] ▶ 受信 site=" + site + " customerId=" + (conditions && conditions.customerId));

    // ─── リアプロ: popup.js直接メッセージ経由（Dijkstra展開含む完全な条件組み立てを使う）──
    if (site === "realnetpro" || site === "realpro") {
      (async () => {
        try {
          var _cid      = conditions && conditions.customerId;
          var _custName = (conditions && conditions.customerName) || null;
          var _areaMode = (conditions && conditions.area_mode) || null;
          var _isWide   = !!(conditions && conditions.is_wide);

          if (!_cid) { sendResponse({ ok: false, error: "no customerId" }); return; }

          // underbar.js（content script）経由でpopup.js iframeに中継
          // chrome.tabs.sendMessage はContent Script経路で確実にデリバリされる（iframe frame登録ラグなし）
          var _allTabs = await chrome.tabs.query({});
          var _realTab = _allTabs.find(function(t) { return t.url && t.url.startsWith("https://www.realnetpro.com"); });
          console.log("[webapp-search] リアプロタブ:", _realTab ? _realTab.url : "見つからない");
          var _directOk = false;
          if (_realTab) {
            _directOk = await new Promise(function(resolve) {
              chrome.tabs.sendMessage(_realTab.id, {
                type:         "axlx-switch-customer",
                customerId:   String(_cid),
                customerName: _custName,
                site:         "realpro",
                areaMode:     _areaMode,
                is_wide:      _isWide,
              }, function(resp) {
                if (chrome.runtime.lastError) {
                  console.log("[webapp-search] tabs.sendMessage エラー:", chrome.runtime.lastError.message);
                  resolve(false); return;
                }
                console.log("[webapp-search] underbar.js応答:", JSON.stringify(resp));
                resolve(!!(resp && resp.ok));
              });
            });
          }
          if (_directOk) {
            console.log("[webapp-search] ✔ underbar.js中継メッセージ成功");
            sendResponse({ ok: true });
            return;
          }
          console.log("[webapp-search] ✗ popup未応答 → フォールバック: ページ更新経由");

          // フォールバック: main.phpへナビゲート + pendingPopupCmd
          // _realTab は上で取得済み（null の場合は新規タブ作成）
          if (_realTab) {
            await chrome.tabs.update(_realTab.id, { url: "https://www.realnetpro.com/main.php", active: true });
            await _batchWaitForTabComplete(_realTab.id);
            await new Promise(function(r) { setTimeout(r, 1500); });
          } else {
            _realTab = await chrome.tabs.create({ url: "https://www.realnetpro.com/main.php", active: true });
            await _batchWaitForTabComplete(_realTab.id);
            await new Promise(function(r) { setTimeout(r, 2000); });
          }
          await chrome.storage.session.set({
            pendingPopupCmd: {
              customerId:   String(_cid),
              customerName: _custName,
              site:         "realpro",
              areaMode:     _areaMode,
              is_wide:      _isWide,
            }
          });
          sendResponse({ ok: true });
        } catch (e) {
          console.error("[webapp-search] realnetpro error:", e);
          sendResponse({ ok: false, error: String(e.message) });
        }
      })();
      return true;
    }

    // ─── itandi / reins: _batchAutofill直接呼び出し（popup.js経由なし・ページ更新なし）──
    (async () => {
      try {
        var _cid      = conditions && conditions.customerId;
        var _isWide   = !!(conditions && conditions.is_wide);
        var _areaMode = (conditions && conditions.area_mode) || null;

        if (!_cid) { sendResponse({ ok: false, error: "no customerId" }); return; }

        // 顧客データをAPIから取得
        var _fetchRes = await fetch("https://sumora-ai-ui.vercel.app/api/property-customers", { cache: "no-store" });
        var _custList = await _fetchRes.json();
        var _customer = Array.isArray(_custList)
          ? _custList.find(function(x) { return String(x.id) === String(_cid); })
          : null;
        if (!_customer) { sendResponse({ ok: false, error: "customer not found" }); return; }

        // area_modeを付与（page-script.jsが参照できるように）
        if (_areaMode) _customer = Object.assign({}, _customer, { area_mode: _areaMode });

        // itandiのみ: fill-done後にスクレイプ→LINE送信するため先に作成
        var _siteFillDone = (site === "itandi")
          ? _createFillDoneWaiter("itandi", 90000)
          : null;

        // in-place autofill（ページ移動なし・バッチ処理と完全同一経路）
        console.log("[webapp-search] ▶ " + site + " _batchAutofill直接呼び出し customerId=" + _cid);
        await _batchAutofill(_customer, site, _isWide);
        console.log("[webapp-search] ✔ " + site + " _batchAutofill完了");

        // itandiのみ: fill完了後にスクレイプ+LINE送信（レインズはスクレイプなし）
        if (site === "itandi" && _siteFillDone) {
          _scrapeAndCompareItandi(
            _siteFillDone,
            String(_cid),
            (conditions && conditions.customerName) || null,
            conditions
          ).catch(function(e) {
            console.error("[itandiScrape] バックグラウンドエラー:", e.message || e);
          });
        }

        sendResponse({ ok: true });
      } catch (e) {
        console.error("[webapp-search] " + site + " error:", e);
        sendResponse({ ok: false, error: String(e.message) });
      }
    })();
    return true;
  }

  // ── CSP回避: content.jsに代わってproperty-customersをfetch ─────────────────
  if (msg.type === "axlx-fetch-customer") {
    (async () => {
      try {
        const res = await fetch("https://sumora-ai-ui.vercel.app/api/property-customers", { cache: "no-store" });
        const list = await res.json();
        const customer = Array.isArray(list)
          ? list.find(function (x) { return String(x.id) === String(msg.customerId); })
          : null;
        sendResponse({ customer: customer || null });
      } catch (e) {
        console.warn("[bg] axlx-fetch-customer error:", e);
        sendResponse({ customer: null });
      }
    })();
    return true;
  }

  // ── WebApp から直接スクレイプ+比較トリガー ──────────────────────────────
  // WebApp の UI から「物件を比較」ボタンを押すと送られるメッセージ。
  // 既存の _webappAutofill でリアプロを検索条件付きで開いた後、
  // 全ページをスクレイプして /api/compare-properties に POST する。
  if (msg.type === "axlx-scrape-and-compare") {
    const { customerId, conditions } = msg;
    (async () => {
      try {
        var _scIsWide   = !!(conditions.isWide || conditions.is_wide);
        var _scAreaMode = (conditions && conditions.area_mode) || null;
        var _scCustName = (conditions && conditions.customerName) || null;

        // fill-done Promise を先に作る（underbarがfill後に content.js 経由で解決する）
        var fillDonePromise = _createFillDoneWaiter("realnetpro", 90000);

        // リアプロタブを探す
        var _scAllTabs = await chrome.tabs.query({});
        var _scRealTab = _scAllTabs.find(function(t) { return t.url && t.url.startsWith("https://www.realnetpro.com"); });

        // まず underbar.js 直接通信を試みる（ページ更新なし）
        var _directOk = false;
        if (_scRealTab && customerId) {
          try {
            var _directResp = await new Promise(function(resolve) {
              chrome.tabs.sendMessage(_scRealTab.id, {
                type:         "axlx-switch-customer",
                customerId:   String(customerId),
                customerName: _scCustName,
                site:         "realpro",
                areaMode:     _scAreaMode,
                is_wide:      _scIsWide,
              }, function(r) {
                void chrome.runtime.lastError;
                resolve(r || { ok: false });
              });
            });
            _directOk = !!_directResp.ok;
            console.log("[scrape-compare] underbar直接通信:", JSON.stringify(_directResp));
          } catch(e) {
            console.log("[scrape-compare] underbar直接通信エラー:", e);
          }
        }

        if (!_directOk) {
          // フォールバック: main.phpナビゲート → pendingPopupCmd
          if (_scRealTab) {
            console.log("[scrape-compare] フォールバック → main.phpへ:", _scRealTab.id);
            await chrome.tabs.update(_scRealTab.id, { url: "https://www.realnetpro.com/main.php", active: true });
            await _batchWaitForTabComplete(_scRealTab.id);
            await new Promise(function(r) { setTimeout(r, 1500); });
          } else {
            console.log("[scrape-compare] リアプロタブなし → 新規作成");
            _scRealTab = await chrome.tabs.create({ url: "https://www.realnetpro.com/main.php", active: true });
            await _batchWaitForTabComplete(_scRealTab.id);
            await new Promise(function(r) { setTimeout(r, 2000); });
          }
          if (customerId) {
            await chrome.storage.session.set({
              pendingPopupCmd: {
                customerId:   String(customerId),
                customerName: _scCustName,
                site:         "realpro",
                areaMode:     _scAreaMode,
                is_wide:      _scIsWide,
              }
            });
            console.log("[scrape-compare] ✔ pendingPopupCmd設定 → underbarが引き継ぎ");
          }
        } else {
          console.log("[scrape-compare] ✔ underbar直接通信成功 → ページ更新なし");
        }

        // fill完了シグナル待機 → スクレイプ → LINE送信
        var scrapedCount = await _scrapeAndSendRealpro(fillDonePromise, customerId, _scCustName, conditions);
        sendResponse({ ok: true, count: scrapedCount });
      } catch (e) {
        console.error("[axlx-scrape-and-compare] error:", e);
        sendResponse({ ok: false, error: String(e.message) });
      }
    })();
    return true;
  }

  return false;
});

// ===== 自動化バッチ検索 =====
const SUMORA_BATCH_API = "https://sumora-ai-ui.vercel.app";

// ── 学習済みマップのキャッシュ付き取得（resolveConditionsLocal の learned パラメータ用）──
// popup.js の fetchLearnedMaps と同じ3エンドポイントを読む。失敗時は {}（静的マップのみで解決）。
var _learnedMapsCache = null;   // { wards, stations, lineOrder } または { __failed: true }
var _learnedMapsCacheAt = 0;    // epoch ms
var _LEARNED_MAPS_TTL_OK = 6 * 60 * 60 * 1000; // 成功キャッシュ: 6時間
var _LEARNED_MAPS_TTL_NG = 10 * 60 * 1000;     // 失敗キャッシュ: 10分（連続バッチで毎回タイムアウト待ちしない）

async function _getLearnedMapsCached() {
  var now = Date.now();
  if (_learnedMapsCache) {
    var ttl = _learnedMapsCache.__failed ? _LEARNED_MAPS_TTL_NG : _LEARNED_MAPS_TTL_OK;
    if (now - _learnedMapsCacheAt < ttl) {
      return _learnedMapsCache.__failed ? {} : _learnedMapsCache;
    }
  }
  try {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 6000);
    var results;
    try {
      results = await Promise.all([
        fetch(SUMORA_BATCH_API + "/api/region-map",    { cache: "no-store", signal: ctrl.signal }),
        fetch(SUMORA_BATCH_API + "/api/station-map",   { cache: "no-store", signal: ctrl.signal }),
        fetch(SUMORA_BATCH_API + "/api/line-stations", { cache: "no-store", signal: ctrl.signal }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    var wards = {}, stations = {}, lineOrder = {};
    if (results[0].ok) {
      var rd = await results[0].json();
      (rd.regions || []).forEach(function (r) { wards[r.token] = r.ward; });
    }
    if (results[1].ok) {
      var sd = await results[1].json();
      (sd.stations || []).forEach(function (s) {
        stations[s.token] = {
          ward: s.ward,
          realpro_lines: s.realpro_lines || [],
          itandi_lines: s.itandi_lines || [],
          reins_line: s.reins_line || null,
        };
      });
    }
    if (results[2].ok) {
      var ld = await results[2].json();
      lineOrder = ld.lines || {};
    }
    _learnedMapsCache = { wards: wards, stations: stations, lineOrder: lineOrder };
    _learnedMapsCacheAt = now;
    return _learnedMapsCache;
  } catch (e) {
    console.warn("[bg] 学習済みマップ取得失敗（静的マップのみでローカル解決）:", (e && e.message) || e);
    _learnedMapsCache = { __failed: true };
    _learnedMapsCacheAt = now;
    return {};
  }
}

// ── ローカル解決結果にAPI結果をマージ（配列はローカル優先の和集合・順序保持）──
function _mergeResolved(local, api) {
  api = api || {};
  function union(a, b) {
    var out = (a || []).slice();
    (b || []).forEach(function (v) { if (out.indexOf(v) === -1) out.push(v); });
    return out;
  }
  return {
    city_codes:        union(local.city_codes,        api.city_codes),
    route_ids:         union(local.route_ids,         api.route_ids),
    station_names:     union(local.station_names,     api.station_names),
    ward_names:        union(local.ward_names,        api.ward_names),
    itandi_line_names: union(local.itandi_line_names, api.itandi_line_names),
    reins_line_names:  union(local.reins_line_names,  api.reins_line_names),
    detail_ward: local.detail_ward || api.detail_ward || null,
    detail_area: local.detail_area || api.detail_area || null,
    // ローカルの unknown_tokens はAPIへの入力そのもの。残すと二重報告になるためAPIの最終判定を採用
    unknown_tokens: api.unknown_tokens || [],
    // 家賃・築年数は決定的な算術（wide時 +5000/+10000・+5年）。API側の再適用を無視して二重加算を防ぐ
    rent_max_resolved:     local.rent_max_resolved,
    building_age_resolved: local.building_age_resolved,
  };
}

// ── エリア条件解決のローカルファースト化 ─────────────────────────────────────
// Phase 1a: resolution-core.js の resolveConditionsLocal（popup.js と同一ロジック）で
//           ネットワークなしで解決。静的マップにあるトークン（大多数）はここで完結する。
// Phase 1b: 未解決トークンが残った場合のみ resolve-search-conditions API（DeepSeek）に
//           フォールバック。未解決分だけを投げるため、APIの応答がローカル解決分を潰さない。
// API 呼び出し条件: unknown_tokens あり、または エリア入力があるのにローカル結果が完全空。
// API 失敗時はローカル結果のまま続行（部分解決でも有効な条件）。
// 戻り値は resolve-search-conditions API と同形（呼び出し側のマージコードは変更不要）。
async function _resolveLocalFirst(baseConditions, isWide) {
  baseConditions = baseConditions || {};

  var desiredAreaFull = String(
    baseConditions.desired_area ||
    (baseConditions.areas && baseConditions.areas.length ? baseConditions.areas.join("・") : "") ||
    ""
  ).trim();
  var hasAreaInput = !!(
    desiredAreaFull ||
    (baseConditions.lines && baseConditions.lines.length) ||
    (baseConditions.stations && baseConditions.stations.length)
  );

  // Phase 1a: ローカル解決
  var local = null;
  try {
    var R = globalThis.SUMORA_RESOLUTION;
    if (R && typeof R.resolveConditionsLocal === "function") {
      var learned = await _getLearnedMapsCached(); // 失敗時 {}
      local = R.resolveConditionsLocal(baseConditions, { isWide: !!isWide, learned: learned }) || null;
      if (local) {
        console.log("[resolveLocalFirst] ローカル解決:", JSON.stringify({
          city_codes: local.city_codes,
          route_ids: local.route_ids,
          station_names: local.station_names,
          unknown_tokens: local.unknown_tokens,
        }));
      }
    }
  } catch (e) {
    console.warn("[resolveLocalFirst] ローカル解決エラー（APIフォールバックへ）:", e);
    local = null;
  }

  // resolution-core 未ロード等でローカル解決不能 → 従来どおりフルスコープでAPI
  if (!local) {
    if (!hasAreaInput) return {};
    try {
      var respFull = await fetch(SUMORA_BATCH_API + "/api/resolve-search-conditions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          desired_area: desiredAreaFull,
          lines: baseConditions.lines || [],
          stations: baseConditions.stations || [],
          is_wide: !!isWide,
          rent_max: baseConditions.rent_max || null,
          building_age: baseConditions.building_age || null,
        }),
        signal: AbortSignal.timeout(30000), // DeepSeekが最大20秒かかるため30秒
      });
      if (respFull.ok) return await respFull.json();
    } catch (e) {
      console.warn("[resolveLocalFirst] resolve-search-conditions 失敗（従来条件で続行）:", e);
    }
    return {};
  }

  // Phase 1b: APIフォールバック判定
  var unknownTokens = local.unknown_tokens || [];
  var localEmpty =
    !(local.city_codes && local.city_codes.length) &&
    !(local.route_ids && local.route_ids.length) &&
    !(local.station_names && local.station_names.length) &&
    !local.detail_ward;
  var needApi = unknownTokens.length > 0 || (hasAreaInput && localEmpty);
  if (!needApi) return local; // ハッピーパス: ネットワーク不要

  var resolved = local;
  try {
    var resolveResp = await fetch(SUMORA_BATCH_API + "/api/resolve-search-conditions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // 未解決トークンだけをAPIに投げる（全部未解決なら desired_area 全体）
        desired_area: unknownTokens.length ? unknownTokens.join("・") : desiredAreaFull,
        lines: [], stations: [], // 明示 lines/stations はローカルで処理済み
        is_wide: !!isWide,
        rent_max: baseConditions.rent_max || null,
        building_age: baseConditions.building_age || null,
      }),
      signal: AbortSignal.timeout(30000), // DeepSeekが最大20秒かかるため30秒
    });
    if (resolveResp.ok) resolved = _mergeResolved(local, await resolveResp.json());
  } catch (e) {
    console.warn("[resolveLocalFirst] APIフォールバック失敗（ローカル解決結果で続行）:", (e && e.message) || e);
  }
  return resolved;
}

// ── 修正10: automation API 共有シークレット ──────────────────────────────────
// chrome.storage.local の automationApiKey に設定した値を x-automation-key として送る。
// （拡張にはハードコード禁止のため、サービスワーカーコンソールで
//   chrome.storage.local.set({automationApiKey: "..."}) を一度実行して設定する）
async function _getAutomationKeyHeader() {
  try {
    var st = await chrome.storage.local.get("automationApiKey");
    return st.automationApiKey ? { "x-automation-key": st.automationApiKey } : {};
  } catch (e) {
    return {};
  }
}

// ── 修正4: 検索完了シグナル（fill-done）待機インフラ ─────────────────────────
// page-script.js / itandi-page-script.js が検索実行後に postMessage する
// 'aixlinx-fill-done' を content script が axlx-fill-done として中継してくる。
// スクレイプ側は autofill 発火「前」に _createFillDoneWaiter() で Promise を
// 作成しておき、シグナル受信（true）またはタイムアウト（false）を待つ。
var _fillDoneWaiters = [];

// resolve 値は { timedOut: boolean, error: string|null } に統一。
// error は page-script.js が fill-done に載せたエラー内容（フォールバック検索は実行済み）。
function _notifyFillDone(site, error) {
  var remaining = [];
  _fillDoneWaiters.forEach(function (w) {
    if (!w.site || !site || w.site === site) {
      clearTimeout(w.timer);
      w.resolve({ timedOut: false, error: error || null });
    } else {
      remaining.push(w);
    }
  });
  _fillDoneWaiters = remaining;
}

function _createFillDoneWaiter(site, timeoutMs) {
  return new Promise(function (resolve) {
    var entry = { site: site || null, resolve: resolve, timer: null };
    entry.timer = setTimeout(function () {
      var idx = _fillDoneWaiters.indexOf(entry);
      if (idx >= 0) _fillDoneWaiters.splice(idx, 1);
      resolve({ timedOut: true, error: null });
    }, timeoutMs || 90000);
    _fillDoneWaiters.push(entry);
  });
}

// content script からの fill-done 中継を受信
chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (msg && msg.type === "axlx-fill-done") {
    if (msg.error) {
      console.warn("[fill-done] 受信 site=" + (msg.site || "unknown") + " error=" + msg.error);
    } else {
      console.log("[fill-done] 受信 site=" + (msg.site || "unknown"));
    }
    _notifyFillDone(msg.site || null, msg.error || null);
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

// ── 修正1: リアプロ物件データを compare-properties API の形式へ変換 ──────────
// bulk-dl.js のスクレイパは name/access/move_in/detail_url で返すが、
// API は building_name/station_info/available_date/url を期待する。
// この不一致のままだとAIプロンプトが「【undefined】」・LINE文面が賃料/間取り欠落になる。
// （itandi 経路は元から正しい形式のため変換不要）
function _normalizeRealproProperties(properties) {
  return (properties || []).map(function (p) {
    return {
      building_name:  p.building_name || p.name || "",
      room_number:    p.room_number || p.room || undefined,
      rent:           p.rent !== undefined ? p.rent : null,
      management_fee: p.management_fee || undefined,
      floor_plan:     p.floor_plan || undefined,
      area:           p.area || undefined,
      address:        p.address || undefined,
      station_info:   p.station_info || p.access || undefined,
      available_date: p.available_date || p.move_in || undefined,
      url:            p.url || p.detail_url || p.pdf_url || undefined,
    };
  });
}

// alarmが既に存在する場合は再作成しない（Service Worker再起動時の重複防止）
chrome.alarms.get("sumora-batch-poll", function(existing) {
  if (!existing) {
    chrome.alarms.create("sumora-batch-poll", { periodInMinutes: 0.5 });
  }
});

// 修正2: SW再起動・拡張更新時に batchRunning ロックを必ずリセット
// （SWクラッシュでロックが残ると全自動化が無音で永久停止するため）
function _resetBatchLock() {
  try {
    chrome.storage.local.set({ batchRunning: null, batchCommandId: null });
  } catch (e) { /* ignore */ }
}
chrome.runtime.onStartup.addListener(_resetBatchLock);
chrome.runtime.onInstalled.addListener(_resetBatchLock);

var BATCH_LOCK_TTL_MS = 15 * 60 * 1000; // 修正2: ロックTTL 15分

chrome.alarms.onAlarm.addListener(async function(alarm) {
  if (alarm.name !== "sumora-batch-poll") return;
  var st = await chrome.storage.local.get("batchRunning");
  var lock = st.batchRunning;
  if (lock) {
    // 修正2: TTL方式 — {running:true, startedAt} 形式で15分未満なら実行中とみなす。
    // 旧boolean形式（startedAt無し）や15分超過は古いロックとして上書き実行する。
    var startedAt = (typeof lock === "object" && lock) ? lock.startedAt : 0;
    if (startedAt && Date.now() - startedAt < BATCH_LOCK_TTL_MS) return;
    console.warn("[batch] 古い batchRunning ロックを検出 → 上書き実行:", JSON.stringify(lock));
  }
  await _pollAndRunBatch();
});

async function _pollAndRunBatch() {
  try {
    // 修正9: pending ポーリングに10秒タイムアウト / 修正10: 共有シークレットヘッダー
    var res = await fetch(SUMORA_BATCH_API + "/api/automation/pending", {
      cache: "no-store",
      headers: await _getAutomationKeyHeader(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      // 修正: pending API のHTTPエラーを無音スキップせず可視化する
      // （SUPABASE_SERVICE_ROLE_KEY 未設定による全500がデバッグ不能だった）
      console.warn("[batch] pending API HTTP " + res.status);
      try {
        await chrome.storage.local.set({ lastPollError: { status: res.status, at: Date.now() } });
      } catch (e2) { /* ignore */ }
      return;
    }
    try { await chrome.storage.local.set({ lastPollError: null }); } catch (e2) { /* ignore */ }
    var json = await res.json();
    if (!json.command) return;
    var cmd = json.command;
    // 修正④b: コマンド受信時にポップアップを開き、スタッフに実行中を通知する。
    // chrome.action.openPopup() は Chrome 127 未満またはユーザージェスチャなし環境で失敗するため
    // try/catch でラップし、失敗時は赤バッジ '!' を 10秒表示してアイコンクリックを促す。
    // popup.js が chrome.storage.session で読むため session に書く。
    // customerId は customer_ids の先頭要素（ポップアップで顧客を自動選択するため）。
    try {
      await chrome.storage.session.set({
        pendingPopupCmd: {
          id: cmd.id,
          command_type: cmd.command_type,
          customerId: (cmd.customer_ids && cmd.customer_ids.length > 0) ? cmd.customer_ids[0] : null,
        }
      });
    } catch (_sessionErr) { /* session storage 非対応環境では無視 */ }
    try {
      await chrome.action.openPopup();
    } catch (_openPopupErr) {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });
      setTimeout(function() { chrome.action.setBadgeText({ text: '' }); }, 10000);
    }
    // 修正2: ロックを {running, startedAt} 形式で保存（TTL判定用）
    await chrome.storage.local.set({
      batchRunning: { running: true, startedAt: Date.now() },
      batchCommandId: cmd.id,
    });
    try {
      await _runBatchSearch(cmd);
    } catch (e) {
      await _updateBatchCommand(cmd.id, { status: "error", error_message: String(e) });
    } finally {
      await chrome.storage.local.set({ batchRunning: null, batchCommandId: null });
    }
  } catch (e) {
    // MV3 Service Worker起動直後の一時的なfetch失敗は無視（次の30秒ポーリングで自動回復）
    console.warn("[batch] poll error (transient):", e.message || e);
  }
}

async function _runBatchSearch(command) {
  // ── scrape_and_compare: WebApp（リアプロボタン）からのスクレイプ比較依頼 ────
  if (command.command_type === "scrape_and_compare") {
    await _updateBatchCommand(command.id, { status: "running" });
    try {
      var payload = command.payload || {};
      await _scrapeAndCompareForCustomer({
        customer_id: payload.customer_id,
        customer_name: payload.customer_name,
        is_wide: payload.is_wide || false,
        conditions: payload.conditions || {},
      });
      await _updateBatchCommand(command.id, { status: "done", completed_at: new Date().toISOString() });
    } catch (scrapeErr) {
      await _updateBatchCommand(command.id, { status: "error", error_message: String(scrapeErr) });
    }
    return;
  }

  // ── property_scrape: 指定顧客の物件をスクレイプして比較API に渡す ──────────
  if (command.command_type === "property_scrape") {
    await _updateBatchCommand(command.id, { status: "running" });
    try {
      var scrapeCustomersRes = await fetch(SUMORA_BATCH_API + "/api/property-customers", { cache: "no-store" });
      if (!scrapeCustomersRes.ok) throw new Error("顧客データ取得失敗");
      var scrapeAllCustomers = await scrapeCustomersRes.json();
      var scrapeCustomer = Array.isArray(scrapeAllCustomers) && command.customer_ids && command.customer_ids.length > 0
        ? scrapeAllCustomers.find(function (c) { return command.customer_ids.indexOf(String(c.id)) !== -1; })
        : null;
      if (!scrapeCustomer) throw new Error("対象顧客が見つかりません (customer_ids=" + (command.customer_ids || []).join(",") + ")");
      await _scrapeAndCompareForCustomer(scrapeCustomer);
      await _updateBatchCommand(command.id, { status: "done", completed_at: new Date().toISOString() });
    } catch (scrapeErr) {
      await _updateBatchCommand(command.id, { status: "error", error_message: String(scrapeErr) });
    }
    return;
  }

  // ── 通常バッチ検索（既存処理）────────────────────────────────────────────
  var customersRes = await fetch(SUMORA_BATCH_API + "/api/property-customers", { cache: "no-store" });
  if (!customersRes.ok) throw new Error("顧客データ取得失敗");
  var allCustomers = await customersRes.json();

  var targets;
  if (command.customer_ids && command.customer_ids.length > 0) {
    targets = allCustomers.filter(function(c) {
      return command.customer_ids.indexOf(String(c.id)) !== -1;
    });
  } else {
    var threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    var now = Date.now();
    targets = allCustomers.filter(function(c) {
      if (c.status === "new_inquiry") return true;
      if (c.status === "hot") return true;
      if (c.status === "property_search") {
        if (!c.last_property_sent_at) return true;
        return now - new Date(c.last_property_sent_at).getTime() > threeDaysMs;
      }
      return false;
    });
  }

  var sites = command.sites || ["reins"];
  // 修正5: is_wide をキュー経路（trigger API → payload.is_wide）から伝搬
  var batchIsWide = !!(command.is_wide || (command.payload && command.payload.is_wide));
  await _updateBatchCommand(command.id, {
    status: "running",
    total_customers: targets.length,
    processed_customers: 0
  });

  var batchErrors = []; // 修正12: サイト別の失敗を集約してサーバーへ可視化する

  for (var i = 0; i < targets.length; i++) {
    var customer = targets[i];
    for (var j = 0; j < sites.length; j++) {
      var batchSite = sites[j];
      try {
        // 修正4: fill-done ウェイターを autofill 発火「前」に作成しておく
        // リアプロ・itandi ともモーダル操作/ページロードで60秒を超えることがあるため90秒に統一
        var fillDoneP = (batchSite === "itandi" || batchSite === "realnetpro")
          ? _createFillDoneWaiter(batchSite, 90000)
          : null;
        // _batchAutofill は解決済み条件（itandi_lines 等を含む）を返す
        var resolvedBatchConds = await _batchAutofill(customer, batchSite, batchIsWide);
        if (batchSite === "itandi") {
          // itandi の場合: autofill後にスクレイプ+AI比較+LINE送信を実行
          // 解決済み条件（itandi_lines を含む）を渡すことで compare-properties API に正しい路線情報を届ける
          await _scrapeAndCompareItandi(
            fillDoneP,
            String(customer.id),
            customer.customer_name || null,
            resolvedBatchConds || _buildBatchConditions(customer, batchIsWide)
          );
        } else if (batchSite === "realnetpro") {
          // 修正7: 通常バッチのリアプロ分岐にもスクレイプ→AI比較→LINE送信を追加
          // （従来は autofill + 3秒 sleep のみで結果がどこにも届かなかった）
          await _scrapeAndSendRealpro(
            fillDoneP,
            String(customer.id),
            customer.customer_name || null,
            resolvedBatchConds || _buildBatchConditions(customer, batchIsWide)
          );
        } else {
          await new Promise(function(r) { setTimeout(r, 3000); });
        }
      } catch (e) {
        console.error("[batch] error:", customer.id, batchSite, e);
        batchErrors.push(customer.id + "/" + batchSite + ": " + ((e && e.message) || e));
      }
    }
    await _updateBatchCommand(command.id, { processed_customers: i + 1 });
  }

  // 修正12: 全件失敗なら status:'error'、一部失敗でも error_message に記録して可視化
  var totalAttempts = targets.length * sites.length;
  if (batchErrors.length > 0 && batchErrors.length >= totalAttempts && totalAttempts > 0) {
    await _updateBatchCommand(command.id, {
      status: "error",
      error_message: batchErrors.join(" | ").slice(0, 1900),
      completed_at: new Date().toISOString()
    });
    return;
  }
  var doneUpdates = {
    status: "done",
    completed_at: new Date().toISOString()
  };
  if (batchErrors.length > 0) {
    doneUpdates.error_message = "一部失敗: " + batchErrors.join(" | ").slice(0, 1800);
  }
  await _updateBatchCommand(command.id, doneUpdates);
}

async function _batchAutofill(customer, site, isWide) {
  var siteUrlPrefixes = {
    reins: "https://system.reins.jp",
    itandi: "https://itandibb.com",
    realnetpro: "https://www.realnetpro.com"
  };
  var siteUrls = {
    reins: "https://system.reins.jp/main/PF08/SA08I010.aspx",
    itandi: "https://itandibb.com/rent_rooms/list",
    realnetpro: "https://www.realnetpro.com/main.php"
  };
  var prefix = siteUrlPrefixes[site];
  if (!prefix) return;

  var allTabs = await chrome.tabs.query({});
  var existing = allTabs.find(function(t) { return t.url && t.url.startsWith(prefix); });
  var tab = existing;
  if (!tab) {
    tab = await chrome.tabs.create({ url: siteUrls[site], active: false });
    await _batchWaitForTabComplete(tab.id);
    await new Promise(function(r) { setTimeout(r, 2000); });
  }

  var conds = _buildBatchConditions(customer, isWide);

  // ── itandi 専用: 路線名・エリア名を itandi-page-script.js が使うキー形式に変換 ──
  // itandi-page-script.js は cond.itandi_lines と cond.ward_names を参照する。
  // _buildBatchConditions は cond.lines（リアプロ形式）と cond.areas を返すため変換が必要。
  if (site === "itandi") {
    // エリア: areas 配列をそのまま ward_names として使用
    if (conds.areas && conds.areas.length) {
      conds.ward_names = conds.areas;
    }
    // 路線名: ローカルファースト解決で itandi 形式の路線名に変換
    // （静的マップで解決できればAPI不要・未解決トークンのみAPIフォールバック）
    if (conds.lines && conds.lines.length) {
      try {
        var resolvedItandi = await _resolveLocalFirst(conds, isWide);
        if (resolvedItandi.itandi_line_names && resolvedItandi.itandi_line_names.length) {
          conds.itandi_lines = resolvedItandi.itandi_line_names;
        }
        if (resolvedItandi.station_names && resolvedItandi.station_names.length) {
          conds.station_names = resolvedItandi.station_names;
        }
        // エリア解決済み ward_names がある場合は上書き（概念地域対応）
        if (resolvedItandi.detail_ward) {
          if (!conds.ward_names || !conds.ward_names.length) {
            conds.ward_names = [resolvedItandi.detail_ward];
          }
        }
      } catch (e) {
        console.warn("[batchAutofill] itandi resolve失敗（デフォルト条件で続行）:", e.message || e);
      }
    }
  }

  if (site === "realnetpro") {
    // itandi分岐と同様: resolve-search-conditions API で city_codes/route_ids/station_names を解決する
    // _buildBatchConditions は raw (areas/lines/stations) しか返さないため、
    // page-script.js の decideLocationMode が参照する解決済みフィールドを補完する必要がある
    if ((conds.areas && conds.areas.length) || (conds.lines && conds.lines.length) || (conds.stations && conds.stations.length)) {
      try {
        // ローカルファースト解決（静的マップで解決できればAPI不要・未解決トークンのみAPIフォールバック）
        var resolvedRealnetpro = await _resolveLocalFirst(conds, isWide);
        if (resolvedRealnetpro.city_codes && resolvedRealnetpro.city_codes.length) {
          conds.city_codes = resolvedRealnetpro.city_codes;
        }
        if (resolvedRealnetpro.route_ids && resolvedRealnetpro.route_ids.length) {
          conds.route_ids = resolvedRealnetpro.route_ids;
        }
        if (resolvedRealnetpro.station_names && resolvedRealnetpro.station_names.length) {
          conds.station_names = resolvedRealnetpro.station_names;
        }
        if (resolvedRealnetpro.detail_ward) {
          conds.detail_ward = resolvedRealnetpro.detail_ward;
        }
      } catch (e) {
        console.warn("[batchAutofill] realnetpro resolve失敗（デフォルト条件で続行）:", e.message || e);
      }
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: function(c) { window.postMessage({ from: "aixlinx-fill", conditions: c }, "*"); },
      args: [conds]
    });
  } else if (site === "itandi") {
    // itandi: chrome.tabs.sendMessage で axlx-itandi-autofill を送る
    // itandi-content.js が injectPageScript() を呼んでから axlx-itandi-fill イベントを転送する
    var itandiSent = await new Promise(function(resolve) {
      chrome.tabs.sendMessage(tab.id, { type: "axlx-itandi-autofill", conditions: conds }, function(resp) {
        resolve(!chrome.runtime.lastError && !!(resp && resp.ok));
      });
    });
    if (!itandiSent) {
      // フォールバック: page script が既に注入済みの場合は MAIN world で直接イベント発火
      console.warn("[batchAutofill] itandi sendMessage未確認, executeScript fallback");
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: function(c) { window.dispatchEvent(new CustomEvent("axlx-itandi-fill", { detail: c })); },
        args: [conds]
      });
    }
  } else {
    // reins
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: function(c) { window.dispatchEvent(new CustomEvent("axlx-reins-fill", { detail: c })); },
      args: [conds]
    });
  }
  // 解決済み条件を返す（呼び出し元でスクレイプ+比較に再利用できるようにする）
  return conds;
}

function _buildBatchConditions(c, isWide) {
  // desired_area (文字列) → areas (配列) 変換
  var areaArr = [];
  if (c.areas && c.areas.length) {
    areaArr = c.areas;
  } else if (c.desired_area) {
    areaArr = c.desired_area.split(/[・、,]+/).map(function(s) { return s.trim(); }).filter(Boolean);
  }
  return {
    is_wide: !!isWide, // 修正5: page-script 側の広ロジック（間取り拡張等）に伝搬
    area_mode: c.area_mode || null, // webapp経由で渡されたarea_modeをpage-scriptに伝搬
    rent_max: c.rent_max || null,
    rent_min: c.rent_min || null,
    walk_minutes: c.walk_minutes || null,
    building_age: c.building_age || null,
    floor_plan: c.floor_plan || null,
    areas: areaArr,
    lines: c.lines || [],
    stations: c.stations || [],
    prefecture: c.prefecture || null,
    city: c.city || null
  };
}

function _batchWaitForTabComplete(tabId) {
  return new Promise(function(resolve) {
    var listener = function(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(resolve, 15000);
  });
}

// content script 生存確認 ping。応答があれば true、受け手不在・タイムアウト時は false。
// orphaned content.js（拡張リロード後に切断された古い content script）は応答できないため、
// これが「ナビゲーション省略しても安全か」の判定シグナルになる。
async function _pingTab(tabId, timeoutMs) {
  timeoutMs = timeoutMs || 800;
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; resolve(false); } }, timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, { type: "axlx-ping" }, function (resp) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) { resolve(false); return; }
        resolve(!!(resp && resp.pong));
      });
    } catch (e) {
      if (!done) { done = true; clearTimeout(timer); resolve(false); }
    }
  });
}

async function _webappAutofill(site, conditions) {
  console.log("[webapp-autofill] ▶ 開始 site=" + site);
  var siteUrlPrefixes = {
    realnetpro: "https://www.realnetpro.com",
    itandi:     "https://itandibb.com",
    reins:      "https://system.reins.jp"
  };
  var siteUrls = {
    realnetpro: "https://www.realnetpro.com/main.php",
    itandi:     "https://itandibb.com/rent_rooms/list",
    reins:      "https://system.reins.jp/main/PF08/SA08I010.aspx"
  };
  var prefix = siteUrlPrefixes[site];
  if (!prefix) { console.warn("[webapp-autofill] 不明なsite:", site); return; }

  var allTabs = await chrome.tabs.query({});
  var existing = allTabs.find(function(t) { return t.url && t.url.startsWith(prefix); });
  // 修正: リアプロは content.js/page-script.js が main.php* にしか注入されない。
  // ログイン画面等 main.php 以外のタブを掴むと条件送信が無音消失するため、
  // main.php タブを優先し、無ければ既存タブを main.php へナビゲートしてから使う。
  if (site === "realnetpro") {
    var mainTab = allTabs.find(function(t) { return t.url && t.url.includes("realnetpro.com/main.php"); });
    var targetRealTab = mainTab || existing;
    if (targetRealTab) {
      // 必ずmain.phpへナビゲートしてフォームをクリーンな初期状態にする
      // ※ ping-skip最適化（alive時にナビゲーション省略）は廃止:
      //   検索結果ページ（フォームが折りたたまれた状態）のまま送信されると
      //   「所在地絞り込み」ボタンが見つからず中止になるバグを引き起こしていた
      console.log("[webapp-autofill] → main.php にナビゲート（フォームクリーン化）", targetRealTab.id);
      await chrome.tabs.update(targetRealTab.id, { url: siteUrls.realnetpro, active: true });
      await _batchWaitForTabComplete(targetRealTab.id);
      await new Promise(function(r) { setTimeout(r, 2000); });
      existing = targetRealTab;
    }
  }
  var tab = existing;
  if (!tab) {
    // タブが存在しない: 新規作成してフォアグラウンドで開く
    tab = await chrome.tabs.create({ url: siteUrls[site], active: true });
    await _batchWaitForTabComplete(tab.id);
    await new Promise(function(r) { setTimeout(r, 2000); });
  } else if (site !== "realnetpro") {
    // タブが存在する: フォアグラウンドに切り替え（realnetpro は上でナビゲート・待機済み）
    // ping が通れば content script は生きているので待機を 1500ms → 300ms に短縮
    await chrome.tabs.update(tab.id, { active: true });
    var alive2 = await _pingTab(tab.id, 800);
    await new Promise(function(r) { setTimeout(r, alive2 ? 300 : 1500); });
  }

  // 修正: タブ準備後にURLを再取得して検証する。
  // リアプロは未ログインだと main.php がログイン画面（別URL）へリダイレクトされ、
  // content.js（main.php* 限定注入）も page-script.js も不在になり、
  // sendMessage / executeScript とも無音失敗して「条件が反映されない」原因になっていた。
  try {
    tab = await chrome.tabs.get(tab.id);
  } catch (tabErr) {
    throw new Error("autofill failed (" + site + "): タブが閉じられました");
  }
  if (site === "realnetpro" && !(tab.url && tab.url.includes("realnetpro.com/main.php"))) {
    throw new Error(
      "リアプロが未ログインです（main.php 以外へリダイレクト）。実行PCのChromeでリアプロにログインしてから再実行してください (現URL: " +
      (tab.url || "不明") + ")"
    );
  }

  // sendMessage 優先（executeScript の world:"MAIN" はホスト権限エラーが出やすいため）
  console.log("[webapp-autofill] ▶ tab確定 id=" + tab.id + " url=" + tab.url);
  var msgType = site === "realnetpro" ? "axlx-realnetpro-autofill"
              : site === "reins"      ? "axlx-reins-autofill"
              :                        "axlx-itandi-autofill";
  // 修正: リダイレクト直後は content script のリスナー登録が間に合わないことがあるため
  // 1回で諦めず 1.5秒間隔で最大3回リトライする
  var sent = false;
  for (var sendAttempt = 0; sendAttempt < 3 && !sent; sendAttempt++) {
    if (sendAttempt > 0) {
      await new Promise(function(r) { setTimeout(r, 1500); });
      console.warn("[webapp-autofill] sendMessage retry " + sendAttempt + " for " + site);
    }
    sent = await new Promise(function(resolve) {
      chrome.tabs.sendMessage(tab.id, { type: msgType, conditions: conditions }, function(resp) {
        if (chrome.runtime.lastError) {
          console.warn("[webapp-autofill] attempt" + sendAttempt + " lastError:", chrome.runtime.lastError.message);
          resolve(false); return;
        }
        console.log("[webapp-autofill] ✔ sendMessage成功 attempt=" + sendAttempt);
        resolve(true);
      });
    });
  }

  if (!sent) {
    // 修正: リアプロは page-script.js を content.js が注入する構造のため、
    // content.js 不在タブへの executeScript(postMessage) は受け手ゼロで無音消失する。
    // フォールバックせず原因が分かるメッセージで throw する。
    if (site === "realnetpro") {
      throw new Error(
        "autofill failed (realnetpro): content.js が3回とも応答しませんでした。" +
        "リアプロタブの再読み込み、または拡張の再読み込みを試してください (URL: " + (tab.url || "不明") + ")"
      );
    }
    // itandi / reins は従来どおり executeScript にフォールバック
    // 修正: フォールバックも失敗したら throw して呼び出し元が status:'error' を記録できるようにする
    console.warn("[webapp-autofill] sendMessage failed, fallback to executeScript for", site);
    try {
      var evName = site === "reins" ? "axlx-reins-fill" : "axlx-itandi-fill";
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: function(name, c) { window.dispatchEvent(new CustomEvent(name, { detail: c })); },
        args: [evName, conditions]
      });
    } catch (fallbackErr) {
      throw new Error("autofill failed (" + site + "): sendMessage失敗 + executeScriptフォールバック失敗: " +
        ((fallbackErr && fallbackErr.message) || fallbackErr));
    }
  }
}

async function _updateBatchCommand(id, updates) {
  try {
    // 修正9: 10秒タイムアウト / 修正10: 共有シークレットヘッダー
    var keyHeader = await _getAutomationKeyHeader();
    var resp = await fetch(SUMORA_BATCH_API + "/api/automation/update", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, keyHeader),
      body: JSON.stringify(Object.assign({ id: id }, updates)),
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) {
      var txt = "";
      try { txt = await resp.text(); } catch (_) {}
      console.error("[batch] update HTTP error", resp.status, txt);
    }
  } catch (e) {
    console.error("[batch] update error:", e);
  }
}

// ===== スクレイピング支援関数 =====

// リアプロのタブに axlx-scrape-realpro メッセージを送り、物件配列を受け取る
// 修正12: 応答不能（content script不在・拡張リロード等）は {error: message} を返し、
// 「0件」と「スクレイプ失敗」を区別できるようにする
async function _scrapeRealproPage(tabId) {
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(tabId, { type: "axlx-scrape-realpro" }, function (resp) {
      if (chrome.runtime.lastError || !resp) {
        var errMsg = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "no response";
        console.warn("[scrape] _scrapeRealproPage: no response from tab " + tabId + " (" + errMsg + ")");
        resolve({ error: errMsg });
        return;
      }
      resolve(resp.properties || []);
    });
  });
}

// 「次へ」ボタンをクリック。クリックできた場合は true を返す
async function _clickNextPage(tabId) {
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(tabId, { type: "axlx-click-next-page" }, function (resp) {
      if (chrome.runtime.lastError || !resp) { resolve(false); return; }
      resolve(resp.clicked === true);
    });
  });
}

// 最大 maxPages ページを巡回してすべての物件データを収集する
async function _scrapeAllRealproPages(tabId) {
  var allProperties = [];
  var maxPages = 10; // リアプロは通常 1〜3 ページ。安全マージンで 10 ページ上限
  for (var page = 0; page < maxPages; page++) {
    var props = await _scrapeRealproPage(tabId);
    // 修正12: スクレイプ失敗（error オブジェクト）と0件を区別する
    if (props && props.error) {
      if (page === 0) {
        throw new Error("リアプロスクレイプ失敗: " + props.error);
      }
      console.warn("[scrape] page " + (page + 1) + " scrape error: " + props.error + " → 打ち切り");
      break;
    }
    console.log("[scrape] page " + (page + 1) + ": " + props.length + "件");
    if (props.length === 0) break; // ページに物件がない = 終了
    allProperties = allProperties.concat(props);
    var hasNext = await _clickNextPage(tabId);
    if (!hasNext) break;
    // 次ページ読み込みを待つ
    await new Promise(function (r) { setTimeout(r, 2000); });
  }
  return allProperties;
}

// スクレイプ結果を /api/compare-properties に POST する
async function _sendPropertiesToBackend(properties, customerId, conditions, customerName) {
  var body = { properties: properties, customerId: customerId, conditions: conditions };
  if (customerName) body.customerName = customerName;
  // 修正9: サーバー側 maxDuration=120 と整合させ120秒に延長（途中Abort→再送によるLINE二重送信リスクを減らす）
  var resp = await fetch(SUMORA_BATCH_API + "/api/compare-properties", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
  });
  if (!resp.ok) {
    var errText = await resp.text().catch(function () { return ""; });
    throw new Error("compare-properties API error HTTP " + resp.status + ": " + errText.slice(0, 120));
  }
  return resp.json();
}

// 1顧客分のスクレイプ+比較を実行する（scrape_and_compare / property_scrape 共用）
// 両形式に対応:
//   新形式: { customer_id, customer_name, is_wide, conditions }  ← scrape_and_compare
//   旧形式: フル顧客オブジェクト { id, rent_max, ... }           ← property_scrape
async function _scrapeAndCompareForCustomer(customer) {
  var customerId = customer.customer_id || customer.id;
  var customerName = customer.customer_name;
  var isWide = customer.is_wide || false;

  // conditions: 新形式は customer.conditions、旧形式は _buildBatchConditions で構築
  var baseConditions = customer.conditions
    ? customer.conditions
    : _buildBatchConditions(customer);

  // Phase 1: エリア→駅名・路線・区コードの解決（ローカルファースト）
  // 1a: resolveConditionsLocal（popup.jsと同一ロジック・ネットワーク不要）で解決し、
  // 1b: 未解決トークンが残った場合のみ resolve-search-conditions API にフォールバックする。
  // 静的マップで解決できる大多数のケースでは 30秒の DeepSeek 往復が丸ごと消える。
  var resolved = await _resolveLocalFirst(baseConditions, isWide);

  // Phase 2: 解決済み条件をマージしてリアプロを開き条件入力・検索
  // resolve結果が空配列の場合も従来条件を残す（length チェック）
  var mergedStations  = (resolved.station_names && resolved.station_names.length) ? resolved.station_names : (baseConditions.station_names || []);
  var mergedRoutes    = (resolved.route_ids && resolved.route_ids.length)         ? resolved.route_ids     : (baseConditions.route_ids     || []);
  var mergedCityCodes = (resolved.city_codes && resolved.city_codes.length)       ? resolved.city_codes    : (baseConditions.city_codes    || []);
  // 複数区顧客の暫定策: detail_ward は最初の1区しか返らないため、
  // city_codes が2つ以上ある場合は null にして従来の直接チェックボックス法を使う
  var mergedDetailWard = (mergedCityCodes.length >= 2) ? null : (resolved.detail_ward || null);
  var mergedConditions = Object.assign({}, baseConditions, {
    station_names: mergedStations,
    route_ids:     mergedRoutes,
    city_codes:    mergedCityCodes,
    detail_ward:   mergedDetailWard,                  // 所在地モーダル法で必要（例: "大阪市西淀川区"）
    detail_area:   resolved.detail_area || baseConditions.detail_area || null, // 町字ピンポイント選択用
    // itandi / レインズ用路線名もマージ（payload事前解決 or 拡張側resolveのどちらでも揃うように）
    itandi_line_names: (resolved.itandi_line_names && resolved.itandi_line_names.length)
      ? resolved.itandi_line_names : (baseConditions.itandi_line_names || []),
    reins_line_names:  (resolved.reins_line_names && resolved.reins_line_names.length)
      ? resolved.reins_line_names  : (baseConditions.reins_line_names  || []),
    unknown_tokens: (resolved.unknown_tokens && resolved.unknown_tokens.length)
      ? resolved.unknown_tokens : (baseConditions.unknown_tokens || []),
    is_wide:       isWide,
    rent_max:      resolved.rent_max_resolved     || baseConditions.rent_max     || null,
    building_age:  resolved.building_age_resolved || baseConditions.building_age || null,
  });

  // 修正: サイレント全件検索の防止。
  // エリア入力（desired_area / lines / stations）があるのに、resolve後も
  // 駅・路線・区コード・区名がすべて空 = 条件解決失敗。このまま検索すると
  // エリア条件ゼロの全件検索が黙って実行され、無関係物件がAI比較→LINE送信される。
  // 誤送信を防ぐため error として明示的に終了する。
  var hasAreaInput = !!(
    (baseConditions.desired_area && String(baseConditions.desired_area).trim()) ||
    (baseConditions.lines && baseConditions.lines.length) ||
    (baseConditions.stations && baseConditions.stations.length)
  );
  // page-script.js の area_mode suppression と同じロジックでチェックする（guard が suppression後の実態を見るため）
  var _am = mergedConditions.area_mode;
  var hasAreaResolved = (_am === "ward")
    ? (mergedCityCodes.length > 0 || !!mergedDetailWard)
    : (_am === "station")
      ? (mergedStations.length > 0 || mergedRoutes.length > 0)
      : (mergedStations.length > 0 || mergedRoutes.length > 0 ||
         mergedCityCodes.length > 0 || !!mergedDetailWard);
  if (hasAreaInput && !hasAreaResolved) {
    var utList = (mergedConditions.unknown_tokens || []).join(", ");
    throw new Error(
      "エリア条件を解決できませんでした（条件なし全件検索を防ぐため中止）。" +
      "desired_area=\"" + (baseConditions.desired_area || "") + "\"" +
      (utList ? " / unknown_tokens: " + utList : " / resolve-search-conditions が空応答")
    );
  }

  // Phase 3〜6: fill-done 待機 → スクレイプ → AI比較+LINE送信
  // 修正4: 固定8秒待ちを廃止。ウェイターは autofill 発火「前」に作成する
  var fillDonePromise = _createFillDoneWaiter("realnetpro", 90000);
  await _webappAutofill("realnetpro", mergedConditions);
  await _scrapeAndSendRealpro(fillDonePromise, customerId, customerName, mergedConditions);
}

// ── 修正4+7+12: リアプロの fill-done 待機 → 全ページスクレイプ → AI比較+LINE送信 ──
// fillDonePromise は autofill 発火「前」に _createFillDoneWaiter("realnetpro", 90000)
// で作成しておくこと。失敗（シグナル未着・タブ不在・スクレイプ全失敗）は throw して
// 呼び出し元（scrape_and_compare / 通常バッチ）が status:'error' として記録できるようにする。
async function _scrapeAndSendRealpro(fillDonePromise, customerId, customerName, conditions) {
  // 修正4: 検索実行シグナルを待つ（所在地・沿線駅モーダル経由だと入力に15〜60秒かかる上、
  // タブのページロード時間もこの待機予算から消費されるため90秒に設定。
  // page-script.js 側は85秒のフェイルセーフで必ず fill-done を送る）
  // resolve 値は { timedOut, error } 形式（_createFillDoneWaiter 参照）
  var fillDone = fillDonePromise ? await fillDonePromise : null;
  if (!fillDone || fillDone.timedOut) {
    throw new Error("リアプロ検索完了シグナル（fill-done）が90秒以内に届きませんでした。前回結果の誤送信を防ぐためスクレイプを中止します。");
  }
  if (fillDone.error) {
    // fallbackSearchWithoutArea はエラー送信のみで検索を実行しないため、
    // スクレイプすると前回結果やエリア条件なし全件を誤送信する。中止する。
    throw new Error("page-script側エラー（スクレイプ中止）: " + fillDone.error);
  }
  // 検索結果の描画完了を待つ
  await new Promise(function (r) { setTimeout(r, 3000); });

  // リアプロタブを取得
  var allTabs = await chrome.tabs.query({});
  var realproTab = allTabs.find(function (t) {
    return t.url && t.url.includes("realnetpro.com");
  });
  if (!realproTab) {
    throw new Error("リアプロのタブが見つかりません");
  }

  // 全ページスクレイピング（最大10ページ）— 1ページ目のスクレイプ失敗は throw（修正12）
  var properties = await _scrapeAllRealproPages(realproTab.id);
  console.log("[scrapeAndCompare] customer=" + customerId + " scraped=" + properties.length + "件");

  if (properties.length === 0) {
    console.warn("[scrapeAndCompare] 物件0件のためAPIスキップ");
    return 0;
  }

  // AI比較 + 売上番長LINE送信（修正1: フィールド名を API 形式へ変換してから送信）
  await _sendPropertiesToBackend(
    _normalizeRealproProperties(properties),
    customerId,
    conditions,
    customerName
  );
  return properties.length;
}

// ===== itandi スクレイプ支援関数 =====

// itandi タブに axlx-scrape-itandi メッセージを送り、物件配列を受け取る
// 修正: content script 無応答は [] ではなく {error: msg} を返す（_scrapeRealproPage と統一）
// _scrapeAllItandiPages で error を検知して throw させることで
// 「0件」と「スクレイプ失敗」を区別できるようにする
async function _scrapeItandiPage(tabId) {
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(tabId, { type: "axlx-scrape-itandi" }, function (resp) {
      if (chrome.runtime.lastError || !resp) {
        var errMsg = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "no response";
        console.warn("[itandiScrape] _scrapeItandiPage: no response from tab " + tabId +
          " (" + errMsg + ")");
        resolve({ error: errMsg });
        return;
      }
      resolve(resp.properties || []);
    });
  });
}

// itandi の「次へ」ボタンをクリック。クリックできた場合は true を返す
async function _clickNextPageItandi(tabId) {
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(tabId, { type: "axlx-click-next-page-itandi" }, function (resp) {
      if (chrome.runtime.lastError || !resp) { resolve(false); return; }
      resolve(resp.clicked === true);
    });
  });
}

// 最大 maxPages ページを巡回してすべての itandi 物件データを収集する
async function _scrapeAllItandiPages(tabId) {
  var allProperties = [];
  var maxPages = 10; // itandi は通常 1〜5 ページ程度。安全マージンで 10 ページ上限
  for (var page = 0; page < maxPages; page++) {
    var props = await _scrapeItandiPage(tabId);
    console.log("[itandiScrape] page " + (page + 1) + ": " + props.length + "件");
    if (props.length === 0) break;
    allProperties = allProperties.concat(props);
    var hasNext = await _clickNextPageItandi(tabId);
    if (!hasNext) break;
    // 次ページ読み込みを待つ
    await new Promise(function (r) { setTimeout(r, 2000); });
  }
  return allProperties;
}

// itandi の autofill 完了後にスクレイプ + /api/compare-properties で AI比較 + LINE送信する
// 修正4: 固定8秒待ちを廃止し、itandi-page-script.js の検索実行シグナル（fill-done）を待つ。
// fillDonePromise は autofill 発火「前」に _createFillDoneWaiter("itandi", 90000) で作成しておくこと。
async function _scrapeAndCompareItandi(fillDonePromise, customerId, customerName, conditions) {
  // resolve 値は { timedOut, error } 形式（_createFillDoneWaiter 参照）
  var fillDone = fillDonePromise ? await fillDonePromise : null;
  if (!fillDone || fillDone.timedOut) {
    throw new Error("itandi 検索完了シグナル（fill-done）が90秒以内に届きませんでした。前回結果の誤送信を防ぐためスクレイプを中止します。");
  }
  if (fillDone.error) {
    console.warn("[fill-done] itandi page-script側エラー（スクレイプは続行）: " + fillDone.error);
  }
  // 検索結果の描画完了を待つ
  await new Promise(function (r) { setTimeout(r, 3000); });

  // itandi タブを取得
  var allTabs = await chrome.tabs.query({});
  var itandiTab = allTabs.find(function (t) {
    return t.url && t.url.includes("itandibb.com");
  });
  if (!itandiTab) {
    throw new Error("itandiのタブが見つかりません"); // 修正12: 無音の欠落を検知可能にする
  }

  // 全ページスクレイプ（最大 10 ページ）
  var properties = await _scrapeAllItandiPages(itandiTab.id);
  console.log("[itandiScrape] customer=" + customerId + " scraped=" + properties.length + "件");

  if (properties.length === 0) {
    console.warn("[itandiScrape] 物件0件のためAPIスキップ");
    return;
  }

  // AI比較 + 売上番長グループへ LINE 送信
  await _sendPropertiesToBackend(properties, customerId, conditions, customerName);
}

// ===== END: 自動化バッチ検索 =====
