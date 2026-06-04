(function () {
  "use strict";

  var tracked     = [];
  var injectTimer = null;
  var checkedKeys = new Set();
  var isSending   = false;

  function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  // ── 物件行を取得 ─────────────────────────────────────────────────────
  function findResultRows() {
    return Array.from(document.querySelectorAll(".p-table-body-row"))
      .filter(function (row) { return row.offsetParent !== null; });
  }

  // ── 行テキストから物件情報を抽出 ──────────────────────────────────────
  function extractInfo(row) {
    var text = row.textContent.replace(/\s+/g, " ").trim();
    var buildingM = text.match(/([ァ-ヶー一-龯A-Za-zA-Za-z0-9][ァ-ヶー一-龯A-Za-zA-Za-z0-9・ー\s]{1,20}?)\s+\d+階/);
    var building  = buildingM ? buildingM[1].trim() : null;
    var rentM     = text.match(/(\d+\.?\d*万円)/);
    var rent      = rentM ? rentM[1] : null;
    var madoriM   = text.match(/([1-9](?:R|K|DK|LDK|SLDK|SDK|LK|SLK))/);
    var madori    = madoriM ? madoriM[0] : null;
    return { building: building, rent: rent, madori: madori };
  }

  function makeRowKey(row) {
    return row.textContent.replace(/\s+/g, " ").trim().slice(0, 60);
  }

  // ── チェックボックスを図面ボタンの右側に注入 ────────────────────────────
  function inject() {
    tracked.forEach(function (t) {
      if (t.cb.checked) checkedKeys.add(t.rowKey);
      else              checkedKeys.delete(t.rowKey);
    });
    document.querySelectorAll(".axlx-reins-cb").forEach(function (el) { el.remove(); });
    tracked = [];

    findResultRows().forEach(function (row) {
      // 「図面」ボタン
      var zumenBtn = Array.from(row.querySelectorAll("button")).find(function (b) {
        return b.textContent.trim() === "図面" && b.offsetParent;
      });
      if (!zumenBtn) return;

      // 間取りセル = 「概要」ボタンのセルの1つ前のセル
      var gaiyoBtn  = Array.from(row.querySelectorAll("button")).find(function (b) {
        return b.textContent.trim() === "概要";
      });
      var gaiyoCell = gaiyoBtn && gaiyoBtn.closest(".p-table-body-item");
      var allCells  = Array.from(row.querySelectorAll(".p-table-body-item"));
      var gaiyoIdx  = allCells.indexOf(gaiyoCell);
      var madoriCell = gaiyoIdx >= 1 ? allCells[gaiyoIdx - 1] : null;
      if (!madoriCell) return; // 間取セルが見つからなければスキップ

      var rowKey = makeRowKey(row);

      var cb = document.createElement("input");
      cb.type      = "checkbox";
      cb.className = "axlx-reins-cb";
      cb.style.cssText = [
        "width:16px;height:16px;cursor:pointer;",
        "accent-color:#1565C0;vertical-align:middle;",
        "margin-left:4px;flex-shrink:0;",
      ].join("");
      cb.checked = checkedKeys.has(rowKey);
      cb.addEventListener("click",  function (e) { e.stopPropagation(); });
      cb.addEventListener("change", function (e) { e.stopPropagation(); updateBar(); });

      // 間取りセルの末尾（2LDKテキストの右側）に追加
      madoriCell.appendChild(cb);

      tracked.push({ cb: cb, row: row, zumenBtn: zumenBtn, rowKey: rowKey });
    });

    updateBar();
  }

  // ── フローティングバー ────────────────────────────────────────────────
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
    document.getElementById("axlx-reins-all-btn").addEventListener("click",  toggleAll);
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

  // ── popup.jsからお客さん名取得 ──────────────────────────────────────
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

  // ── LINE送信エントリ ─────────────────────────────────────────────────
  function onSendToLine() {
    if (isSending) return;
    var targets = tracked.filter(function (t) { return t.cb.checked; });
    if (!targets.length) { alert("物件を選択してください"); return; }

    var lineBtn  = document.getElementById("axlx-reins-line-btn");
    var lineOrig = lineBtn.textContent;
    lineBtn.disabled    = true;
    lineBtn.textContent = "準備中...";
    getCustomerFromPopup(function (customerName) {
      startSend(targets, customerName, lineBtn, lineOrig);
    });
  }

  // ── ネイティブチェックボックスを取得（レインズの行左端）─────────────────
  function findNativeCheckbox(row) {
    var cells = Array.from(row.querySelectorAll(".p-table-body-item"));
    if (cells.length) {
      var cb = cells[0].querySelector('input[type="checkbox"]');
      if (cb) return cb;
    }
    return Array.from(row.querySelectorAll('input[type="checkbox"]')).find(function (c) {
      return !c.classList.contains("axlx-reins-cb");
    }) || null;
  }

  // ── 図面一括取得ボタンを取得 ─────────────────────────────────────────
  function findBatchBtn() {
    return Array.from(document.querySelectorAll("button")).find(function (b) {
      return b.textContent.trim().includes("図面一括取得") && b.offsetParent;
    }) || null;
  }

  // ── LINE送信共通ロジック ─────────────────────────────────────────────
  function sendAllToLine(pdfBase64List, targets, customerName, propertySummaries, lineBtn, lineOrig) {
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
  }

  // ── 一括取得モード（図面一括取得ボタンを使用・高速並列）─────────────────
  // レインズの「図面一括取得」が複数の新タブを開くのをbackground.jsが一括キャプチャ
  function startBatchSend(targets, customerName, lineBtn, lineOrig, propertySummaries) {
    var expectedCount = targets.length;
    var pdfBase64List = [];
    var batchHandler  = null;
    var batchTimer    = null;

    function finish() {
      if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
      window.removeEventListener("message", batchHandler);
      sendAllToLine(pdfBase64List, targets, customerName, propertySummaries, lineBtn, lineOrig);
    }

    // 各タブのPDFを受け取る（background.js → axlx-reins-pdf-captured → postMessage → ここ）
    batchHandler = function (e) {
      if (!e.data || e.data.from !== "axlx-itandi-pdf") return;
      pdfBase64List.push(e.data.b64);
      lineBtn.textContent = "PDF取得中... (" + pdfBase64List.length + "/" + expectedCount + ")";
      console.log("[AX-REINS] 一括: " + pdfBase64List.length + "/" + expectedCount + " 件取得");
      if (pdfBase64List.length >= expectedCount) finish();
    };
    window.addEventListener("message", batchHandler);

    // タイムアウト（1件あたり30秒・取得できた分だけ送信）
    batchTimer = setTimeout(function () {
      console.warn("[AX-REINS] 一括タイムアウト: " + pdfBase64List.length + "/" + expectedCount + " 件取得済み");
      finish();
    }, Math.max(expectedCount * 30000, 60000));

    // Step1: レインズの行ネイティブCBをONにする
    var checked = 0;
    targets.forEach(function (t) {
      var nativeCb = findNativeCheckbox(t.row);
      if (nativeCb && !nativeCb.checked) {
        nativeCb.click();
        checked++;
      } else if (nativeCb && nativeCb.checked) {
        checked++;
      }
    });
    console.log("[AX-REINS] ネイティブCB: " + checked + "/" + expectedCount + " にチェック");

    sleep(400).then(function () {
      // Step2: フック注入 + 新タブ一括監視開始
      chrome.runtime.sendMessage({ type: "axlx-inject-pdf-hook" }, function () {
        chrome.runtime.sendMessage({ type: "axlx-reins-watch-tab" }, function () {
          var batchBtn = findBatchBtn();
          if (!batchBtn) {
            console.warn("[AX-REINS] 図面一括取得ボタンなし → 逐次モードへフォールバック");
            window.removeEventListener("message", batchHandler);
            clearTimeout(batchTimer);
            startSequentialSend(targets, customerName, lineBtn, lineOrig, propertySummaries);
            return;
          }
          lineBtn.textContent = "PDF取得中... (0/" + expectedCount + ")";
          console.log("[AX-REINS] 図面一括取得クリック");
          batchBtn.click();
        });
      });
    });
  }

  // ── 逐次取得モード（フォールバック：図面ボタンを1件ずつクリック）────────
  function startSequentialSend(targets, customerName, lineBtn, lineOrig, propertySummaries) {
    chrome.runtime.sendMessage({ type: "axlx-inject-pdf-hook" }, function () {
      lineBtn.textContent = "図面取得中... (0/" + targets.length + ")";
      var pdfBase64List   = [];

      function processNext(i) {
        if (i >= targets.length) {
          sendAllToLine(pdfBase64List, targets, customerName, propertySummaries, lineBtn, lineOrig);
          return;
        }
        lineBtn.textContent = "図面取得中... (" + (i + 1) + "/" + targets.length + ")";
        captureOnePdf(targets[i]).then(function (b64) {
          console.log("[AX-REINS] 図面取得成功 " + (i + 1) + "件目 (" + Math.round(b64.length / 1024) + "KB)");
          pdfBase64List.push(b64);
          return sleep(1500);
        }).then(function () {
          processNext(i + 1);
        }).catch(function (e) {
          console.error("[AX-REINS] 図面取得失敗 " + (i + 1) + "件目:", e.message);
          sleep(800).then(function () { processNext(i + 1); });
        });
      }

      processNext(0);
    });
  }

  // ── 送信メイン（一括 or 逐次を自動選択）────────────────────────────────
  function startSend(targets, customerName, lineBtn, lineOrig) {
    isSending = true;

    var propertySummaries = targets.map(function (t, i) {
      var info  = extractInfo(t.row);
      var lines = ["【" + (i + 1) + "】" + (info.building || "物件" + (i + 1))];
      if (info.rent)   lines.push("賃料: " + info.rent);
      if (info.madori) lines.push("間取: " + info.madori);
      return lines.join("\n");
    });

    // 図面一括取得ボタンがあれば一括モード（高速・並列）
    if (findBatchBtn()) {
      startBatchSend(targets, customerName, lineBtn, lineOrig, propertySummaries);
    } else {
      startSequentialSend(targets, customerName, lineBtn, lineOrig, propertySummaries);
    }
  }

  // ── 開いているビューワー（モーダル・ダイアログ等）を閉じる ──────────────
  // 注意: Escape を無条件に送るとレインズのページナビゲーションが起きるため
  // 明示的な閉じるボタン OR role=dialog が検出された場合のみ Escape を送る
  function closeViewer() {
    var closeBtn = Array.from(document.querySelectorAll("button")).find(function (b) {
      return /^[×✕✗]$|^閉じる$|^close$|^Close$/i.test(b.textContent.trim()) && b.offsetParent;
    });
    if (closeBtn) { closeBtn.click(); return; }
    var ariaClose = document.querySelector(
      "[aria-label='閉じる'],[aria-label='close'],[aria-label='Close']"
    );
    if (ariaClose) { ariaClose.click(); return; }
    // モーダルが確認できた場合のみ Escape（無条件dispatch禁止 = ページ遷移防止）
    if (document.querySelector('[role="dialog"],[aria-modal="true"]')) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      document.dispatchEvent(new KeyboardEvent("keyup",   { key: "Escape", bubbles: true }));
    }
  }

  // ── 結果行が見えるようになるまで待つ（最大maxMs ms）───────────────────
  function waitForRows(callback, maxMs) {
    var start    = Date.now();
    var interval = setInterval(function () {
      if (findResultRows().length > 0 || Date.now() - start > maxMs) {
        clearInterval(interval);
        setTimeout(callback, 300);
      }
    }, 200);
  }

  // ── 1件の図面PDF取得 ─────────────────────────────────────────────────
  // 流れ: ①ビューワーを閉じて行が見えるのを確認 → ②フック再注入（SPA遷移対策） →
  //       ③postMessage送信 → ④少し待ってからクリック（MAINワールドの処理待ち） →
  //       ⑤Blobキャプチャ → ⑥ビューワーを閉じて次の行が見える状態に戻す
  function captureOnePdf(target) {
    return new Promise(function (resolve, reject) {
      // まず前回のビューワーを閉じ、行が復活するのを待ってからクリック
      closeViewer();

      waitForRows(function () {
        // 毎件フックを再注入（レインズがSPA遷移でMAINワールド状態をリセットする場合に対応）
        console.log("[AX-REINS] フック注入開始:", target.rowKey.slice(0, 25));
        chrome.runtime.sendMessage({ type: "axlx-inject-pdf-hook" }, function (resp) {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            console.error("[AX-REINS] フック注入失敗:", chrome.runtime.lastError?.message || resp?.error);
            reject(new Error("フック注入失敗"));
            return;
          }
          console.log("[AX-REINS] フック注入OK");
          var captureStart   = Date.now();
          var pdfHandler     = null;
          var customEvtHdlr  = null;
          var doneCalled     = false; // 二重呼び出し防止
          var reinjTimer     = null;  // 動的iframe対応の定期再注入タイマー

          var timer = setTimeout(function () {
            window.removeEventListener("message", pdfHandler);
            document.removeEventListener("axlx-pdf-ready", customEvtHdlr);
            if (reinjTimer) { clearInterval(reinjTimer); reinjTimer = null; }
            closeViewer();
            reject(new Error("タイムアウト（30秒）"));
          }, 30000);

          function done(b64) {
            if (doneCalled) return; // 両チャネルから同時に受信した場合の重複防止
            doneCalled = true;
            clearTimeout(timer);
            if (reinjTimer) { clearInterval(reinjTimer); reinjTimer = null; }
            window.removeEventListener("message", pdfHandler);
            document.removeEventListener("axlx-pdf-ready", customEvtHdlr);
            closeViewer();
            // レインズのDOM安定化を待ってから行の確認（新タブ閉鎖後のSPA再描画を考慮）
            sleep(600).then(function () {
              waitForRows(function () { resolve(b64); }, 3000);
            });
          }

          // 方法1: window.postMessage（itandiと同じ）
          pdfHandler = function (e) {
            if (!e.data || e.data.from !== "axlx-itandi-pdf") return;
            if (typeof e.data.ts === "number" && e.data.ts < captureStart) return;
            console.log("[AX-REINS] window.message受信 → done()");
            done(e.data.b64);
          };
          window.addEventListener("message", pdfHandler);

          // 方法2: document CustomEvent（window messageが止められる場合のフォールバック）
          customEvtHdlr = function (e) {
            if (!e.detail || e.detail.from !== "axlx-itandi-pdf") return;
            if (typeof e.detail.ts === "number" && e.detail.ts < captureStart) return;
            console.log("[AX-REINS] CustomEvent受信 → done()");
            done(e.detail.b64);
          };
          document.addEventListener("axlx-pdf-ready", customEvtHdlr);

          // postMessage送信 → MAINワールドが処理するまで少し待ってからクリック
          // （同期的にクリックするとcapturePendingがfalseのままfetchが走る場合がある）
          window.postMessage({ from: "axlx-start-pdf-capture" }, "*");

          setTimeout(function () {
            // offsetParentフィルタなしでrowを探す（ビューワーに覆われていても取得）
            var freshRow = Array.from(document.querySelectorAll(".p-table-body-row"))
              .find(function (r) { return makeRowKey(r) === target.rowKey; });
            var freshBtn = freshRow
              ? Array.from(freshRow.querySelectorAll("button")).find(function (b) {
                  return b.textContent.trim() === "図面";
                })
              : target.zumenBtn;

            if (!freshBtn) {
              clearTimeout(timer);
              if (reinjTimer) { clearInterval(reinjTimer); reinjTimer = null; }
              window.removeEventListener("message", pdfHandler);
              reject(new Error("図面ボタンが見つかりません: " + target.rowKey.slice(0, 20)));
              return;
            }

            // 新タブ監視を開始してからボタンクリック
            // （レインズがwindow.openで開く新タブをbackground.jsが捕捉してPDFを取得）
            chrome.runtime.sendMessage({ type: "axlx-reins-watch-tab" }, function () {
              console.log("[AX-REINS] 図面クリック:", target.rowKey.slice(0, 25));
              freshBtn.click();

              // 動的iframe対応: クリック後に300msごと最大6回再注入
              // レインズはボタンクリック後にPDF viewer iframeを生成する場合があり
              // 生成後に即座にフックを入れて capturePending=true を確保する
              var reinjCount = 0;
              reinjTimer = setInterval(function () {
                if (doneCalled || ++reinjCount > 6) {
                  clearInterval(reinjTimer);
                  reinjTimer = null;
                  return;
                }
                console.log("[AX-REINS] 動的iframe対応 再注入(" + reinjCount + "/6)");
                chrome.runtime.sendMessage({ type: "axlx-inject-pdf-hook" });
              }, 300);
            });
          }, 200); // MAINワールドのaxlx-start-pdf-capture処理を待つ
        });
      }, 4000); // 前回のビューワーが閉じるのを最大4秒待つ
    });
  }

  // ── background.jsからの通知を受信 ───────────────────────────────────
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.type === "axlx-blob-upload-progress") {
      var lineBtn = document.getElementById("axlx-reins-line-btn");
      if (lineBtn && isSending) {
        lineBtn.textContent = "Blobアップ中... (" + msg.current + "/" + msg.total + ")";
      }
      return;
    }
    // 新タブからキャプチャされたPDFをpdfHandlerに転送
    if (msg.type === "axlx-reins-pdf-captured" && msg.b64) {
      console.log("[AX-REINS] 新タブPDF受信 → pdfHandlerに転送");
      window.postMessage({ from: "axlx-itandi-pdf", b64: msg.b64, ts: msg.ts || Date.now() }, "*");
    }
  });

  // ── MutationObserver で結果ページ更新時に再注入 ──────────────────────
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
