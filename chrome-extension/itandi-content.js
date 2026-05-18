(function () {
  "use strict";

  var injected = false;

  function injectPageScript() {
    if (injected) return;
    injected = true;
    var s = document.createElement("script");
    s.src = chrome.runtime.getURL("itandi-page-script.js");
    (document.head || document.documentElement).appendChild(s);
  }

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.type !== "axlx-itandi-autofill") return;
    injectPageScript();
    setTimeout(function () {
      window.dispatchEvent(new CustomEvent("axlx-itandi-fill", { detail: msg.conditions }));
    }, 200);
  });

  // underbar.js経由のpostMessageも受け取る（iframe内でchrome.tabsが使えないため）
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.from !== "aixlinx-itandi-fill") return;
    injectPageScript();
    setTimeout(function () {
      window.dispatchEvent(new CustomEvent("axlx-itandi-fill", { detail: e.data.conditions }));
    }, 200);
  });
})();
