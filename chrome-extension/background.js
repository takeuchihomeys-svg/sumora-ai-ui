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
      // M8修正: 即時 clear() を廃止。複数PDF一括DLでは2件目以降がここに来るため
      // 既存の35秒タイマーで自然消化させる（全件完了後に watcher が自動削除される）
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

// content script から chrome.storage.session へのアクセスを許可
if (chrome.storage && chrome.storage.session && chrome.storage.session.setAccessLevel) {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(function() {});
}

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

// ── ヘルパー: uploadPdfToBlob の個別リトライラッパー（M9修正）──────────────
// 途中失敗で孤立 Blob が出ても LINE 送信を止めないよう最大3回リトライ
async function uploadWithRetry(b64, fileName) {
  for (let i = 0; i < 3; i++) {
    try { return await uploadPdfToBlob(b64, fileName); }
    catch (e) {
      if (i === 2) throw e;
      console.warn(`[uploadWithRetry] 試行 ${i + 1} 失敗、1秒後に再試行:`, e.message);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
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
        const { urls, customer_name, property_summaries, customer_conditions, site, property_pool, customer_id } = msg;
        const today = new Date().toLocaleDateString("ja-JP").replace(/\//g, "-");

        // fire-and-forget: 物件候補プールを学習ループ用APIに記録
        if (property_pool && property_pool.length > 0) {
          fetch("https://sumora-ai-ui.vercel.app/api/log-property-candidates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              property_customer_id: customer_id || null,
              customer_name: customer_name || null,
              site: site || "realpro",
              candidates: property_pool,
            }),
          }).catch(function() {});
        }

        const data = await callMergeApi({
          pdf_urls: urls,
          cookie_str,
          file_name: `物件まとめ_${today}.pdf`,
          send_to_line: true,
          customer_name: customer_name || null,
          property_summaries: property_summaries || null,
          customer_conditions: customer_conditions || null,
          site: site || null,
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

        // fire-and-forget: 物件候補プールを学習ループ用APIに記録
        if (msg.property_pool && msg.property_pool.length > 0) {
          fetch("https://sumora-ai-ui.vercel.app/api/log-property-candidates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              property_customer_id: msg.customer_id || null,
              customer_name: msg.customer_name || null,
              site: msg.site || "itandi",
              candidates: msg.property_pool,
            }),
          }).catch(function() {});
        }

        // Step1: 1件ずつVercel BlobにアップロードしてURLを収集
        const blobUrls = [];
        for (let i = 0; i < msg.pdf_data.length; i++) {
          const name = `${baseName}_${i + 1}.pdf`;
          const url = await uploadWithRetry(msg.pdf_data[i], name);
          blobUrls.push(url);
          // 進捗ハートビート: itandi多物件のBlobアップは数分かかるため無進捗タイムアウトを延長
          try { _notifyBatchProgress(msg.customer_id || null); } catch (_) {}  // M10修正: null→customer_id で別顧客タイマーの誤延長を防ぐ
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
          pdf_urls:            blobUrls,
          cookie_str:          "",   // 公開Blob URLはcookie不要
          file_name:           `${baseName}.pdf`,
          send_to_line:        true,
          customer_name:       msg.customer_name || null,
          property_summaries:  msg.property_summaries || null,
          customer_conditions: msg.customer_conditions || null,
          site:                msg.site || null,
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
      // スタッフモード中は即時ポーリングも行わない（別PCの30秒ポーリングに任せる）
      if (await _isStaffModeActive()) {
        sendResponse({ ok: false, reason: "staff-mode" });
        return;
      }
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
                auto_send_all: !!(msg.auto_send_all),
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
              auto_send_all: !!(msg.auto_send_all),
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

    // ─── itandi: switch-customer経由でunderbar.js→popup.js→自動入力（リアプロと同一仕組み）──
    if (site === "itandi") {
      (async () => {
        try {
          var _cid      = conditions && conditions.customerId;
          var _custName = (conditions && conditions.customerName) || null;
          var _areaMode = (conditions && conditions.area_mode) || null;
          var _isWide   = !!(conditions && conditions.is_wide);

          if (!_cid) { sendResponse({ ok: false, error: "no customerId" }); return; }

          // fill-done後にスクレイプ→LINE送信するため先に作成
          var _siteFillDone = _createFillDoneWaiter("itandi", String(_cid), 90000);

          // itandiタブを探す（なければ新規作成）
          var _allTabs = await chrome.tabs.query({});
          var _itandiTab = _allTabs.find(function(t) { return t.url && t.url.startsWith("https://itandibb.com"); });
          if (!_itandiTab) {
            _itandiTab = await chrome.tabs.create({ url: "https://itandibb.com/rent_rooms/list", active: false });
            await _batchWaitForTabComplete(_itandiTab.id);
            await new Promise(function(r) { setTimeout(r, 2000); });
          }
          console.log("[webapp-search] itandiタブ:", _itandiTab.url);
          // itandi-content.js に現在の顧客IDを通知（fill-done relay に customerId を付与するため）
          try { await chrome.tabs.sendMessage(_itandiTab.id, { type: "axlx-set-fill-customer", customerId: String(_cid) }); } catch(_) {}

          // underbar.js → popup.js 経由でリアプロと同じ仕組みで自動入力
          var _directOk = await new Promise(function(resolve) {
            chrome.tabs.sendMessage(_itandiTab.id, {
              type:         "axlx-switch-customer",
              customerId:   String(_cid),
              customerName: _custName,
              site:         "itandi",
              areaMode:     _areaMode,
              is_wide:      _isWide,
              auto_send_all: !!(msg.auto_send_all),
            }, function(resp) {
              if (chrome.runtime.lastError) {
                console.log("[webapp-search] itandi tabs.sendMessage エラー:", chrome.runtime.lastError.message);
                resolve(false); return;
              }
              console.log("[webapp-search] itandi underbar.js応答:", JSON.stringify(resp));
              resolve(!!(resp && resp.ok));
            });
          });

          if (!_directOk) {
            // フォールバック: popup.js未応答 → _batchAutofill直接呼び出し
            console.warn("[webapp-search] itandi popup未応答 → _batchAutofill fallback");
            var _fetchRes = await fetch("https://sumora-ai-ui.vercel.app/api/property-customers", { cache: "no-store" });
            var _custList = await _fetchRes.json();
            var _customer = Array.isArray(_custList)
              ? _custList.find(function(x) { return String(x.id) === String(_cid); })
              : null;
            if (_customer) {
              if (_areaMode) _customer = Object.assign({}, _customer, { area_mode: _areaMode });
              await _batchAutofill(_customer, "itandi", _isWide);
            }
          }

          sendResponse({ ok: true });

          // fill完了後: リアプロと同様に fill-done + batch-customer-done 待機（itandi-bulk-dl.js 経由）
          _scrapeAndSendRealpro(
            _siteFillDone,
            String(_cid),
            _custName,
            conditions,
            "itandi"
          ).catch(function(e) {
            console.error("[webapp-search] itandi _scrapeAndSendRealpro error:", e.message || e);
          });
        } catch (e) {
          console.error("[webapp-search] itandi error:", e);
          sendResponse({ ok: false, error: String(e.message) });
        }
      })();
      return true;
    }

    // ─── reins: _batchAutofill直接呼び出し ──────────────────────────────────
    (async () => {
      try {
        var _cid      = conditions && conditions.customerId;
        var _isWide   = !!(conditions && conditions.is_wide);
        var _areaMode = (conditions && conditions.area_mode) || null;

        if (!_cid) { sendResponse({ ok: false, error: "no customerId" }); return; }

        var _fetchRes = await fetch("https://sumora-ai-ui.vercel.app/api/property-customers", { cache: "no-store" });
        var _custList = await _fetchRes.json();
        var _customer = Array.isArray(_custList)
          ? _custList.find(function(x) { return String(x.id) === String(_cid); })
          : null;
        if (!_customer) { sendResponse({ ok: false, error: "customer not found" }); return; }

        if (_areaMode) _customer = Object.assign({}, _customer, { area_mode: _areaMode });

        console.log("[webapp-search] ▶ " + site + " _batchAutofill直接呼び出し customerId=" + _cid);
        await _batchAutofill(_customer, site, _isWide);
        console.log("[webapp-search] ✔ " + site + " _batchAutofill完了");

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

  // ── 手動一括検索: popup.jsのチェックボックスで選択した顧客を連続処理 ──────
  // popup.jsはリアプロページリロードで消えるため、ループをbackground.jsに委ねる
  if (msg.type === "axlx-manual-bulk-search") {
    var _bulkSite = msg.site;
    var _bulkIds  = Array.isArray(msg.customerIds) ? msg.customerIds : [];
    sendResponse({ ok: true, started: true });
    (async () => {
      try {
        // 前回バッチのストップ残留をクリア（即解決を防ぐ）
        _batchShouldStop = false;
        try { await chrome.storage.local.set({ batchStopRequested: false }); } catch(_) {}
        var _bulkRes = await fetch("https://sumora-ai-ui.vercel.app/api/property-customers", { cache: "no-store" });
        if (!_bulkRes.ok) throw new Error("顧客データ取得失敗");
        var _bulkAll = await _bulkRes.json();
        var _bulkTargets = _bulkIds
          .map(function(id) { return _bulkAll.find(function(c) { return String(c.id) === String(id); }); })
          .filter(Boolean);
        console.log("[manual-bulk-search] ▶ site=" + _bulkSite + " 対象=" + _bulkTargets.length + "人");
        for (var _bi = 0; _bi < _bulkTargets.length; _bi++) {
          var _bc = _bulkTargets[_bi];
          console.log("[manual-bulk-search] (" + (_bi+1) + "/" + _bulkTargets.length + ") " + _bc.customer_name);
          try {
            // fill-done ウェイターを autofill 発火「前」に生成（先着シグナルを取りこぼさないため）
            var _bulkFillDone = (_bulkSite === "realnetpro" || _bulkSite === "itandi")
              ? _createFillDoneWaiter(_bulkSite, String(_bc.id), 90000)
              : null;
            var _bulkConds = await _batchAutofill(_bc, _bulkSite, false);
            // fill-done → axlx-batch-customer-done を待ってから次顧客へ（混線防止）
            // reins は bulk-dl.js 自動送信なし → ウェイターなしでスキップ
            if (_bulkFillDone) {
              await _scrapeAndSendRealpro(
                _bulkFillDone,
                String(_bc.id),
                _bc.customer_name || null,
                _bulkConds || {},
                _bulkSite === "itandi" ? "itandi" : "リアプロ"
              );
            }
          } catch (_be) {
            if (_be && _be.message === "__BATCH_STOPPED__") {
              console.log("[manual-bulk-search] ストップ要求 → 中断");
              break;
            }
            console.error("[manual-bulk-search] 顧客エラー:", _bc.customer_name, _be.message || _be);
            // 例外スキップ時も必ず1件アナウンス（4人検索→4人分アナウンス要件）
            if (_bc.customer_name) {
              var _bulkSiteLabel = _bulkSite === "itandi" ? "itandi" : _bulkSite === "reins" ? "レインズ" : "リアプロ";
              fetch(SUMORA_BATCH_API + "/api/notify-group", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: "🔍【物件0件】" + _bc.customer_name + "さんの" + _bulkSiteLabel + "検索が0件でした" })
              }).catch(function() {});
            }
          }
          if (_bi < _bulkTargets.length - 1) {
            // 完了確認後のインターバル（6〜12秒）
            await new Promise(function(r) { setTimeout(r, 6000 + Math.floor(Math.random() * 6000)); });
          }
        }
        console.log("[manual-bulk-search] ✔ 完了");
      } catch (_be2) {
        console.error("[manual-bulk-search] エラー:", _be2.message || _be2);
      }
    })();
    return true;
  }

  // ── 見積書自動モード: 開いている物件詳細タブをスクレイプ ─────────────────
  if (msg.type === "axlx-estimate-auto") {
    var _site = msg.site || "unknown";
    (async function() {
      try {
        var allTabs = await chrome.tabs.query({});
        var realproDetailTabs = allTabs.filter(function(t) {
          return t.url && t.url.includes("realnetpro.com") &&
            (t.url.includes("room_detail") || t.url.includes("/detail"));
        });
        var itandiDetailTabs = allTabs.filter(function(t) {
          return t.url && t.url.includes("itandibb.com") && t.url.includes("rent_rooms");
        });
        var targetTabs = [];
        if (_site === "realnetpro") {
          targetTabs = realproDetailTabs.length > 0 ? realproDetailTabs :
            allTabs.filter(function(t) { return t.url && t.url.includes("realnetpro.com"); });
        } else if (_site === "itandi") {
          targetTabs = itandiDetailTabs.length > 0 ? itandiDetailTabs :
            allTabs.filter(function(t) { return t.url && t.url.includes("itandibb.com"); });
        } else {
          targetTabs = realproDetailTabs.concat(itandiDetailTabs);
          if (targetTabs.length === 0) {
            targetTabs = allTabs.filter(function(t) {
              return t.url && (t.url.includes("realnetpro.com") || t.url.includes("itandibb.com"));
            });
          }
        }
        if (targetTabs.length === 0) {
          sendResponse({ ok: false, error: "リアプロ/itandiの物件詳細ページが見つかりません。物件詳細ページを開いてからお試しください。" });
          return;
        }
        var targetTab = targetTabs.sort(function(a, b) {
          return ((b.lastAccessed || 0) - (a.lastAccessed || 0));
        })[0];
        var isRealpro = !!(targetTab.url && targetTab.url.includes("realnetpro.com"));
        var estimateTabId = targetTab.id;
        if (!estimateTabId) { sendResponse({ ok: false, error: "タブIDが取得できません" }); return; }
        var scrapeResults = await chrome.scripting.executeScript({
          target: { tabId: estimateTabId },
          world: "MAIN",
          func: function() {
            var lines = [];
            var titleEl = document.querySelector("h1, h2, .property-name, .room-name, .building-name");
            if (titleEl) lines.push("物件名: " + titleEl.innerText.trim());
            document.querySelectorAll("table").forEach(function(table) {
              table.querySelectorAll("tr").forEach(function(row) {
                var ths = Array.from(row.querySelectorAll("th"));
                var tds = Array.from(row.querySelectorAll("td"));
                if (ths.length > 0 && tds.length > 0) {
                  ths.forEach(function(th, i) {
                    var val = tds[i] ? tds[i].innerText.trim() : "";
                    var label = th.innerText.trim();
                    if (label && val && val.length < 300) lines.push(label + ": " + val);
                  });
                } else if (tds.length >= 2 && ths.length === 0) {
                  for (var i = 0; i < tds.length - 1; i += 2) {
                    var l = tds[i].innerText.trim();
                    var v = tds[i + 1].innerText.trim();
                    if (l && v && v.length < 300) lines.push(l + ": " + v);
                  }
                }
              });
            });
            document.querySelectorAll("dl").forEach(function(dl) {
              var dts = Array.from(dl.querySelectorAll("dt"));
              var dds = Array.from(dl.querySelectorAll("dd"));
              dts.forEach(function(dt, i) {
                if (dds[i]) {
                  var l = dt.innerText.trim();
                  var v = dds[i].innerText.trim();
                  if (l && v && v.length < 300) lines.push(l + ": " + v);
                }
              });
            });
            return lines.filter(function(x) { return x.trim().length > 0; }).join("\n");
          }
        });
        var pageText = (scrapeResults && scrapeResults[0] && scrapeResults[0].result) || "";
        var page2Text = "";
        if (isRealpro) {
          try {
            var currentUrl = targetTab.url || "";
            var page2Url = currentUrl.includes("page=") ?
              currentUrl.replace(/page=\d+/, "page=2") :
              currentUrl + (currentUrl.includes("?") ? "&" : "?") + "page=2";
            var page2Results = await chrome.scripting.executeScript({
              target: { tabId: estimateTabId },
              world: "MAIN",
              func: function(url) {
                return fetch(url, { credentials: "include" })
                  .then(function(r) { return r.text(); })
                  .then(function(html) {
                    var parser = new DOMParser();
                    var doc = parser.parseFromString(html, "text/html");
                    var lines = [];
                    doc.querySelectorAll("table tr").forEach(function(row) {
                      var ths = Array.from(row.querySelectorAll("th"));
                      var tds = Array.from(row.querySelectorAll("td"));
                      if (ths.length > 0 && tds.length > 0) {
                        ths.forEach(function(th, i) {
                          var val = tds[i] ? tds[i].innerText.trim() : "";
                          var label = th.innerText.trim();
                          if (label && val && val.length < 300) lines.push(label + ": " + val);
                        });
                      }
                    });
                    return lines.join("\n");
                  })
                  .catch(function() { return ""; });
              },
              args: [page2Url]
            });
            page2Text = (page2Results && page2Results[0] && page2Results[0].result) || "";
          } catch (_) { /* page2取得失敗は無視 */ }
        }
        var siteName = isRealpro ? "リアプロ" : "itandi";
        var fullText = "【" + siteName + " 物件詳細】\n" + pageText;
        if (page2Text) fullText += "\n\n【" + siteName + " 次ページ詳細】\n" + page2Text;
        if (!pageText) {
          sendResponse({ ok: false, error: "ページから情報を取得できませんでした。詳細ページを開いているか確認してください。" });
          return;
        }
        sendResponse({ ok: true, text: fullText });
      } catch (e) {
        console.error("[axlx-estimate-auto] error:", e);
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // axlx-estimate-realpro-search
  // リアプロ main.php でフリーワード検索 → 号室マッチ行のhref取得 → 詳細タブ開いて
  // 「客付業者様へ」セクションを抽出 → 補足情報フィールドに注入
  // ──────────────────────────────────────────────────────────────────────────────
  if (msg.type === "axlx-estimate-realpro-search") {
    var _epPropName = (msg.propertyName || "").trim();
    var _epRoomNum  = (msg.roomNumber   || "").trim();

    if (!_epPropName) {
      sendResponse({ ok: false, error: "物件名が指定されていません" });
      return true;
    }

    (async function() {
      try {
        var MAIN_PHP_URL = "https://www.realnetpro.com/main.php";

        // ── Step 1: リアプロ main.php タブを探す or 作成 ───────────────────────
        var _epAllTabs = await chrome.tabs.query({});

        // main.php 上のタブを優先（page-script.js が注入されているため）
        var _epMainTab = _epAllTabs
          .filter(function(t) { return t.url && t.url.startsWith(MAIN_PHP_URL); })
          .sort(function(a, b) { return (b.lastAccessed || 0) - (a.lastAccessed || 0); })[0];

        if (!_epMainTab) {
          // main.php 以外の realnetpro タブがあればそこへナビゲート
          var _epAnyReal = _epAllTabs.find(function(t) {
            return t.url && t.url.includes("realnetpro.com") && !t.url.includes("room_detail");
          });
          if (_epAnyReal) {
            await chrome.tabs.update(_epAnyReal.id, { url: MAIN_PHP_URL, active: false });
            _epMainTab = { id: _epAnyReal.id };
          } else {
            _epMainTab = await chrome.tabs.create({ url: MAIN_PHP_URL, active: false });
          }
          await _batchWaitForTabComplete(_epMainTab.id);
          // page-script.js が document_start → document_idle で注入されるまで待機
          await new Promise(function(r) { setTimeout(r, 2500); });
        }

        var _epListTabId = _epMainTab.id;

        // ── Step 2: page-script.js へ window.postMessage でフリーワード検索を指示 ──
        await chrome.scripting.executeScript({
          target: { tabId: _epListTabId },
          world: "MAIN",
          func: function(propName, roomNum) {
            window.__axlxEstimateSearchResult = undefined;
            window.postMessage({
              from: "axlx-realpro-freeword-search",
              propertyName: propName,
              roomNumber: roomNum,
            }, "*");
          },
          args: [_epPropName, _epRoomNum],
        });

        // ── Step 3: page-script.js が検索ボタンをクリックしたか確認（triggered フラグ, 最大6秒）
        var _epTriggered = false;
        for (var _ep1 = 0; _ep1 < 12; _ep1++) {
          await new Promise(function(r) { setTimeout(r, 500); });
          try {
            var _epTrigPoll = await chrome.scripting.executeScript({
              target: { tabId: _epListTabId },
              world: "MAIN",
              func: function() { return window.__axlxEstimateSearchResult; },
            });
            var _epTrigRes = _epTrigPoll && _epTrigPoll[0] && _epTrigPoll[0].result;
            if (_epTrigRes && _epTrigRes.triggered) { _epTriggered = true; break; }
            if (_epTrigRes && _epTrigRes.ok === false) {
              // page-script.js がエラーを設定した（フリーワード欄や検索ボタンが見つからない等）
              sendResponse({ ok: false, error: _epTrigRes.error || "フリーワード検索の起動に失敗しました" });
              return;
            }
          } catch (_) { /* ページ遷移中に executeScript が一時的に失敗することがある */ }
        }
        if (!_epTriggered) {
          sendResponse({ ok: false, error: "フリーワード検索が開始されませんでした（page-script.jsが応答しません。リアプロ main.php が開かれているか確認してください）" });
          return;
        }

        // ── Step 4: room_detail タブ監視 + 号室行の「詳細」ボタンクリック ─────────
        // DevTools確認済み（2026-08-11）:
        // 詳細ボタンは <a class="hide_text hide_detail" href="#" target="_blank">詳細</a>
        // → target="_blank" でブラウザが room_detail.php?id=...&gr=... を新タブで開く
        // → window.open は呼ばれないため URL は取得不可。chrome.tabs.onUpdated で捕捉する。
        var _epDetailTabId = null;
        var _epTabFound = false;
        var _epRoomNumEsc = _epRoomNum.replace(/号室?$/, "").trim()
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        var _epTabUpdatedL = function(tabId, changeInfo, tab) {
          if (_epTabFound) return;
          var url = (tab && tab.url) || (changeInfo && changeInfo.url) || "";
          if (url.includes("room_detail.php") && changeInfo.status === "complete") {
            _epTabFound = true;
            _epDetailTabId = tabId;
          }
        };
        chrome.tabs.onUpdated.addListener(_epTabUpdatedL);

        // ── Step 5: 号室に一致する行の「詳細」ボタンをクリック（最大25秒ポーリング）
        var _epClicked = false;
        for (var _ep2 = 0; _ep2 < 50 && !_epClicked; _ep2++) {
          await new Promise(function(r) { setTimeout(r, 500); });
          try {
            var _epClickRes = await chrome.scripting.executeScript({
              target: { tabId: _epListTabId },
              world: "MAIN",
              func: function(roomReStr) {
                var roomRe = new RegExp(roomReStr);
                var ROW_SELS = [
                  "table.result-list tbody tr",
                  "table.list tbody tr",
                  ".room-list tr",
                  "tbody tr",
                ];
                for (var sel of ROW_SELS) {
                  var rows = Array.from(document.querySelectorAll(sel));
                  for (var row of rows) {
                    if (!roomRe.test(row.innerText || row.textContent || "")) continue;
                    // class="hide_text hide_detail" target="_blank" のリンクをクリック
                    var detailLink = Array.from(row.querySelectorAll("a")).find(function(a) {
                      return (a.innerText || "").trim() === "詳細";
                    });
                    if (detailLink) {
                      detailLink.click();
                      return true;
                    }
                  }
                }
                return false;
              },
              args: ["(?<![0-9])" + _epRoomNumEsc + "(?![0-9])"],
            });
            _epClicked = !!(_epClickRes && _epClickRes[0] && _epClickRes[0].result);
          } catch (_) { /* ページ遷移中の一時エラーは無視 */ }
        }

        if (!_epClicked) {
          chrome.tabs.onUpdated.removeListener(_epTabUpdatedL);
          sendResponse({ ok: false, error: "号室「" + _epRoomNum + "」が検索結果に見つかりませんでした（物件名: " + _epPropName + "）" });
          return;
        }

        // room_detail タブが開いてロード完了するまで待つ（最大20秒）
        for (var _ep3 = 0; _ep3 < 40 && !_epDetailTabId; _ep3++) {
          await new Promise(function(r) { setTimeout(r, 500); });
        }
        chrome.tabs.onUpdated.removeListener(_epTabUpdatedL);

        if (!_epDetailTabId) {
          sendResponse({ ok: false, error: "詳細ページ（room_detail.php）が開きませんでした。リアプロにログインしているか確認してください。" });
          return;
        }
        await new Promise(function(r) { setTimeout(r, 500); });

        // ── Step 6: 「客付業者様へ」セクションの innerText を抽出 ────────────────
        // リアプロ詳細ページは page=1 と page=2 に分割されている場合がある。
        // まず現在のページ（page=1 相当）でセクションを探し、
        // 見つからなければ page=2 を fetch して探す。
        var _epExtract = await chrome.scripting.executeScript({
          target: { tabId: _epDetailTabId },
          world: "MAIN",
          func: function() {
            function extractBrokerSection(doc) {
              // 戦略1: 「客付業者」を含む見出し要素 → その親コンテナ
              var headings = Array.from(doc.querySelectorAll("h1,h2,h3,h4,th,dt,strong,b,td"));
              for (var h of headings) {
                var ht = (h.innerText || h.textContent || "").trim();
                if (!ht.includes("客付")) continue;
                var container = h.closest("section,article,table,dl,.block,.section,.card") || h.parentElement;
                if (!container) continue;
                var text = (container.innerText || "")
                  .replace(/[ \t]+/g, " ")
                  .replace(/\n{3,}/g, "\n\n")
                  .trim();
                if (text && text.length > 5) return text;
              }
              // 戦略2: 「客付業者」を含むテキストノードを持つ末端要素を収集
              var blocks = Array.from(doc.querySelectorAll("p,li,dd,span,div")).filter(function(el) {
                return el.children.length === 0 && (el.innerText || "").includes("客付");
              });
              if (blocks.length > 0) {
                return blocks.map(function(b) { return b.innerText.trim(); }).join("\n");
              }
              return null;
            }

            var text = extractBrokerSection(document);
            if (text) return { text: "【客付業者様へ】\n" + text, page2Url: null };

            // page=2 が必要な場合: URLを構築して返す（fetchはMAIN worldで実施）
            var currentUrl = location.href;
            var page2Url = currentUrl.includes("page=")
              ? currentUrl.replace(/page=\d+/, "page=2")
              : currentUrl + (currentUrl.includes("?") ? "&" : "?") + "page=2";
            return { text: null, page2Url: page2Url };
          },
        });

        var _epExtractRes = _epExtract && _epExtract[0] && _epExtract[0].result;
        var _epBrokerText = _epExtractRes && _epExtractRes.text;

        // page=1 で見つからなければ page=2 を fetch
        if (!_epBrokerText && _epExtractRes && _epExtractRes.page2Url) {
          var _epPage2 = await chrome.scripting.executeScript({
            target: { tabId: _epDetailTabId },
            world: "MAIN",
            func: function(url) {
              return fetch(url, { credentials: "include" }).then(function(r) { return r.text(); }).then(function(html) {
                var doc = new DOMParser().parseFromString(html, "text/html");
                var headings = Array.from(doc.querySelectorAll("h1,h2,h3,h4,th,dt,strong,b,td"));
                for (var h of headings) {
                  var ht = (h.innerText || h.textContent || "").trim();
                  if (!ht.includes("客付")) continue;
                  var container = h.closest("section,article,table,dl,.block,.section") || h.parentElement;
                  if (!container) continue;
                  var text = (container.innerText || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
                  if (text && text.length > 5) return text;
                }
                return null;
              }).catch(function() { return null; });
            },
            args: [_epExtractRes.page2Url],
          });
          var _epPage2Text = _epPage2 && _epPage2[0] && _epPage2[0].result;
          if (_epPage2Text) {
            _epBrokerText = "【客付業者様へ（詳細2ページ目）】\n" + _epPage2Text;
          }
        }

        // ── Step 7: 詳細タブを閉じる ─────────────────────────────────────────────
        // _epListTabId と同じタブになっていた場合（target="_blank"が効かなかった等）は閉じない
        if (_epDetailTabId !== _epListTabId) {
          await chrome.tabs.remove(_epDetailTabId).catch(function() {});
        }

        if (!_epBrokerText) {
          sendResponse({ ok: false, error: "詳細ページ（room_detail.php）に「客付業者様へ」セクションが見つかりませんでした。" });
          return;
        }

        // fromPopup の場合: supplementaryText を storage に保存し、見積書ページを開く
        if (msg.fromPopup) {
          await chrome.storage.local.set({ axlx_pending_supplementary: _epBrokerText });
          await chrome.tabs.create({ url: "https://sumora-ai-ui.vercel.app/estimate?pendingSupp=1", active: true });
        }

        sendResponse({ ok: true, text: _epBrokerText });
      } catch (err) {
        sendResponse({ ok: false, error: "エラー: " + String(err) });
      }
    })();
    return true; // async sendResponse
  }

  // ── ポップアップ経由で保存された supplementaryText を返す ────────────────
  if (msg.type === "axlx-get-pending-supplementary") {
    chrome.storage.local.get("axlx_pending_supplementary", function(result) {
      var text = result.axlx_pending_supplementary || null;
      if (text) chrome.storage.local.remove("axlx_pending_supplementary");
      sendResponse({ ok: !!text, text: text });
    });
    return true; // async sendResponse
  }

  // ── WebApp から直接スクレイプ+比較トリガー ──────────────────────────────
  // WebApp の UI から「物件を比較」ボタンを押すと送られるメッセージ。
  // 既存の _webappAutofill でリアプロを検索条件付きで開いた後、
  // 全ページをスクレイプして /api/compare-properties に POST する。
  if (msg.type === "axlx-scrape-and-compare") {
    const { customerId, conditions } = msg;
    (async () => {
      try {
        var scrapedCount = await _runScrapeAndCompare(customerId, conditions);
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

// ── Supabase Realtime WebSocket（スマホ→拡張 リアルタイムコマンド配信）─────────────────
// スマホからボタンを押したとき、30秒ポーリングを待たずに即座に拡張に届けるための双方向チャンネル
var _SB_WS_URL       = "wss://wfwsmwxakhyxobytszoq.supabase.co/realtime/v1/websocket?apikey=sb_publishable_0MBDxmVGZHFnjWX79QzKlw_x6sT1w4N&vsn=1.0.0";
var _SB_CMD_CHANNEL  = "realtime:ext-commands";  // スマホ → 拡張（コマンド受信）
var _SB_RES_CHANNEL  = "realtime:ext-results";   // 拡張 → スマホ（結果配信）
var _sbWs            = null;
var _sbWsRef         = 0;
var _sbHbTimer       = null;
var _sbCmdJoined     = false;
var _sbResJoined     = false;

function _sbSend(obj) {
  if (_sbWs && _sbWs.readyState === WebSocket.OPEN) {
    try { _sbWs.send(JSON.stringify(obj)); } catch(_) { /* ignore */ }
  }
}

function _sbConnect() {
  if (_sbWs && (_sbWs.readyState === WebSocket.OPEN || _sbWs.readyState === WebSocket.CONNECTING)) return;
  _sbCmdJoined = false; _sbResJoined = false;
  try {
    _sbWs = new WebSocket(_SB_WS_URL);
    _sbWs.onopen = function() {
      console.log("[SB-RT] Supabase Realtime 接続");
      // ext-commands（受信）と ext-results（送信）の両チャンネルに参加
      _sbSend({ topic: _SB_CMD_CHANNEL, event: "phx_join", payload: { config: { broadcast: { ack: false, self: false } } }, ref: String(++_sbWsRef), join_ref: "cmd" });
      _sbSend({ topic: _SB_RES_CHANNEL, event: "phx_join", payload: { config: { broadcast: { ack: false, self: false } } }, ref: String(++_sbWsRef), join_ref: "res" });
      // ハートビート 25秒ごと（Supabase の 30秒タイムアウト前に送る + SW を起こし続ける）
      if (_sbHbTimer) clearInterval(_sbHbTimer);
      _sbHbTimer = setInterval(function() {
        _sbSend({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(++_sbWsRef) });
      }, 25000);
    };
    _sbWs.onmessage = function(ev) {
      try {
        var msg = JSON.parse(ev.data);
        // チャンネル参加確認
        if (msg.event === "phx_reply" && msg.payload && msg.payload.status === "ok") {
          if (msg.topic === _SB_CMD_CHANNEL) { _sbCmdJoined = true; console.log("[SB-RT] ext-commands 参加完了"); }
          if (msg.topic === _SB_RES_CHANNEL) { _sbResJoined = true; console.log("[SB-RT] ext-results 参加完了"); }
        }
        // スマホからのコマンドを受信 → 即時実行
        if (msg.topic === _SB_CMD_CHANNEL && msg.event === "broadcast" && msg.payload && msg.payload.event === "scrape_command") {
          _sbHandleCommand(msg.payload.payload || {});
        }
        // スマホのストップボタンからのストップ信号 → バッチループを中断するフラグをセット
        if (msg.topic === _SB_CMD_CHANNEL && msg.event === "broadcast" && msg.payload && msg.payload.event === "stop_command") {
          console.log("[SB-RT] stop_command 受信 → _batchShouldStop = true");
          _batchShouldStop = true; // Fix 2: 同期フラグを即時セット
          chrome.storage.local.set({ batchStopRequested: true });
        }
      } catch(_) { /* ignore */ }
    };
    _sbWs.onclose = function() {
      console.log("[SB-RT] 切断 → 8秒後に再接続");
      _sbCmdJoined = false; _sbResJoined = false;
      if (_sbHbTimer) { clearInterval(_sbHbTimer); _sbHbTimer = null; }
      _sbWs = null;
      setTimeout(_sbConnect, 8000);
    };
    _sbWs.onerror = function() {};
  } catch(e) {
    console.warn("[SB-RT] 接続失敗:", e.message);
    setTimeout(_sbConnect, 15000);
  }
}

// ── popup.js 経由の完全フロー共通実装（PC ボタン・スマホ WebSocket 両方から呼ぶ）──────
// underbar.js → popup.js → page-script.js というルートを通る。
// バッチパス（_webappAutofill → page-script.js 直接）とは異なり、
// Dijkstra 路線展開・エリアAPI自動判定・駅/区モード切替が popup.js 内で正しく動く。
async function _runScrapeAndCompare(customerId, conditions) {
  var _scIsWide   = !!(conditions.isWide || conditions.is_wide);
  var _scAreaMode = (conditions && conditions.area_mode) || null;
  var _scCustName = (conditions && conditions.customerName) || null;

  var fillDonePromise = _createFillDoneWaiter("realnetpro", customerId, 90000);

  var _scAllTabs = await chrome.tabs.query({});
  var _scRealTab = _scAllTabs.find(function(t) { return t.url && t.url.startsWith("https://www.realnetpro.com"); });

  var _directOk = false;
  if (_scRealTab && customerId) {
    try {
      await chrome.tabs.update(_scRealTab.id, { active: true });
      // content.js に現在の顧客IDを通知（fill-done relay に customerId を付与するため）
      try { await chrome.tabs.sendMessage(_scRealTab.id, { type: "axlx-set-fill-customer", customerId: String(customerId) }); } catch(_) {}
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

  return await _scrapeAndSendRealpro(fillDonePromise, customerId, _scCustName, conditions);
}

async function _sbHandleCommand(payload) {
  var customerId   = String(payload.customerId   || payload.customer_id   || "");
  var customerName = String(payload.customerName || payload.customer_name || "");
  var conditions   = payload.conditions || {};
  var commandId    = payload.commandId  || null;
  if (!customerId) return;

  // スタッフモード中は Realtime コマンドを無視（claimしないので別PC or DBポーリングが処理する）
  if (await _isStaffModeActive()) {
    console.log("[SB-RT] スタッフモード中 → scrape_command を無視 (customerId=" + customerId + ")");
    return;
  }

  // batchRunning ロックチェック（二重実行防止）
  var stLock = await chrome.storage.local.get("batchRunning");
  var lock = stLock.batchRunning;
  if (lock) {
    var startedAt = (typeof lock === "object" && lock) ? lock.startedAt : 0;
    if (startedAt && Date.now() - startedAt < BATCH_LOCK_TTL_MS) {
      console.log("[SB-RT] batchRunning 中 → スキップ (customerId=" + customerId + ")");
      return;
    }
  }

  console.log("[SB-RT] scrape_command 受信 → popup.js完全フローで実行 customerId=" + customerId);
  // 前回ストップで残留したフラグをクリア（_runBatchSearch 経路と同様）
  _batchShouldStop = false;
  await chrome.storage.local.set({ batchStopRequested: false });
  await chrome.storage.local.set({ batchRunning: { running: true, startedAt: Date.now() }, batchCommandId: commandId });
  if (commandId) _updateBatchCommand(commandId, { status: "running" }).catch(function() {});

  try {
    // customerName を conditions に含める（_runScrapeAndCompare は conditions.customerName を参照）
    var mergedConditions = Object.assign({}, conditions, { customerName: customerName });
    await _runScrapeAndCompare(customerId, mergedConditions);
    if (commandId) _updateBatchCommand(commandId, { status: "done", completed_at: new Date().toISOString() }).catch(function() {});
    _sbBroadcastResult({ customerId: customerId, ok: true });
  } catch(e) {
    if (commandId) _updateBatchCommand(commandId, { status: "error", error_message: String(e) }).catch(function() {});
    _sbBroadcastResult({ customerId: customerId, ok: false, error: String(e).slice(0, 300) });
  } finally {
    await chrome.storage.local.set({ batchRunning: null, batchCommandId: null });
  }
}

function _sbBroadcastResult(result) {
  _sbSend({
    topic: _SB_RES_CHANNEL,
    event: "broadcast",
    payload: { type: "broadcast", event: "scrape_result", payload: result },
    ref: String(++_sbWsRef),
  });
  console.log("[SB-RT] 結果配信:", JSON.stringify(result));
}

// 起動時に Supabase Realtime へ接続
_sbConnect();

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

// Fix 2: モジュールレベルの同期ストップフラグ。
// chrome.storage.local.get の非同期ラグなしに即座に参照できる。
// stop_command (Realtime WebSocket) と axlx-force-stop-batch (window.postMessage 経由)
// の両方で true にセットする。バッチ開始時に false へリセットする。
var _batchShouldStop = false;

// resolve 値は { timedOut: boolean, error: string|null } に統一。
// error は page-script.js が fill-done に載せたエラー内容（フォールバック検索は実行済み）。
function _notifyFillDone(site, customerId, error) {
  if (!customerId) {
    // null のときは最古の1件のみ解決（本来は content script 側で必ず送るべき）
    var first = _fillDoneWaiters.find(function(w) { return !w.site || !site || w.site === site; });
    if (first) {
      clearTimeout(first.timer);
      first.resolve({ timedOut: false, error: error || null });
      _fillDoneWaiters = _fillDoneWaiters.filter(function(w) { return w !== first; });
    }
    return;
  }
  var remaining = [];
  _fillDoneWaiters.forEach(function (w) {
    var siteMatch = !w.site || !site || w.site === site;
    // customerId が両方ある場合のみ厳密一致。片方でも null なら旧来どおり site のみで解決
    var cidMatch = (w.customerId && customerId)
      ? String(w.customerId) === String(customerId)
      : true;
    if (siteMatch && cidMatch) {
      clearTimeout(w.timer);
      w.resolve({ timedOut: false, error: error || null });
    } else {
      remaining.push(w);
    }
  });
  _fillDoneWaiters = remaining;
}

function _createFillDoneWaiter(site, customerId, timeoutMs) {
  return new Promise(function (resolve) {
    var entry = { site: site || null, customerId: customerId || null, resolve: resolve, timer: null };
    // Fix 3: _batchShouldStop を 500ms ごとにポーリングし、true になったら即解決する。
    // これにより 90秒ブロッキングが最大 500ms 遅延に短縮される。
    var stopInterval = setInterval(function () {
      if (!_batchShouldStop) return;
      clearInterval(stopInterval);
      clearTimeout(entry.timer);
      var idx = _fillDoneWaiters.indexOf(entry);
      if (idx >= 0) _fillDoneWaiters.splice(idx, 1);
      console.log("[fill-done-waiter] _batchShouldStop 検知 → stopped:true で解決");
      resolve({ timedOut: false, stopped: true, error: null });
    }, 500);
    entry.timer = setTimeout(function () {
      clearInterval(stopInterval);
      var idx = _fillDoneWaiters.indexOf(entry);
      if (idx >= 0) _fillDoneWaiters.splice(idx, 1);
      resolve({ timedOut: true, error: null });
    }, timeoutMs || 90000);
    _fillDoneWaiters.push(entry);
  });
}

// ── 全ページ送信完了（axlx-batch-customer-done）待機インフラ ─────────────────────────
// bulk-dl.js が tryNext→全ページ完了時に chrome.runtime.sendMessage で通知する。
// _scrapeAndSendRealpro はこの Promise が解決するまで次顧客への移行を待つ。
var _batchCustomerDoneWaiters = [];

function _notifyBatchCustomerDone(customerId, propertyCount) {
  var target = null;
  // 厳密一致優先
  if (customerId) {
    for (var _bdi = 0; _bdi < _batchCustomerDoneWaiters.length; _bdi++) {
      var _bdw = _batchCustomerDoneWaiters[_bdi];
      if (_bdw.customerId && String(_bdw.customerId) === String(customerId)) { target = _bdw; break; }
    }
  } else {
    for (var _bdi2 = 0; _bdi2 < _batchCustomerDoneWaiters.length; _bdi2++) {
      var _bdw2 = _batchCustomerDoneWaiters[_bdi2];
      if (!_bdw2.customerId) { target = _bdw2; break; }
    }
  }
  if (!target) {
    console.warn('[AX] _notifyBatchCustomerDone: no waiter matched for', customerId);
    return;  // resolve しない・タイムアウト自然消化
  }
  clearInterval(target.stopInterval);
  clearTimeout(target.timer);
  var _bdIdx = _batchCustomerDoneWaiters.indexOf(target);
  if (_bdIdx >= 0) _batchCustomerDoneWaiters.splice(_bdIdx, 1);
  target.resolve({ ok: true, propertyCount: propertyCount != null ? propertyCount : null });
}

function _createBatchCustomerDoneWaiter(customerId, timeoutMs) {
  return new Promise(function(resolve) {
    var entry = { customerId: customerId || null, resolve: resolve, timer: null, stopInterval: null, timeoutMs: timeoutMs || 300000 };
    var _expire = function() {
      clearInterval(entry.stopInterval);
      var idx = _batchCustomerDoneWaiters.indexOf(entry);
      if (idx >= 0) _batchCustomerDoneWaiters.splice(idx, 1);
      console.warn("[batch-done-waiter] " + entry.timeoutMs / 1000 + "秒（無進捗）タイムアウト customer=" + entry.customerId);
      resolve({ timedOut: true });
    };
    // 「固定5分」→「無進捗5分」に変更:
    // 多ページの全ページ送信は5分を超えることがあり、固定タイムアウトのままだと
    // 送信中に次顧客の autofill が始まり検索リロードで送信が破壊されていた
    // （1顧客だけなら誰もページを触らないため完走する＝複数顧客のみ失敗する根本原因）。
    // bulk-dl.js / itandi-bulk-dl.js が送る axlx-batch-progress を受けるたびに延長する。
    entry.resetTimer = function() {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(_expire, entry.timeoutMs);
    };
    entry.stopInterval = setInterval(function() {
      if (!_batchShouldStop) return;
      clearInterval(entry.stopInterval);
      clearTimeout(entry.timer);
      var idx = _batchCustomerDoneWaiters.indexOf(entry);
      if (idx >= 0) _batchCustomerDoneWaiters.splice(idx, 1);
      console.log("[batch-done-waiter] _batchShouldStop 検知 → stopped:true で解決");
      resolve({ stopped: true });
    }, 500);
    entry.resetTimer();
    _batchCustomerDoneWaiters.push(entry);
  });
}

// ── 全ページ送信の進捗ハートビート受信 → 該当waiterのタイムアウトを延長 ──
function _notifyBatchProgress(customerId) {
  var target = null;
  if (customerId) {
    for (var _bpi = 0; _bpi < _batchCustomerDoneWaiters.length; _bpi++) {
      var _bpw = _batchCustomerDoneWaiters[_bpi];
      if (_bpw.customerId && String(_bpw.customerId) === String(customerId)) { target = _bpw; break; }
    }
  }
  // customerId null / 不一致でも最古のwaiterにフォールバック（顧客は直列処理のため安全）
  if (!target && _batchCustomerDoneWaiters.length) target = _batchCustomerDoneWaiters[0];
  if (target && target.resetTimer) target.resetTimer();
}

// content script からの fill-done 中継を受信
// Fix 5: underbar.js が中継する Web アプリのストップボタン信号を受信する
chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (msg && msg.type === "axlx-force-stop-batch") {
    console.log("[batch] axlx-force-stop-batch 受信 → _batchShouldStop = true");
    _batchShouldStop = true; // Fix 2: 同期フラグを即時セット
    chrome.storage.local.set({ batchStopRequested: true });
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (msg && msg.type === "axlx-fill-done") {
    if (msg.error) {
      console.warn("[fill-done] 受信 site=" + (msg.site || "unknown") + " error=" + msg.error);
    } else {
      console.log("[fill-done] 受信 site=" + (msg.site || "unknown"));
    }
    _notifyFillDone(msg.site || null, msg.customerId || null, msg.error || null);
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (msg && msg.type === "axlx-batch-customer-done") {
    // _scrapeAndSendRealpro の待機を解除して次顧客へ進む（propertyCount: 0 なら0件確定）
    _notifyBatchCustomerDone(msg.customerId || null, msg.propertyCount != null ? msg.propertyCount : null);
    // Webアプリへの進捗通知は _runBatchSearch の顧客ループ完了後に一元化（リアプロ/itandi/レインズ全サイト対応）
  }
  if (msg && msg.type === "axlx-batch-progress") {
    // 全ページ送信の進捗ハートビート → 無進捗タイムアウトをリセット（次顧客への早すぎる移行を防ぐ）
    _notifyBatchProgress(msg.customerId || null);
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

// ── スタッフモード ─────────────────────────────────────────────────────────
// スタッフが手動で拡張を使う間、自動化コマンドを無視するモード（PCごと・chrome.storage.local）。
// _pollAndRunBatch の fetch 前（= claim 前）でチェックするため、コマンドは pending のまま残り、
// 30秒以内に別PC（自動化PC）が自動的に拾う。自動化全体は止まらない。
// 消し忘れ防止のため2時間で自動OFF（TTL方式・batchRunning と同型）。
var STAFF_MODE_TTL_MS = 2 * 60 * 60 * 1000; // 2時間で自動解除

async function _isStaffModeActive() {
  try {
    var st = await chrome.storage.local.get(["staffMode", "staffModeAt"]);
    if (!st.staffMode) return false;
    var at = st.staffModeAt || 0;
    if (at && Date.now() - at > STAFF_MODE_TTL_MS) {
      // TTL失効 → 自動OFF（storage.onChanged 経由でバッジ・popup UIも同期される）
      await chrome.storage.local.set({ staffMode: false, staffModeAt: null });
      return false;
    }
    return true;
  } catch (e) {
    return false; // 読み取り失敗時は通常モード扱い（自動化を止めない）
  }
}

function _updateStaffModeBadge(on) {
  try {
    if (on) {
      chrome.action.setBadgeText({ text: "手動" });
      chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  } catch (e) { /* ignore */ }
}

// popup のトグル操作・TTL自動解除をバッジに即時反映
chrome.storage.onChanged.addListener(function(changes, area) {
  if (area === "local" && changes.staffMode) {
    _updateStaffModeBadge(!!changes.staffMode.newValue);
  }
});

// SW起動時にバッジを復元（TTL失効チェック込み）
_isStaffModeActive().then(_updateStaffModeBadge);

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
    // スタッフモード中は pending をclaimしない（fetch前に離脱）。
    // コマンドは pending のまま残り、次の30秒ポーリングで別PCが拾うため自動化は継続する。
    if (await _isStaffModeActive()) {
      return;
    }
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
    // Fix 6: stop_all は batchRunning ロック中でも即時にフラグをセットする。
    // 既存の _runBatchSearch 冒頭でも処理されるが、ここで先行してフラグを立てることで
    // 実行中バッチへのシグナル到達を早める。
    if (cmd.command_type === "stop_all") {
      console.log("[batch] Fix6: stop_all を pending から検出 → _batchShouldStop = true");
      _batchShouldStop = true;
      await chrome.storage.local.set({ batchStopRequested: true });
      // ロック中の場合はコマンドを完了扱いにして終了（_runBatchSearch を呼ばない）
      var lockSt = await chrome.storage.local.get("batchRunning");
      if (lockSt.batchRunning) {
        await _updateBatchCommand(cmd.id, { status: "done", completed_at: new Date().toISOString() });
        return;
      }
    }
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
  // ── stop_all: スマホのストップボタンから DB 経由で届いたストップコマンド ──
  if (command.command_type === "stop_all") {
    console.log("[batch] stop_all コマンド受信 → バッチを中断");
    _batchShouldStop = true; // Fix 2: 同期フラグも立てる
    await chrome.storage.local.set({ batchStopRequested: true });
    await _updateBatchCommand(command.id, { status: "done", completed_at: new Date().toISOString() });
    return;
  }

  // バッチ開始時にストップフラグをクリア（前回の残留を防ぐ）
  _batchShouldStop = false; // Fix 2: 同期フラグもリセット
  await chrome.storage.local.set({ batchStopRequested: false });

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
    // ストップフラグをチェック（同期フラグを優先、フォールバックで storage も確認）
    if (_batchShouldStop) {
      console.log("[batch] ストップ要求を検知（同期）→ バッチ中断 (処理済み:", i, "/ 全体:", targets.length, ")");
      await _updateBatchCommand(command.id, { status: "cancelled", completed_at: new Date().toISOString() });
      return;
    }
    var _stopSt = await chrome.storage.local.get("batchStopRequested");
    if (_stopSt.batchStopRequested) {
      console.log("[batch] ストップ要求を検知（storage）→ バッチ中断 (処理済み:", i, "/ 全体:", targets.length, ")");
      await _updateBatchCommand(command.id, { status: "cancelled", completed_at: new Date().toISOString() });
      return;
    }
    var customer = targets[i];
    for (var j = 0; j < sites.length; j++) {
      // Fix 4: サイト間でも同期フラグを確認し、ストップ要求があれば即中断する
      if (_batchShouldStop) {
        console.log("[batch] Fix4: _batchShouldStop 検知 (j=" + j + ") → バッチ中断");
        await _updateBatchCommand(command.id, { status: "cancelled", completed_at: new Date().toISOString() });
        return;
      }
      var batchSite = sites[j];
      // area_mode='both': 地域（ward）と駅（station）を別々に2回検索・送信
      var areaModePasses = (customer.area_mode === 'both') ? ['ward', 'station'] : [null];
      // B3修正: both顧客は各パスの0件通知を抑制し、ループ後に合計0件なら1回だけ通知する
      var _isMultiPass = areaModePasses.length > 1;
      var _totalPassCount = 0;
      for (var k = 0; k < areaModePasses.length; k++) {
        if (k > 0) {
          // 地域→駅の切り替えインターバル（5〜10秒）
          var _betweenModeDelay = 5000 + Math.floor(Math.random() * 5000);
          console.log("[batch] both顧客: 地域→駅 切り替え待機 " + _betweenModeDelay + "ms");
          await new Promise(function(r) { setTimeout(r, _betweenModeDelay); });
        }
        var effectiveCustomer = areaModePasses[k]
          ? Object.assign({}, customer, { area_mode: areaModePasses[k] })
          : customer;
        try {
          // 修正4: fill-done ウェイターを autofill 発火「前」に作成しておく
          // リアプロ・itandi ともモーダル操作/ページロードで60秒を超えることがあるため90秒に統一
          // customerId を渡して他顧客の遅延 fill-done が誤解決しないよう保護する
          var fillDoneP = (batchSite === "itandi" || batchSite === "realnetpro")
            ? _createFillDoneWaiter(batchSite, String(effectiveCustomer.id), 90000)
            : null;
          // _batchAutofill は解決済み条件（itandi_lines 等を含む）を返す
          var resolvedBatchConds = await _batchAutofill(effectiveCustomer, batchSite, batchIsWide);
          var _passCount = 0;
          if (batchSite === "itandi") {
            // itandi の場合: リアプロと同じく fill-done + batch-customer-done を待つ形に統一
            // itandi-bulk-dl.js の autoSendAllPages が axlx-batch-customer-done シグナルを送信する
            _passCount = await _scrapeAndSendRealpro(
              fillDoneP,
              String(effectiveCustomer.id),
              effectiveCustomer.customer_name || null,
              resolvedBatchConds || _buildBatchConditions(effectiveCustomer, batchIsWide),
              "itandi",
              _isMultiPass  // suppressZeroNotify: both顧客は呼び出し元が集計して1回通知
            );
          } else if (batchSite === "realnetpro") {
            // 修正7: 通常バッチのリアプロ分岐にもスクレイプ→AI比較→LINE送信を追加
            // （従来は autofill + 3秒 sleep のみで結果がどこにも届かなかった）
            _passCount = await _scrapeAndSendRealpro(
              fillDoneP,
              String(effectiveCustomer.id),
              effectiveCustomer.customer_name || null,
              resolvedBatchConds || _buildBatchConditions(effectiveCustomer, batchIsWide),
              null,         // siteLabel → "リアプロ" (default)
              _isMultiPass  // suppressZeroNotify: both顧客は呼び出し元が集計して1回通知
            );
          } else {
            await new Promise(function(r) { setTimeout(r, 2000 + Math.floor(Math.random() * 2000)); });
          }
          _totalPassCount += (_passCount || 0);
        } catch (e) {
          // Fix 3/4: __BATCH_STOPPED__ は正常なキャンセルなので re-throw して全ループを抜ける
          if (e && e.message === "__BATCH_STOPPED__") {
            console.log("[batch] __BATCH_STOPPED__ 受信 → バッチ中断");
            await _updateBatchCommand(command.id, { status: "cancelled", completed_at: new Date().toISOString() });
            return;
          }
          console.error("[batch] error:", effectiveCustomer.id, batchSite, areaModePasses[k] || "auto", e);
          batchErrors.push(effectiveCustomer.id + "/" + batchSite + "/" + (areaModePasses[k] || "auto") + ": " + ((e && e.message) || e));
        }
      }
      // B3修正: area_mode='both' で全パス合計0件の場合のみ1回だけ通知（重複送信防止）
      if (_isMultiPass && _totalPassCount === 0 && customer.customer_name) {
        var _bothSiteLabel = batchSite === "itandi" ? "itandi" : "リアプロ";
        fetch(SUMORA_BATCH_API + "/api/notify-group", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "🔍【物件0件】" + customer.customer_name + "さんの" + _bothSiteLabel + "検索が0件でした" })
        }).catch(function() {});
      }
    }
    await _updateBatchCommand(command.id, { processed_customers: i + 1 });
    // Webアプリタブに顧客完了を通知（リアプロ/itandi/レインズ全サイト対応・バッチ進捗カウンター更新）
    try {
      var _webTabs = await chrome.tabs.query({ url: ["https://sumora-ai-ui.vercel.app/*", "http://localhost:3000/*"] });
      for (var _wi = 0; _wi < _webTabs.length; _wi++) {
        try { await chrome.tabs.sendMessage(_webTabs[_wi].id, { type: "axlx-batch-customer-done" }); } catch (_ignore) {}
      }
    } catch (_ignore) {}
    // 次顧客がいる場合のみ: 人間らしい間隔（3〜8秒ランダム）を挿入
    if (i < targets.length - 1) {
      var _interCustomerDelay = 3000 + Math.floor(Math.random() * 5000);
      console.log("[batch] 次顧客まで待機 " + _interCustomerDelay + "ms");
      await new Promise(function(r) { setTimeout(r, _interCustomerDelay); });
    }
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
    await new Promise(function(r) { setTimeout(r, 1800 + Math.floor(Math.random() * 900)); });
  }

  var conds = _buildBatchConditions(customer, isWide);

  // ── itandi 専用: 路線名・エリア名を itandi-page-script.js が使うキー形式に変換 ──
  // itandi-page-script.js は cond.itandi_lines と cond.ward_names を参照する。
  // _buildBatchConditions は cond.lines（リアプロ形式）と cond.areas を返すため変換が必要。
  // 修正: areas に駅名が入る場合（desired_area="鶴橋"など）、ward_names として使うのではなく
  //       _resolveLocalFirst で itandi_lines に変換する必要があるため、常に解決を試みる。
  if (site === "itandi") {
    var hasItandiAreaInput = (conds.areas && conds.areas.length) || (conds.lines && conds.lines.length) || (conds.stations && conds.stations.length);
    if (hasItandiAreaInput) {
      try {
        var resolvedItandi = await _resolveLocalFirst(conds, isWide);
        if (resolvedItandi.itandi_line_names && resolvedItandi.itandi_line_names.length) {
          // 路線解決成功 → 路線・駅モード優先（ward_namesは使わない）
          conds.itandi_lines = resolvedItandi.itandi_line_names;
          if (resolvedItandi.station_names && resolvedItandi.station_names.length) {
            conds.station_names = resolvedItandi.station_names;
          }
          conds.ward_names = null; // 路線モード時は所在地フィルターを無効化
        } else {
          // 路線未解決 → 所在地モード（区・市区町村ベース）
          if (resolvedItandi.ward_names && resolvedItandi.ward_names.length) {
            conds.ward_names = resolvedItandi.ward_names;
          } else if (conds.areas && conds.areas.length) {
            conds.ward_names = conds.areas;
          }
          if (resolvedItandi.detail_ward && (!conds.ward_names || !conds.ward_names.length)) {
            conds.ward_names = [resolvedItandi.detail_ward];
          }
        }
      } catch (e) {
        console.warn("[batchAutofill] itandi resolve失敗（デフォルト条件で続行）:", e.message || e);
        // フォールバック: areas をそのまま ward_names として使用
        if (conds.areas && conds.areas.length) {
          conds.ward_names = conds.areas;
        }
      }
    } else if (conds.areas && conds.areas.length) {
      conds.ward_names = conds.areas;
    }
  }

  if (site === "realnetpro") {
    // popup.js 経由で完全条件構築（Dijkstra路線展開・API判定含む）を実行する
    // 個別検索（axlx-webapp-search）と同一フロー: chrome.tabs.sendMessage → underbar.js → popup.js → page-script.js
    // ★ switch-customer を先に送り、resolveLocalFirst はその後実行（フォーム入力を即時開始させるため）
    // content.js に現在の顧客IDを事前通知（fill-done relay に customerId を付与するため）
    try { await chrome.tabs.sendMessage(tab.id, { type: "axlx-set-fill-customer", customerId: String(customer.id) }); } catch(_) {}
    var batchRpSwitched = await new Promise(function(resolve) {
      chrome.tabs.sendMessage(tab.id, {
        type:         "axlx-switch-customer",
        customerId:   String(customer.id),
        customerName: customer.customer_name || null,
        site:         "realpro",
        areaMode:     customer.area_mode || null,
        is_wide:      isWide,
        auto_send_all: false,
      }, function(resp) {
        if (chrome.runtime.lastError) {
          console.warn("[batchAutofill] realnetpro axlx-switch-customer error:", chrome.runtime.lastError.message);
          resolve(false); return;
        }
        resolve(!!(resp && resp.ok));
      });
    });
    if (!batchRpSwitched) {
      // フォールバック: underbar.js / popup.js 未応答 → 解決済み条件で直接 fill
      console.warn("[batchAutofill] realnetpro: axlx-switch-customer 未応答 → executeScript fallback");
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: function(c) {
          window.postMessage({ from: "axlx-autofill-initiated" }, "*");
          window.postMessage({ from: "aixlinx-fill", conditions: c }, "*");
        },
        args: [conds]
      });
    }
    // switch-customer 送信後に _resolveLocalFirst を実行（_scrapeAndSendRealpro 用の条件補完）
    // フォーム入力はすでに popup.js 側で開始済みのため、ここでのAPI呼び出しが遅延しても問題なし
    if ((conds.areas && conds.areas.length) || (conds.lines && conds.lines.length) || (conds.stations && conds.stations.length)) {
      try {
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
  } else if (site === "itandi") {
    // popup.js 経由で完全条件構築（ITANDI_LINE_MAP_FILL・Dijkstra路線展開含む）を実行する
    // リアプロと同一フロー: chrome.tabs.sendMessage → underbar.js → popup.js → itandi-page-script.js
    // itandi-content.js に現在の顧客IDを事前通知（fill-done relay に customerId を付与するため）
    try { await chrome.tabs.sendMessage(tab.id, { type: "axlx-set-fill-customer", customerId: String(customer.id) }); } catch(_) {}
    var batchItandiSwitched = await new Promise(function(resolve) {
      chrome.tabs.sendMessage(tab.id, {
        type:          "axlx-switch-customer",
        customerId:    String(customer.id),
        customerName:  customer.customer_name || null,
        site:          "itandi",
        areaMode:      customer.area_mode || null,
        is_wide:       isWide,
        auto_send_all: false,
      }, function(resp) {
        if (chrome.runtime.lastError) {
          console.warn("[batchAutofill] itandi axlx-switch-customer error:", chrome.runtime.lastError.message);
          resolve(false); return;
        }
        resolve(!!(resp && resp.ok));
      });
    });
    if (!batchItandiSwitched) {
      // フォールバック: underbar.js / popup.js 未応答 → 解決済み条件で直接 fill
      console.warn("[batchAutofill] itandi: axlx-switch-customer 未応答 → direct fallback");
      var itandiFbSent = await new Promise(function(resolve) {
        chrome.tabs.sendMessage(tab.id, { type: "axlx-itandi-autofill", conditions: conds }, function(resp) {
          resolve(!chrome.runtime.lastError && !!(resp && resp.ok));
        });
      });
      if (!itandiFbSent) {
        console.warn("[batchAutofill] itandi sendMessage未確認, executeScript fallback");
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: function(c) {
            window.postMessage({ from: "axlx-itandi-autofill-initiated" }, "*");
            window.postMessage({ from: "axlx-itandi-fill-exec", conditions: c }, "*");
          },
          args: [conds]
        });
      }
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
    area_mode: (c.area_mode === 'both') ? null : (c.area_mode || null), // 'both'はnull(自動判定)にフォールバック
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
    var resolved = false;
    var listener = function(id, info) {
      if (id === tabId && info.status === "complete" && !resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(function() {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener); // リスナーリーク防止
        resolve();
      }
    }, 15000);
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
      await new Promise(function(r) { setTimeout(r, 1800 + Math.floor(Math.random() * 900)); });
      existing = targetRealTab;
    }
  }
  var tab = existing;
  if (!tab) {
    // タブが存在しない: 新規作成してフォアグラウンドで開く
    tab = await chrome.tabs.create({ url: siteUrls[site], active: true });
    await _batchWaitForTabComplete(tab.id);
    await new Promise(function(r) { setTimeout(r, 1800 + Math.floor(Math.random() * 900)); });
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
      await new Promise(function(r) { setTimeout(r, 1200 + Math.floor(Math.random() * 800)); });
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
async function _sendPropertiesToBackend(properties, customerId, conditions, customerName, site) {
  var body = { properties: properties, customerId: customerId, conditions: conditions };
  if (customerName) body.customerName = customerName;
  if (site) body.site = site;
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
  // 'both' は _buildBatchConditions で null に変換済みのため ここには届かないが念のため null と同等扱い
  var _am = mergedConditions.area_mode;
  var hasAreaResolved = (_am === "ward")
    ? (mergedCityCodes.length > 0 || !!mergedDetailWard)
    : (_am === "station")
      ? (mergedStations.length > 0 || mergedRoutes.length > 0)
      : (mergedStations.length > 0 || mergedRoutes.length > 0 ||
         mergedCityCodes.length > 0 || !!mergedDetailWard); // null/auto/'both'は両方チェック
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
  var fillDonePromise = _createFillDoneWaiter("realnetpro", customerId, 90000);
  await _webappAutofill("realnetpro", mergedConditions);
  await _scrapeAndSendRealpro(fillDonePromise, customerId, customerName, mergedConditions);
}

// ── リアプロの fill-done 待機 → bulk-dl.js 全ページ送信完了待機 ──
// bulk-dl.js の autoSendAllPages が全ページ送信後に axlx-batch-customer-done を送る。
// background.js はその完了を待ってから次顧客へ移る（ページ競合を防ぐ）。
// suppressZeroNotify=true のとき 0件 LINE通知をスキップし、呼び出し元が集計して1回だけ通知する
// （area_mode='both' の2パス重複通知防止用）
async function _scrapeAndSendRealpro(fillDonePromise, customerId, customerName, conditions, siteLabel, suppressZeroNotify) {
  var _site = siteLabel || "リアプロ";
  // fill-done を待つ（検索実行完了シグナル）
  var fillDone = fillDonePromise ? await fillDonePromise : null;
  if (fillDone && fillDone.stopped) {
    throw new Error("__BATCH_STOPPED__");
  }
  if (!fillDone || fillDone.timedOut) {
    throw new Error(_site + " 検索完了シグナル（fill-done）が90秒以内に届きませんでした。");
  }
  if (fillDone.error) {
    throw new Error("page-script側エラー（スキップ）: " + fillDone.error);
  }

  // fill-done 受信後、bulk-dl.js が axlx-autofill-initiated → autoSendAllPages → 全ページPDF送信
  // axlx-batch-customer-done シグナルで全ページ送信完了を待つ（最大5分）
  // これにより次顧客のautofillがページを書き換える前に現顧客の送信が確実に完了する
  console.log("[scrapeAndCompare] fill-done 受信 → 全ページ送信完了を待機 customer=" + customerId);
  var batchDone = await _createBatchCustomerDoneWaiter(customerId, 300000);
  if (batchDone && batchDone.stopped) {
    throw new Error("__BATCH_STOPPED__");
  }
  var _propCount = 0;
  if (batchDone && batchDone.timedOut) {
    console.warn("[scrapeAndCompare] 全ページ送信完了シグナルが5分以内に届きませんでした（次顧客へ続行） customer=" + customerId);
    // タイムアウト = 検索結果0件の可能性が高い → 0件アナウンスとして送信（4人検索→4人分アナウンス要件）
    // suppressZeroNotify=true の場合は呼び出し元が集計後に1回だけ通知するためここではスキップ
    if (!suppressZeroNotify && customerName) {
      fetch(SUMORA_BATCH_API + "/api/notify-group", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "🔍【物件0件】" + customerName + "さんの" + _site + "検索が0件でした" })
      }).catch(function() {});
    }
    _propCount = 0;
  } else {
    console.log("[scrapeAndCompare] 全ページ送信完了 customer=" + customerId);
    _propCount = (batchDone && batchDone.propertyCount) ? batchDone.propertyCount : 0;
  }
  // 0件時 → LINEグループへアナウンス（timedOut 分岐で既に通知済みの場合は重複しない）
  if (_propCount === 0 && !(batchDone && batchDone.timedOut) && !suppressZeroNotify && customerName) {
    fetch(SUMORA_BATCH_API + "/api/notify-group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "🔍【物件0件】" + customerName + "さんの" + _site + "検索が0件でした" })
    }).catch(function() {});
  }
  return _propCount;
}

// ===== END: 自動化バッチ検索 =====
