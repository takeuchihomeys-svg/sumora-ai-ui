(function () {
  "use strict";

  var injected = false;

  function injectPageScript() {
    if (injected) return;
    injected = true;
    var s = document.createElement("script");
    s.src = chrome.runtime.getURL("reins-page-script.js");
    (document.head || document.documentElement).appendChild(s);
  }

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.type !== "axlx-reins-autofill") return;
    injectPageScript();
    setTimeout(function () {
      window.dispatchEvent(
        new CustomEvent("axlx-reins-fill", { detail: msg.conditions })
      );
    }, 200);
  });
})();
