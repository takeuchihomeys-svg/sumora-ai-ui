"use strict";

// リアプロページにAIXLINX フローティングパネルを注入
// ミニ(52x52)↔パネル(可変)、ドラッグ移動・右下コーナーリサイズ対応
(function () {
  if (document.getElementById("aixlinx-float-wrap")) return;

  const MINI    = 52;
  const DRAG_H  = 28;   // 展開時のドラッグバー高さ
  const MIN_W   = 260;
  const MIN_H   = 300;
  const INIT_W  = 360;
  const INIT_H  = 520;

  let posX = 8, posY = 70;
  let panelW = INIT_W, panelH = INIT_H;
  let expanded = false;

  // ── wrap ─────────────────────────────────────────────────────────
  const wrap = document.createElement("div");
  wrap.id = "aixlinx-float-wrap";
  Object.assign(wrap.style, {
    position:      "fixed",
    top:           posY + "px",
    left:          posX + "px",
    width:         MINI + "px",
    height:        MINI + "px",
    zIndex:        "2147483647",
    boxShadow:     "0 4px 28px rgba(0,0,0,0.32)",
    borderRadius:  "14px",
    overflow:      "hidden",
    display:       "flex",
    flexDirection: "column",
    transition:    "width 0.22s ease, height 0.22s ease",
    background:    "#fff",
  });

  // ── ドラッグバー（展開時）─────────────────────────────────────────
  const dragBar = document.createElement("div");
  Object.assign(dragBar.style, {
    width:          "100%",
    height:         DRAG_H + "px",
    flexShrink:     "0",
    background:     "linear-gradient(135deg, #0a1628, #1565C0)",
    cursor:         "grab",
    display:        "none",
    alignItems:     "center",
    justifyContent: "center",
    userSelect:     "none",
  });
  dragBar.title = "ドラッグして移動";
  dragBar.innerHTML = `<svg width="36" height="10" viewBox="0 0 36 10">
    <circle cx="6"  cy="3" r="2.2" fill="rgba(255,255,255,0.38)"/>
    <circle cx="18" cy="3" r="2.2" fill="rgba(255,255,255,0.38)"/>
    <circle cx="30" cy="3" r="2.2" fill="rgba(255,255,255,0.38)"/>
    <circle cx="6"  cy="7" r="2.2" fill="rgba(255,255,255,0.38)"/>
    <circle cx="18" cy="7" r="2.2" fill="rgba(255,255,255,0.38)"/>
    <circle cx="30" cy="7" r="2.2" fill="rgba(255,255,255,0.38)"/>
  </svg>`;

  // ── iframe ────────────────────────────────────────────────────────
  const iframe = document.createElement("iframe");
  iframe.src = chrome.runtime.getURL("popup.html");
  Object.assign(iframe.style, {
    flex:     "1",
    width:    "100%",
    border:   "none",
    display:  "block",
    minHeight:"0",
  });

  // ── リサイズハンドル（右下）──────────────────────────────────────
  const resizeHandle = document.createElement("div");
  Object.assign(resizeHandle.style, {
    position: "absolute",
    bottom:   "0",
    right:    "0",
    width:    "20px",
    height:   "20px",
    cursor:   "se-resize",
    zIndex:   "4",
    display:  "none",
  });
  resizeHandle.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20">
    <path d="M20 8L20 20L8 20Z" fill="rgba(21,101,192,0.18)"/>
    <line x1="8"  y1="20" x2="20" y2="8"  stroke="rgba(21,101,192,0.45)" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="20" x2="20" y2="13" stroke="rgba(21,101,192,0.45)" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;

  // ── ミニ用オーバーレイ（ドラッグ+クリック検出）───────────────────
  const miniOverlay = document.createElement("div");
  Object.assign(miniOverlay.style, {
    position:      "absolute",
    inset:         "0",
    zIndex:        "3",
    cursor:        "grab",
    pointerEvents: "auto",
  });

  wrap.appendChild(dragBar);
  wrap.appendChild(iframe);
  wrap.appendChild(resizeHandle);
  wrap.appendChild(miniOverlay);
  document.body.appendChild(wrap);

  // ── サイズ切り替え ────────────────────────────────────────────────
  function setSize(exp) {
    expanded = exp;
    if (exp) {
      wrap.style.width            = panelW + "px";
      wrap.style.height           = (panelH + DRAG_H) + "px";
      dragBar.style.display       = "flex";
      resizeHandle.style.display  = "block";
      miniOverlay.style.display   = "none";
    } else {
      wrap.style.width            = MINI + "px";
      wrap.style.height           = MINI + "px";
      dragBar.style.display       = "none";
      resizeHandle.style.display  = "none";
      miniOverlay.style.display   = "block";
    }
  }

  // ── ドラッグ & リサイズ（一元管理）──────────────────────────────
  let action   = null; // "move" | "resize"
  let startCX  = 0, startCY  = 0;
  let startWX  = 0, startWY  = 0;
  let startPW  = panelW, startPH = panelH;

  function onDragStart(e, type) {
    if (e.button !== 0) return;
    action   = type;
    startCX  = e.clientX;
    startCY  = e.clientY;
    startWX  = parseInt(wrap.style.left) || posX;
    startWY  = parseInt(wrap.style.top)  || posY;
    startPW  = panelW;
    startPH  = panelH;
    iframe.style.pointerEvents = "none";
    wrap.style.transition      = "none";
    if (type === "move") {
      (e.currentTarget || e.target).style.cursor = "grabbing";
    }
    e.preventDefault();
    e.stopPropagation();
  }

  miniOverlay.addEventListener("mousedown",  (e) => onDragStart(e, "move"));
  dragBar.addEventListener("mousedown",      (e) => onDragStart(e, "move"));
  resizeHandle.addEventListener("mousedown", (e) => onDragStart(e, "resize"));

  document.addEventListener("mousemove", (e) => {
    if (!action) return;
    const dx = e.clientX - startCX;
    const dy = e.clientY - startCY;
    if (action === "move") {
      wrap.style.left = Math.max(0, startWX + dx) + "px";
      wrap.style.top  = Math.max(0, startWY + dy) + "px";
    } else {
      panelW = Math.max(MIN_W, startPW + dx);
      panelH = Math.max(MIN_H, startPH + dy);
      wrap.style.width  = panelW + "px";
      wrap.style.height = (panelH + DRAG_H) + "px";
    }
  });

  document.addEventListener("mouseup", (e) => {
    if (!action) return;
    const wasMini  = !expanded;
    const wasMove  = action === "move";
    const dx = Math.abs(e.clientX - startCX);
    const dy = Math.abs(e.clientY - startCY);

    action = null;
    iframe.style.pointerEvents = "";
    dragBar.style.cursor   = "grab";
    miniOverlay.style.cursor = "grab";
    setTimeout(() => {
      wrap.style.transition = "width 0.22s ease, height 0.22s ease";
    }, 50);

    // ミニモードでほぼ動かなかった → クリック → 展開
    if (wasMini && wasMove && dx < 5 && dy < 5) {
      setSize(true);
      iframe.contentWindow.postMessage({ from: "underbar-parent", action: "expand-from-parent" }, "*");
    }
  });

  // ── popup.htmlからのメッセージ ────────────────────────────────────
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.from !== "aixlinx-underbar") return;
    const a = e.data.action;
    if (a === "expand")   setSize(true);
    if (a === "collapse") setSize(false);
    if (a === "toggle")   setSize(!expanded);
  });
})();
