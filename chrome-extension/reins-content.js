(function () {
  "use strict";

  var injected = false;

  function injectPageScript() {
    if (injected) return;
    injected = true;
    try {
      var s = document.createElement("script");
      s.src = chrome.runtime.getURL("reins-page-script.js");
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      injected = false;
    }
  }

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg.type !== "axlx-reins-autofill") return;
      try { injectPageScript(); } catch (e) { return; }
      setTimeout(function () {
        window.dispatchEvent(
          new CustomEvent("axlx-reins-fill", { detail: msg.conditions })
        );
      }, 200);
    });
  }
})();
