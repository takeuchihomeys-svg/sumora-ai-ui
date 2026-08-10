"use strict";
// webapp-bridge.js
// sumora-ai-ui.vercel.app 向け content script
// WebApp の window.postMessage を background.js の chrome.runtime.sendMessage に橋渡しする

const ALLOWED_ORIGINS = [
  "https://sumora-ai-ui.vercel.app",
  "http://localhost:3000"
];

window.addEventListener("message", (e) => {
  // ① origin 検証: 許可済みオリジン以外は即リターン
  if (!ALLOWED_ORIGINS.includes(e.origin)) return;

  // ── poll-now: automation_commands INSERT直後にアラーム30秒待ちをスキップ ──
  if (e.data && e.data.from === "aixlinx-webapp-poll-now") {
    chrome.runtime.sendMessage({ type: "axlx-poll-now" }, () => {
      void chrome.runtime.lastError; // ignore if no listener
    });
    return;
  }

  // ── scrape-and-compare: リアプロ自動スクレイプ+比較の直接トリガー ──
  // Supabase automation_commands 経由より高速・条件は拡張側で resolve（popupと同等）
  if (e.data && e.data.from === "aixlinx-webapp-scrape") {
    const { customerId, customerName, isWide, conditions } = e.data;
    // 即時ACKを返してwebappに拡張の存在を通知（フォールバック判定用）
    try { window.postMessage({ from: "aixlinx-webapp-scrape-ack", customerId }, "*"); } catch (_) {}
    chrome.runtime.sendMessage(
      { type: "axlx-scrape-and-compare", customerId, conditions: Object.assign({}, conditions, { customerName, isWide: !!isWide }) },
      (resp) => {
        void chrome.runtime.lastError;
        window.postMessage({
          from: "aixlinx-webapp-scrape-result",
          customerId,
          ok:    resp?.ok    ?? false,
          count: resp?.count ?? 0,
          error: resp?.error ?? null,
        }, "*");
      }
    );
    return;
  }

  // ── estimate-auto: 見積書自動モード（物件詳細ページを自動スクレイプ）──────
  if (e.data && e.data.from === "aixlinx-webapp-estimate-auto") {
    var site = e.data.site || "unknown";
    chrome.runtime.sendMessage(
      { type: "axlx-estimate-auto", site: site },
      function(resp) {
        void chrome.runtime.lastError;
        if (resp && resp.ok) {
          window.postMessage({ from: "aixlinx-estimate-data", text: resp.text }, "*");
        } else {
          window.postMessage({ from: "aixlinx-estimate-error", error: (resp && resp.error) || "不明なエラー" }, "*");
        }
      }
    );
    return;
  }

  // ② ペイロード検証
  if (!e.data || e.data.from !== "aixlinx-webapp") return;
  const { site, conditions } = e.data;
  if (!site || !conditions) return;

  console.log("[webapp-bridge] site=" + site + " conditions=", conditions);

  // 修正6: 拡張が同一ブラウザに存在することを WebApp に即時通知する受領ACK。
  // WebApp（queuePropertySearch）はこのACKを受け取ったらキュー投入をスキップして二重実行を防ぐ
  try {
    window.postMessage({ from: "aixlinx-webapp-received", site: site }, "*");
  } catch (_e) { /* ignore */ }

  const auto_send_all = !!(e.data.auto_send_all);
  chrome.runtime.sendMessage(
    { type: "axlx-webapp-search", site, conditions, auto_send_all },
    (resp) => {
      if (chrome.runtime.lastError) {
        console.warn("[webapp-bridge] sendMessage error:", chrome.runtime.lastError.message);
        return;
      }
      console.log("[webapp-bridge] background response:", resp);
    }
  );
});

chrome.runtime.onMessage.addListener(function(msg) {
  if (msg && msg.type === "axlx-batch-customer-done") {
    window.postMessage({ from: "aixlinx-batch-customer-done", customerId: msg.customerId || null }, "*");
  }
});
