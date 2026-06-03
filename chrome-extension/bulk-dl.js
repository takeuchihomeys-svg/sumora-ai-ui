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
      "position:fixed;bottom:24px;right:24px;z-index:2147483647;",
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
    document.getElementById("axlx-merge-btn").addEventListener("click", function() { mergePdfs(false); });
    document.getElementById("axlx-line-btn").addEventListener("click", function() { mergePdfs(true); });
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
    return tracked.filter(function (t) { return t.cb.checked && t.btn.href; }).map(function (t) { return t.btn.href; });
  }

  // ── 一括DL（既存） ────────────────────────────────
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

  // ── PDF結合・LINE送信（新）────────────────────────
  function mergePdfs(sendToLine) {
    var urls = getSelectedUrls();
    if (!urls.length) { alert("物件を選択してください"); return; }

    var btn = document.getElementById(sendToLine ? "axlx-line-btn" : "axlx-merge-btn");
    var origText = btn.textContent;
    btn.textContent = "処理中...";
    btn.disabled = true;

    var today = new Date().toLocaleDateString("ja-JP").replace(/\//g, "-");
    var fileName = "物件まとめ_" + today + ".pdf";

    // 全PDFをfetchしてbase64に変換（認証クッキー付き）
    Promise.all(urls.map(function(url) {
      return fetch(url, {
        credentials: "include",
        headers: { "Referer": location.href },
      })
        .then(function(r) {
          if (!r.ok) throw new Error("HTTP " + r.status + ": " + url);
          return r.arrayBuffer();
        })
        .then(function(buf) {
          var bytes = new Uint8Array(buf);
          var binary = "";
          for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          return btoa(binary);
        });
    }))
    .then(function(pdf_data) {
      return fetch("https://sumora-ai-ui.vercel.app/api/merge-pdfs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdf_data: pdf_data, file_name: fileName, send_to_line: sendToLine }),
      });
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.ok) throw new Error(data.error || "失敗");

      // PDFをダウンロード
      var bytes = Uint8Array.from(atob(data.pdf), function(c) { return c.charCodeAt(0); });
      var blob = new Blob([bytes], { type: "application/pdf" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      setTimeout(function() { a.remove(); }, 100);

      if (sendToLine && data.line_sent) {
        btn.textContent = "✅ LINE送信完了！";
      } else if (sendToLine) {
        btn.textContent = "✅ DL完了（LINE送信失敗）";
      } else {
        btn.textContent = "✅ ダウンロード完了！";
      }
    })
    .catch(function(e) {
      console.error("[AXLX] PDF結合エラー:", e);
      alert("エラー: " + e.message + "\n\nDevToolsのコンソールで詳細を確認してください。");
      btn.textContent = origText;
    })
    .finally(function() {
      btn.disabled = false;
      setTimeout(function() { btn.textContent = origText; }, 3000);
    });
  }

  // ── まとめて印刷（プレビュー）────────────────────────
  function printMerged() {
    var urls = getSelectedUrls();
    if (!urls.length) { alert("物件を選択してください"); return; }

    var win = window.open("", "_blank", "width=960,height=900");
    var iframes = urls.map(function (u, i) {
      return '<div class="page"><div class="label">物件 ' + (i + 1) + ' / ' + urls.length + '</div><iframe src="' + u + '" allowfullscreen></iframe></div>';
    }).join("");

    win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>物件まとめ印刷</title><style>' +
      'body{margin:0;background:#eee;font-family:sans-serif}' +
      '.ctrl{position:fixed;top:12px;right:12px;z-index:9999;display:flex;gap:8px;background:rgba(0,0,0,0.7);padding:8px 12px;border-radius:10px}' +
      '.ctrl button{padding:8px 14px;border:none;border-radius:6px;font-weight:bold;cursor:pointer;font-size:13px}' +
      '.print-btn{background:#1565C0;color:#fff}' +
      '.close-btn{background:#fff;color:#333}' +
      '.page{background:#fff;margin:12px auto;max-width:900px;box-shadow:0 2px 8px rgba(0,0,0,0.2);position:relative}' +
      '.label{background:#1565C0;color:#fff;font-size:11px;font-weight:bold;padding:4px 10px}' +
      'iframe{width:100%;height:1050px;border:none;display:block}' +
      '@media print{.ctrl{display:none!important}.page{box-shadow:none;margin:0;max-width:100%;page-break-after:always}iframe{height:100vh}}' +
      '</style></head><body>' +
      '<div class="ctrl">' +
      '<button class="print-btn" onclick="window.print()">🖨️ PDF保存（' + urls.length + '枚まとめて）</button>' +
      '<button class="close-btn" onclick="window.close()">✕ 閉じる</button>' +
      '</div>' + iframes + '</body></html>');
    win.document.close();
  }

  // ── 画像保存（新）────────────────────────────────
  function extractCard(btn) {
    var row = btn;
    while (row && row.tagName !== "TR") row = row.parentElement;

    // 建物名を探す（上位のテーブルや見出し）
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
    // 建物名が取れない場合はテーブル直前の要素から
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

  function downloadImages() {
    var targets = tracked.filter(function (t) { return t.cb.checked; });
    if (!targets.length) { alert("物件を選択してください"); return; }

    var cards = targets.map(function (t) { return extractCard(t.btn); });

    var W = 680, CARD_H = 130, GAP = 8, PAD = 14;
    var canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = PAD * 2 + cards.length * (CARD_H + GAP);
    var ctx = canvas.getContext("2d");

    // 背景
    ctx.fillStyle = "#f0f4f8";
    ctx.fillRect(0, 0, W, canvas.height);

    cards.forEach(function (card, i) {
      var x = PAD;
      var y = PAD + i * (CARD_H + GAP);
      var w = W - PAD * 2;

      // カード背景
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(x, y, w, CARD_H, 8);
      } else {
        ctx.rect(x, y, w, CARD_H);
      }
      ctx.fill();

      // 左アクセントバー
      ctx.fillStyle = "#1565C0";
      ctx.fillRect(x, y, 4, CARD_H);

      // 番号バッジ
      ctx.fillStyle = "#1565C0";
      ctx.beginPath();
      ctx.arc(x + 18, y + 16, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(i + 1), x + 18, y + 20);
      ctx.textAlign = "left";

      // 建物名
      ctx.fillStyle = "#1565C0";
      ctx.font = "bold 13px 'Hiragino Sans', 'Meiryo', sans-serif";
      ctx.fillText(card.name.slice(0, 32), x + 34, y + 20);

      // 区切り線
      ctx.strokeStyle = "#e3eaf3";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 12, y + 28);
      ctx.lineTo(x + w - 12, y + 28);
      ctx.stroke();

      // 物件情報テキスト
      ctx.fillStyle = "#444";
      ctx.font = "11px 'Hiragino Sans', 'Meiryo', sans-serif";
      var lineH = 16;
      card.texts.forEach(function (t, j) {
        if (j >= 6) return;
        var col = j % 2 === 0 ? x + 14 : x + w / 2;
        var row2 = y + 38 + Math.floor(j / 2) * lineH;
        ctx.fillText(t.slice(0, 28), col, row2);
      });
    });

    // 日付フッター
    ctx.fillStyle = "#90a4ae";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    var today = new Date().toLocaleDateString("ja-JP");
    ctx.fillText("スモラ物件リスト " + today, W - PAD, canvas.height - 6);

    canvas.toBlob(function (blob) {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "物件リスト_" + today.replace(/\//g, "-") + ".png";
      document.body.appendChild(a);
      a.click();
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
