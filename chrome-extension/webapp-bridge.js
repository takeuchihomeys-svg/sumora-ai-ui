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

  // ② ペイロード検証
  if (!e.data || e.data.from !== "aixlinx-webapp") return;
  const { site, conditions } = e.data;
  if (!site || !conditions) return;

  console.log("[webapp-bridge] site=" + site + " conditions=", conditions);

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
