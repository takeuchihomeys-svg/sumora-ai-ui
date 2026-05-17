"use strict";

// リアプロページにAIXLINX フローティングボタンを注入
// ミニモード: 52x52の■ボタン（ドラッグ移動可・クリックで展開）
// 展開モード: 360x520のパネル
(function () {
  if (document.getElementById("aixlinx-float-wrap")) return;

  const MINI    = 52;
  const PANEL_W = 360;
  const PANEL_H = 520;

  let posX = 8, posY = 70;
  let expanded = false;

  const wrap = document.createElement("div");
  wrap.id = "aixlinx-float-wrap";
  Object.assign(wrap.style, {
    position:     "fixed",
    top:          posY + "px",
    left:         posX + "px",
    width:        MINI + "px",
    height:       MINI + "px",
    zIndex:       "2147483647",
    boxShadow:    "0 4px 24px rgba(0,0,0,0.28)",
    transition:   "width 0.25s cubic-bezier(0.4,0,0.2,1), height 0.25s cubic-bezier(0.4,0,0.2,1)",
    overflow:     "hidden",
    borderRadius: "14px",
  });

  const iframe = document.createElement("iframe");
  iframe.src = chrome.runtime.getURL("popup.html");
  Object.assign(iframe.style, {
    width:   PANEL_W + "px",
    height:  (PANEL_H + 60) + "px",
    border:  "none",
    display: "block",
  });

  // ミニモード時のみ有効なドラッグ用透明オーバーレイ
  const overlay = document.createElement("div");
  Object.assign(overlay.style, {
    position:      "absolute",
    top:           "0",
    left:          "0",
    right:         "0",
    height:        MINI + "px",
    zIndex:        "1",
    cursor:        "grab",
    pointerEvents: "auto",
  });

  wrap.appendChild(iframe);
  wrap.appendChild(overlay);
  document.body.appendChild(wrap);

  // ── サイズ切り替え ──────────────────────────────────
  function setSize(exp) {
    expanded = exp;
    if (exp) {
      wrap.style.width    = PANEL_W + "px";
      wrap.style.height   = PANEL_H + "px";
      overlay.style.height        = "0";
      overlay.style.pointerEvents = "none";
    } else {
      wrap.style.width    = MINI + "px";
      wrap.style.height   = MINI + "px";
      overlay.style.height        = MINI + "px";
      overlay.style.pointerEvents = "auto";
    }
  }

  // ── ドラッグ（ミニモード時のみ） ────────────────────
  let dragging = false;
  let startCX = 0, startCY = 0, startWX = posX, startWY = posY;

  overlay.addEventListener("mousedown", (e) => {
    dragging  = true;
    startCX   = e.clientX;
    startCY   = e.clientY;
    startWX   = parseInt(wrap.style.left) || posX;
    startWY   = parseInt(wrap.style.top)  || posY;
    overlay.style.cursor       = "grabbing";
    iframe.style.pointerEvents = "none";
    wrap.style.transition      = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    wrap.style.left = Math.max(0, startWX + e.clientX - startCX) + "px";
    wrap.style.top  = Math.max(0, startWY + e.clientY - startCY) + "px";
  });

  document.addEventListener("mouseup", (e) => {
    if (!dragging) return;
    dragging = false;
    overlay.style.cursor       = "grab";
    iframe.style.pointerEvents = "";
    setTimeout(() => {
      wrap.style.transition = "width 0.25s cubic-bezier(0.4,0,0.2,1), height 0.25s cubic-bezier(0.4,0,0.2,1)";
    }, 50);

    // ほとんど動いていない → クリック扱い → 展開
    const dx = Math.abs(e.clientX - startCX);
    const dy = Math.abs(e.clientY - startCY);
    if (!expanded && dx < 5 && dy < 5) {
      setSize(true);
      iframe.contentWindow.postMessage({ from: "underbar-parent", action: "expand-from-parent" }, "*");
    }
  });

  // ── popup.htmlからのメッセージ ──────────────────────
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.from !== "aixlinx-underbar") return;
    const a = e.data.action;
    if (a === "expand")   setSize(true);
    if (a === "collapse") setSize(false);
    if (a === "toggle")   setSize(!expanded);
  });
})();
