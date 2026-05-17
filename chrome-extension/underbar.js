"use strict";

// リアプロページにAIXLINX フローティングボタンを注入
// 左上に小さい■ボタン → クリックでパネル展開
(function () {
  if (document.getElementById("aixlinx-float-wrap")) return;

  const MINI     = 52;
  const PANEL_W  = 360;
  const PANEL_H  = 520;

  const wrap = document.createElement("div");
  wrap.id = "aixlinx-float-wrap";
  Object.assign(wrap.style, {
    position:   "fixed",
    top:        "70px",
    left:       "8px",
    width:      MINI + "px",
    height:     MINI + "px",
    zIndex:     "2147483647",
    boxShadow:  "0 4px 24px rgba(0,0,0,0.28)",
    transition: "width 0.25s cubic-bezier(0.4,0,0.2,1), height 0.25s cubic-bezier(0.4,0,0.2,1)",
    overflow:   "hidden",
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

  wrap.appendChild(iframe);
  document.body.appendChild(wrap);

  let expanded = false;
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.from !== "aixlinx-underbar") return;
    const action = e.data.action;
    if (action === "expand") {
      expanded = true;
      wrap.style.width  = PANEL_W + "px";
      wrap.style.height = PANEL_H + "px";
    } else if (action === "collapse") {
      expanded = false;
      wrap.style.width  = MINI + "px";
      wrap.style.height = MINI + "px";
    } else if (action === "toggle") {
      expanded = !expanded;
      wrap.style.width  = (expanded ? PANEL_W : MINI) + "px";
      wrap.style.height = (expanded ? PANEL_H : MINI) + "px";
    }
  });
})();
