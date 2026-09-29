// chrome-extension/snapshot-popup.js
// 2026-09-29 v2.5.40 小窓の「拡張の版」と「画面の写真」の許可ボタン（popup.html の #snap-perm）。
//   竹内「拡張ツールでひらいているページの画面をみて判断できる事もできるのか？ …画面開いているのも目で見ることができるのが理想」
//   画面の写真（chrome.tabs.captureVisibleTab）には <all_urls> の許可が要る。最初から持たせず（optional_host_permissions）、
//   PC ごとに1回このボタンで許可してもらう。許可が無くても、ページの文字・拡張の状態・ログは送る（background.js _takeSnapshot）。
//   版は 9/29 の件（v2.5.38 で直したのに PC が古い版のまま動いていた）を小窓で見分けるために出す。
(function () {
  "use strict";
  var ORIGINS = { origins: ["<all_urls>"] };

  function el(id) { return document.getElementById(id); }

  function render(granted) {
    var box = el("snap-perm");
    if (!box) return;
    var ver = "";
    try { ver = chrome.runtime.getManifest().version; } catch (_) {}
    el("snap-ver").textContent = "拡張 v" + (ver || "?");
    el("snap-perm-state").textContent = granted ? "📷 画面の写真: 許可済み" : "📷 画面の写真: 未許可（文字だけ送ります）";
    el("snap-perm-btn").style.display = granted ? "none" : "inline-block";
    box.style.display = "flex";
  }

  function refresh() {
    try {
      chrome.permissions.contains(ORIGINS, function (ok) { render(!!ok); });
    } catch (_) { render(false); }
  }

  document.addEventListener("DOMContentLoaded", function () {
    refresh();
    var btn = el("snap-perm-btn");
    if (btn) {
      btn.addEventListener("click", function () {
        // 人のクリックの中で呼ぶ（chrome.permissions.request はユーザー操作が要る）
        try {
          chrome.permissions.request(ORIGINS, function (ok) {
            if (chrome.runtime.lastError) console.warn("[snap] 許可の確認に失敗:", chrome.runtime.lastError.message);
            render(!!ok);
          });
        } catch (e) { console.warn("[snap] 許可の確認に失敗:", e && e.message); }
      });
    }
  });
  try {
    if (chrome.permissions && chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(refresh);
    if (chrome.permissions && chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(refresh);
  } catch (_) {}
  // popup.html の最後で読むので DOMContentLoaded の後の時もある
  if (document.readyState !== "loading") refresh();
})();
