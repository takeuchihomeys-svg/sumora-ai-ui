"use strict";

// リアプロページにAIXLINXアンダーバーを注入
// サイドパネルと違いviewportを狭めないため、リアプロの左サイドバーが消えない
(function () {
  if (document.getElementById("aixlinx-underbar-wrap")) return;

  const COLLAPSED_H = 54;
  const EXPANDED_H  = 480;

  // ── ラッパー（高さアニメーション用） ──
  const wrap = document.createElement("div");
  wrap.id = "aixlinx-underbar-wrap";
  Object.assign(wrap.style, {
    position:   "fixed",
    bottom:     "0",
    left:       "0",
    right:      "0",
    width:      "100%",
    height:     COLLAPSED_H + "px",
    zIndex:     "2147483647",
    boxShadow:  "0 -3px 20px rgba(0,0,0,0.22)",
    transition: "height 0.28s cubic-bezier(0.4,0,0.2,1)",
    overflow:   "hidden",
    background: "white",
    borderTop:  "2px solid #1565C0",
  });

  // ── iframe（popup.htmlを読み込む） ──
  const iframe = document.createElement("iframe");
  iframe.src = chrome.runtime.getURL("popup.html");
  Object.assign(iframe.style, {
    width:   "100%",
    height:  (EXPANDED_H + 60) + "px",
    border:  "none",
    display: "block",
  });

  wrap.appendChild(iframe);

  // ページコンテンツがアンダーバーに隠れないよう余白を追加
  function updateBodyPadding(h) {
    document.body.style.paddingBottom = Math.max(
      parseInt(document.body.style.paddingBottom || "0") - COLLAPSED_H,
      0
    ) + h + "px";
  }
  updateBodyPadding(COLLAPSED_H);

  document.body.appendChild(wrap);

  // ── popup.htmlからのメッセージを受信して高さを制御 ──
  let expanded = false;
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.from !== "aixlinx-underbar") return;

    const action = e.data.action;
    if (action === "expand") {
      expanded = true;
      wrap.style.height = EXPANDED_H + "px";
    } else if (action === "collapse") {
      expanded = false;
      wrap.style.height = COLLAPSED_H + "px";
    } else if (action === "toggle") {
      expanded = !expanded;
      wrap.style.height = (expanded ? EXPANDED_H : COLLAPSED_H) + "px";
    }
  });
})();
