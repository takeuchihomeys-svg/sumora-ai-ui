// itandi BB 物件資料一括PDF取得 → LINE送信 v2.2.0
// 改善: チェックボックス状態保持 / モーダル操作強化 / AD抽出 / LINE物件サマリー付き
(function () {
  "use strict";

  // ── 状態管理 ────────────────────────────────────────────────────────────
  var tracked     = [];
  var checkedKeys = new Set(); // re-inject時にchecked状態を復元するキー集合
  var injectTimer = null;
  var pdfHookInjected = false;

  function ensurePdfHook() {
    if (pdfHookInjected) return;
    pdfHookInjected = true;
    chrome.runtime.sendMessage({ type: "axlx-inject-pdf-hook" });
  }

  // ── 物件資料ボタンを探す ─────────────────────────────────────────────
  function findMaterialBtns() {
    var seen = new Set();
    var results = [];
    Array.from(document.querySelectorAll("button")).forEach(function (btn) {
      var t = btn.textContent.trim();
      if (t !== "物件資料") return;
      if (seen.has(btn)) return;
      // offsetParent=null でも getBoundingClientRect で存在確認（モーダルの backdrop 対策）
      var r = btn.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      seen.add(btn);
      results.push(btn);
    });
    return results;
  }

  // ── 行のユニークキー生成（re-inject後の状態復元に使用） ─────────────
  function makeRowKey(btn) {
    var el = btn;
    for (var i = 0; i < 10 && el && el !== document.body; i++) {
      el = el.parentElement;
      // itandi の物件URL（/properties/12345）からIDを取得（最安定）
      var links = el.querySelectorAll("a[href]");
      for (var j = 0; j < links.length; j++) {
        var m = (links[j].getAttribute("href") || "").match(/\/properties\/(\w+)/);
        if (m) return "pid_" + m[1];
      }
      // フォールバック: 行テキストの先頭60文字
      var t = el.textContent.replace(/\s+/g, " ").trim().slice(0, 60);
      if (t.length > 20) return t;
    }
    return "pos_" + btn.getBoundingClientRect().top.toFixed(0);
  }

  // ── 広告費・物件名の抽出 ─────────────────────────────────────────────
  function extractPropertyInfo(btn) {
    var el = btn;
    var name = "";
    var ad   = null;

    for (var i = 0; i < 12 && el && el !== document.body; i++) {
      el = el.parentElement;
      var text = el.textContent;

      // 物件名（まだ取得できていない場合）
      if (!name) {
        var nameEl = el.querySelector(
          "h3,h4,h5,[class*='name'],[class*='title'],[class*='building'],[class*='property-name']"
        );
        if (nameEl) name = nameEl.textContent.trim().slice(0, 40);
      }

      // 広告費: 金額表記（例: 広告費 30,000円 / AD 1ヶ月）
      if (!ad) {
        var mYen = text.match(/(?:広告[費料]|AD)[^\d]*([\d,，]+)\s*円/);
        if (mYen) { ad = mYen[1].replace(/[，,]/g, "") + "円"; }
      }
      if (!ad) {
        var mMonth = text.match(/(?:広告[費料]|AD)[^\d]*([\d.]+)\s*[ヶか]月/);
        if (mMonth) { ad = "AD " + mMonth[1] + "ヶ月分"; }
      }
      if (!ad) {
        var mPct = text.match(/(?:広告[費料]|AD)[^\d]*([\d.]+)\s*%/);
        if (mPct) { ad = "AD " + mPct[1] + "%"; }
      }
    }

    return { name: name || "物件", ad: ad };
  }

  // ── チェックボックス注入（re-inject時にchecked状態を保持） ───────────
  function inject() {
    // Step1: 現在の checked 状態を rowKey で保存
    tracked.forEach(function (t) {
      if (t.cb.checked) checkedKeys.add(t.rowKey);
      else              checkedKeys.delete(t.rowKey);
    });

    // Step2: 既存チェックボックスを削除
    document.querySelectorAll(".axlx-itandi-cb").forEach(function (el) { el.remove(); });
    tracked = [];

    // Step3: 再注入 + checked状態を復元
    findMaterialBtns().forEach(function (btn) {
      var container = btn;
      for (var i = 0; i < 5 && container.parentElement && container.parentElement !== document.body; i++) {
        if (container.parentElement.classList &&
            container.parentElement.classList.contains("CommonButton")) {
          container = container.parentElement;
          break;
        }
        container = container.parentElement;
      }

      var cb = document.createElement("input");
      cb.type      = "checkbox";
      cb.className = "axlx-itandi-cb";
      cb.style.cssText = [
        "width:18px;height:18px;margin-right:6px;cursor:pointer;",
        "accent-color:#1565C0;vertical-align:middle;flex-shrink:0;",
      ].join("");
      cb.addEventListener("click",  function (e) { e.stopPropagation(); });
      cb.addEventListener("change", function (e) { e.stopPropagation(); updateBar(); });

      var rowKey = makeRowKey(btn);
      cb.checked = checkedKeys.has(rowKey); // ← 状態復元

      container.parentNode.insertBefore(cb, container);
      tracked.push({ cb: cb, btn: btn, rowKey: rowKey });
    });
    updateBar();
  }

  // ── フローティングバー ──────────────────────────────────────────────
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
    var bar     = document.getElementById("axlx-itandi-bar");
    var checked = tracked.filter(function (t) { return t.cb.checked; });
    bar.style.display = tracked.length > 0 ? "flex" : "none";
    var countEl = document.getElementById("axlx-itandi-count");
    if (countEl) countEl.textContent = checked.length + "件";
    var allBtn = document.getElementById("axlx-itandi-all-btn");
    if (allBtn) allBtn.textContent =
      (checked.length === tracked.length && tracked.length > 0) ? "全解除" : "全選択";
  }

  function toggleAll() {
    var checked = tracked.filter(function (t) { return t.cb.checked; });
    var s = checked.length < tracked.length;
    tracked.forEach(function (t) {
      t.cb.checked = s;
      if (s) checkedKeys.add(t.rowKey); else checkedKeys.delete(t.rowKey);
    });
    updateBar();
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ── モーダルの要素を可視・不可視問わず取得（itandi は transition中でrect=0になる） ─
  function findInModal(selector) {
    return Array.from(document.querySelectorAll(selector)).filter(function (el) {
      // 完全に hidden でなければOK（transitioning中は rect=0 だが parentElement!=nullで判定）
      return el.parentElement !== null && el.closest("body") !== null;
    });
  }

  function findBtnByText(text) {
    return Array.from(document.querySelectorAll("button")).filter(function (b) {
      return b.textContent.trim().includes(text) && b.parentElement !== null;
    });
  }

  // ── Reactのradioinputを確実に変更する ────────────────────────────────
  function setReactRadio(el) {
    // ネイティブclickだけでは React の state が更新されないことがあるため
    // nativeInputValueSetter + change event で強制更新
    try {
      var nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "checked"
      ).set;
      nativeSetter.call(el, true);
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    } catch (_) {
      el.click();
    }
  }

  // ── 1件のPDFをキャプチャ ─────────────────────────────────────────────
  function captureOnePdf(btn) {
    return new Promise(function (resolve, reject) {
      var pdfTimer;
      var modalObs = null;

      function cleanup() {
        clearTimeout(pdfTimer);
        window.removeEventListener("message", pdfHandler);
        if (modalObs) { modalObs.disconnect(); modalObs = null; }
      }

      // PDF blobをMAINワールドフックから受信
      var pdfHandler = function (e) {
        if (!e.data || e.data.from !== "axlx-itandi-pdf") return;
        cleanup();
        resolve(e.data.b64);
      };
      window.addEventListener("message", pdfHandler);

      pdfTimer = setTimeout(function () {
        cleanup();
        reject(new Error("タイムアウト（40秒）: PDFが生成されませんでした"));
      }, 40000);

      // モーダル内で「12枚」ラジオ選択 → PDFを出力クリック
      function interactWithModal() {
        // 「間取り図＋写真12枚」ラジオを探す（rectチェックなし）
        var selected = false;

        // パターン1: label テキストに「12枚」含む
        var labels = findInModal("label").filter(function (l) {
          return l.textContent.includes("12枚");
        });
        if (labels.length) {
          var lbl = labels[labels.length - 1];
          var radio = lbl.querySelector("input[type='radio']");
          if (radio) {
            setReactRadio(radio);
            selected = true;
          } else {
            lbl.click();
            selected = true;
          }
          console.log("[AXLX] 12枚ラジオ選択:", lbl.textContent.trim());
        }

        // パターン2: ラジオボタンのvalue/idに「12」含む
        if (!selected) {
          var radios = findInModal("input[type='radio']").filter(function (r) {
            return (r.value || r.id || "").includes("12") ||
                   (r.labels && r.labels[0] && r.labels[0].textContent.includes("12"));
          });
          if (radios.length) {
            setReactRadio(radios[radios.length - 1]);
            selected = true;
            console.log("[AXLX] ラジオ(12)選択:", radios[radios.length - 1].id);
          }
        }

        if (!selected) {
          console.warn("[AXLX] 12枚ラジオが見つかりません。現在のラジオ一覧:");
          findInModal("input[type='radio']").forEach(function(r){
            console.log("  radio:", r.id, r.name, r.value, r.labels[0]&&r.labels[0].textContent.trim());
          });
        }

        sleep(500).then(function () {
          // 「PDFを出力」ボタンをクリック
          var pdfBtns = findBtnByText("PDFを出力");
          if (pdfBtns.length) {
            console.log("[AXLX] PDFを出力クリック");
            pdfBtns[pdfBtns.length - 1].click();
          } else {
            // フォールバック: 「出力」「生成」「ダウンロード」を含むボタン
            var fallback = findBtnByText("出力").concat(findBtnByText("生成")).concat(findBtnByText("PDF"));
            var dlBtn = fallback.find(function(b){ return !b.textContent.includes("物件資料"); });
            if (dlBtn) {
              console.log("[AXLX] フォールバックボタンクリック:", dlBtn.textContent.trim());
              dlBtn.click();
            } else {
              console.error("[AXLX] PDFを出力ボタンが見つかりません");
              // 診断: 現在のボタン一覧をログ
              findBtnByText("").slice(0,20).forEach(function(b){
                console.log("  available btn:", b.textContent.trim().slice(0,50));
              });
              cleanup();
              reject(new Error("「PDFを出力」ボタンが見つかりません"));
            }
          }
        });
      }

      // 物件資料ボタンをクリック
      btn.click();

      // MutationObserver でモーダルの出現を監視
      // 「PDFを出力」が現れたら操作開始（rectチェックなし）
      var appeared = false;
      modalObs = new MutationObserver(function () {
        if (appeared) return;
        var btns = findBtnByText("PDFを出力");
        if (!btns.length) return;
        appeared = true;
        modalObs.disconnect();
        modalObs = null;
        // モーダルの描画が完全に終わるまで少し待つ
        setTimeout(interactWithModal, 600);
      });
      modalObs.observe(document.body, { childList: true, subtree: true });
    });
  }

  // ── モーダルを閉じる ─────────────────────────────────────────────────
  function closeModal() {
    var closeBtn = document.querySelector("button[aria-label='閉じる']");
    if (closeBtn) { closeBtn.click(); return; }
    findBtnByText("キャンセル").concat(findBtnByText("閉じる")).forEach(function (b) {
      var r = b.getBoundingClientRect();
      if (r.width > 0 || b.parentElement) b.click();
    });
  }

  // ── popup.js からお客さん名を取得 ────────────────────────────────────
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

  // ── LINE送信メイン ────────────────────────────────────────────────────
  function onSendToLine() {
    var targets = tracked.filter(function (t) { return t.cb.checked; });
    if (!targets.length) { alert("物件を選択してください"); return; }

    var lineBtn  = document.getElementById("axlx-itandi-line-btn");
    var lineOrig = lineBtn.textContent;
    lineBtn.disabled  = true;
    lineBtn.textContent = "準備中...";

    getCustomerFromPopup(function (customerName) {
      startSend(targets, customerName, lineBtn, lineOrig);
    });
  }

  function startSend(targets, customerName, lineBtn, lineOrig) {
    // 送信前に各物件の情報（名前・AD）を収集
    var propertyInfos = targets.map(function (t, i) {
      return extractPropertyInfo(t.btn);
    });

    lineBtn.textContent = "PDF取得中... (0/" + targets.length + ")";
    var pdfBase64List = [];

    function processNext(i) {
      if (i >= targets.length) {
        // 全件取得完了 → LINE送信
        if (!pdfBase64List.length) {
          alert("PDFが1件も取得できませんでした");
          lineBtn.disabled    = false;
          lineBtn.textContent = lineOrig;
          return;
        }

        // 物件サマリー生成（名前 + AD）
        var propertySummaries = pdfBase64List.map(function (_, j) {
          var info  = propertyInfos[j] || { name: "物件" + (j + 1), ad: null };
          var lines = ["【" + (j + 1) + "】" + info.name];
          if (info.ad) lines.push("AD: " + info.ad);
          return lines.join("\n");
        });

        lineBtn.textContent = "LINE送信中...";
        var today = new Date().toLocaleDateString("ja-JP").replace(/\//g, "-");
        chrome.runtime.sendMessage({
          type:               "axlx-send-pdf-data-to-line",
          pdf_data:           pdfBase64List,
          file_name:          "物件まとめ_" + today + ".pdf",
          customer_name:      customerName || null,
          property_summaries: propertySummaries,
        }, function (resp) {
          lineBtn.disabled    = false;
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            var errMsg = resp ? resp.error : (chrome.runtime.lastError ? chrome.runtime.lastError.message : "不明");
            alert("LINE送信エラー:\n" + errMsg);
            lineBtn.textContent = lineOrig;
            return;
          }
          // 選択をリセット
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
      captureOnePdf(targets[i].btn)
        .then(function (b64) {
          console.log("[AXLX] PDF取得成功 " + (i + 1) + "件目 (" + b64.length + " chars)");
          pdfBase64List.push(b64);
          return sleep(1500);
        })
        .then(function () { processNext(i + 1); })
        .catch(function (e) {
          console.error("[AXLX] PDF取得失敗 " + (i + 1) + "件目:", e.message);
          closeModal();
          sleep(800).then(function () { processNext(i + 1); });
        });
    }

    processNext(0);
  }

  // ── MutationObserver（チェックボックスの再注入） ──────────────────────
  var mutObs = new MutationObserver(function () {
    if (injectTimer) return;
    // 物件資料ボタンにチェックボックスが付いていないものがあれば再注入
    var btns   = findMaterialBtns();
    var uninj  = btns.filter(function (b) {
      var prev = b;
      for (var i = 0; i < 6 && prev.parentElement; i++) {
        prev = prev.parentElement;
        if (prev.querySelector(".axlx-itandi-cb")) return false; // 既存あり
        if (prev.classList && prev.classList.contains("CommonButton")) break;
      }
      return true; // チェックボックスなし
    });
    if (uninj.length > 0) {
      injectTimer = setTimeout(function () { inject(); injectTimer = null; }, 400);
    }
  });

  function start() {
    ensureBar();
    ensurePdfHook();
    setTimeout(inject, 1500);
    mutObs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
  window.addEventListener("load", function () { setTimeout(inject, 2500); });
})();
