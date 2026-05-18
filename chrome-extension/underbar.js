"use strict";

// リアプロページにAIXLINX フローティングパネルを注入
// ページ遷移をまたいで展開状態・位置・サイズをsessionStorageで保持
(function () {
  if (document.getElementById("aixlinx-float-wrap")) return;

  const MINI    = 100;
  const DRAG_H  = 28;
  const MIN_W   = 260;
  const MIN_H   = 300;
  const INIT_W  = 540;
  const INIT_H  = 780;
  const SK      = "aixlinx_state"; // sessionStorage key

  // ── 前回状態を復元 ────────────────────────────────────────────────
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(SK) || "{}"); } catch {}

  let posX   = saved.posX   ?? 8;
  let posY   = saved.posY   ?? 70;
  let panelW = saved.panelW ?? INIT_W;
  let panelH = saved.panelH ?? INIT_H;
  let expanded = false; // 視覚的サイズは後でiframe.loadで確定

  const wasExpanded = saved.expanded === true;
  let ignoreNextCollapse = wasExpanded; // popup.jsの初期collapseを無視するフラグ

  function persist() {
    try {
      sessionStorage.setItem(SK, JSON.stringify({
        expanded,
        posX:   parseInt(wrap.style.left) || posX,
        posY:   parseInt(wrap.style.top)  || posY,
        panelW,
        panelH,
      }));
    } catch {}
  }

  // ── wrap ─────────────────────────────────────────────────────────
  const wrap = document.createElement("div");
  wrap.id = "aixlinx-float-wrap";
  Object.assign(wrap.style, {
    boxShadow:     "0 4px 28px rgba(0,0,0,0.32)",
    borderRadius:  "14px",
    overflow:      "hidden",
    display:       "flex",
    flexDirection: "column",
    transition:    "width 0.22s ease, height 0.22s ease",
    background:    "#fff",
  });
  // ページCSSに上書きされないよう !important で固定
  wrap.style.setProperty("position", "fixed", "important");
  wrap.style.setProperty("top",      posY + "px", "important");
  wrap.style.setProperty("left",     posX + "px", "important");
  wrap.style.setProperty("width",    MINI + "px", "important");
  wrap.style.setProperty("height",   MINI + "px", "important");
  wrap.style.setProperty("z-index",  "2147483647", "important");

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
  // iframe.allow = "clipboard-write" は削除
  // → itandibb.comのPermissions-PolicyがclipboardをブロックするためChrome違反ログの原因になる
  // → コピーはpostMessage経由でコンテンツスクリプトのexecCommandに委託
  Object.assign(iframe.style, {
    flex:      "1",
    width:     "100%",
    border:    "none",
    display:   "block",
    minHeight: "0",
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

  // ── ミニ用オーバーレイ ────────────────────────────────────────────
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
      wrap.style.setProperty("width",  panelW + "px", "important");
      wrap.style.setProperty("height", (panelH + DRAG_H) + "px", "important");
      dragBar.style.display       = "flex";
      resizeHandle.style.display  = "block";
      miniOverlay.style.display   = "none";
    } else {
      wrap.style.setProperty("width",  MINI + "px", "important");
      wrap.style.setProperty("height", MINI + "px", "important");
      dragBar.style.display       = "none";
      resizeHandle.style.display  = "none";
      miniOverlay.style.display   = "block";
    }
    persist();
  }

  // ── iframe ロード後に展開状態を復元 ──────────────────────────────
  iframe.addEventListener("load", () => {
    if (wasExpanded) {
      setTimeout(() => {
        setSize(true);
        iframe.contentWindow.postMessage(
          { from: "underbar-parent", action: "expand-from-parent" }, "*"
        );
      }, 80);
    }
  });

  // ── ドラッグ & リサイズ（一元管理）──────────────────────────────
  let dragAction = null; // "move" | "resize"
  let startCX = 0, startCY = 0;
  let startWX = 0, startWY = 0;
  let startPW = panelW, startPH = panelH;

  function onDragStart(e, type) {
    if (e.button !== 0) return;
    dragAction = type;
    startCX = e.clientX;
    startCY = e.clientY;
    startWX = parseInt(wrap.style.left) || posX;
    startWY = parseInt(wrap.style.top)  || posY;
    startPW = panelW;
    startPH = panelH;
    iframe.style.pointerEvents = "none";
    wrap.style.transition      = "none";
    e.preventDefault();
    e.stopPropagation();
  }

  miniOverlay.addEventListener("mousedown",  (e) => onDragStart(e, "move"));
  dragBar.addEventListener("mousedown",      (e) => onDragStart(e, "move"));
  resizeHandle.addEventListener("mousedown", (e) => onDragStart(e, "resize"));

  document.addEventListener("mousemove", (e) => {
    if (!dragAction) return;
    const dx = e.clientX - startCX;
    const dy = e.clientY - startCY;
    if (dragAction === "move") {
      wrap.style.setProperty("left", Math.max(0, startWX + dx) + "px", "important");
      wrap.style.setProperty("top",  Math.max(0, startWY + dy) + "px", "important");
    } else {
      panelW = Math.max(MIN_W, startPW + dx);
      panelH = Math.max(MIN_H, startPH + dy);
      wrap.style.setProperty("width",  panelW + "px", "important");
      wrap.style.setProperty("height", (panelH + DRAG_H) + "px", "important");
    }
  });

  document.addEventListener("mouseup", (e) => {
    if (!dragAction) return;
    const wasMini = !expanded;
    const wasMove = dragAction === "move";
    const dx = Math.abs(e.clientX - startCX);
    const dy = Math.abs(e.clientY - startCY);

    dragAction = null;
    iframe.style.pointerEvents = "";
    dragBar.style.cursor       = "grab";
    miniOverlay.style.cursor   = "grab";
    setTimeout(() => {
      wrap.style.transition = "width 0.22s ease, height 0.22s ease";
    }, 50);

    persist(); // 位置・サイズを保存

    // ミニモードでほぼ動かなかった → クリック → 展開
    if (wasMini && wasMove && dx < 5 && dy < 5) {
      setSize(true);
      iframe.contentWindow.postMessage(
        { from: "underbar-parent", action: "expand-from-parent" }, "*"
      );
    }
  });

  // ── popup.htmlからのメッセージ ────────────────────────────────────
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.from !== "aixlinx-underbar") return;
    const a = e.data.action;
    if (a === "collapse") {
      // popup.js初期化時のcollapseは無視（前回展開状態を維持するため）
      if (ignoreNextCollapse) { ignoreNextCollapse = false; return; }
      setSize(false);
    }
    if (a === "expand") setSize(true);
    if (a === "toggle") setSize(!expanded);
    if (a === "autofill") {
      // page-script.jsのリスナーに転送（ページのJS文脈で動かす）
      window.postMessage({ from: "aixlinx-fill", conditions: e.data.conditions }, "*");
    }
    if (a === "itandi-autofill") {
      // itandi-content.jsに転送（chrome.tabsがiframe内で使えないためpostMessage経由）
      window.postMessage({ from: "aixlinx-itandi-fill", conditions: e.data.conditions }, "*");
    }
    if (a === "copy" && typeof e.data.text === "string") {
      // Clipboard APIは一切使わずexecCommandのみでコピー
      // （navigator.clipboard.writeTextもPermissions-Policy違反ログの原因になるため使用禁止）
      const ta = document.createElement("textarea");
      ta.value = e.data.text;
      ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { document.execCommand("copy"); } catch {}
      ta.remove();
    }
  });
})();
