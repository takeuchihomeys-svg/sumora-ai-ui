(function () {
  "use strict";

  var tracked = []; // { cb, btn }
  var injectTimer = null;

  // ── 印刷用PDFボタンを探す ─────────────────────────
  function findPrintBtns() {
    var seen = new Set();
    var results = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (!node.textContent.trim().includes("印刷用PDF")) continue;
      var el = node.parentElement;
      for (var i = 0; i < 6 && el && el !== document.body; i++, el = el.parentElement) {
        if ((el.tagName === "A" || el.tagName === "BUTTON") && !seen.has(el) && el.offsetParent) {
          seen.add(el);
          results.push(el);
          break;
        }
      }
    }
    return results;
  }

  // ── チェックボックス注入 ──────────────────────────
  function inject() {
    document.querySelectorAll(".axlx-cb").forEach(function (el) { el.remove(); });
    tracked = [];
    var btns = findPrintBtns();
    btns.forEach(function (btn) {
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "axlx-cb";
      cb.style.cssText = "width:14px;height:14px;margin-right:3px;cursor:pointer;accent-color:#1565C0;vertical-align:middle;flex-shrink:0;";
      cb.addEventListener("change", updateBar);
      btn.parentNode.insertBefore(cb, btn);
      tracked.push({ cb: cb, btn: btn });
    });
    updateBar();
  }

  // ── フローティングバー ────────────────────────────
  function ensureBar() {
    if (document.getElementById("axlx-bar")) return;
    var bar = document.createElement("div");
    bar.id = "axlx-bar";
    bar.style.cssText = [
      "position:fixed;bottom:24px;right:24px;z-index:2147483647;",
      "background:linear-gradient(135deg,#0d1b3e,#1565C0);",
      "color:white;border-radius:14px;padding:12px 16px;",
      "font-size:13px;font-weight:700;",
      "box-shadow:0 4px 20px rgba(0,0,0,0.4);",
      "display:none;flex-direction:column;gap:8px;min-width:170px;",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;",
    ].join("");
    bar.innerHTML = [
      '<div style="display:flex;align-items:center;gap:6px;">',
      '  <span style="font-size:16px;">📥</span>',
      '  <span id="axlx-count">0件</span>を選択中',
      "</div>",
      '<div style="display:flex;gap:6px;">',
      '  <button id="axlx-all-btn" style="flex:1;padding:6px 4px;background:rgba(255,255,255,0.18);border:none;border-radius:8px;color:white;font-size:11px;font-weight:700;cursor:pointer;">全選択</button>',
      '  <button id="axlx-dl-btn" style="flex:2;padding:6px 8px;background:#ff9800;border:none;border-radius:8px;color:white;font-size:12px;font-weight:700;cursor:pointer;">一括DL</button>',
      "</div>",
    ].join("");
    document.body.appendChild(bar);
    document.getElementById("axlx-all-btn").addEventListener("click", toggleAll);
    document.getElementById("axlx-dl-btn").addEventListener("click", bulkDownload);
  }

  function updateBar() {
    ensureBar();
    var bar = document.getElementById("axlx-bar");
    var checked = tracked.filter(function (t) { return t.cb.checked; });
    bar.style.display = tracked.length > 0 ? "flex" : "none";
    document.getElementById("axlx-count").textContent = checked.length + "件";
    var allBtn = document.getElementById("axlx-all-btn");
    if (allBtn) allBtn.textContent = checked.length === tracked.length && tracked.length > 0 ? "全解除" : "全選択";
  }

  function toggleAll() {
    var checked = tracked.filter(function (t) { return t.cb.checked; });
    var newState = checked.length < tracked.length;
    tracked.forEach(function (t) { t.cb.checked = newState; });
    updateBar();
  }

  function bulkDownload() {
    var targets = tracked.filter(function (t) { return t.cb.checked; });
    if (!targets.length) return;
    var dlBtn = document.getElementById("axlx-dl-btn");
    dlBtn.style.pointerEvents = "none";
    dlBtn.textContent = "DL中...";

    var i = 0;
    function next() {
      if (i >= targets.length) {
        document.getElementById("axlx-count").textContent = "✓ " + targets.length + "件 完了！";
        dlBtn.textContent = "一括DL";
        dlBtn.style.pointerEvents = "auto";
        setTimeout(function () {
          targets.forEach(function (t) { t.cb.checked = false; });
          updateBar();
        }, 2500);
        return;
      }
      document.getElementById("axlx-count").textContent = (i + 1) + "/" + targets.length + " DL中";
      targets[i].btn.click();
      i++;
      setTimeout(next, 1800);
    }
    next();
  }

  // ── MutationObserver（ループ防止付き） ───────────
  var obs = new MutationObserver(function () {
    if (injectTimer) return;
    var btns = findPrintBtns();
    var uninjected = btns.filter(function (b) {
      return !b.previousSibling || !b.previousSibling.classList || !b.previousSibling.classList.contains("axlx-cb");
    });
    if (uninjected.length > 0) {
      injectTimer = setTimeout(function () { inject(); injectTimer = null; }, 400);
    }
  });

  function start() {
    ensureBar();
    setTimeout(inject, 1200);
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
  window.addEventListener("load", function () { setTimeout(inject, 2000); });
})();
