// itandi BB 物件資料一括PDF取得 → LINE送信
(function () {
  "use strict";

  var tracked = [];
  var injectTimer = null;

  // ── PDF キャプチャフックを background 経由で MAIN world に注入 ───────────
  // itandi は CSP で <script> タグのインライン注入を禁止しているため
  // chrome.scripting.executeScript(world:"MAIN") で CSP を完全に迂回する
  var pdfHookInjected = false;
  function ensurePdfHook() {
    if (pdfHookInjected) return;
    pdfHookInjected = true;
    chrome.runtime.sendMessage({ type: "axlx-inject-pdf-hook" });
  }

  // ── 物件資料ボタンを探す ────────────────────────────────────────────────
  // DOM診断結果: button.MuiButtonBase-root でテキスト「物件資料」
  function findMaterialBtns() {
    var seen = new Set();
    var results = [];
    Array.from(document.querySelectorAll("button.MuiButtonBase-root")).forEach(function (btn) {
      if (btn.textContent.trim() !== "物件資料") return;
      if (seen.has(btn) || !btn.offsetParent) return;
      seen.add(btn);
      results.push(btn);
    });
    return results;
  }

  // ── チェックボックス注入 ───────────────────────────────────────────────
  // 物件資料ボタンの直前に挿入
  function inject() {
    document.querySelectorAll(".axlx-itandi-cb").forEach(function (el) { el.remove(); });
    tracked = [];
    findMaterialBtns().forEach(function (btn) {
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "axlx-itandi-cb";
      cb.style.cssText = "width:16px;height:16px;margin-right:4px;cursor:pointer;accent-color:#1565C0;vertical-align:middle;flex-shrink:0;";
      cb.addEventListener("change", updateBar);
      btn.parentNode.insertBefore(cb, btn);
      tracked.push({ cb: cb, btn: btn });
    });
    updateBar();
  }

  // ── フローティングバー ──────────────────────────────────────────────────
  function ensureBar() {
    if (document.getElementById("axlx-itandi-bar")) return;
    var bar = document.createElement("div");
    bar.id = "axlx-itandi-bar";
    bar.style.cssText = [
      "position:fixed;bottom:24px;right:24px;z-index:2147483646;",
      "background:linear-gradient(135deg,#0d1b3e,#1565C0);",
      "color:white;border-radius:14px;padding:12px 16px;",
      "font-size:13px;font-weight:700;display:none;",
      "flex-direction:column;gap:8px;min-width:200px;",
      "box-shadow:0 4px 20px rgba(0,0,0,0.4);",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;",
    ].join("");
    bar.innerHTML = [
      '<div style="display:flex;align-items:center;gap:6px;">',
      '  <span id="axlx-itandi-count">0件</span>を選択中',
      "</div>",
      '<div style="display:flex;gap:6px;">',
      '  <button id="axlx-itandi-all-btn" style="flex:1;padding:6px 4px;background:rgba(255,255,255,0.18);border:none;border-radius:8px;color:white;font-size:11px;font-weight:700;cursor:pointer;">全選択</button>',
      '  <button id="axlx-itandi-line-btn" style="flex:2;padding:6px 8px;background:#06c755;border:none;border-radius:8px;color:white;font-size:12px;font-weight:700;cursor:pointer;">📤 売上番長に送る</button>',
      "</div>",
    ].join("");
    document.body.appendChild(bar);
    document.getElementById("axlx-itandi-all-btn").addEventListener("click", toggleAll);
    document.getElementById("axlx-itandi-line-btn").addEventListener("click", onSendToLine);
  }

  function updateBar() {
    ensureBar();
    var bar = document.getElementById("axlx-itandi-bar");
    var checked = tracked.filter(function (t) { return t.cb.checked; });
    bar.style.display = tracked.length > 0 ? "flex" : "none";
    var countEl = document.getElementById("axlx-itandi-count");
    if (countEl) countEl.textContent = checked.length + "件";
    var allBtn = document.getElementById("axlx-itandi-all-btn");
    if (allBtn) allBtn.textContent = (checked.length === tracked.length && tracked.length > 0) ? "全解除" : "全選択";
  }

  function toggleAll() {
    var checked = tracked.filter(function (t) { return t.cb.checked; });
    var s = checked.length < tracked.length;
    tracked.forEach(function (t) { t.cb.checked = s; });
    updateBar();
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // backdrop があると offsetParent=null になるため getBoundingClientRect で可視判定
  function isVis(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // ── 1件のPDFをキャプチャ ──────────────────────────────────────────────
  // 物件資料クリック → MutationObserverでモーダル検知 → 12枚選択 → PDFを出力
  function captureOnePdf(btn) {
    return new Promise(function (resolve, reject) {
      var pdfTimer;
      var obs = null;

      function cleanup() {
        clearTimeout(pdfTimer);
        window.removeEventListener("message", pdfHandler);
        if (obs) { obs.disconnect(); obs = null; }
      }

      var pdfHandler = function (e) {
        if (!e.data || e.data.from !== "axlx-itandi-pdf") return;
        cleanup();
        resolve(e.data.b64);
      };
      window.addEventListener("message", pdfHandler);
      pdfTimer = setTimeout(function () {
        cleanup();
        reject(new Error("タイムアウト（30秒）: モーダルが開かないかPDFが生成されませんでした"));
      }, 30000);

      function interactWithModal() {
        // 「間取り図＋写真12枚」ラベルを選択（getBoundingClientRect で可視チェック）
        var labels = Array.from(document.querySelectorAll("label")).filter(function (l) {
          return l.textContent.includes("12枚") && isVis(l);
        });
        if (labels.length) {
          var lbl = labels[labels.length - 1];
          var radio = lbl.querySelector("input[type='radio']");
          if (radio) { radio.click(); } else { lbl.click(); }
        }
        sleep(300).then(function () {
          // 「PDFを出力」ボタンをクリック
          var pdfBtns = Array.from(document.querySelectorAll("button")).filter(function (b) {
            return b.textContent.trim().includes("PDFを出力") && isVis(b);
          });
          if (pdfBtns.length) {
            pdfBtns[pdfBtns.length - 1].click();
          } else {
            cleanup();
            reject(new Error("「PDFを出力」ボタンが見つかりません"));
          }
        });
      }

      // 物件資料ボタンをクリック
      btn.click();

      // MutationObserver で「PDFを出力」ボタンの出現を検知
      obs = new MutationObserver(function () {
        var appeared = Array.from(document.querySelectorAll("button")).some(function (b) {
          return b.textContent.trim().includes("PDFを出力") && isVis(b);
        });
        if (!appeared) return;
        obs.disconnect();
        obs = null;
        setTimeout(interactWithModal, 300);
      });
      obs.observe(document.body, { childList: true, subtree: true });
    });
  }

  // ── モーダルを閉じる（エラー時）─────────────────────────────────────────
  // 診断結果: aria-label="閉じる" が正解
  function closeModal() {
    var closeBtn = document.querySelector("button[aria-label='閉じる']");
    if (closeBtn && isVis(closeBtn)) { closeBtn.click(); return; }
    Array.from(document.querySelectorAll("button")).forEach(function (b) {
      if ((b.textContent.trim() === "キャンセル" || b.textContent.trim() === "閉じる") && isVis(b)) {
        b.click();
      }
    });
  }

  // ── popup.js からお客さん名を取得（underbar.js 中継）────────────────────
  function getCustomerFromPopup(callback) {
    var timer;
    var handler = function (e) {
      if (!e.data || e.data.from !== "axlx-customer-response") return;
      clearTimeout(timer);
      window.removeEventListener("message", handler);
      callback(e.data.name || null);
    };
    window.addEventListener("message", handler);
    window.postMessage({ from: "axlx-get-customer" }, "*");
    timer = setTimeout(function () {
      window.removeEventListener("message", handler);
      callback(null);
    }, 800);
  }

  // ── LINE送信メイン ─────────────────────────────────────────────────────
  function onSendToLine() {
    var targets = tracked.filter(function (t) { return t.cb.checked; });
    if (!targets.length) { alert("物件を選択してください"); return; }

    var lineBtn = document.getElementById("axlx-itandi-line-btn");
    var lineOrig = lineBtn.textContent;
    lineBtn.disabled = true;
    lineBtn.textContent = "準備中...";

    // お客さん名を取得してから処理開始
    getCustomerFromPopup(function (customerName) {
      startSend(targets, customerName, lineBtn, lineOrig);
    });
  }

  function startSend(targets, customerName, lineBtn, lineOrig) {
    lineBtn.textContent = "PDF取得中... (0/" + targets.length + ")";

    var pdfBase64List = [];

    function processNext(i) {
      if (i >= targets.length) {
        // 全件取得完了 → LINE送信
        if (!pdfBase64List.length) {
          alert("PDFが1件も取得できませんでした");
          lineBtn.disabled = false;
          lineBtn.textContent = lineOrig;
          return;
        }
        lineBtn.textContent = "LINE送信中...";
        var today = new Date().toLocaleDateString("ja-JP").replace(/\//g, "-");
        chrome.runtime.sendMessage({
          type: "axlx-send-pdf-data-to-line",
          pdf_data: pdfBase64List,
          file_name: "物件まとめ_" + today + ".pdf",
          customer_name: customerName || null,
          property_summaries: null,
        }, function (resp) {
          lineBtn.disabled = false;
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            alert("LINE送信エラー:\n" + (resp ? resp.error : (chrome.runtime.lastError ? chrome.runtime.lastError.message : "不明")));
            lineBtn.textContent = lineOrig;
            return;
          }
          lineBtn.textContent = "✅ " + pdfBase64List.length + "件 LINE送信完了！";
          setTimeout(function () { lineBtn.textContent = lineOrig; }, 5000);
        });
        return;
      }

      lineBtn.textContent = "PDF取得中... (" + (i + 1) + "/" + targets.length + ")";
      captureOnePdf(targets[i].btn)
        .then(function (b64) {
          pdfBase64List.push(b64);
          return sleep(1200);
        })
        .then(function () { processNext(i + 1); })
        .catch(function (e) {
          console.error("[AXLX itandi] PDF取得失敗 " + (i + 1) + "件目:", e.message);
          closeModal();
          sleep(600).then(function () { processNext(i + 1); });
        });
    }

    processNext(0);
  }

  // ── MutationObserver ─────────────────────────────────────────────────
  var obs = new MutationObserver(function () {
    if (injectTimer) return;
    var btns = findMaterialBtns();
    var uninj = btns.filter(function (b) {
      return !b.previousSibling || !(b.previousSibling.classList && b.previousSibling.classList.contains("axlx-itandi-cb"));
    });
    if (uninj.length > 0) {
      injectTimer = setTimeout(function () { inject(); injectTimer = null; }, 400);
    }
  });

  function start() {
    ensureBar();
    ensurePdfHook();
    setTimeout(inject, 1500);
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
  window.addEventListener("load", function () { setTimeout(inject, 2500); });
})();
