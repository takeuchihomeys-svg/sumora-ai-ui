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

  chrome.runtime.sendMessage(
    { type: "axlx-webapp-search", site, conditions },
    (resp) => {
      if (chrome.runtime.lastError) {
        console.warn("[webapp-bridge] sendMessage error:", chrome.runtime.lastError.message);
        return;
      }
      console.log("[webapp-bridge] background response:", resp);
    }
  );
});
