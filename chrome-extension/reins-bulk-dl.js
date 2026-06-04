(function () {
  "use strict";

  var tracked    = [];
  var injectTimer = null;
  var checkedKeys = new Set();
  var isSending   = false;

  function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  // ── 物件行を取得 ────────────────────────────────────────────────────
  function findResultRows() {
    return Array.from(document.querySelectorAll(".p-table-body-row"))
      .filter(function (row) { return row.offsetParent !== null; });
  }

  // ── 行テキストから物件情報を抽出 ─────────────────────────────────────
  function extractInfo(row) {
    var text = row.textContent.replace(/\s+/g, " ").trim();

    // 建物名（階数の直前にあるカタカナ・漢字混じりテキスト）
    var buildingM = text.match(/([ァ-ヶー一-龯A-Za-zA-Za-z0-9][ァ-ヶー一-龯A-Za-zA-Za-z0-9・ー\s]{1,20}?)\s+\d+階/);
    var building  = buildingM ? buildingM[1].trim() : null;

    // 賃料（例: 7.9万円）
    var rentM = text.match(/(\d+\.?\d*万円)/);
    var rent  = rentM ? rentM[1] : null;

    // 間取り（例: 2LDK）
    var madoriM = text.match(/([1-9](?:R|K|DK|LDK|SLDK|SDK|LK|SLK))/);
    var madori  = madoriM ? madoriM[0] : null;

    return { building: building, rent: rent, madori: madori };
  }

  function makeRowKey(row) {
    return row.textContent.replace(/\s+/g, " ").trim().slice(0, 60);
  }

  // ── チェックボックス注入 ────────────────────────────────────────────
  function inject() {
    tracked.forEach(function (t) {
      if (t.cb.checked) checkedKeys.add(t.rowKey);
      else              checkedKeys.delete(t.rowKey);
    });
    document.querySelectorAll(".axlx-reins-cb").forEach(function (el) { el.remove(); });
    tracked = [];

    findResultRows().forEach(function (row) {
      var rowKey    = makeRowKey(row);
      var firstItem = row.querySelector(".p-table-body-item");
      if (!firstItem) return;

      var cb = document.createElement("input");
      cb.type      = "checkbox";
      cb.className = "axlx-reins-cb";
      cb.style.cssText = [
        "width:16px;height:16px;cursor:pointer;vertical-align:middle;",
        "accent-color:#1565C0;flex-shrink:0;display:block;margin:2px auto;",
      ].join("");
      cb.checked = checkedKeys.has(rowKey);
      cb.addEventListener("click",  function (e) { e.stopPropagation(); });
      cb.addEventListener("change", function (e) { e.stopPropagation(); updateBar(); });
      firstItem.insertBefore(cb, firstItem.firstChild);

      var detailBtn = Array.from(row.querySelectorAll("button")).find(function (b) {
        return b.textContent.trim() === "詳細";
      });
      tracked.push({ cb: cb, row: row, detailBtn: detailBtn, rowKey: rowKey });
    });

    updateBar();
  }

  // ── フローティングバー ──────────────────────────────────────────────
  function ensureBar() {
    if (document.getElementById("axlx-reins-bar")) return;
    var bar = document.createElement("div");
    bar.id = "axlx-reins-bar";
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
      '  <span id="axlx-reins-count">0件</span>を選択中',
      "</div>",
      '<div style="display:flex;gap:6px;">',
      '  <button id="axlx-reins-all-btn" style="flex:1;padding:6px 4px;background:rgba(255,255,255,0.18);border:none;border-radius:8px;color:white;font-size:11px;font-weight:700;cursor:pointer;">全選択</button>',
      '  <button id="axlx-reins-line-btn" style="flex:2;padding:6px 8px;background:#06c755;border:none;border-radius:8px;color:white;font-size:12px;font-weight:700;cursor:pointer;">📤 売上番長に送る</button>',
      "</div>",
    ].join("");
    document.body.appendChild(bar);
    document.getElementById("axlx-reins-all-btn").addEventListener("click", toggleAll);
    document.getElementById("axlx-reins-line-btn").addEventListener("click", onSendToLine);
  }

  function updateBar() {
    ensureBar();
    var bar     = document.getElementById("axlx-reins-bar");
    var checked = tracked.filter(function (t) { return t.cb.checked; });
    bar.style.display = tracked.length > 0 ? "flex" : "none";
    document.getElementById("axlx-reins-count").textContent = checked.length + "件";
    var allBtn = document.getElementById("axlx-reins-all-btn");
    if (allBtn) allBtn.textContent = (checked.length === tracked.length && tracked.length > 0) ? "全解除" : "全選択";
  }

  function toggleAll() {
    var checked  = tracked.filter(function (t) { return t.cb.checked; });
    var newState = checked.length < tracked.length;
    tracked.forEach(function (t) { t.cb.checked = newState; });
    updateBar();
  }

  // ── popup.jsからお客さん名取得 ─────────────────────────────────────
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

  // ── LINE送信エントリ ───────────────────────────────────────────────
  function onSendToLine() {
    if (isSending) return;
    var targets = tracked.filter(function (t) { return t.cb.checked; });
    if (!targets.length) { alert("物件を選択してください"); return; }

    var lineBtn  = document.getElementById("axlx-reins-line-btn");
    var lineOrig = lineBtn.textContent;
    lineBtn.disabled  = true;
    lineBtn.textContent = "準備中...";
    getCustomerFromPopup(function (customerName) {
      startSend(targets, customerName, lineBtn, lineOrig);
    });
  }

  // ── 送信メイン ────────────────────────────────────────────────────
  function startSend(targets, customerName, lineBtn, lineOrig) {
    isSending = true;

    // PDF Blob キャプチャフックを注入（background.js → MAIN world）
    chrome.runtime.sendMessage({ type: "axlx-inject-pdf-hook" }, function () {

      // 物件サマリー（先に生成しておく）
      var propertySummaries = targets.map(function (t, i) {
        var info  = extractInfo(t.row);
        var lines = ["【" + (i + 1) + "】" + (info.building || "物件" + (i + 1))];
        if (info.rent)   lines.push("賃料: " + info.rent);
        if (info.madori) lines.push("間取: " + info.madori);
        return lines.join("\n");
      });

      lineBtn.textContent = "PDF取得中... (0/" + targets.length + ")";
      var pdfBase64List   = [];

      function processNext(i) {
        if (i >= targets.length) {
          // ─ 全件完了 → Blobアップ → merge → LINE送信 ─
          if (!pdfBase64List.length) {
            alert("PDFが1件も取得できませんでした");
            lineBtn.disabled    = false;
            lineBtn.textContent = lineOrig;
            isSending           = false;
            return;
          }
          lineBtn.textContent = "Blobアップ中... (1/" + pdfBase64List.length + ")";
          var today = new Date().toLocaleDateString("ja-JP").replace(/\//g, "-");
          chrome.runtime.sendMessage({
            type:               "axlx-send-pdf-data-to-line",
            pdf_data:           pdfBase64List,
            file_name:          "物件まとめ_" + today + ".pdf",
            customer_name:      customerName || null,
            property_summaries: propertySummaries,
          }, function (resp) {
            lineBtn.disabled = false;
            isSending        = false;
            if (chrome.runtime.lastError || !resp || !resp.ok) {
              var err = resp ? resp.error : (chrome.runtime.lastError ? chrome.runtime.lastError.message : "不明");
              alert("LINE送信エラー:\n" + err);
              lineBtn.textContent = lineOrig;
              return;
            }
            targets.forEach(function (t) {
              t.cb.checked = false;
              checkedKeys.delete(t.rowKey);
            });
            updateBar();
            lineBtn.textContent = "✅ " + pdfBase64List.length + "件 LINE送信完了！";
            setTimeout(function () { lineBtn.textContent = lineOrig; }, 5000);
          });
          return;
        }

        lineBtn.textContent = "PDF取得中... (" + (i + 1) + "/" + targets.length + ")";

        // rowKeyで最新のDOMから該当行を再検索（SPA再レンダリング対応）
        var rowKey  = targets[i].rowKey;
        var freshRow = findResultRows().find(function (r) { return makeRowKey(r) === rowKey; });
        var freshBtn = freshRow
          ? Array.from(freshRow.querySelectorAll("button")).find(function (b) {
              return b.textContent.trim() === "詳細";
            })
          : targets[i].detailBtn;

        captureOnePdf({ row: freshRow || targets[i].row, detailBtn: freshBtn, rowKey: rowKey })
          .then(function (b64) {
            console.log("[AX-REINS] PDF取得成功 " + (i + 1) + "件目 (" + Math.round(b64.length / 1024) + "KB)");
            pdfBase64List.push(b64);
            return sleep(500);
          })
          .then(function () { processNext(i + 1); })
          .catch(function (e) {
            console.error("[AX-REINS] PDF取得失敗 " + (i + 1) + "件目:", e.message);
            sleep(800).then(function () { processNext(i + 1); });
          });
      }

      processNext(0);
    });
  }

  // ── 1件のPDF取得 ──────────────────────────────────────────────────
  // 詳細ボタンをクリック → SPAが詳細ページに遷移 → 印刷/PDFボタンをクリック
  // → background.jsのBlobフックがPDFをキャプチャ → history.back()で戻る
  function captureOnePdf(target) {
    return new Promise(function (resolve, reject) {
      if (!target.detailBtn) { reject(new Error("詳細ボタンなし")); return; }

      var captureStart = Date.now();
      var resolved     = false;
      var pdfHandler   = null;
      var detailObs    = null;
      var backObs      = null;

      var timer = setTimeout(function () {
        cleanup();
        reject(new Error("タイムアウト（40秒）"));
      }, 40000);

      function cleanup() {
        clearTimeout(timer);
        if (detailObs) { detailObs.disconnect(); detailObs = null; }
        if (backObs)   { backObs.disconnect();   backObs   = null; }
        if (pdfHandler) window.removeEventListener("message", pdfHandler);
      }

      // PDF Blob受信ハンドラ
      pdfHandler = function (e) {
        if (!e.data || e.data.from !== "axlx-itandi-pdf") return;
        if (typeof e.data.ts === "number" && e.data.ts < captureStart) return;
        if (resolved) return;
        resolved = true;
        var b64 = e.data.b64;
        cleanup();

        // history.back()で結果ページへ戻る → .p-table-body復活を待ってresolve
        history.back();
        backObs = new MutationObserver(function () {
          if (document.querySelector(".p-table-body")) {
            backObs.disconnect(); backObs = null;
            setTimeout(function () { resolve(b64); }, 600);
          }
        });
        backObs.observe(document.body, { childList: true, subtree: true });
      };
      window.addEventListener("message", pdfHandler);

      // 詳細ページ出現を監視
      // .p-table-body が消えたら詳細ページと判断し、印刷/PDF系ボタンを探す
      var printClicked = false;
      detailObs = new MutationObserver(function () {
        if (printClicked || resolved) return;
        if (document.querySelector(".p-table-body")) return; // まだ結果ページ

        // 詳細ページで印刷/PDF系ボタンを探す
        var printBtn = Array.from(document.querySelectorAll("button")).find(function (b) {
          return /印刷|物件票|帳票|PDF|プリント/.test(b.textContent.trim()) && b.offsetParent;
        });
        if (printBtn) {
          printClicked = true;
          console.log("[AX-REINS] 印刷ボタン発見:", printBtn.textContent.trim());
          window.postMessage({ from: "axlx-start-pdf-capture" }, "*");
          setTimeout(function () { printBtn.click(); }, 400);
        }
      });
      detailObs.observe(document.body, { childList: true, subtree: true });

      // 詳細ボタンをクリック（SPA遷移開始）
      target.detailBtn.click();
    });
  }

  // ── MutationObserverで結果ページ復帰時に再注入 ─────────────────────
  var mutObs = new MutationObserver(function () {
    if (injectTimer || isSending) return;
    injectTimer = setTimeout(function () {
      injectTimer = null;
      var rows    = findResultRows();
      var cbCount = document.querySelectorAll(".axlx-reins-cb").length;
      if (rows.length > 0 && cbCount !== rows.length) inject();
    }, 800);
  });
  mutObs.observe(document.body, { childList: true, subtree: true });

  // 初回注入
  inject();
})();
