(function () {
  "use strict";

  var tracked     = [];
  var injectTimer = null;
  var isSending   = false;

  function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  // ── 物件行を取得（クラス名非依存・CB逆引き方式）──────────────────────
  // 設計方針: CSSクラス名はREINSのUI更新で変わるため信頼しない。
  // チェックボックス要素を起点に「行コンテナ」を逆引きし、
  // 同一親に2件以上あるグループ = 物件リスト行と判定する。
  function findResultRows() {
    function isVisible(el) {
      if (el.offsetParent !== null) return true;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    function dedup(arr) {
      return arr.filter(function(el) {
        return !arr.some(function(o) { return o !== el && el.contains(o); });
      });
    }

    // ── 高速パス1: PrimeVue v3クラス ─────────────────────────────────
    var rows = Array.from(document.querySelectorAll(".p-table-body-row")).filter(isVisible);
    if (rows.length > 0) {
      console.log("[AX-REINS] 行検出[v3クラス]:", rows.length + "件");
      return rows;
    }

    // ── 高速パス2: PrimeVue v4+クラス部分一致 ────────────────────────
    rows = Array.from(document.querySelectorAll(
      "[class*='table-body-row'],[class*='datatable-row'],[class*='p-datatable-row'],[class*='p-row-odd'],[class*='p-row-even']"
    )).filter(isVisible);
    if (rows.length > 0) {
      console.log("[AX-REINS] 行検出[v4クラス]:", rows.length + "件");
      return rows;
    }

    // ── 高速パス3: WAI-ARIA role="row" + CB ──────────────────────────
    rows = Array.from(document.querySelectorAll("[role='row']")).filter(function(el) {
      return isVisible(el) && !!el.querySelector('input[type="checkbox"]');
    });
    if (rows.length > 0) {
      console.log("[AX-REINS] 行検出[role=row]:", rows.length + "件");
      return rows;
    }

    // ── 高速パス4: thead除外 tr + CB ─────────────────────────────────
    rows = Array.from(document.querySelectorAll("tr")).filter(function(el) {
      return isVisible(el) && !el.closest("thead") && !!el.querySelector('input[type="checkbox"]');
    });
    if (rows.length > 0) {
      var d4 = dedup(rows);
      console.log("[AX-REINS] 行検出[tr]:", d4.length + "件");
      return d4;
    }

    // ── 最終フォールバック: CB逆引き（クラス名・フレームワーク完全非依存）─
    // 戦略: CBから上に辿り「同じ親に CB を持つ兄弟が1件以上いる要素」= 行コンテナ
    // PrimeVue v4 の [role="checkbox"] / data-pc-section にも対応
    var CB_SEL = 'input[type="checkbox"], [role="checkbox"], [data-pc-section="checkbox"]';
    var allCbs = Array.from(document.querySelectorAll(CB_SEL)).filter(function(cb) {
      return isVisible(cb) && !cb.classList.contains("axlx-reins-cb");
    });

    console.log("[AX-REINS] CB逆引きモード: 可視CB数 =", allCbs.length);
    if (allCbs.length < 2) return [];

    // CB → 行コンテナを逆引き
    // 「このノードの兄弟ノードの中にCBを含むものが1件以上ある」要素が行コンテナ
    function findRowEl(cb) {
      var el = cb.parentElement;
      for (var i = 0; i < 12 && el && el !== document.body; i++, el = el.parentElement) {
        if (el.tagName === "TR" || el.getAttribute("role") === "row") return el;
        if (el.getAttribute("data-pc-section") === "bodyrow") return el;
        var parent = el.parentElement;
        if (parent) {
          var cbSiblings = Array.from(parent.children).filter(function(s) {
            return s !== el && !!(s.querySelector(CB_SEL));
          });
          if (cbSiblings.length >= 1) return el; // 兄弟にCBあり → ここが行レベル
        }
      }
      return cb.parentElement;
    }

    var seen = [];
    var result = [];
    allCbs.forEach(function(cb) {
      var rowEl = findRowEl(cb);
      if (!rowEl || !isVisible(rowEl)) return;
      if (seen.indexOf(rowEl) !== -1) return;
      // ① form 要素内にある行はフォームフィールドのため除外
      if (rowEl.closest("form")) return;
      // ② テキストが短すぎる要素は物件行でない
      var txt = rowEl.textContent.replace(/\s+/g, "").length;
      if (txt < 15) return;
      seen.push(rowEl);
      result.push(rowEl);
    });

    // 同一親に2件以上ある行グループのみ残す
    var parentCount = new Map();
    result.forEach(function(r) {
      var p = r.parentElement;
      parentCount.set(p, (parentCount.get(p) || 0) + 1);
    });
    result = result.filter(function(r) { return (parentCount.get(r.parentElement) || 0) >= 2; });

    if (result.length > 0) {
      var sample = result[0];
      console.log("[AX-REINS] 行検出[CB逆引き]:", result.length + "件",
        "| 最初の行 <" + sample.tagName + " class='" + (sample.className || "").toString().slice(0, 60) + "'>");
    } else {
      console.warn("[AX-REINS] 行を検出できませんでした。" +
        "CB数=" + allCbs.length + " ページURL=" + location.pathname);
    }
    return result;
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

  // ── ネイティブCBをトラッキング（カスタムCB注入なし・レインズ左端CBを直接使用）──
  function inject() {
    tracked = [];
    var rows = findResultRows();
    var noCbCount = 0;
    rows.forEach(function (row) {
      var nativeCb = findNativeCheckbox(row);
      if (!nativeCb) { noCbCount++; return; }
      var zumenBtn = Array.from(row.querySelectorAll("button")).find(function (b) {
        return b.textContent.trim() === "図面";
      });
      tracked.push({ cb: nativeCb, row: row, zumenBtn: zumenBtn, rowKey: makeRowKey(row) });
    });
    if (rows.length > 0)
      console.log("[AX-REINS] inject: 行=" + rows.length + " 有効=" + tracked.length + " CB不明=" + noCbCount);
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

  // ── React対応チェックボックス操作（レインズはReact製のため直接代入では反映されない）──
  function clickNativeCb(cb, newState) {
    if (cb.checked === newState) return;
    try {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked").set;
      setter.call(cb, newState);
      cb.dispatchEvent(new Event("change", { bubbles: true }));
      cb.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    } catch (_) { cb.click(); }
  }

  function toggleAll() {
    var checked  = tracked.filter(function (t) { return t.cb.checked; });
    var newState = checked.length < tracked.length;
    tracked.forEach(function (t) { clickNativeCb(t.cb, newState); });
    setTimeout(function () { updateBar(); }, 100);
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

  // ── ネイティブチェックボックスを取得（PrimeVue v3/v4 + 汎用対応）───────
  var CB_ANY = 'input[type="checkbox"], [role="checkbox"], [data-pc-section="checkbox"]';
  function findNativeCheckbox(row) {
    // 1. PrimeVue v3/v4/標準テーブル の先頭セルを探す
    var firstCell = row.querySelector(
      ".p-table-body-item, .p-datatable-td, [data-pc-section='cell'], td, [role='cell']"
    );
    if (firstCell) {
      var cb = firstCell.querySelector(CB_ANY);
      if (cb) return cb;
    }
    // 2. 行全体からCBを探す
    return Array.from(row.querySelectorAll(CB_ANY)).find(function(c) {
      return !c.classList.contains("axlx-reins-cb");
    }) || null;
  }

  // ── 図面一括取得ボタンを取得 ─────────────────────────────────────────
  function findBatchBtn() {
    return Array.from(document.querySelectorAll("button,input[type='button']")).find(function (b) {
      // offsetParent チェック除外（ページ下部で非表示扱いになる場合があるため）
      return (b.textContent || b.value || "").trim().includes("図面一括取得");
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
      updateBar(); // ネイティブCBはそのまま（ユーザーが手動で解除）
      lineBtn.textContent = "✅ " + pdfBase64List.length + "件 LINE送信完了！";
      setTimeout(function () { lineBtn.textContent = lineOrig; }, 5000);
    });
  }

  // ── 一括取得モード（図面一括取得ボタン → 確認ダイアログ自動クリック → 1枚のマージ済みPDF）──
  // レインズは「4件選択 → 1つのPDFにまとめてダウンロード」の設計。
  // 個別タブは開かず、JSフック(createObjectURL / fetch / XHR / <a download>)でPDFを横取りする。
  function startBatchSend(targets, customerName, lineBtn, lineOrig, propertySummaries, batchBtnEl) {
    var expectedCount  = targets.length;
    var pdfReceived    = false;
    var batchHandler   = null;
    var batchTimer     = null;
    var fallbackTimer  = null;

    function finish(mergedPdf) {
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
      if (batchTimer)    { clearTimeout(batchTimer);    batchTimer    = null; }
      window.removeEventListener("message", batchHandler);
      if (!mergedPdf) {
        // PDF取得失敗 → 逐次モードへ
        console.warn("[AX-REINS] 一括PDF取得失敗 → 逐次モードへ");
        lineBtn.textContent = "図面取得中... (0/" + expectedCount + ")";
        startSequentialSend(targets, customerName, lineBtn, lineOrig, propertySummaries);
        return;
      }
      // レインズが結合した1枚のPDFをそのままLINE送信（merge-pdfs APIはスキップ）
      sendAllToLine([mergedPdf], targets, customerName, propertySummaries, lineBtn, lineOrig);
    }

    // PDFフックからのメッセージを受け取る（1件のマージ済みPDF）
    batchHandler = function (e) {
      if (!e.data || e.data.from !== "axlx-itandi-pdf") return;
      if (pdfReceived) return; // 重複防止
      pdfReceived = true;
      console.log("[AX-REINS] 一括: マージ済みPDF取得 " + Math.round(e.data.b64.length / 1024) + "KB");
      lineBtn.textContent = "LINE送信中...";
      finish(e.data.b64);
    };
    window.addEventListener("message", batchHandler);

    // タイムアウト（60秒）
    batchTimer = setTimeout(function () {
      console.warn("[AX-REINS] 一括タイムアウト（60s） → 逐次モードへ");
      finish(null);
    }, 60000);

    // 15秒で未取得なら逐次へ（ダイアログ未表示・フック失敗時の早期離脱）
    fallbackTimer = setTimeout(function () {
      if (!pdfReceived) {
        clearTimeout(batchTimer); batchTimer = null;
        window.removeEventListener("message", batchHandler);
        console.warn("[AX-REINS] 一括0件（15s）→ 逐次モードへ切替");
        lineBtn.textContent = "図面取得中... (0/" + expectedCount + ")";
        startSequentialSend(targets, customerName, lineBtn, lineOrig, propertySummaries);
      }
    }, 15000);

    // Step1: 念のり未チェックのものだけONに
    var confirmed = 0;
    targets.forEach(function (t) { clickNativeCb(t.cb, true); confirmed++; });
    console.log("[AX-REINS] ネイティブCB確認: " + confirmed + "/" + expectedCount + " 件");

    sleep(400).then(function () {
      // Step2: JSフック注入（createObjectURL / fetch / XHR / <a download> を全て捕捉）
      chrome.runtime.sendMessage({ type: "axlx-inject-pdf-hook" }, function () {
        chrome.runtime.sendMessage({ type: "axlx-reins-watch-tab" }, function () {
          if (!batchBtnEl || !batchBtnEl.isConnected) {
            console.warn("[AX-REINS] 図面一括取得ボタンが消えた → 逐次モードへ");
            clearTimeout(batchTimer);
            if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
            window.removeEventListener("message", batchHandler);
            startSequentialSend(targets, customerName, lineBtn, lineOrig, propertySummaries);
            return;
          }
          lineBtn.textContent = "PDF取得中...";
          console.log("[AX-REINS] 図面一括取得クリック");
          batchBtnEl.click();

          // Step3: 確認ダイアログ「一括取得」を800ms後に自動クリック
          // offsetParent は position:fixed のモーダルで null になるため getBoundingClientRect で可視判定
          sleep(800).then(function () {
            var ikkatsuBtn = Array.from(document.querySelectorAll("button")).find(function (b) {
              if (b.textContent.trim() !== "一括取得") return false;
              var r = b.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            });
            if (ikkatsuBtn) {
              console.log("[AX-REINS] 確認ダイアログ「一括取得」自動クリック");
              ikkatsuBtn.click();
            } else {
              console.warn("[AX-REINS] 確認ダイアログが見つかりません（既に閉じた？）");
            }
          });
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
    var batchBtnEl = findBatchBtn();
    console.log("[AX-REINS] 図面一括取得ボタン:", batchBtnEl ? "発見 → 一括モード" : "なし → 逐次モード");
    if (batchBtnEl) {
      startBatchSend(targets, customerName, lineBtn, lineOrig, propertySummaries, batchBtnEl);
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
            // findResultRows()でrowを逆引き（クラス名依存を排除）
            var freshRow = findResultRows().find(function (r) { return makeRowKey(r) === target.rowKey; });
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

  // ── MutationObserver で結果ページ更新時に再スキャン ──────────────────
  var mutObs = new MutationObserver(function () {
    if (injectTimer || isSending) return;
    injectTimer = setTimeout(function () {
      injectTimer = null;
      var rows = findResultRows();
      if (rows.length > 0 && rows.length !== tracked.length) inject();
    }, 800);
  });
  mutObs.observe(document.body, { childList: true, subtree: true });

  // ── ネイティブCBクリックでバーを更新（レインズのチェック操作を検知）─────
  document.addEventListener("click", function (e) {
    if (e.target.type === "checkbox" && !isSending) {
      setTimeout(function () { updateBar(); }, 50);
    }
  }, true);

  // ── 🔍 診断ボタン（テスト部隊）─────────────────────────────────────
  // 常にREINSページ右下に表示。クリックで拡張機能の認識状況をその場で確認できる。
  function addDiagButton() {
    if (document.getElementById("axlx-reins-diag")) return;
    var btn = document.createElement("button");
    btn.id = "axlx-reins-diag";
    btn.textContent = "🔍AXLX";
    btn.title = "AXLX診断（クリックで詳細表示）";
    btn.style.cssText = [
      "position:fixed;bottom:4px;right:4px;z-index:2147483647;",
      "background:rgba(30,30,30,0.75);color:#aef;border:none;",
      "border-radius:6px;padding:3px 7px;font-size:10px;cursor:pointer;",
    ].join("");
    btn.addEventListener("click", function() {
      var cbAll = Array.from(document.querySelectorAll(CB_ANY)).length;
      var rows  = findResultRows();
      var valid = rows.filter(function(r) { return !!findNativeCheckbox(r); }).length;
      var sample = rows.length > 0
        ? "\n行0クラス: " + (rows[0].className || "").toString().slice(0, 80)
        : "\n行なし";
      alert(
        "【AXLX REINS診断】\n" +
        "URL: " + location.pathname + "\n" +
        "CB数(全): " + cbAll + "\n" +
        "検出行数: " + rows.length + "\n" +
        "有効行数: " + valid + "\n" +
        "tracked: " + tracked.length +
        sample + "\n\n" +
        (rows.length === 0
          ? "⚠ 行が検出できません。検索結果ページで実行してください。"
          : "✅ 行を検出しています。")
      );
    });
    document.body.appendChild(btn);
  }

  // 初回スキャン + 動的ページ対応リトライ（REINSは遅延描画 / ページ遷移後に再描画）
  console.log("[AX-REINS] 起動 URL=" + location.pathname);
  addDiagButton();
  inject();
  var retryCount = 0;
  var retryTimer = setInterval(function () {
    if (tracked.length > 0 || ++retryCount > 30) { // 最大60秒（30回×2秒）
      clearInterval(retryTimer);
      if (retryCount > 30) console.warn("[AX-REINS] リトライ上限到達: 行が見つかりませんでした");
      return;
    }
    if (retryCount % 5 === 0) console.log("[AX-REINS] リトライ中... (" + retryCount + "/30)");
    inject();
  }, 2000);
})();
