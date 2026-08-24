// itandi BB 物件資料一括PDF取得 → LINE送信 v2.3.0
// 改善: チェックボックス状態保持 / モーダル操作強化 / AD抽出 / LINE物件サマリー付き / 全ページ自動送信
(function () {
  "use strict";

  // ── 状態管理 ────────────────────────────────────────────────────────────
  var tracked     = [];
  var checkedKeys = new Set(); // re-inject時にchecked状態を復元するキー集合
  var injectTimer = null;
  var pdfHookInjected = false;

  // ── 全ページ自動送信の状態 ─────────────────────────────────────────────
  var _autoSendArmed = false;
  var _autofillInitiated = false;
  var _preAutofillBtns = new Set();
  var _pendingAutoSendDispatched = false;
  var _autoSendInProgress = false;
  var _zeroDetectTimer = null; // 0件確定ポーリング（15秒）タイマー

  // ── スタッフモードキャッシュ（bulk-dl.js と同じ TTL=2時間ロジック）──
  var _staffModeOn = false;
  try {
    chrome.storage.local.get(["staffMode", "staffModeAt"], function(res) {
      var on = !!(res && res.staffMode);
      var at = (res && res.staffModeAt) || 0;
      _staffModeOn = on && (!at || Date.now() - at <= 2 * 60 * 60 * 1000);
    });
    chrome.storage.local.onChanged.addListener(function(changes) {
      if ("staffMode" in changes) {
        _staffModeOn = !!changes.staffMode.newValue;
        if (_staffModeOn) {
          _autoSendArmed = false;
          _pendingAutoSendDispatched = false;
        }
      }
    });
  } catch (_) { /* ignore */ }

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

  // ── 住所から市区を抽出（bulk-dl.js と同じロジック） ──────────────────
  function trimToCity(addr) {
    var m = addr.match(/([^都道府県\s　、]{1,6}市)/);
    if (m) return m[1];
    var m2 = addr.match(/([^都道府県\s　、]{1,6}[区郡])/);
    return m2 ? m2[1] : "";
  }

  // ── itandi 物件カードから住所（市区）を抽出 ─────────────────────────
  function extractCityFromCard(btn) {
    var el = btn;
    for (var i = 0; i < 12 && el && el !== document.body; i++) {
      el = el.parentElement;
      var fullText = (el.textContent || "").replace(/\s+/g, " ");
      // 「所在地：○○市△△」形式を優先
      var m = fullText.match(/所在地[：:]\s*([^\n\r]{2,40})/);
      if (m) return trimToCity(m[1]);
      // 住所ラベルも試す
      var m2 = fullText.match(/住所[：:]\s*([^\n\r]{2,40})/);
      if (m2) return trimToCity(m2[1]);
    }
    return "";
  }

  // ── SUUMO 検索ボタン注入 ──────────────────────────────────────────────
  function injectSuumoButtons() {
    document.querySelectorAll(".axlx-itandi-suumo-btn").forEach(function (el) { el.remove(); });
    findMaterialBtns().forEach(function (btn) {
      // 既に注入済みなら skip
      var container = btn;
      for (var i = 0; i < 5 && container.parentElement && container.parentElement !== document.body; i++) {
        if (container.parentElement.classList &&
            container.parentElement.classList.contains("CommonButton")) {
          container = container.parentElement;
          break;
        }
        container = container.parentElement;
      }
      if (container.parentNode.querySelector(".axlx-itandi-suumo-btn")) return;

      var info = extractPropertyInfo(btn);
      var city = extractCityFromCard(btn);
      var _n = info.name;
      var _a = city;

      var suumoBtn = document.createElement("button");
      suumoBtn.className = "axlx-itandi-suumo-btn";
      suumoBtn.textContent = "🔍 SUUMO";
      suumoBtn.title = (_n || "物件名") + (_a ? " " + _a : "") + " SUUMO でGoogle検索";
      suumoBtn.style.cssText = [
        "display:inline-flex;align-items:center;gap:3px;",
        "padding:4px 10px;margin:2px 4px;",
        "background:#00a55b;color:#fff;",
        "border:none;border-radius:6px;",
        "font-size:12px;font-weight:700;cursor:pointer;",
        "box-shadow:0 1px 4px rgba(0,0,0,0.18);",
        "white-space:nowrap;vertical-align:middle;",
      ].join("");
      suumoBtn.addEventListener("mouseover", function () { this.style.background = "#007a44"; });
      suumoBtn.addEventListener("mouseout",  function () { this.style.background = "#00a55b"; });
      suumoBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        var q = [_n, _a, "SUUMO"].filter(Boolean).join(" ");
        window.open("https://www.google.com/search?q=" + encodeURIComponent(q), "_blank");
      });

      container.parentNode.insertBefore(suumoBtn, container.nextSibling);
    });
  }

  // ── チェックボックス注入（re-inject時にchecked状態を保持） ───────────
  function inject() {
    // Step1: 現在の checked 状態を rowKey で保存
    tracked.forEach(function (t) {
      if (t.cb.checked) checkedKeys.add(t.rowKey);
      else              checkedKeys.delete(t.rowKey);
    });

    // Step2: 既存チェックボックス・SUUMOボタンを削除
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
    injectSuumoButtons();

    // 全ページ自動送信: autofill後に新しいボタンが出現したら自動発火
    if (_autoSendArmed && tracked.length > 0 && !_pendingAutoSendDispatched && !_autoSendInProgress) {
      var _hasNewBtn = tracked.some(function(item) { return !_preAutofillBtns.has(item.btn); });
      if (_hasNewBtn) {
        _autoSendArmed = false;
        _pendingAutoSendDispatched = true;
        if (_staffModeOn) {
          console.log("[AXLX itandi] スタッフモード中 → 自動送信スキップ（検索結果のみ表示）");
        } else {
          console.log("[AXLX itandi] 新結果検出 → 全ページ自動送信開始");
          setTimeout(autoSendAllPages, 500 + Math.floor(Math.random() * 700));
        }
      }
    }
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
      '  <button id="axlx-itandi-all-pages-btn" style="flex:2;padding:6px 8px;background:#1565C0;border:none;border-radius:8px;color:white;font-size:12px;font-weight:700;cursor:pointer;">🔄 全ページ送る</button>',
      "</div>",
    ].join("");
    document.body.appendChild(bar);
    document.getElementById("axlx-itandi-all-btn").addEventListener("click", toggleAll);
    document.getElementById("axlx-itandi-line-btn").addEventListener("click", onSendToLine);
    document.getElementById("axlx-itandi-all-pages-btn").addEventListener("click", function() { autoSendAllPages(true); }); // 手動=スタッフモードでも許可
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

  // ── 進捗バー更新（captureOnePdf 内から現在ステップを表示） ─────────────
  function setStatusBar(text) {
    var btn = document.getElementById("axlx-itandi-line-btn");
    if (btn) btn.textContent = text; // disabled 中でも更新（進捗表示のため）
  }

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

  // ── モーダルを3段階フォールバックで検索 ────────────────────────────
  function findOpenModal() {
    return (
      document.querySelector('.itandi-bb-ui__Modalv2[role="dialog"]') ||
      document.querySelector('[class*="itandi-bb-ui__Modal"][role="dialog"]') ||
      document.querySelector('[class*="itandi"][role="dialog"]') ||
      document.querySelector('[role="dialog"]')
    );
  }

  // ── 1件のPDFをキャプチャ ─────────────────────────────────────────────
  function captureOnePdf(btn) {
    return new Promise(function (resolve, reject) {
      var pdfTimer;
      var modalObs = null;
      var pollTimer = null;
      var pdfHandler = null; // クリック直前に生成してタイムスタンプ以降のみ受付

      function cleanup() {
        clearTimeout(pdfTimer);
        clearInterval(pollTimer);
        if (pdfHandler) window.removeEventListener("message", pdfHandler);
        if (modalObs) { modalObs.disconnect(); modalObs = null; }
      }

      pdfTimer = setTimeout(function () {
        cleanup();
        reject(new Error("タイムアウト（60秒）: PDFが生成されませんでした"));
      }, 60000);

      // モーダル内で「12枚」ラジオ選択 → PDFを出力クリック
      function interactWithModal() {
        // ガード: 所在地選択モーダル（regionName ラジオあり）はitandi-page-script.jsが処理するのでスキップ
        if (document.querySelector('input[name="regionName"]') || document.querySelector('input[name="prefectureId"]')) {
          console.log("[AXLX] 所在地選択モーダル検出 → interactWithModal スキップ");
          return;
        }

        // ── 「間取り図＋写真12枚」ラジオ選択 ────────────────────────────
        // 黄金ルール#1: MUI hidden radioはlabel.click()が正解（inp.click()は無効）
        function clickRadioLabel(inputEl) {
          var lbl = inputEl.closest ? inputEl.closest("label") : null;
          if (!lbl && inputEl.labels && inputEl.labels[0]) lbl = inputEl.labels[0];
          if (lbl) { lbl.click(); return true; }
          setReactRadio(inputEl); // labelが見つからない場合のフォールバック
          return false;
        }

        // ── ラジオ選択（5段階フォールバック） ─────────────────────────────
        var modal = findOpenModal();
        var modalEl = modal || document;

        // フォールバック1: 旧セレクタ（name=layoutType, value=detailed）
        var radio12 = document.querySelector('input[name="layoutType"][value="detailed"]');

        // フォールバック2: モーダル内全ラジオ（name/value問わず）からラベルテキストで検索
        if (!radio12) {
          var allModalInputRadios = Array.from(modalEl.querySelectorAll('input[type="radio"]'));
          // 診断: モーダル内の全ラジオ情報をログ（name/value/labelが判明する）
          console.warn("[AXLX] layoutType=detailed 未発見。モーダル内ラジオ全件:",
            allModalInputRadios.map(function(r) {
              var lbl = (r.labels && r.labels[0]) ? r.labels[0].textContent.trim() : "?";
              return "name=" + (r.name || "?") + " value=" + (r.value || "?") + " label=" + lbl;
            }).join(" | ") || "（ラジオなし）"
          );
          radio12 = allModalInputRadios.find(function(r) {
            // labels[0] → closest("label") → aria-label の優先順で取得
            var labelEl = (r.labels && r.labels[0]) || (r.closest ? r.closest("label") : null);
            var lbl = labelEl ? labelEl.textContent : (r.getAttribute("aria-label") || "");
            return lbl.includes("12枚") || lbl.includes("間取り図");
          }) || null;
          if (radio12) {
            console.log("[AXLX] ラジオ発見 (label=12枚/間取り図):", radio12.name, "=", radio12.value);
          } else if (allModalInputRadios.length > 0) {
            // フォールバック2b: 最後の input[type=radio]（最も詳細な選択肢が末尾の可能性）
            radio12 = allModalInputRadios[allModalInputRadios.length - 1];
            console.warn("[AXLX] 12枚ラベルなし。最後のラジオを選択:", radio12.name, "=", radio12.value);
          }
        }

        // フォールバック3: role="radio" 要素（MUI や Headless UI のカスタムラジオ）
        if (!radio12) {
          var ariaRadios = Array.from(modalEl.querySelectorAll('[role="radio"]'));
          console.warn("[AXLX] input[type=radio]なし。role=radio件数:", ariaRadios.length,
            ariaRadios.map(function(el){ return '"' + el.textContent.trim().slice(0, 20) + '"'; }).join(", ")
          );
          var ar12 = ariaRadios.find(function(el) {
            var t = el.textContent.trim();
            return t.includes("12枚") || t.includes("間取り図");
          });
          if (ar12) { ar12.click(); console.log("[AXLX] role=radio クリック:", ar12.textContent.trim().slice(0,20)); setStatusBar("ラジオ選択(role=radio)・PDFボタン待ち..."); }
          else if (ariaRadios.length > 0) {
            // フォールバック4: 最後のrole=radioを選択（最も詳細な選択肢が末尾の場合）
            ariaRadios[ariaRadios.length - 1].click();
            console.log("[AXLX] role=radio 最後の選択肢クリック:", ariaRadios[ariaRadios.length - 1].textContent.trim().slice(0,20));
            setStatusBar("ラジオ(最終選択肢)・PDFボタン待ち...");
          } else {
            // モーダル内の全input要素もログ（何があるか把握）
            var allInputs = Array.from(modalEl.querySelectorAll("input,select"));
            console.warn("[AXLX] ラジオ系要素ゼロ。モーダル内input全件:", allInputs.map(function(el){ return el.tagName + " type=" + el.type + " name=" + el.name; }).join(", "));
            setStatusBar("ラジオ未発見・PDFボタン探索中...");
          }
        }

        if (radio12) {
          var usedLabel = clickRadioLabel(radio12);
          console.log("[AXLX] 12枚ラジオ選択完了 label=" + usedLabel);
          setStatusBar("ラジオ選択(12枚)・PDFボタン待ち...");
        }

        // ラジオ変更がReact stateに反映されるまで500ms待機してからPDFボタンを探す
        // PDFボタンが未描画の場合は250msごとにポーリング（最大3秒）
        var pdfPollTries = 0;
        var maxPdfPollTries = 12; // 12 × 250ms = 3秒

        function findAndClickPdf() {
          pdfPollTries++;
          var modal = findOpenModal();
          // disabled ボタンは除外（ラジオ変更前に描画されたグレーアウトボタンを誤クリック防止）
          function isClickable(b) { return b && b.parentElement && !b.disabled; }
          var pdfBtn =
            (modal && Array.from(modal.querySelectorAll('[class*="ModalFooter"] button,[class*="Footer"] button')).filter(isClickable).pop()) ||
            (function(b){ return isClickable(b) ? b : null; })(document.querySelector('.itandi-bb-ui__ModalFooter__Right button')) ||
            (function(b){ return isClickable(b) ? b : null; })(document.querySelector('button.itandi-bb-ui__Button__Variant--primary[type="submit"]')) ||
            Array.from(document.querySelectorAll("button")).find(function (b) {
              if (!isClickable(b)) return false;
              var t = b.textContent.trim();
              return t.includes("PDFを出力") || t.includes("PDF出力") || t === "出力" || t.includes("ダウンロード");
            }) ||
            // モーダル内の最後の有効ボタン（最終フォールバック）
            (modal && Array.from(modal.querySelectorAll('button[type="submit"],button')).filter(isClickable).pop()) || null;

          if (!pdfBtn) {
            if (pdfPollTries < maxPdfPollTries) {
              console.log("[AXLX] PDFボタン待機中... (" + pdfPollTries + "/" + maxPdfPollTries + ")");
              setStatusBar("PDFボタン探索中 (" + pdfPollTries + "/" + maxPdfPollTries + ")...");
              setTimeout(findAndClickPdf, 250);
              return;
            }
            var dlgBtns = Array.from(document.querySelectorAll('[role="dialog"] button'));
            console.error("[AXLX] PDFを出力ボタンが見つかりません（ポーリング終了）。モーダル内ボタン一覧:",
              dlgBtns.map(function(b){ return '"' + b.textContent.trim().slice(0,20) + '"' + (b.disabled ? "(disabled)" : ""); })
            );
            setStatusBar("❌ PDFボタン未発見（コンソールで確認）");
            cleanup();
            reject(new Error("「PDFを出力」ボタンが見つかりません"));
            return;
          }

          var pdfBtnText = pdfBtn.textContent.trim().slice(0, 15);
          console.log("[AXLX] PDFボタン発見:", pdfBtnText, "(試行" + pdfPollTries + "回目)");
          setStatusBar("PDFボタン[" + pdfBtnText + "]クリック!");
          // クリック直前にタイムスタンプを記録し、それ以降のblobのみ受け付ける
          var captureStart = Date.now();
          pdfHandler = function (e) {
            if (!e.data || e.data.from !== "axlx-itandi-pdf") return;
            // ts が付いている場合はクリック前のものを除外
            if (typeof e.data.ts === "number" && e.data.ts < captureStart) {
              console.log("[AXLX] 古いblobをスキップ (ts=" + e.data.ts + " < start=" + captureStart + ")");
              return;
            }
            cleanup();
            // itandiが生成した <a download="物件名.pdf"> からファイル名を取得
            var b64captured = e.data.b64;
            setTimeout(function () {
              var dlName = null;
              var dlLink = document.querySelector('a[download$=".pdf"]') ||
                           document.querySelector('[role="dialog"] a[download]') ||
                           document.querySelector('.itandi-bb-ui__Modalv2 a[download]');
              if (dlLink) {
                var fname = dlLink.getAttribute("download") || "";
                dlName = fname.replace(/\.pdf$/i, "").trim() || null;
                console.log("[AXLX] 物件名(download属性):", dlName);
              }
              resolve({ b64: b64captured, name: dlName });
            }, 150 + Math.floor(Math.random() * 250));
          };
          window.addEventListener("message", pdfHandler);
          // JSフック失敗時フォールバック：background.jsにダウンロード監視を依頼
          chrome.runtime.sendMessage({ type: "axlx-itandi-watch-download" });
          // axlx-start-pdf-capture を送ってから 60ms 待機してクリック
          window.postMessage({ from: "axlx-start-pdf-capture" }, "*");
          // cross-origin iframeにも同シグナルを送信（PDF生成がiframe内の場合に対応）
          document.querySelectorAll("iframe").forEach(function(fr) {
            try { fr.contentWindow.postMessage({ from: "axlx-start-pdf-capture" }, "*"); } catch(e) {}
          });
          console.log("[AXLX] PDFを出力クリック (captureStart=" + captureStart + ")");
          setTimeout(function() {
            pdfBtn.click();
            setStatusBar("PDFキャプチャ待機中...(最大60秒)");
          }, 40 + Math.floor(Math.random() * 60));
        }

        // ラジオ選択後500ms待機してからPDFボタン探索開始
        setTimeout(findAndClickPdf, 300 + Math.floor(Math.random() * 450));
      }

      // 物件資料ボタンをクリック（画面外の場合はスクロールして確実にクリックできる状態にする）
      console.log("[AXLX] 物件資料ボタンをクリック");
      setStatusBar("物件資料クリック...");
      try { btn.scrollIntoView({ behavior: "instant", block: "center" }); } catch(e) {}
      btn.click();

      // MutationObserver でモーダルの出現を監視（3段階フォールバック）
      var appeared = false;
      function tryDetectModal() {
        if (appeared) return;
        var modal = findOpenModal();
        if (!modal) return;
        appeared = true;
        if (modalObs) { modalObs.disconnect(); modalObs = null; }
        clearInterval(pollTimer);
        console.log("[AXLX] モーダル検出 (class=" + modal.className.slice(0, 60) + ")");
        setStatusBar("モーダル検出・2秒待機...");
        // 黄金ルール#4: itandiモーダルは1000msでは描画未完了→2000ms待機
        setTimeout(interactWithModal, 1400 + Math.floor(Math.random() * 1400));
      }

      modalObs = new MutationObserver(tryDetectModal);
      modalObs.observe(document.body, { childList: true, subtree: true });

      // MutationObserverが検知できない場合のポーリングバックアップ（500ms毎・最大15秒）
      pollTimer = setInterval(tryDetectModal, 500);
      setTimeout(function() {
        clearInterval(pollTimer);
        // モーダルが15秒以内に現れなければ即時リジェクト（60秒タイムアウトを待たない）
        if (!appeared) {
          cleanup();
          reject(new Error("モーダルが15秒以内に表示されませんでした（ボタンクリック失敗の可能性）"));
        }
      }, 15000);
    });
  }

  // ── PDF取得リトライラッパー（最大1回リトライ・失敗時フック再注入） ──
  async function captureOnePdfWithRetry(btn) {
    try {
      return await captureOnePdf(btn);
    } catch (e) {
      console.warn("[AXLX] PDF取得失敗（1回目）→ リトライ:", e.message);
      closeModal();
      pdfHookInjected = false;
      ensurePdfHook();
      await sleep(700 + Math.floor(Math.random() * 1200));
      return captureOnePdf(btn);
    }
  }

  // ── モーダルを閉じる ─────────────────────────────────────────────────
  function closeModal() {
    var closeBtn = document.querySelector("button[aria-label='閉じる']");
    if (closeBtn) { closeBtn.click(); return; }
    findBtnByText("キャンセル").concat(findBtnByText("閉じる")).forEach(function (b) {
      var r = b.getBoundingClientRect();
      if (r.width > 0) b.click(); // 可視ボタンのみクリック（b.parentElementは常にtruthyなので除外）
    });
  }

  // ── popup.js からお客さん名＋IDを取得 ────────────────────────────────
  // popup未応答・未選択時は chrome.storage.local の最終選択顧客（名前・ID・条件）に
  // フォールバックする（bulk-dl.js と同一挙動。条件が無いと LINE の
  // 「🌟 一番オススメ」AIランキングが顧客条件なしで実行されてしまう）
  function getCustomerFromPopup(callback) {
    var timer;
    var storageFallback = function (liveId, liveConditions) {
      try {
        chrome.storage.local.get(["current_customer_name", "current_customer_id", "current_customer_conditions"], function (data) {
          data = data || {};
          callback(data.current_customer_name || null, liveId || data.current_customer_id || null, liveConditions || data.current_customer_conditions || null);
        });
      } catch (_) {
        callback(null, liveId || null, liveConditions || null);
      }
    };
    var handler = function (e) {
      if (!e.data || e.data.from !== "axlx-customer-response") return;
      clearTimeout(timer);
      window.removeEventListener("message", handler);
      if (e.data.name) {
        callback(e.data.name, e.data.id || null, e.data.conditions || null);
      } else {
        storageFallback(e.data.id || null, e.data.conditions || null);
      }
    };
    window.addEventListener("message", handler);
    window.postMessage({ from: "axlx-get-customer" }, "*");
    timer = setTimeout(function () {
      window.removeEventListener("message", handler);
      storageFallback(null, null);
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

    getCustomerFromPopup(function (customerName, customerId, customerConditions) {
      startSend(targets, customerName, customerId, lineBtn, lineOrig, null, customerConditions);
    });
  }

  // rowKey でフレッシュなボタンを取得（DOM更新後も正しいボタンをクリックできる）
  function findFreshBtn(rowKey) {
    var btns = findMaterialBtns();
    for (var i = 0; i < btns.length; i++) {
      if (makeRowKey(btns[i]) === rowKey) return btns[i];
    }
    return null;
  }

  function startSend(targets, customerName, customerId, lineBtn, lineOrig, onComplete, customerConditions) {
    // AD情報は事前に収集（物件名はPDFキャプチャ時に取得するのでフォールバック用）
    var propertyInfos = targets.map(function (t) {
      return extractPropertyInfo(t.btn);
    });

    lineBtn.textContent = "PDF取得中... (0/" + targets.length + ")";
    var pdfBase64List   = [];
    var capturedNames   = []; // captureOnePdf で取得した物件名（download属性）

    // 送信中はMutationObserverを停止（DOM更新でtargetsのボタン参照が無効化されるのを防ぐ）
    mutObs.disconnect();

    function finalizeSend() {
      mutObs.observe(document.body, { childList: true, subtree: true });
    }

    // ── 1件ずつキャプチャして全件集める → background.jsがBlobアップ→merge→LINE ──
    function processNext(i) {
      if (i >= targets.length) {
        // 全件キャプチャ完了 → background.jsに渡す（Blobアップ→merge→LINE送信）
        if (!pdfBase64List.length) {
          finalizeSend();
          alert("PDFが1件も取得できませんでした");
          lineBtn.disabled    = false;
          lineBtn.textContent = lineOrig;
          if (onComplete) onComplete(false, 0); // バッチハング防止: axlx-batch-customer-done を確実に送る
          return;
        }

        var propertySummaries = pdfBase64List.map(function (_, j) {
          // download属性の物件名 → extractPropertyInfo の名前 → "物件N" の優先順
          var dlName   = capturedNames[j] || null;
          var fallback = propertyInfos[j] || { name: null, ad: null };
          var name     = dlName || fallback.name || ("物件" + (j + 1));
          var ad       = fallback.ad;
          var lines    = ["【" + (j + 1) + "】" + name];
          if (ad) lines.push("AD: " + ad);
          return lines.join("\n");
        });

        lineBtn.textContent = "Blobアップ中... (1/" + pdfBase64List.length + ")";
        var today = new Date().toLocaleDateString("ja-JP").replace(/\//g, "-");
        // itandi: propertyInfos から構造化候補データを生成（学習ループ用）
        var propertyPool = pdfBase64List.map(function(_, j) {
          var fi = propertyInfos[j] || {};
          return { rank: j + 1, name: capturedNames[j] || fi.name || ("物件" + (j + 1)), ad_months: fi.ad ? parseInt((fi.ad.match(/\d+/) || [])[0]) || null : null };
        });
        chrome.runtime.sendMessage({
          type:                "axlx-send-pdf-data-to-line",
          pdf_data:            pdfBase64List,
          file_name:           "物件まとめ_" + today + ".pdf",
          customer_name:       customerName || null,
          customer_id:         customerId || null,
          property_summaries:  propertySummaries,
          property_pool:       propertyPool,
          customer_conditions: customerConditions || null,
          site:                "itandi",
        }, function (resp) {
          finalizeSend();
          lineBtn.disabled    = false;
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            var errMsg = resp ? resp.error : (chrome.runtime.lastError ? chrome.runtime.lastError.message : "不明");
            alert("LINE送信エラー:\n" + errMsg);
            lineBtn.textContent = lineOrig;
            if (onComplete) onComplete(false, 0);
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
          // 物件送った日付を自動更新（fire-and-forget）
          if (customerId) {
            fetch("https://sumora-ai-ui.vercel.app/api/property-tasks", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ customer_id: customerId }),
            }).catch(function () {});
          }
          if (onComplete) onComplete(true, pdfBase64List.length);
        });
        return;
      }

      lineBtn.textContent = "PDF取得中... (" + (i + 1) + "/" + targets.length + ")";
      // 進捗ハートビート: background の全ページ送信完了待機（無進捗5分）をリセット。
      // itandi の PDF キャプチャは1件数秒×多物件で5分を超えることがあり、
      // 固定タイムアウトのままだと送信中に次顧客の autofill が走って混線していた。
      try { chrome.runtime.sendMessage({ type: "axlx-batch-progress", customerId: customerId || null }, function () { void chrome.runtime.lastError; }); } catch (_) {}
      // DOM更新後もボタンを正しく取得（stale reference 防止）
      var freshBtn = findFreshBtn(targets[i].rowKey);
      if (!freshBtn) {
        console.warn("[AXLX] rowKey=" + targets[i].rowKey + " の物件資料ボタンが見つからず → stale参照を使用");
        freshBtn = targets[i].btn;
      }
      captureOnePdfWithRetry(freshBtn)
        .then(function (result) {
          var b64  = result.b64;
          var name = result.name;
          console.log("[AXLX] PDF取得成功 " + (i + 1) + "件目 (" + Math.round(b64.length / 1024) + "KB) 物件名:" + (name || "不明"));
          pdfBase64List.push(b64);
          capturedNames.push(name);
          closeModal();
          return sleep(500 + Math.floor(Math.random() * 1200)); // モーダルが完全に閉じるのを待つ（500ms→1000ms）
        })
        .then(function () { processNext(i + 1); })
        .catch(function (e) {
          console.warn("[AXLX] PDF取得失敗（リトライ後も失敗） " + (i + 1) + "件目:", e.message);
          closeModal();
          sleep(600 + Math.floor(Math.random() * 1600)).then(function () { processNext(i + 1); });
        });
    }

    processNext(0);
  }

  // ── 次ページボタンをクリック ─────────────────────────────────────────────
  function clickNextPage() {
    var btns = Array.from(document.querySelectorAll("button,a[href]"));
    var nextBtn = btns.find(function(b) {
      if (b.tagName === "BUTTON" && b.disabled) return false;
      var t = b.textContent.trim();
      return t === "次へ" || t === "次のページ" || t === ">" || t === "›" || t === "→";
    });
    if (!nextBtn) {
      nextBtn = Array.from(document.querySelectorAll("[aria-label]")).find(function(el) {
        var label = el.getAttribute("aria-label") || "";
        return label.includes("次") || label.toLowerCase().includes("next");
      });
    }
    if (nextBtn && !nextBtn.disabled) { nextBtn.click(); return true; }
    return false;
  }

  // ── 全ページ自動送信 ─────────────────────────────────────────────────────
  // _manual=true で呼ぶとスタッフモードチェックをスキップ（手動ボタン押下用）
  function autoSendAllPages(_manual) {
    if (_autoSendInProgress) return;
    if (!_manual && _staffModeOn) {
      console.log("[AXLX itandi] スタッフモード中 → autoSendAllPages をスキップ");
      return;
    }
    _autoSendInProgress = true;
    var _totalSentCount = 0; // 全ページ合計送信件数（axlx-batch-customer-done に渡す）
    getCustomerFromPopup(function(customerName, customerId, customerConditions) {
      _autoSendOnePage(customerName, customerId, customerConditions, function done(ok, count) {
        if (ok && count) _totalSentCount += count;
        var clicked = clickNextPage();
        if (!clicked) {
          _autoSendInProgress = false;
          _pendingAutoSendDispatched = false;
          console.log("[AXLX itandi] 全ページ送信完了 totalSent=" + _totalSentCount);
          // リアプロ(bulk-dl.js)と同様に background.js へ完了シグナルを送る
          try {
            chrome.runtime.sendMessage(
              { type: "axlx-batch-customer-done", customerId: customerId, propertyCount: _totalSentCount },
              function () { void chrome.runtime.lastError; }
            );
          } catch (_) {}
          return;
        }
        // 次ページのDOM更新を待ってから再送
        setTimeout(function() {
          inject();
          setTimeout(function() {
            if (tracked.length > 0) {
              _autoSendOnePage(customerName, customerId, customerConditions, done);
            } else {
              _autoSendInProgress = false;
              _pendingAutoSendDispatched = false;
              // 次ページに物件がなかった（ページ移動後0件）→ 完了シグナル
              try {
                chrome.runtime.sendMessage(
                  { type: "axlx-batch-customer-done", customerId: customerId, propertyCount: _totalSentCount },
                  function () { void chrome.runtime.lastError; }
                );
              } catch (_) {}
            }
          }, 1200 + Math.floor(Math.random() * 1600));
        }, 600 + Math.floor(Math.random() * 1000));
      });
    });
  }

  function _autoSendOnePage(customerName, customerId, customerConditions, onComplete) {
    // BUG-B修正: 顧客切り替え時に前顧客のrowKeyを必ずリセット（混入バグ対策）
    checkedKeys.clear();
    // 全選択
    tracked.forEach(function(t) { t.cb.checked = true; checkedKeys.add(t.rowKey); });
    updateBar();
    var targets = tracked.filter(function(t) { return t.cb.checked; });
    if (!targets.length) { onComplete(true); return; }
    var lineBtn = document.getElementById("axlx-itandi-line-btn");
    if (!lineBtn) { onComplete(false); return; }
    var lineOrig = lineBtn.textContent;
    lineBtn.disabled = true;
    startSend(targets, customerName, customerId, lineBtn, lineOrig, onComplete, customerConditions);
  }

  // ── 自動送信アームリスナー ────────────────────────────────────────────────
  // Step1: underbar.js が autofill-initiated を送ったらボタンスナップショット
  window.addEventListener("message", function(e) {
    if (!e.data || e.data.from !== "axlx-itandi-autofill-initiated") return;
    _autofillInitiated = true;
    _preAutofillBtns = new Set(findMaterialBtns());
    _pendingAutoSendDispatched = false;
    // 前顧客の0件検出タイマーが残っていたら停止（次顧客のコンテキストで誤発火しないよう）
    if (_zeroDetectTimer) { clearInterval(_zeroDetectTimer); _zeroDetectTimer = null; }
    console.log("[AXLX itandi] autofill initiated, snapshot=" + _preAutofillBtns.size + "btn");
  });

  // Step2: 検索完了シグナル → 自動送信をアーム + inject()で新ボタン確認
  window.addEventListener("message", function(e) {
    if (!e.data || e.data.from !== "aixlinx-fill-done") return;
    if (!_autofillInitiated) return;
    _autoSendArmed = true;
    _autofillInitiated = false;
    console.log("[AXLX itandi] fill-done 受信 → 全ページ自動送信 armed");
    // DOMがまだ更新中の場合がある → 1.5秒後に明示的にinject()を呼んで新ボタンを検出
    setTimeout(function() { inject(); }, 900 + Math.floor(Math.random() * 1300));
    // 0件確定ポーリング: 15秒以内に物件資料ボタンが出現しなければ0件確定
    // → axlx-batch-customer-done を送信して background.js のタイムアウト待機（5分）を解除する
    if (_zeroDetectTimer) { clearInterval(_zeroDetectTimer); _zeroDetectTimer = null; }
    var _zeroDeadline = Date.now() + 15000;
    _zeroDetectTimer = setInterval(function() {
      if (!_autoSendArmed) { clearInterval(_zeroDetectTimer); _zeroDetectTimer = null; return; }
      if (tracked.length > 0) { clearInterval(_zeroDetectTimer); _zeroDetectTimer = null; return; }
      if (Date.now() < _zeroDeadline) return;
      // 15秒経過しても物件なし → 0件確定
      clearInterval(_zeroDetectTimer); _zeroDetectTimer = null;
      _autoSendArmed = false;
      _pendingAutoSendDispatched = true;
      console.log("[AXLX itandi] 15秒経過・物件なし確定 → 0件としてaxlx-batch-customer-done送信");
      getCustomerFromPopup(function(_n, customerId) {
        try {
          chrome.runtime.sendMessage(
            { type: "axlx-batch-customer-done", customerId: customerId || null, propertyCount: 0 },
            function() { void chrome.runtime.lastError; }
          );
        } catch (_) {}
      });
    }, 1000);
  });

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
      injectTimer = setTimeout(function () { inject(); injectTimer = null; }, 250 + Math.floor(Math.random() * 350));
    }
  });

  // background.jsからのメッセージ受信
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg) {
      // Blobアップロード進捗更新
      if (msg.type === "axlx-blob-upload-progress") {
        var lineBtn = document.getElementById("axlx-itandi-line-btn");
        if (lineBtn) {
          lineBtn.textContent = "Blobアップ中... (" + msg.current + "/" + msg.total + ")";
        }
      }
      // ダウンロード経由でキャプチャしたPDF（JSフック失敗時フォールバック）
      if (msg.type === "axlx-itandi-pdf-by-download") {
        console.log("[AXLX] DLフォールバック: PDF取得成功 " + Math.round((msg.b64 || "").length / 1024) + "KB");
        window.postMessage({ from: "axlx-itandi-pdf", b64: msg.b64, ts: msg.ts }, "*");
      }
    });
  }

  function start() {
    ensureBar();
    ensurePdfHook();
    setTimeout(inject, 900 + Math.floor(Math.random() * 1300));
    mutObs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
  window.addEventListener("load", function () { setTimeout(inject, 1800 + Math.floor(Math.random() * 1400)); });
})();
