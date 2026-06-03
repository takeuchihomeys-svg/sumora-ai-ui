// itandi BB 物件資料一括PDF取得 → LINE送信
(function () {
  "use strict";

  var tracked = [];
  var injectTimer = null;

  // ── PDF キャプチャ用スクリプトを MAIN world に注入 ─────────────────────
  // URL.createObjectURL (blob) と fetch (直接PDF) の両方をフック
  var pdfHookInjected = false;
  function ensurePdfHook() {
    if (pdfHookInjected) return;
    pdfHookInjected = true;
    var s = document.createElement("script");
    s.textContent = [
      "(function(){",
      "  if (window.__axlxItandiHook) return;",
      "  window.__axlxItandiHook = true;",
      "  // Blob URL フック",
      "  var origCreate = URL.createObjectURL;",
      "  URL.createObjectURL = function(blob) {",
      "    var url = origCreate.call(URL, blob);",
      "    var t = (blob && blob.type) || '';",
      "    if (t.includes('pdf') || t === 'application/octet-stream') {",
      "      var r = new FileReader();",
      "      r.onload = function(e) {",
      "        window.postMessage({ from: 'axlx-itandi-pdf', b64: e.target.result.split(',')[1] }, '*');",
      "      };",
      "      r.readAsDataURL(blob);",
      "    }",
      "    return url;",
      "  };",
      "  // fetch フック (直接 application/pdf を返す場合)",
      "  var origFetch = window.fetch;",
      "  window.fetch = function() {",
      "    var args = arguments;",
      "    return origFetch.apply(this, args).then(function(resp) {",
      "      var ct = resp.headers.get('content-type') || '';",
      "      if (ct.includes('application/pdf')) {",
      "        var clone = resp.clone();",
      "        clone.arrayBuffer().then(function(buf) {",
      "          var bytes = new Uint8Array(buf);",
      "          var ch = [];",
      "          for (var i = 0; i < bytes.length; i += 8192) {",
      "            ch.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i+8192,bytes.length))));",
      "          }",
      "          window.postMessage({ from: 'axlx-itandi-pdf', b64: btoa(ch.join('')) }, '*');",
      "        });",
      "      }",
      "      return resp;",
      "    });",
      "  };",
      "})()",
    ].join("\n");
    (document.head || document.documentElement).appendChild(s);
  }

  // ── 物件資料ボタンを探す ────────────────────────────────────────────────
  // DOM診断結果: P.css-5rqx8z-Label → SPAN.MuiButton-label → BUTTON.MuiButtonBase-root
  //              → SPAN.MuiBadge-root → DIV → DIV.CommonButton → DIV.itandi-bb-ui__Flex
  function findMaterialBtns() {
    var seen = new Set();
    var results = [];

    // P タグのテキストで「物件資料」を探し、親の BUTTON まで遡る
    Array.from(document.querySelectorAll("p")).forEach(function (p) {
      if (!p.textContent.trim().includes("物件資料")) return;
      var el = p.parentElement;
      for (var i = 0; i < 5 && el && el !== document.body; i++, el = el.parentElement) {
        if (el.tagName === "BUTTON" && !seen.has(el) && el.offsetParent) {
          seen.add(el);
          results.push(el);
          break;
        }
      }
    });

    // フォールバック: DIV.CommonButton 内の button
    if (!results.length) {
      Array.from(document.querySelectorAll("div.CommonButton")).forEach(function (div) {
        if (!div.textContent.includes("物件資料")) return;
        var btn = div.querySelector("button");
        if (btn && !seen.has(btn) && btn.offsetParent) {
          seen.add(btn);
          results.push(btn);
        }
      });
    }

    return results;
  }

  // ── チェックボックス注入 ───────────────────────────────────────────────
  // DIV.CommonButton の前に挿入（行の中のボタン群の一番外のコンテナ）
  function inject() {
    document.querySelectorAll(".axlx-itandi-cb").forEach(function (el) { el.remove(); });
    tracked = [];
    findMaterialBtns().forEach(function (btn) {
      // CommonButton ラッパーを探す（挿入位置として使う）
      var container = btn;
      for (var i = 0; i < 4 && container.parentElement && container.parentElement !== document.body; i++) {
        if (container.parentElement.classList && container.parentElement.classList.contains("CommonButton")) {
          container = container.parentElement;
          break;
        }
        container = container.parentElement;
      }

      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "axlx-itandi-cb";
      cb.style.cssText = "width:16px;height:16px;margin-right:6px;cursor:pointer;accent-color:#1565C0;vertical-align:middle;flex-shrink:0;align-self:center;";
      cb.addEventListener("change", updateBar);
      container.parentNode.insertBefore(cb, container);
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

  // ── 1件のPDFをキャプチャ ──────────────────────────────────────────────
  // 物件資料ボタン → モーダル → 間取り図＋写真12枚 → PDFを出力 → blob capture
  function captureOnePdf(btn) {
    return new Promise(function (resolve, reject) {
      var timer;
      var handler = function (e) {
        if (!e.data || e.data.from !== "axlx-itandi-pdf") return;
        clearTimeout(timer);
        window.removeEventListener("message", handler);
        resolve(e.data.b64);
      };
      window.addEventListener("message", handler);
      timer = setTimeout(function () {
        window.removeEventListener("message", handler);
        reject(new Error("PDF取得タイムアウト（30秒）"));
      }, 30000);

      // 物件資料ボタンをクリック
      btn.click();

      sleep(800)
        .then(function () {
          // 「間取り図＋写真12枚」ラベルを探してクリック
          var found = false;
          // label テキストで探す
          Array.from(document.querySelectorAll("label")).forEach(function (lbl) {
            if (!found && lbl.textContent.includes("12枚") && lbl.offsetParent) {
              var inp = lbl.querySelector("input[type='radio']");
              if (!inp && lbl.htmlFor) inp = document.getElementById(lbl.htmlFor);
              if (inp) { inp.click(); } else { lbl.click(); }
              found = true;
            }
          });
          // radio value で探す（ラベルが無い場合）
          if (!found) {
            Array.from(document.querySelectorAll("input[type='radio']")).forEach(function (r) {
              if (!found && (r.value === "12" || r.value.includes("12"))) {
                r.click();
                found = true;
              }
            });
          }
          return sleep(400);
        })
        .then(function () {
          // 「PDFを出力」ボタンをクリック
          var pdfBtns = Array.from(document.querySelectorAll("button")).filter(function (b) {
            return b.textContent.includes("PDFを出力") && b.offsetParent;
          });
          if (!pdfBtns.length) {
            reject(new Error("「PDFを出力」ボタンが見つかりません（モーダルが開いているか確認してください）"));
            return;
          }
          pdfBtns[pdfBtns.length - 1].click();
        });
    });
  }

  // ── モーダルを閉じる（エラー時フォールバック）──────────────────────────
  function closeModal() {
    var selectors = [
      "button[aria-label='Close']",
      "button[aria-label='close']",
      "[class*='close']",
      "[class*='cancel']",
      "button[class*='Cancel']",
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el && el.offsetParent) { el.click(); return; }
    }
    // キャンセルボタン（テキスト）
    Array.from(document.querySelectorAll("button")).forEach(function (b) {
      if (b.textContent.trim() === "キャンセル" && b.offsetParent) b.click();
    });
  }

  // ── LINE送信メイン ─────────────────────────────────────────────────────
  function onSendToLine() {
    var targets = tracked.filter(function (t) { return t.cb.checked; });
    if (!targets.length) { alert("物件を選択してください"); return; }

    var lineBtn = document.getElementById("axlx-itandi-line-btn");
    var lineOrig = lineBtn.textContent;
    lineBtn.disabled = true;
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
          customer_name: null,
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
