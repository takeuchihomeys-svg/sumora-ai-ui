(function () {
  "use strict";

  var tracked = [];
  var injectTimer = null;

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
      '  <button id="axlx-print-btn" style="flex:1;padding:6px 4px;background:rgba(255,255,255,0.18);border:none;border-radius:8px;color:white;font-size:10px;font-weight:700;cursor:pointer;">🖨 印刷プレビュー</button>',
      '  <button id="axlx-img-btn" style="flex:1;padding:6px 4px;background:#7b1fa2;border:none;border-radius:8px;color:white;font-size:10px;font-weight:700;cursor:pointer;">📸 画像保存</button>',
      "</div>",
    ].join("");
    document.body.appendChild(bar);
    document.getElementById("axlx-all-btn").addEventListener("click", toggleAll);
    document.getElementById("axlx-dl-btn").addEventListener("click", bulkDownload);
    document.getElementById("axlx-merge-btn").addEventListener("click", function () { mergePdfs(false); });
    document.getElementById("axlx-line-btn").addEventListener("click", function () { getCustomerFromPopup(function (customerName) { mergePdfs(true, customerName); }); });
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
    if (rentText) lines.push("💰 " + rentText.replace(/\s+/g, " ").trim());

    // 間取り（1R / 1K / 2LDK 等）
    var madoriText = card.texts.find(function (t) {
      return /[1-9](R\b|K\b|DK\b|LDK|SLDK|SDK)/.test(t);
    });
    if (madoriText) lines.push("🏠 " + madoriText.trim());

    // 駅・徒歩（「徒歩」または「駅」を含むセル）
    var accessText = card.texts.find(function (t) {
      return /徒歩/.test(t);
    });
    if (!accessText) {
      accessText = card.texts.find(function (t) { return /駅/.test(t); });
    }
    if (accessText) lines.push("🚶 " + accessText.trim());

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

  // ── 保存済みPDFをファイル選択してLINEに送る ─────────
  // cookieもProxyも一切不要。すでにDLしたPDFをそのまま送るだけ。
  function sendLocalPdfsToLine(customerName) {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf,application/pdf";
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);

    input.addEventListener("change", function () {
      var files = Array.from(input.files || []);
      input.remove();
      if (!files.length) return;

      var btn = document.getElementById("axlx-line-btn");
      var origText = btn.textContent;
      btn.textContent = "読込中…(" + files.length + "件)";
      btn.disabled = true;

      // ファイルを全部base64に変換
      Promise.all(files.map(function (file) {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function (e) { resolve(e.target.result.split(",")[1]); };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      }))
      .then(function (pdf_data) {
        btn.textContent = "LINE送信中…";
        var today = new Date().toLocaleDateString("ja-JP").replace(/\//g, "-");
        var fileName = "物件まとめ_" + today + ".pdf";

        // 選択した物件のサマリーも追加
        var selectedTargets = tracked.filter(function (t) { return t.cb.checked; });
        var propertySummaries = selectedTargets.length
          ? selectedTargets.map(function (t, i) { return buildPropertySummary(extractCard(t.btn), i); })
          : null;

        return fetch("https://sumora-ai-ui.vercel.app/api/merge-pdfs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pdf_data: pdf_data,
            file_name: fileName,
            send_to_line: true,
            customer_name: customerName || null,
            property_summaries: propertySummaries,
          }),
        });
      })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || "サーバーエラー");
        // 結合PDFをダウンロード
        var bytes = Uint8Array.from(atob(data.pdf), function (c) { return c.charCodeAt(0); });
        var blob = new Blob([bytes], { type: "application/pdf" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = (data.fileName || "物件まとめ.pdf");
        document.body.appendChild(a); a.click();
        setTimeout(function () { a.remove(); }, 100);

        btn.textContent = data.line_sent ? "✅ LINE送信完了！" : "✅ PDF完成（LINE設定なし）";
      })
      .catch(function (e) {
        alert("エラー: " + e.message);
        btn.textContent = origText;
      })
      .finally(function () {
        btn.disabled = false;
        setTimeout(function () { btn.textContent = origText; }, 4000);
      });
    });

    input.click();
  }

  // ── PDF結合・LINE送信（cookieプロキシ方式）──────────
  function mergePdfs(sendToLine, customerName) {
    var urls = getSelectedUrls();
    if (!urls.length) {
      alert("物件を選択してください\n（PDFリンクが検出できない場合は一括DLをお試しください）");
      return;
    }

    var btnId = sendToLine ? "axlx-line-btn" : "axlx-merge-btn";
    var btn = document.getElementById(btnId);
    var origText = btn.textContent;
    btn.textContent = "クッキー取得中...";
    btn.disabled = true;

    var today = new Date().toLocaleDateString("ja-JP").replace(/\//g, "-");
    var fileName = "物件まとめ_" + today + ".pdf";

    // 物件サマリーを生成（LINEに送るときのみ）
    var propertySummaries = null;
    if (sendToLine) {
      var selectedTargets = tracked.filter(function (t) { return t.cb.checked; });
      propertySummaries = selectedTargets.map(function (t, i) {
        return buildPropertySummary(extractCard(t.btn), i);
      });
    }

    // コンテンツスクリプト（ISOLATED world）から直接fetch
    // → ページのCSP制限を受けず・セッションクッキーは共有される
    btn.textContent = "PDF取得中... (0/" + urls.length + ")";

    var completed = 0;
    Promise.all(urls.map(function (url) {
      return fetch(url, { credentials: "include" })
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.arrayBuffer();
        })
        .then(function (buf) {
          completed++;
          btn.textContent = "PDF取得中... (" + completed + "/" + urls.length + ")";
          var bytes = new Uint8Array(buf);
          var binary = "";
          var chunk = 8192;
          for (var i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
          }
          return btoa(binary);
        });
    }))
    .then(function (pdf_data) {
      // 取得したbase64 PDFをサーバーで結合
      btn.textContent = sendToLine ? "PDF送信中..." : "PDF結合中...";

      return fetch("https://sumora-ai-ui.vercel.app/api/merge-pdfs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pdf_data: pdf_data,
          file_name: fileName,
          send_to_line: sendToLine,
          customer_name: customerName || null,
          property_summaries: propertySummaries,
        }),
      });
    })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.ok) throw new Error(data.error || "サーバーエラー");

      // PDFをブラウザにダウンロード
      var bytes = Uint8Array.from(atob(data.pdf), function (c) { return c.charCodeAt(0); });
      var blob = new Blob([bytes], { type: "application/pdf" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { a.remove(); }, 100);

      if (sendToLine && data.line_sent) {
        btn.textContent = "✅ LINE送信完了！";
      } else if (sendToLine) {
        btn.textContent = "✅ PDF完成（LINE設定なし）";
      } else {
        btn.textContent = "✅ PDF完成！";
      }
    })
    .catch(function (e) {
      console.error("[AXLX] PDF結合エラー:", e);
      if (confirm("PDFの取得に失敗しました。\nエラー: " + e.message + "\n\n個別ダウンロードに切り替えますか？")) {
        bulkDownload();
      }
      btn.textContent = origText;
    })
    .finally(function () {
      btn.disabled = false;
      setTimeout(function () { btn.textContent = origText; }, 4000);
    });
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
  window.addEventListener("load", function () { setTimeout(inject, 2000); });
})();
