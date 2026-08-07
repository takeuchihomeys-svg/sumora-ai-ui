(function () {
  "use strict";

  // 物件詳細・その他ページでは動作不要（MutationObserver＋DOM走査によるメモリ圧迫を防ぐ）
  if (location.pathname.indexOf("main.php") === -1) return;

  var tracked = [];
  var injectTimer = null;
  var _pendingAutoSendDispatched = false; // inject() から autoSendAllPages を起動済みか
  var _autoSendArmed = false;            // fill-done 受信後、新結果待ちフラグ
  var _autofillInitiated = false;        // 手動autofillボタン押下フラグ（fill-done到着前）
  var _preAutofillBtns = new Set();      // autofill前の 印刷用PDF ボタンスナップショット

  // ── 全ページ自動送信: sessionStorage キー ──────────────
  var AUTO_SEND_KEY = "axlx_auto_send";

  function getAutoSendState() {
    try {
      var raw = sessionStorage.getItem(AUTO_SEND_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function setAutoSendState(state) {
    try { sessionStorage.setItem(AUTO_SEND_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function clearAutoSendState() {
    try { sessionStorage.removeItem(AUTO_SEND_KEY); } catch (e) {}
  }

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

    // Case A: fill-done 受信済み かつ スナップショット前にない新しい結果が出た
    if (_autoSendArmed && tracked.length > 0 && !getAutoSendState() && !_pendingAutoSendDispatched) {
      var _hasNewBtn = tracked.some(function(item) { return !_preAutofillBtns.has(item.btn); });
      if (_hasNewBtn) {
        _autoSendArmed = false;
        _pendingAutoSendDispatched = true;
        try { chrome.storage.session.remove("axlx_pending_auto_send"); } catch (_) {}
        console.log("[AXLX bulk-dl] Case A: 新結果検出 → 自動送信開始");
        setTimeout(autoSendAllPages, 800);
      }
    }
    // Case B: AJAXページネーション継続（tryNext がページ遷移後に inject() が再実行される）
    else if (tracked.length > 0 && !_pendingAutoSendDispatched) {
      var _resumeState = getAutoSendState();
      if (_resumeState && _resumeState.active) {
        _pendingAutoSendDispatched = true;
        console.log("[AXLX bulk-dl] Case B: AJAXページネーション継続 P" + _resumeState.currentPage);
        setTimeout(function () {
          autoSendOnePage(_resumeState, function (ok) { tryNext(_resumeState); });
        }, 800);
      }
    }
  }

  // ── フローティングバー ────────────────────────────
  function ensureBar() {
    if (document.getElementById("axlx-bar")) return;
    var bar = document.createElement("div");
    bar.id = "axlx-bar";
    bar.style.cssText = [
      "position:fixed;bottom:24px;right:24px;z-index:2147483646;",
      "background:linear-gradient(135deg,#0d1b3e,#1565C0);",
      "color:white;border-radius:14px;padding:12px 16px;",
      "font-size:13px;font-weight:700;",
      "box-shadow:0 4px 20px rgba(0,0,0,0.4);",
      "display:none;flex-direction:column;gap:8px;min-width:200px;",
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
      '<div style="display:flex;gap:6px;">',
      '  <button id="axlx-merge-btn" style="flex:1;padding:6px 8px;background:#43a047;border:none;border-radius:8px;color:white;font-size:11px;font-weight:700;cursor:pointer;">📄 1つのPDFに結合</button>',
      "</div>",
      '<div style="display:flex;gap:6px;">',
      '  <button id="axlx-line-btn" style="flex:1;padding:6px 8px;background:#06c755;border:none;border-radius:8px;color:white;font-size:11px;font-weight:700;cursor:pointer;">📤 売上番長に送る</button>',
      "</div>",
      '<div style="display:flex;gap:6px;">',
      '  <button id="axlx-auto-btn" style="flex:1;padding:6px 8px;background:#e91e63;border:none;border-radius:8px;color:white;font-size:11px;font-weight:700;cursor:pointer;">📡 全ページ送る</button>',
      "</div>",
      '<div style="display:flex;gap:6px;">',
      '  <button id="axlx-print-btn" style="flex:1;padding:6px 4px;background:rgba(255,255,255,0.18);border:none;border-radius:8px;color:white;font-size:10px;font-weight:700;cursor:pointer;">🖨 印刷プレビュー</button>',
      '  <button id="axlx-img-btn" style="flex:1;padding:6px 4px;background:#7b1fa2;border:none;border-radius:8px;color:white;font-size:10px;font-weight:700;cursor:pointer;">📸 画像保存</button>',
      "</div>",
    ].join("");
    document.body.appendChild(bar);
    document.getElementById("axlx-all-btn").addEventListener("click", toggleAll);
    document.getElementById("axlx-dl-btn").addEventListener("click", bulkDownload);
    document.getElementById("axlx-merge-btn").addEventListener("click", function () { mergePdfs(false); });
    document.getElementById("axlx-line-btn").addEventListener("click", function () { getCustomerFromPopup(function (customerName) { mergePdfs(true, customerName); }); });
    document.getElementById("axlx-auto-btn").addEventListener("click", function () { autoSendAllPages(); });
    document.getElementById("axlx-print-btn").addEventListener("click", printMerged);
    document.getElementById("axlx-img-btn").addEventListener("click", downloadImages);
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

  function getSelectedUrls() {
    return tracked.filter(function (t) {
      return t.cb.checked && t.btn.href && /^https?:\/\//.test(t.btn.href);
    }).map(function (t) { return t.btn.href; });
  }

  // ── 一括DL ────────────────────────────────────────
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
        setTimeout(function () { targets.forEach(function (t) { t.cb.checked = false; }); updateBar(); }, 2500);
        return;
      }
      document.getElementById("axlx-count").textContent = (i + 1) + "/" + targets.length + " DL中";
      targets[i].btn.click();
      i++;
      setTimeout(next, 1800);
    }
    next();
  }

  // ── 物件カード情報抽出 ─────────────────────────────
  function extractCard(btn) {
    var row = btn;
    while (row && row.tagName !== "TR") row = row.parentElement;

    var name = "";
    var cur = row ? row.parentElement : null;
    while (cur && !name) {
      var prev = cur.previousElementSibling;
      if (prev) {
        var h = prev.querySelector("h2,h3,h4,.building-name,td b,td strong");
        if (h) { name = h.textContent.trim(); break; }
        var txt = prev.textContent.trim();
        if (txt && txt.length < 40) { name = txt; break; }
      }
      cur = cur.parentElement;
    }
    if (!name && row) {
      var tbl = row.closest("table");
      var before = tbl && tbl.previousElementSibling;
      if (before) name = before.textContent.trim().split("\n")[0].trim().slice(0, 30);
    }

    var cells = row ? Array.from(row.querySelectorAll("td")) : [];
    var texts = cells.map(function (td) {
      return td.textContent.replace(/\s+/g, " ").trim();
    }).filter(function (t) { return t && t.length > 0 && t.length < 60; });

    return { name: name || "物件", texts: texts.slice(0, 8) };
  }

  // ── 物件サマリーテキスト生成（LINE送信用）──────────
  function buildPropertySummary(card, index) {
    var lines = ["【" + (index + 1) + "】" + card.name];

    // 家賃（数字＋万円 or 円 or ¥ が含まれるセル）
    var rentText = card.texts.find(function (t) {
      return /[0-9,，]+[\s]*[万円]/.test(t) || /¥/.test(t);
    });
    if (rentText) lines.push(rentText.replace(/\s+/g, " ").trim());

    // 間取り（1R / 1K / 2LDK 等）
    var madoriText = card.texts.find(function (t) {
      return /[1-9](R\b|K\b|DK\b|LDK|SLDK|SDK)/.test(t);
    });
    if (madoriText) lines.push(madoriText.trim());

    // 駅・徒歩（「徒歩」または「駅」を含むセル）
    var accessText = card.texts.find(function (t) {
      return /徒歩/.test(t);
    });
    if (!accessText) {
      accessText = card.texts.find(function (t) { return /駅/.test(t); });
    }
    if (accessText) lines.push(accessText.trim());

    // AD（「AD」を含むセルから金額だけ抽出）
    var adText = card.texts.find(function (t) {
      return /AD/.test(t) || /広告料/.test(t);
    });
    if (adText) {
      var adMatch = adText.match(/[\d,，]+円/);
      if (adMatch) lines.push("AD " + adMatch[0]);
    }

    return lines.join("\n");
  }

  // ── popup.jsから選択中のお客さん名を自動取得 ──────────
  // postMessage → underbar.js中継 → popup.js → 応答を受け取る
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
    // 800ms 以内に応答がなければ null で続行（アンダーバー外から使った場合など）
    timer = setTimeout(function () {
      window.removeEventListener("message", handler);
      callback(null);
    }, 800);
  }

  // ── LINE送信: 1件ずつ順番に送信（background経由・CSP/CORS完全回避）──────
  // ── PDF結合ダウンロード: background経由 ───────────────────────────────────
  function mergePdfs(sendToLine, customerName) {
    var urls = getSelectedUrls();
    if (!urls.length) {
      alert("物件を選択してください（印刷用PDFリンクが検出できる物件をチェックしてください）");
      return;
    }

    var today = new Date().toLocaleDateString("ja-JP").replace(/\//g, "-");

    if (sendToLine) {
      // ── 売上番長に送る: 1件ずつ順番にLINE送信 ─────────────────────────────
      var lineBtn = document.getElementById("axlx-line-btn");
      var lineOrig = lineBtn.textContent;
      lineBtn.disabled = true;
      lineBtn.textContent = "送信中... (0/" + urls.length + ")";

      var selectedTargets = tracked.filter(function (t) { return t.cb.checked; });
      var propertySummaries = selectedTargets.map(function (t, i) {
        return buildPropertySummary(extractCard(t.btn), i);
      });

      chrome.runtime.sendMessage({
        type: "axlx-send-to-line",
        urls: urls,
        customer_name: customerName || null,
        property_summaries: propertySummaries,
      }, function (resp) {
        lineBtn.disabled = false;
        if (chrome.runtime.lastError) {
          alert("エラー: " + chrome.runtime.lastError.message);
          lineBtn.textContent = lineOrig;
          return;
        }
        if (!resp || !resp.ok) {
          alert("LINE送信エラー:\n" + (resp ? resp.error : "応答なし"));
          lineBtn.textContent = lineOrig;
          return;
        }
        lineBtn.textContent = "✅ " + urls.length + "件 LINE送信完了！";
        setTimeout(function () { lineBtn.textContent = lineOrig; }, 5000);
      });

    } else {
      // ── 1つのPDFに結合してダウンロード ────────────────────────────────────
      var mergeBtn = document.getElementById("axlx-merge-btn");
      var mergeOrig = mergeBtn.textContent;
      mergeBtn.disabled = true;
      mergeBtn.textContent = "PDF結合中... (" + urls.length + "件)";
      var fileName = "物件まとめ_" + today + ".pdf";

      chrome.runtime.sendMessage({
        type: "axlx-merge-pdf",
        urls: urls,
        file_name: fileName,
        customer_name: customerName || null,
      }, function (resp) {
        mergeBtn.disabled = false;
        if (chrome.runtime.lastError) {
          alert("エラー: " + chrome.runtime.lastError.message);
          mergeBtn.textContent = mergeOrig;
          return;
        }
        if (!resp || !resp.ok) {
          alert("エラー: " + (resp ? resp.error : "応答なし"));
          mergeBtn.textContent = mergeOrig;
          return;
        }
        var bytes = Uint8Array.from(atob(resp.pdf), function (c) { return c.charCodeAt(0); });
        var blob = new Blob([bytes], { type: "application/pdf" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = resp.fileName || fileName;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { a.remove(); }, 100);
        mergeBtn.textContent = "✅ PDF完成！";
        setTimeout(function () { mergeBtn.textContent = mergeOrig; }, 4000);
      });
    }
  }

  // ── Canvas生成（共通ヘルパー）────────────────────────
  function buildCanvas(cards) {
    var W = 680, CARD_H = 130, GAP = 8, PAD = 14;
    var canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = PAD * 2 + cards.length * (CARD_H + GAP);
    var ctx = canvas.getContext("2d");

    ctx.fillStyle = "#f0f4f8";
    ctx.fillRect(0, 0, W, canvas.height);

    cards.forEach(function (card, i) {
      var x = PAD, y = PAD + i * (CARD_H + GAP), w = W - PAD * 2;

      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      if (ctx.roundRect) { ctx.roundRect(x, y, w, CARD_H, 8); } else { ctx.rect(x, y, w, CARD_H); }
      ctx.fill();
      ctx.fillStyle = "#1565C0";
      ctx.fillRect(x, y, 4, CARD_H);

      ctx.fillStyle = "#1565C0";
      ctx.beginPath();
      ctx.arc(x + 18, y + 16, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(i + 1), x + 18, y + 20);
      ctx.textAlign = "left";

      ctx.fillStyle = "#1565C0";
      ctx.font = "bold 13px 'Hiragino Sans', 'Meiryo', sans-serif";
      ctx.fillText(card.name.slice(0, 32), x + 34, y + 20);

      ctx.strokeStyle = "#e3eaf3"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + 12, y + 28); ctx.lineTo(x + w - 12, y + 28); ctx.stroke();

      ctx.fillStyle = "#444";
      ctx.font = "11px 'Hiragino Sans', 'Meiryo', sans-serif";
      card.texts.forEach(function (t, j) {
        if (j >= 6) return;
        var col = j % 2 === 0 ? x + 14 : x + w / 2;
        ctx.fillText(t.slice(0, 28), col, y + 38 + Math.floor(j / 2) * 16);
      });
    });

    ctx.fillStyle = "#90a4ae"; ctx.font = "10px sans-serif"; ctx.textAlign = "right";
    ctx.fillText("スモラ物件リスト " + new Date().toLocaleDateString("ja-JP"), W - PAD, canvas.height - 6);
    return canvas;
  }

  // ── まとめて印刷 ─────────────────────────────────
  function printMerged() {
    var urls = getSelectedUrls();
    if (!urls.length) { alert("物件を選択してください"); return; }
    var win = window.open("", "_blank", "width=960,height=900");
    var iframes = urls.map(function (u, i) {
      return '<div class="page"><div class="label">物件 ' + (i + 1) + ' / ' + urls.length + '</div><iframe src="' + u + '" allowfullscreen></iframe></div>';
    }).join("");
    win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>物件まとめ印刷</title><style>body{margin:0;background:#eee;font-family:sans-serif}.ctrl{position:fixed;top:12px;right:12px;z-index:9999;display:flex;gap:8px;background:rgba(0,0,0,0.7);padding:8px 12px;border-radius:10px}.ctrl button{padding:8px 14px;border:none;border-radius:6px;font-weight:bold;cursor:pointer;font-size:13px}.print-btn{background:#1565C0;color:#fff}.close-btn{background:#fff;color:#333}.page{background:#fff;margin:12px auto;max-width:900px;box-shadow:0 2px 8px rgba(0,0,0,0.2)}.label{background:#1565C0;color:#fff;font-size:11px;font-weight:bold;padding:4px 10px}iframe{width:100%;height:1050px;border:none;display:block}@media print{.ctrl{display:none!important}.page{box-shadow:none;margin:0;page-break-after:always}iframe{height:100vh}}</style></head><body><div class="ctrl"><button class="print-btn" onclick="window.print()">🖨️ PDF保存（' + urls.length + '枚）</button><button class="close-btn" onclick="window.close()">✕ 閉じる</button></div>' + iframes + '</body></html>');
    win.document.close();
  }

  // ── 画像保存 ─────────────────────────────────────
  function downloadImages() {
    var targets = tracked.filter(function (t) { return t.cb.checked; });
    if (!targets.length) { alert("物件を選択してください"); return; }
    var canvas = buildCanvas(targets.map(function (t) { return extractCard(t.btn); }));
    var today = new Date().toLocaleDateString("ja-JP");
    canvas.toBlob(function (blob) {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "物件リスト_" + today.replace(/\//g, "-") + ".png";
      document.body.appendChild(a); a.click();
      setTimeout(function () { a.remove(); }, 100);
    }, "image/png");
  }

  // ── スクレイピング: 現在ページの物件データをJSON収集 ─────────────────────
  // findPrintBtns() が返すボタン1本 = 物件1件として処理する。
  // extractCard() の TR取得・建物名ロジックをそのまま流用し、
  // 賃料・間取り・面積・アクセス・所在地・入居可能日・URLも正規表現で抽出する。
  function scrapePropertiesFromPage() {
    var btns = findPrintBtns();
    var results = [];

    btns.forEach(function (btn) {
      var card = extractCard(btn);

      // TR を特定（extractCard と同じロジック）
      var row = btn;
      while (row && row.tagName !== "TR") row = row.parentElement;

      var cells = row ? Array.from(row.querySelectorAll("td")) : [];
      var allTexts = cells.map(function (td) {
        return td.textContent.replace(/\s+/g, " ").trim();
      }).filter(function (t) { return t.length > 0; });

      // 賃料（万円表記）
      var rentText = allTexts.find(function (t) { return /[0-9,，.]+\s*万円/.test(t); }) || "";
      var rentMatch = rentText.match(/([0-9,，.]+)\s*万円/);
      var rent = rentMatch
        ? Math.round(parseFloat(rentMatch[1].replace(/[,，]/g, "")) * 10000)
        : null;

      // 管理費・共益費（円表記で、万円を含まない短いセル）
      var mgmtText = allTexts.find(function (t) {
        return /[0-9,，]+\s*円/.test(t) && !/万円/.test(t) && t.length < 30;
      }) || "";
      var mgmtMatch = mgmtText.match(/([0-9,，]+)\s*円/);
      var management_fee = mgmtMatch
        ? parseInt(mgmtMatch[1].replace(/[,，]/g, ""), 10)
        : null;

      // 間取り（全セル結合して最初にマッチしたもの）
      var floorPlanMatch = allTexts.join(" ").match(/[1-9](?:R|K|DK|LDK|SLDK|SDK)\b/);
      var floor_plan = floorPlanMatch ? floorPlanMatch[0] : null;

      // 専有面積（m² / m2 / ㎡ を含むセル）
      var areaText = allTexts.find(function (t) { return /[\d.]+\s*[m㎡²]/.test(t); }) || "";
      var areaMatch = areaText.match(/([\d.]+)\s*[m㎡²]/);
      var area = areaMatch ? parseFloat(areaMatch[1]) : null;

      // アクセス（「徒歩」優先、次に「線」「駅」を含むセル）
      var accessText = allTexts.find(function (t) { return /徒歩/.test(t); }) ||
                       allTexts.find(function (t) { return /[線駅]/.test(t); }) || "";

      // 所在地（区・市・町・村を含み、賃料/面積/アクセス系でないセル）
      var addressText = allTexts.find(function (t) {
        return /[区市町村]/.test(t) &&
               t.length < 60 &&
               !/万円|徒歩|m[²2]|㎡|間取|[0-9]+分/.test(t);
      }) || "";

      // 入居可能日（「入居」「即入居」「即時」「相談」を含む短いセル）
      var moveinText = allTexts.find(function (t) {
        return /入居|即入居|即時|相談/.test(t) && t.length < 30;
      }) || "";

      // 詳細URL（印刷用PDF以外の最初のリンク）
      var pdfHref = btn.href || "";
      var links = row ? Array.from(row.querySelectorAll("a[href]")) : [];
      var detailLink = links.find(function (a) {
        return a.href && a.href !== pdfHref && !/印刷用PDF/.test(a.textContent);
      });
      var detail_url = detailLink ? detailLink.href : pdfHref;

      results.push({
        name:           card.name,
        rent:           rent,
        management_fee: management_fee,
        floor_plan:     floor_plan,
        area:           area,
        access:         accessText,
        address:        addressText,
        move_in:        moveinText,
        detail_url:     detail_url,
        pdf_url:        pdfHref
      });
    });

    return results;
  }

  // ── ページネーション: 次ページボタンの存在確認（クリックなし）──────────────
  // clickNextPageBtn と同じ探索ロジックで true/false のみ返す。
  function hasNextPageBtn() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var t = node.textContent.trim();
      if (t !== "次" && t !== "次へ" && t !== "次のページ" && t !== ">" && t !== ">>") continue;
      var el = node.parentElement;
      for (var up = 0; up < 4 && el && el !== document.body; up++, el = el.parentElement) {
        if ((el.tagName === "A" || el.tagName === "BUTTON") && el.offsetParent !== null) {
          return true;
        }
      }
    }
    var candidates = document.querySelectorAll(
      '[aria-label*="次"], .pagination-next, .page-next, a.next, button.next'
    );
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].offsetParent !== null) return true;
    }
    return false;
  }

  // ── ページネーション: 「次」ボタンをクリックして true を返す ───────────────
  // リアプロの「次へ」ボタンは DOM 上どこにあるか機種依存のため多段探索する。
  function clickNextPageBtn() {
    // フェーズ1: テキストノードウォーカーで「次」「次へ」「>」「>>」を探す
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var t = node.textContent.trim();
      if (t !== "次" && t !== "次へ" && t !== "次のページ" && t !== ">" && t !== ">>") continue;
      var el = node.parentElement;
      for (var up = 0; up < 4 && el && el !== document.body; up++, el = el.parentElement) {
        if ((el.tagName === "A" || el.tagName === "BUTTON") && el.offsetParent !== null) {
          el.click();
          return true;
        }
      }
    }
    // フェーズ2: CSSクラス・aria-label ベース（モダンなページャーに対応）
    var candidates = document.querySelectorAll(
      '[aria-label*="次"], .pagination-next, .page-next, a.next, button.next'
    );
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].offsetParent !== null) {
        candidates[i].click();
        return true;
      }
    }
    return false;
  }

  // ── 全ページ自動送信: 共通の次ページ遷移 or 完了処理 ─────────────────────
  // autoSendOnePage の onDone コールバックと start() 内の再開処理で共通利用する。
  function tryNext(state) {
    if (hasNextPageBtn()) {
      setAutoSendState({ active: true, currentPage: state.currentPage + 1, customerName: state.customerName });
      var clicked = clickNextPageBtn();
      if (!clicked) {
        clearAutoSendState();
        alert("次ページへの遷移に失敗しました。手動で操作してください。");
      } else {
        // AJAX: 次のinject()でCase Bが拾えるようにリセット
        // ページリロード: _pendingAutoSendDispatched は再初期化されるので問題なし
        _pendingAutoSendDispatched = false;
        console.log("[AXLX bulk-dl] 次ページへ遷移 P" + (state.currentPage + 1));
      }
    } else {
      clearAutoSendState();
      var countEl = document.getElementById("axlx-count");
      if (countEl) countEl.textContent = "全ページ送信完了！";
      alert("全ページ自動送信が完了しました。（" + state.currentPage + "ページ処理済み）");
    }
  }

  // ── 全ページ自動送信: 現ページを自動送信する ──────────────────────────────
  // mergePdfs を再利用せず chrome.runtime.sendMessage を直接呼ぶ
  // （コールバック内で onDone を呼ぶため）。
  function autoSendOnePage(state, onDone) {
    var countEl = document.getElementById("axlx-count");
    if (countEl) countEl.textContent = "全ページ送信中 P" + state.currentPage + "...";

    // 全チェックボックス選択
    tracked.forEach(function (t) { t.cb.checked = true; });
    updateBar();

    var urls = getSelectedUrls();
    if (!urls.length) {
      onDone(true);
      return;
    }

    var selectedTargets = tracked.filter(function (t) { return t.cb.checked; });
    var propertySummaries = selectedTargets.map(function (t, i) {
      return buildPropertySummary(extractCard(t.btn), i);
    });

    chrome.runtime.sendMessage({
      type: "axlx-send-to-line",
      urls: urls,
      customer_name: state.customerName || null,
      property_summaries: propertySummaries,
    }, function (resp) {
      if (chrome.runtime.lastError) {
        clearAutoSendState();
        if (countEl) countEl.textContent = "送信エラー";
        alert("全ページ送信エラー: " + chrome.runtime.lastError.message);
        return;
      }
      if (!resp || !resp.ok) {
        clearAutoSendState();
        if (countEl) countEl.textContent = "送信エラー";
        alert("全ページ送信エラー:\n" + (resp ? resp.error : "応答なし"));
        return;
      }
      onDone(true);
    });
  }

  // ── 全ページ自動送信: エントリポイント ────────────────────────────────────
  function autoSendAllPages() {
    if (getAutoSendState()) return; // 既に動作中
    getCustomerFromPopup(function (name) {
      var state = { active: true, currentPage: 1, customerName: name };
      setAutoSendState(state);
      autoSendOnePage(state, function (ok) {
        tryNext(state);
      });
    });
  }

  // ── underbar.js からの全ページ自動送信シグナル受信 ───────────────────────
  // Step1: autofill ボタン押下時 → 現在の結果ボタンをスナップショット
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.from !== "axlx-autofill-initiated") return;
    _autofillInitiated = true;
    _preAutofillBtns = new Set(findPrintBtns());
    _pendingAutoSendDispatched = false;
    console.log("[AXLX bulk-dl] autofill initiated, snapshot=" + _preAutofillBtns.size + "btn");
  });

  // Step2: fill-done 受信 → arm（スナップショット外の新結果が出たら Case A で発動）
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.from !== "aixlinx-fill-done") return;
    if (!_autofillInitiated) return;
    _autoSendArmed = true;
    _autofillInitiated = false;
    console.log("[AXLX bulk-dl] fill-done 受信 → 全ページ自動送信 armed");
  });

  // ── メッセージリスナー（background.js からのスクレイプ指示）──────────────
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.type === "axlx-scrape-realpro") {
      var properties = scrapePropertiesFromPage();
      console.log("[AXLX bulk-dl] axlx-scrape-realpro: " + properties.length + "件取得");
      sendResponse({ properties: properties });
      return true;
    }
    if (msg.type === "axlx-click-next-page") {
      var clicked = clickNextPageBtn();
      console.log("[AXLX bulk-dl] axlx-click-next-page: clicked=" + clicked);
      sendResponse({ clicked: clicked });
      return true;
    }
  });

  // ── MutationObserver ────────────────────────────
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

    // Case D: ページリロード後の再開（ページ2以降: tryNext がsetAutoSendStateした後）
    var autoState = getAutoSendState();
    if (autoState && autoState.active) {
      setTimeout(function () {
        if (_pendingAutoSendDispatched) return; // inject() Case B が先に処理済み
        _pendingAutoSendDispatched = true;
        console.log("[AXLX bulk-dl] Case D: ページリロード後の継続 P" + autoState.currentPage);
        autoSendOnePage(autoState, function (ok) { tryNext(autoState); });
      }, 2500);
      return; // Case C は不要（ページ1ではないため）
    }

    // Case C: ページリロード後の初回起動（chrome.storage.session経由 / AJAXでCase Aが動かなかった場合の保険）
    setTimeout(function () {
      if (_pendingAutoSendDispatched) return;
      try {
        chrome.storage.session.get(["axlx_pending_auto_send"], function (data) {
          if (data && data.axlx_pending_auto_send && !_pendingAutoSendDispatched) {
            _pendingAutoSendDispatched = true;
            chrome.storage.session.remove("axlx_pending_auto_send");
            console.log("[AXLX bulk-dl] Case C: ページリロード初回起動");
            autoSendAllPages();
          }
        });
      } catch (_) {}
    }, 2500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
  window.addEventListener("load", function () { setTimeout(inject, 2000); });
})();
