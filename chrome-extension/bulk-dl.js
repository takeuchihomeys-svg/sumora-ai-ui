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
  var _pendingCustomerForAutoSend = null; // autofill開始時点の顧客スナップショット（名前ずれ防止）
  var _zeroDetectTimer = null;            // 0件確定ポーリングタイマー（顧客切替時にクリア）

  // ── ページ離脱（検索リロード開始）時は0件確定ポーリングを必ず破棄する ──
  // 検索クリック→fill-done→リロード完了の間にサーバー応答が遅いと、旧ページ上の
  // 0件確定タイマーが誤発火して「0件」を background に送信し、さらに Case C の
  // 起動フラグ（axlx_pending_auto_send）まで消してしまう。
  // → リロード後の結果ページで全ページ送るが永久に起動しない
  //   （複数顧客バッチで2人目以降が無音で死ぬ根本原因の一つ）。
  window.addEventListener("pagehide", function () {
    if (_zeroDetectTimer) { clearInterval(_zeroDetectTimer); _zeroDetectTimer = null; }
  });

  // ── 全ページ自動送信: sessionStorage キー ──────────────
  var AUTO_SEND_KEY = "axlx_auto_send";

  // ── スタッフモードキャッシュ（chrome.storage.local の非同期値をコンテンツスクリプト内で同期参照）──
  // background.js の _isStaffModeActive() と同じ TTL=2時間 ロジック。
  // スタッフモードONの間、自動 autoSendAllPages の呼び出しをすべてスキップする。
  // 手動ボタン押下（axlx-auto-btn）は autoSendAllPages(true) で呼ばれるのでスキップしない。
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
        // スタッフモードONになったら残留 sessionStorage をクリア（Case B/D の継続防止）
        if (_staffModeOn) {
          try { sessionStorage.removeItem(AUTO_SEND_KEY); } catch (_) {}
        }
      }
    });
  } catch (_e) {}

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
    // _autoSendArmed が true の場合: 次顧客の fill-done 受信済みで新結果待ち中。
    // ここで false にすると次顧客の Case A が永遠に発火しないため inject() を再呼び出し。
    // （_scrapeAndSendRealpro 高速化により前顧客の PDF 送信完了前に次顧客の autofill が
    //   始まるようになり、Case A が getAutoSendState() ガードで弾かれたまま放置される
    //   問題への対処: clearAutoSendState 後にもう一度 Case A を試みる）
    if (_autoSendArmed) {
      _pendingAutoSendDispatched = false;
      console.log("[AXLX bulk-dl] clearAutoSendState: 次顧客がarm済み → inject() 再試行");
      setTimeout(inject, 200);
    } else {
      _autoSendArmed = false;
      _pendingAutoSendDispatched = false;
    }
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

  // 建物名から「○○市」部分だけを抽出するヘルパー
  function trimToCity(addr) {
    // 都道府県文字を除く6文字以内 + 市 → "大阪市", "横浜市" etc.
    var m = addr.match(/([^都道府県\s　、]{1,6}市)/);
    if (m) return m[1];
    // 市がなければ区・郡
    var m2 = addr.match(/([^都道府県\s　、]{1,6}[区郡])/);
    return m2 ? m2[1] : "";
  }

  // フリーワード検索中はSUUMOボタンを注入しない
  // （見積書ツールの自動フリーワード検索・手動フリーワード検索の結果画面が対象。
  //   リアプロは全画面 main.php のため、キーワード入力欄の値で画面モードを判定する）
  function isFreewordSearchActive() {
    var sels = [
      'input[name="keyword"]', 'input[name="free_word"]', 'input[name="freeword"]',
      '#free_word', '#freeword', 'input[type="search"]', 'input[placeholder*="フリーワード"]'
    ];
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (el && el.value && el.value.trim()) return true;
    }
    return false;
  }

  // リアプロ建物モード: 印刷用PDFボタンを起点に建物ヘッダー要素を特定し
  // 建物ごとに「SUUMO」ボタンを1つ注入する
  function injectSuumoButtons() {
    document.querySelectorAll(".axlx-suumo-btn").forEach(function (el) { el.remove(); });
    if (isFreewordSearchActive()) return; // フリーワード検索結果には注入しない
    var btns = findPrintBtns();
    var injectedHeaders = new Set();

    btns.forEach(function (btn) {
      var row = btn;
      while (row && row.tagName !== "TR") row = row.parentElement;
      var cur = row ? row.parentElement : null;
      var headerEl = null;
      var bldgName = "";
      var bldgAddr = "";

      // TR の親要素を遡りながら「住所|沿線|TEL」を含む previousElementSibling を探す
      while (cur && !headerEl) {
        var prev = cur.previousElementSibling;
        if (prev && /住所|沿線|Tel[\s:：]|TEL[\s:：]/.test(prev.textContent)) {
          headerEl = prev;
          // 建物名を抽出（h系タグ優先 → テキスト行分割）
          var hEl = prev.querySelector("h2,h3,h4,.building-name,td b,td strong");
          if (hEl) {
            bldgName = hEl.textContent.trim();
          } else {
            var lines = (prev.innerText || prev.textContent).split(/[\n\r]+/).map(function (s) { return s.trim(); }).filter(Boolean);
            for (var li = 0; li < lines.length; li++) {
              var l = lines[li];
              if (l.length < 2 || l.length > 40) continue;
              if (/^住所|^〒|^沿線|^TEL|^Tel|^お問合せ|^株式会社|^有限会社|^合同会社/.test(l)) continue;
              bldgName = l; break;
            }
          }
          // 住所を抽出（○○市まで）
          // 「住所：○○市△△1丁目」形式を直接抽出（沿線・徒歩情報が混入してもフィルター誤爆しない）
          var fullText = (prev.textContent || "").replace(/\s+/g, " ");
          var addrMatch = fullText.match(/住所[：:]\s*([^\n\r]{2,60})/);
          var addrTxt = addrMatch ? addrMatch[1] : "";
          if (!addrTxt) {
            // フォールバック: 市/区を含む要素テキストから探す
            var allTxts = Array.from(prev.querySelectorAll("td,div,p,span")).map(function (e) {
              return e.textContent.replace(/\s+/g, " ").trim();
            }).concat([fullText]);
            addrTxt = allTxts.find(function (t) {
              return /[区市町村]/.test(t) && t.length < 80 && !/万円|徒歩|m[²2]|㎡|[0-9]+分/.test(t);
            }) || "";
          }
          bldgAddr = trimToCity(addrTxt);
        }
        cur = cur.parentElement;
      }

      if (!headerEl || injectedHeaders.has(headerEl)) return;
      injectedHeaders.add(headerEl);

      var _n = bldgName;
      var _a = bldgAddr;
      var suumoBtn = document.createElement("button");
      suumoBtn.className = "axlx-suumo-btn";
      suumoBtn.textContent = "🔍 SUUMO";
      suumoBtn.title = (_n || "物件名") + " " + (_a || "") + " SUUMO でGoogle検索";
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

      // 建物ヘッダー内の最後の <td> にボタンを追加（なければ直接追加）
      var tds = headerEl.querySelectorAll("td");
      var target = tds.length > 0 ? tds[tds.length - 1] : headerEl;
      target.appendChild(suumoBtn);
    });
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
    injectSuumoButtons();

    // Case A: fill-done 受信済み かつ スナップショット前にない新しい結果が出た
    if (_autoSendArmed && tracked.length > 0 && !getAutoSendState() && !_pendingAutoSendDispatched) {
      var _hasNewBtn = tracked.some(function(item) { var k = item.btn.href || item.btn.getAttribute('href') || ''; return k && !_preAutofillBtns.has(k); });
      if (_hasNewBtn) {
        _autoSendArmed = false;
        _pendingAutoSendDispatched = true;
        try { chrome.storage.session.remove("axlx_pending_auto_send"); } catch (_) {}
        console.log("[AXLX bulk-dl] Case A: 新結果検出 → 自動送信開始");
        setTimeout(autoSendAllPages, 600 + Math.floor(Math.random() * 600));
      }
    }
    // Case B: AJAXページネーション継続（tryNext がページ遷移後に inject() が再実行される）
    // !_autoSendArmed: fill-done 受信直後（新顧客の新結果待ち中）は Case B を発火させない。
    // armed 中に発火すると前顧客の state（getAutoSendState）を使って
    // 次顧客の DOM 結果を前顧客名で誤送信するバグが発生する。
    else if (!_autoSendArmed && tracked.length > 0 && !_pendingAutoSendDispatched) {
      var _resumeState = getAutoSendState();
      if (_resumeState && _resumeState.active) {
        _pendingAutoSendDispatched = true;
        console.log("[AXLX bulk-dl] Case B: AJAXページネーション継続 P" + _resumeState.currentPage);
        setTimeout(function () {
          autoSendOnePage(_resumeState, function (ok, cnt) { _resumeState.sentCount = (_resumeState.sentCount || 0) + (cnt || 0); setTimeout(function() { tryNext(_resumeState); }, 800); });
        }, 700 + Math.floor(Math.random() * 700));
      }
    }
  }

  // ── フローティングバー ────────────────────────────
  function ensureBar() {
    if (document.getElementById("axlx-bar")) return;
    var bar = document.createElement("div");
    bar.id = "axlx-bar";
    bar.style.cssText = [
      "position:fixed;top:50%;right:12px;transform:translateY(-50%);z-index:2147483646;",
      "background:linear-gradient(135deg,#0d1b3e,#1565C0);",
      "color:white;border-radius:14px;padding:12px 16px;",
      "font-size:13px;font-weight:700;",
      "box-shadow:0 4px 20px rgba(0,0,0,0.4);",
      "display:none;flex-direction:column;gap:8px;min-width:200px;",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;",
    ].join("");
    bar.innerHTML = [
      '<div id="axlx-drag-handle" style="display:flex;align-items:center;justify-content:center;cursor:grab;padding:2px 0;margin:-6px 0 -4px;user-select:none;" title="ドラッグで移動">',
      '  <span style="font-size:10px;opacity:0.6;letter-spacing:2px;">⠿ ⠿ ⠿</span>',
      "</div>",
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
    // ── ドラッグ移動（ハンドル or パネル余白をつかんで移動。ボタン/入力上は除外）──
    (function () {
      var dragging = false, offX = 0, offY = 0;
      var handle = document.getElementById("axlx-drag-handle");
      bar.addEventListener("mousedown", function (e) {
        var onHandle = handle && (e.target === handle || handle.contains(e.target));
        if (!onHandle && (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT")) return;
        dragging = true;
        if (handle) handle.style.cursor = "grabbing";
        var r = bar.getBoundingClientRect();
        offX = e.clientX - r.left; offY = e.clientY - r.top;
        // translateX(-50%) を解除して left/top 直指定に切替
        bar.style.transform = "none";
        bar.style.left = r.left + "px"; bar.style.top = r.top + "px";
        bar.style.right = "auto"; bar.style.bottom = "auto";
        e.preventDefault();
      });
      document.addEventListener("mousemove", function (e) {
        if (!dragging) return;
        bar.style.left = (e.clientX - offX) + "px";
        bar.style.top = (e.clientY - offY) + "px";
      });
      document.addEventListener("mouseup", function () {
        dragging = false;
        if (handle) handle.style.cursor = "grab";
      });
    })();
    document.getElementById("axlx-all-btn").addEventListener("click", toggleAll);
    document.getElementById("axlx-dl-btn").addEventListener("click", bulkDownload);
    document.getElementById("axlx-merge-btn").addEventListener("click", function () { mergePdfs(false); });
    document.getElementById("axlx-line-btn").addEventListener("click", function () { getCustomerFromPopup(function (customerName, customerConditions, customerId) { mergePdfs(true, customerName, customerConditions, customerId); }); });
    document.getElementById("axlx-auto-btn").addEventListener("click", function () { autoSendAllPages(true); }); // 手動=スタッフモードでも許可
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
  var _bulkDlStopped = false;
  var _bulkDlTimer = null;

  function bulkDownload() {
    var targets = tracked.filter(function (t) { return t.cb.checked; });
    if (!targets.length) return;
    var dlBtn = document.getElementById("axlx-dl-btn");

    // ストップ処理（ダウンロード中にボタンを押したら中断）
    if (_bulkDlTimer !== null) {
      _bulkDlStopped = true;
      clearTimeout(_bulkDlTimer);
      _bulkDlTimer = null;
      document.getElementById("axlx-count").textContent = "⏹ 中断しました";
      dlBtn.textContent = "一括DL";
      dlBtn.style.background = "#ff9800";
      dlBtn.style.pointerEvents = "auto";
      return;
    }

    // ダウンロード開始
    _bulkDlStopped = false;
    dlBtn.textContent = "⏹ STOP";
    dlBtn.style.background = "#d32f2f";
    dlBtn.style.pointerEvents = "auto"; // STOPボタンは押せる状態に

    var i = 0;
    function next() {
      _bulkDlTimer = null;
      if (_bulkDlStopped || i >= targets.length) {
        if (!_bulkDlStopped) {
          document.getElementById("axlx-count").textContent = "✓ " + targets.length + "件 完了！";
          setTimeout(function () { targets.forEach(function (t) { t.cb.checked = false; }); updateBar(); }, 2500);
        }
        dlBtn.textContent = "一括DL";
        dlBtn.style.background = "#ff9800";
        dlBtn.style.pointerEvents = "auto";
        return;
      }
      document.getElementById("axlx-count").textContent = (i + 1) + "/" + targets.length + " DL中";
      targets[i].btn.click();
      i++;
      _bulkDlTimer = setTimeout(next, 1200 + Math.floor(Math.random() * 1600));
    }
    next();
  }

  // ── 物件カード情報抽出 ─────────────────────────────
  function extractCard(btn) {
    var row = btn;
    while (row && row.tagName !== "TR") row = row.parentElement;

    var name = "";
    var cur = row ? row.parentElement : null;
    var UI_TEXTS = ["検索条件を表示", "検索条件", "条件を表示", "条件を隠す", "詳細を表示", "詳細を閉じる", "閉じる", "次へ", "前へ", "表示", "印刷", "選択", "一覧に戻る", "リスト検索", "リスト", "検索結果"];
    while (cur && !name) {
      var prev = cur.previousElementSibling;
      if (prev) {
        var h = prev.querySelector("h2,h3,h4,.building-name,td b,td strong");
        if (h) { name = h.textContent.trim(); break; }
        var txt = prev.textContent.trim();
        var isUIText = UI_TEXTS.indexOf(txt) !== -1;
        var hasInteractive = !!(prev.querySelector("button, input[type=button], input[type=submit]"));
        if (txt && txt.length < 40 && !isUIText && !hasInteractive) { name = txt; break; }
        // ★ 修正: 建物情報カード（住所・沿線を含む長テキスト、またはボタン付き要素）から建物名を抽出
        // リアプロは建物名ヘッダーが <a>タグのみでhasInteractive=falseになるが住所・沿線を含む
        var looksLikeBuildingCard = txt.length > 40 && /住所|沿線|Tel\s*:|TEL\s*:/.test(txt);
        if (!isUIText && (hasInteractive || looksLikeBuildingCard)) {
          var rawLines = (prev.innerText || txt).split(/[\n\r]+/).map(function(s) { return s.trim(); }).filter(Boolean);
          for (var li2 = 0; li2 < rawLines.length; li2++) {
            var seg = rawLines[li2];
            if (seg.length < 2 || seg.length > 40) continue;
            if (/^住所|^〒|^沿線|^TEL|^Tel|^tel|^\d{2,4}-|^株式会社|^有限会社|^お問合せ|^問合せ/.test(seg)) continue;
            if (UI_TEXTS.indexOf(seg) !== -1) continue;
            if (/PDF|600件|万円|㎡|徒歩|印刷|並べ替え|デフォルト/.test(seg)) continue;
            name = seg; break;
          }
          if (name) break;
        }
      }
      cur = cur.parentElement;
    }
    if (!name && row) {
      var tbl = row.closest("table");
      var before = tbl && tbl.previousElementSibling;
      if (before) {
        var bTxt = before.textContent.trim().split("\n")[0].trim().slice(0, 30);
        if (UI_TEXTS.indexOf(bTxt) === -1) name = bTxt;
      }
    }
    // Fallback: tbody内の前の行を遡って建物名ヘッダー行を探す（リアプロ形式）
    // tbody.previousElementSibling が undefined の場合（建物名が同一tbody内のヘッダー行に混在）
    if (!name && row) {
      var _prevRow = row.previousElementSibling;
      var SKIP_PATTERNS = /万円|㎡|m[²2]|徒歩|印刷|PDF|空室|審査|空き|ヶ月|^\d+\s*分前|^[0-9]+$|^\d+点$|^\d+階$|[○◯〇].*点|^\d+\.\d|^相談|^即/;
      var SKIP_PREFIX = /^住所|^〒|^沿線|^TEL|^Tel|^tel|^\d{2,4}[-‐]|^株式会社|^有限会社|^合同会社/;
      for (var _pi = 0; _pi < 8 && _prevRow && !name; _pi++, _prevRow = _prevRow.previousElementSibling) {
        // 印刷用PDFを含む行はルームデータ行なのでスキップ
        if (_prevRow.textContent.includes("印刷用PDF")) continue;
        // h系タグ・building-nameクラス優先
        var _hEl = _prevRow.querySelector("h2,h3,h4,.building-name,td b,td strong,[class*='building'],[class*='title']");
        if (_hEl) {
          var _hTxt = _hEl.textContent.trim();
          if (_hTxt && _hTxt.length >= 2 && _hTxt.length <= 40 && UI_TEXTS.indexOf(_hTxt) === -1 && !SKIP_PATTERNS.test(_hTxt) && !SKIP_PREFIX.test(_hTxt)) {
            name = _hTxt; break;
          }
        }
        // innerText の行分割でも試みる（建物名が改行区切りで別要素に入っていない場合）
        if (!name) {
          var _rowLines = (_prevRow.innerText || _prevRow.textContent || "").split(/[\n\r]+/).map(function(s) { return s.trim(); }).filter(Boolean);
          for (var _li = 0; _li < _rowLines.length && !name; _li++) {
            var _ls = _rowLines[_li];
            if (_ls.length < 2 || _ls.length > 40) continue;
            if (UI_TEXTS.indexOf(_ls) !== -1) continue;
            if (SKIP_PATTERNS.test(_ls)) continue;
            if (SKIP_PREFIX.test(_ls)) continue;
            name = _ls;
          }
          if (name) break;
        }
        // セルを1つずつチェックして建物名らしい文字列を探す
        var _rCells = Array.from(_prevRow.querySelectorAll("td,th"));
        for (var _ri = 0; _ri < _rCells.length && !name; _ri++) {
          var _rTxt = _rCells[_ri].textContent.replace(/\s+/g, " ").trim();
          if (_rTxt.length < 2 || _rTxt.length > 40) continue;
          if (UI_TEXTS.indexOf(_rTxt) !== -1) continue;
          if (SKIP_PATTERNS.test(_rTxt)) continue;
          if (SKIP_PREFIX.test(_rTxt)) continue;
          name = _rTxt;
        }
      }
    }
    if (!name) {
      console.log("[extractCard] 建物名取得失敗 - row:", row, "btn:", btn);
    }

    var cells = row ? Array.from(row.querySelectorAll("td")) : [];
    var texts = cells.map(function (td) {
      return td.textContent.replace(/\s+/g, " ").trim();
    }).filter(function (t) { return t && t.length > 0 && t.length < 60; });

    // AD列はリアプロで10〜12列目あたりのため15まで取得
    return { name: name || "物件", texts: texts.slice(0, 15) };
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

    // 間取りのインデックスをAD/敷金礼金抽出の境界として使う
    var madoriIdx = madoriText ? card.texts.indexOf(madoriText) : -1;

    // 敷金・礼金: 間取りの直前2セルが Nヶ月 or なし/－ 形式なら採用
    // 列順: ...管理費 | 敷金 | 礼金 | 間取り...
    if (madoriIdx >= 2) {
      var _toMonth = function(t) {
        if (!t) return null;
        t = t.trim();
        if (/^(\d+)[ヶか]月$/.test(t)) return t;
        if (t === "なし" || t === "－" || t === "-") return "なし";
        return null;
      };
      var _s = _toMonth(card.texts[madoriIdx - 2]);
      var _r = _toMonth(card.texts[madoriIdx - 1]);
      if (_s && _r) lines.push("敷" + _s + " 礼" + _r);
    }

    // 駅・徒歩（「徒歩」または「駅」を含むセル）
    var accessText = card.texts.find(function (t) { return /徒歩/.test(t); });
    if (!accessText) accessText = card.texts.find(function (t) { return /駅/.test(t); });
    if (accessText) lines.push(accessText.trim());

    // AD（間取りより後のセルだけを検索して敷金礼金との混同を防ぐ）
    var adLine = null;
    var _adStart = madoriIdx >= 0 ? madoriIdx + 1 : 0;
    for (var _ai = _adStart; _ai < card.texts.length; _ai++) {
      var _at = card.texts[_ai].trim();
      var _am = _at.match(/^(\d+)[ヶか]月$/);
      if (_am) { adLine = "AD " + _at; break; }
    }
    // 旧形式: "AD 2ヶ月" や "広告料 xxxxxx円" が同一セルに入っている場合
    if (!adLine) {
      var _adCell = card.texts.find(function (t) { return /AD|広告料/.test(t); });
      if (_adCell) {
        var _adM = _adCell.match(/\d+[ヶか]月/);
        var _adY = _adCell.match(/[\d,，]+円/);
        if (_adM) adLine = "AD " + _adM[0];
        else if (_adY) adLine = "AD " + _adY[0];
      }
    }
    if (adLine) lines.push(adLine);

    return lines.join("\n");
  }

  // ── 物件候補データ構造化（学習ループAPI送信用）──────
  function buildPropertyData(card, index) {
    var data = { rank: index + 1, name: card.name };
    var rentText = card.texts.find(function(t) { return /[0-9,，]+[\s]*[万円]/.test(t) || /¥/.test(t); });
    if (rentText) {
      var rm = rentText.replace(/[,，]/g, "").match(/(\d+)万/);
      data.rent = rm ? parseInt(rm[1]) * 10000 : null;
    }
    var madoriText = card.texts.find(function(t) { return /[1-9](R\b|K\b|DK\b|LDK|SLDK|SDK)/.test(t); });
    if (madoriText) {
      var mm = madoriText.trim().match(/[1-9][A-Z]+/i);
      data.floor_plan = mm ? mm[0] : null;
    }
    var madoriIdx = madoriText ? card.texts.indexOf(madoriText) : -1;
    var accessText = card.texts.find(function(t) { return /徒歩/.test(t); });
    if (accessText) {
      var wm = accessText.match(/徒歩\s*(\d+)\s*分/);
      if (wm) data.walk_minutes = parseInt(wm[1]);
    }
    if (madoriIdx >= 0) {
      for (var _ai2 = madoriIdx + 1; _ai2 < card.texts.length; _ai2++) {
        var _am2 = card.texts[_ai2].trim().match(/^(\d+)[ヶか]月$/);
        if (_am2) { data.ad_months = parseInt(_am2[1]); break; }
      }
    }
    return data;
  }

  // ── popup.jsから選択中のお客さん名を自動取得 ──────────
  // postMessage → underbar.js中継 → popup.js → 応答を受け取る
  function getCustomerFromPopup(callback) {
    var timer;
    var handler = function (e) {
      if (!e.data || e.data.from !== "axlx-customer-response") return;
      clearTimeout(timer);
      window.removeEventListener("message", handler);
      if (e.data.name) {
        callback(e.data.name, e.data.conditions || null, e.data.id || null);
      } else {
        // popup未選択 → storage から最後の顧客名・ID・条件をフォールバック
        // （検索リロード後は popup iframe が再生成され selectedCustomer が消えるため、
        //   一括検索では常にこのフォールバックを通る。条件が無いと LINE の
        //   「🌟 一番オススメ」AIランキングが顧客条件なしで実行されてしまう）
        chrome.storage.local.get(["current_customer_name", "current_customer_id", "current_customer_conditions"], function(data) {
          callback(data.current_customer_name || null, e.data.conditions || data.current_customer_conditions || null, data.current_customer_id || e.data.id || null);
        });
      }
    };
    window.addEventListener("message", handler);
    window.postMessage({ from: "axlx-get-customer" }, "*");
    // 800ms 以内に応答がなければ storage から最後の顧客名・ID・条件をフォールバック
    timer = setTimeout(function () {
      window.removeEventListener("message", handler);
      chrome.storage.local.get(["current_customer_name", "current_customer_id", "current_customer_conditions"], function(data) {
        callback(data.current_customer_name || null, data.current_customer_conditions || null, data.current_customer_id || null);
      });
    }, 800);
  }

  // ── LINE送信: 1件ずつ順番に送信（background経由・CSP/CORS完全回避）──────
  // ── PDF結合ダウンロード: background経由 ───────────────────────────────────
  function mergePdfs(sendToLine, customerName, customerConditions, customerId) {
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
      var propertyPool = selectedTargets.map(function (t, i) {
        return buildPropertyData(extractCard(t.btn), i);
      });

      chrome.runtime.sendMessage({
        type: "axlx-send-to-line",
        urls: urls,
        customer_name: customerName || null,
        property_summaries: propertySummaries,
        property_pool: propertyPool,
        customer_id: customerId || null,
        customer_conditions: customerConditions || null,
        site: "realpro",
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
      // 円表記フォールバック（リアプロは 48,000円 形式で表示する場合がある）
      if (rent === null) {
        var rentYenText = allTexts.find(function (t) {
          if (!/^[0-9,，]+\s*円$/.test(t)) return false;
          var v = parseInt(t.replace(/[,，円\s]/g, ""), 10);
          return v >= 10000; // 1万円以上を賃料とみなす
        }) || "";
        var rentYenMatch = rentYenText.match(/([0-9,，]+)\s*円/);
        if (rentYenMatch) {
          rent = parseInt(rentYenMatch[1].replace(/[,，]/g, ""), 10);
        }
      }

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
  function _isDisabledEl(el) {
    return el.disabled ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.getAttribute('disabled') !== null ||
      el.classList.contains('disabled') ||
      el.classList.contains('is-disabled') ||
      el.classList.contains('btn-disabled') ||
      el.classList.contains('pagination-disabled');
  }

  // position:fixed な要素は offsetParent===null になるため getBoundingClientRect で可視判定する
  function _isElVisible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // 「次」テキストを持つ clickable な要素を返す
  function _findNextPageEl() {
    var NEXT_TEXTS = ["次", "次へ", "次のページ", ">", ">>"];

    // フェーズ0: リアプロ専用 td.pager（最も確実）
    // リアプロのページネーションは <TD class="pager" onclick="pager(...)">次</TD> の構造
    var pagerTds = document.querySelectorAll("td.pager");
    for (var pi = 0; pi < pagerTds.length; pi++) {
      var pt = pagerTds[pi];
      if (NEXT_TEXTS.indexOf(pt.textContent.trim()) !== -1 && _isElVisible(pt) && !_isDisabledEl(pt)) {
        console.log("[AXLX bulk-dl] _findNextPageEl: td.pager で次ボタン発見 onclick=" + (pt.getAttribute("onclick") || ""));
        return pt;
      }
    }

    // フェーズ1: テキストウォーカーで A/BUTTON/onclick持ち要素を探す（汎用）
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var t = node.textContent.trim();
      if (NEXT_TEXTS.indexOf(t) === -1) continue;
      var el = node.parentElement;
      for (var up = 0; up < 6 && el && el !== document.body; up++, el = el.parentElement) {
        if (!_isElVisible(el)) continue;
        if (_isDisabledEl(el)) break;
        var tag = el.tagName;
        var isClickable = tag === "A" || tag === "BUTTON" || !!el.getAttribute("onclick") || !!el.getAttribute("href");
        if (!isClickable) continue;
        if (tag === "A" && el.href && el.href !== "javascript:void(0)" && el.href === location.href) break;
        console.log("[AXLX bulk-dl] _findNextPageEl: フェーズ1で発見 tag=" + tag);
        return el;
      }
    }

    // フェーズ2: CSSクラス・aria-label ベース
    var candidates = document.querySelectorAll('[aria-label*="次"], .pagination-next, .page-next, a.next, button.next');
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (_isElVisible(c) && !_isDisabledEl(c)) {
        console.log("[AXLX bulk-dl] _findNextPageEl: フェーズ2で発見 tag=" + c.tagName);
        return c;
      }
    }

    console.log("[AXLX bulk-dl] _findNextPageEl: 次ボタンなし（最終ページ or 未対応構造）");
    return null;
  }

  function hasNextPageBtn() {
    return _findNextPageEl() !== null;
  }

  // ── ページネーション: 「次」ボタンをクリックして true を返す ───────────────
  function clickNextPageBtn() {
    var el = _findNextPageEl();
    if (!el) return false;
    el.click();
    console.log("[AXLX bulk-dl] clickNextPageBtn: クリック完了 tag=" + el.tagName);
    return true;
  }

  // ── 全ページ自動送信: 共通の次ページ遷移 or 完了処理 ─────────────────────
  // autoSendOnePage の onDone コールバックと start() 内の再開処理で共通利用する。
  function tryNext(state) {
    if (hasNextPageBtn()) {
      var clicked = clickNextPageBtn();
      if (!clicked) {
        clearAutoSendState();
        // propertyCount を付けない（すでに送信済みの物件があるため0件アナウンスを出さない）
        try { chrome.runtime.sendMessage({ type: "axlx-batch-customer-done", customerId: state.customerId || null }, function() { void chrome.runtime.lastError; }); } catch (_) {}
        console.error("[AXLX bulk-dl] 次ページへの遷移に失敗しました（次ページボタンが見つからない）");
        var countEl2 = document.getElementById("axlx-count");
        if (countEl2) countEl2.textContent = "次ページ遷移エラー";
      } else {
        // クリック成功後にstateを更新（失敗時にdirty stateが残らないようにする）
        setAutoSendState({ active: true, currentPage: state.currentPage + 1, customerName: state.customerName, customerConditions: state.customerConditions || null, customerId: state.customerId || null, sentCount: state.sentCount || 0 });
        // 進捗ハートビート: ページ遷移も「進行中」として background のタイムアウトをリセット
        try { chrome.runtime.sendMessage({ type: "axlx-batch-progress", customerId: state.customerId || null }, function () { void chrome.runtime.lastError; }); } catch (_) {}
        // AJAX: 次のinject()でCase Bが拾えるようにリセット
        // ページリロード: _pendingAutoSendDispatched は再初期化されるので問題なし
        _pendingAutoSendDispatched = false;
        console.log("[AXLX bulk-dl] 次ページへ遷移 P" + (state.currentPage + 1));
      }
    } else {
      clearAutoSendState();
      // sentCount を必ず付ける: 0件なら background が「🔍【物件0件】」アナウンスを送る
      try { chrome.runtime.sendMessage({ type: "axlx-batch-customer-done", customerId: state.customerId || null, propertyCount: state.sentCount || 0 }, function() { void chrome.runtime.lastError; }); } catch (_) {}
      var countEl = document.getElementById("axlx-count");
      if (countEl) countEl.textContent = "全ページ送信完了！";
      console.log("[AXLX bulk-dl] 全ページ自動送信が完了しました。（" + state.currentPage + "ページ / " + (state.sentCount || 0) + "件送信）");
    }
  }

  // ── 全ページ自動送信: 現ページを自動送信する ──────────────────────────────
  // mergePdfs を再利用せず chrome.runtime.sendMessage を直接呼ぶ
  // （コールバック内で onDone を呼ぶため）。
  function autoSendOnePage(state, onDone) {
    var BATCH_SIZE = 10; // 20→10: merge-pdfs の処理時間削減（PDF10件×並列取得+結合+Blob+AI+LINE+DB）
    var countEl = document.getElementById("axlx-count");
    if (countEl) countEl.textContent = "全ページ送信中 P" + state.currentPage + "...";

    // 全チェックボックス選択
    tracked.forEach(function (t) { t.cb.checked = true; });
    updateBar();

    var urls = getSelectedUrls();
    if (!urls.length) {
      // DOM がまだレンダリング中の可能性があるため最大4秒ポーリングして待つ
      var _pollWait = 0;
      var _pollTimer = setInterval(function () {
        inject();
        tracked.forEach(function (t) { t.cb.checked = true; });
        updateBar();
        var urls2 = getSelectedUrls();
        _pollWait += 200;
        if (urls2.length > 0 || _pollWait >= 4000) {
          clearInterval(_pollTimer);
          if (!urls2.length) {
            console.warn("[AXLX bulk-dl] autoSendOnePage: " + _pollWait + "ms待機後も物件なし → スキップ");
            onDone(true, 0);
            return;
          }
          // ポーリング中に物件が出た → 処理継続
          _doSend(urls2);
        }
      }, 200);
      return;
    }
    _doSend(urls);

    function _doSend(sendUrls) {
      var selectedTargets = tracked.filter(function (t) { return t.cb.checked; });
      var propertySummaries = selectedTargets.map(function (t, i) {
        return buildPropertySummary(extractCard(t.btn), i);
      });
      var propertyPool = selectedTargets.map(function (t, i) {
        return buildPropertyData(extractCard(t.btn), i);
      });

      // 20件ずつバッチに分割して順番に送信（一括送信はタイムアウトするため）
      var batches = [];
      for (var i = 0; i < sendUrls.length; i += BATCH_SIZE) {
        batches.push({
          urls: sendUrls.slice(i, i + BATCH_SIZE),
          summaries: propertySummaries.slice(i, i + BATCH_SIZE),
          pool: propertyPool.slice(i, i + BATCH_SIZE),
        });
      }

      var batchIndex = 0;
      function sendNextBatch() {
        if (batchIndex >= batches.length) {
          onDone(true, sendUrls.length);
          return;
        }
        var batch = batches[batchIndex];
        if (countEl) {
          countEl.textContent = "P" + state.currentPage + " 送信中 (" + (batchIndex + 1) + "/" + batches.length + ")";
        }
        chrome.runtime.sendMessage({
          type: "axlx-send-to-line",
          urls: batch.urls,
          customer_name: state.customerName || null,
          property_summaries: batch.summaries,
          property_pool: batch.pool,
          customer_id: state.customerId || null,
          customer_conditions: state.customerConditions || null,
          site: "realpro",
        }, function (resp) {
          if (chrome.runtime.lastError) {
            clearAutoSendState();
            var errMsg1 = chrome.runtime.lastError.message || "不明なエラー";
            if (countEl) countEl.textContent = "送信エラー（次顧客へ）";
            console.error("[AXLX bulk-dl] 送信エラー:", errMsg1);
            // エラー詳細をアラートで表示（何が原因か分かるように）
            alert("LINE送信エラー:\n" + errMsg1 + "\n\n※リアプロにログインし直して再試行してください");
            try { chrome.runtime.sendMessage({ type: "axlx-batch-customer-done", customerId: state.customerId || null }, function () { void chrome.runtime.lastError; }); } catch (_) {}
            return;
          }
          if (!resp || !resp.ok) {
            clearAutoSendState();
            var errMsg2 = resp ? (resp.error || "サーバーエラー") : "応答なし（タイムアウトの可能性）";
            if (countEl) countEl.textContent = "送信エラー（次顧客へ）";
            console.error("[AXLX bulk-dl] 送信エラー:", errMsg2);
            // エラー詳細をアラートで表示（何が原因か分かるように）
            alert("LINE送信エラー:\n" + errMsg2 + "\n\n※セッション切れの場合: リアプロに再ログインしてください\n※タイムアウトの場合: 物件数を減らして再試行してください");
            try { chrome.runtime.sendMessage({ type: "axlx-batch-customer-done", customerId: state.customerId || null }, function () { void chrome.runtime.lastError; }); } catch (_) {}
            return;
          }
          batchIndex++;
          // 進捗ハートビート: background の全ページ送信完了待機タイムアウトをリセット。
          // 多ページ・多物件の送信は5分を超えることがあり、固定5分タイムアウトのままだと
          // background が次顧客の autofill を開始 → 検索リロードで送信中のページが破壊される。
          try { chrome.runtime.sendMessage({ type: "axlx-batch-progress", customerId: state.customerId || null }, function () { void chrome.runtime.lastError; }); } catch (_) {}
          sendNextBatch();
        });
      }

      sendNextBatch();
    }
  }

  // ── 全ページ自動送信: エントリポイント ────────────────────────────────────
  // _manual=true で呼ぶとスタッフモードチェックをスキップ（手動ボタン押下用）
  function autoSendAllPages(_manual) {
    if (getAutoSendState()) return; // 既に動作中
    // 自動呼び出し時のみスタッフモードをチェック
    if (!_manual && _staffModeOn) {
      console.log("[AXLX bulk-dl] スタッフモード中 → autoSendAllPages をスキップ");
      return;
    }
    // Case A / Case C / 手動ボタン いずれの経路で起動しても再開フラグは必ずここで消費する。
    // （消し忘れると次顧客・次ページロードで Case C が誤発火して二重送信になる）
    try { chrome.storage.session.remove("axlx_pending_auto_send"); } catch (_) {}
    var _snap = _pendingCustomerForAutoSend;
    _pendingCustomerForAutoSend = null;
    if (_snap && _snap.name) {
      // autofill開始時点でスナップショット済みのお客さん名を使う（名前ずれ防止）
      var state = { active: true, currentPage: 1, customerName: _snap.name, customerConditions: _snap.conditions || null, customerId: _snap.customerId || null, sentCount: 0 };
      setAutoSendState(state);
      autoSendOnePage(state, function (ok, cnt) { state.sentCount = (state.sentCount || 0) + (cnt || 0); setTimeout(function() { tryNext(state); }, 800); });
    } else {
      // スナップショットなし（手動操作など）→ 従来通りpopupから取得
      getCustomerFromPopup(function (name, conditions, customerId) {
        var state = { active: true, currentPage: 1, customerName: name, customerConditions: conditions, customerId: customerId || null, sentCount: 0 };
        setAutoSendState(state);
        autoSendOnePage(state, function (ok, cnt) { state.sentCount = (state.sentCount || 0) + (cnt || 0); setTimeout(function() { tryNext(state); }, 800); });
      });
    }
  }

  // ── underbar.js からの全ページ自動送信シグナル受信 ───────────────────────
  // Step1: autofill ボタン押下時 → 現在の結果ボタンをスナップショット
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.from !== "axlx-autofill-initiated") return;
    _autofillInitiated = true;
    // 前バッチ中断で残留したsessionStorage状態をクリア（Case Aの!getAutoSendState()チェックがブロックされるバグ対策）
    try { sessionStorage.removeItem(AUTO_SEND_KEY); } catch (_) {}
    // 前顧客の0件ポーリングが残っていれば即座に停止（次顧客の窓で誤発火を防ぐ）
    if (_zeroDetectTimer) { clearInterval(_zeroDetectTimer); _zeroDetectTimer = null; }
    // href URL をキーにしたスナップショット（DOM参照ではなくURL比較でAJAX再利用を正しく検出）
    _preAutofillBtns = new Set(findPrintBtns().map(function(b) { return b.href || b.getAttribute('href') || ''; }));
    _pendingAutoSendDispatched = false;
    console.log("[AXLX bulk-dl] autofill initiated, snapshot=" + _preAutofillBtns.size + "btn");
    // バッチ中の名前ずれ防止: autofill開始時点のお客さん名をここでスナップショット
    // autoSendAllPages() 発火時には popup が次の顧客に切り替わっている可能性があるため
    _pendingCustomerForAutoSend = null;
    getCustomerFromPopup(function(name, conditions, customerId) {
      _pendingCustomerForAutoSend = { name: name, conditions: conditions, customerId: customerId };
      console.log("[AXLX bulk-dl] autofill initiated: customer snapshot =", name);
      // BUG-D修正: fill-done が先着していた場合、スナップショット確定後に再チェックして安全起動
      if (_autoSendArmed && !_pendingAutoSendDispatched && !getAutoSendState()) {
        var _hasNBsnap = tracked.some(function(item) { var k = item.btn.href || item.btn.getAttribute('href') || ''; return k && !_preAutofillBtns.has(k); });
        if (_hasNBsnap) {
          _autoSendArmed = false;
          _pendingAutoSendDispatched = true;
          setTimeout(autoSendAllPages, 200);
        }
      }
    });
  });

  // Step2: fill-done 受信 → arm（スナップショット外の新結果が出たら Case A で発動）
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.from !== "aixlinx-fill-done") return;
    if (!_autofillInitiated) return;
    _autoSendArmed = true;
    _autofillInitiated = false;
    console.log("[AXLX bulk-dl] fill-done 受信 → 全ページ自動送信 armed");
    // AJAX完了はfill-done到着より先にMutationObserverが走るため、
    // Case A は _autoSendArmed=false のまま inject() を空振りしてしまう。
    // fill-done 後に inject() を再呼び出しして Case A を確実に到達させる。
    setTimeout(inject, 50);
    // _hasNewBtn=false フォールバック: AJAXがDOMを再利用しCase Aが起動しなかった場合の安全網
    // BUG-A修正: _hasNewBtn チェックをここでも実行し、前顧客DOM残留時は発火しない
    setTimeout(function () {
      if (_autoSendArmed && tracked.length > 0 && !getAutoSendState() && !_pendingAutoSendDispatched) {
        var _hasNewBtn2s = tracked.some(function(item) { var k = item.btn.href || item.btn.getAttribute('href') || ''; return k && !_preAutofillBtns.has(k); });
        if (!_hasNewBtn2s) {
          console.log("[AXLX bulk-dl] 2秒フォールバック: hasNewBtn=false → 見送り（前顧客 DOM 残留）");
          return;
        }
        _autoSendArmed = false;
        _pendingAutoSendDispatched = true;
        console.log("[AXLX bulk-dl] 2秒フォールバック: hasNewBtn=true → 自動送信開始");
        setTimeout(autoSendAllPages, 200);
      }
    }, 2000);
    // 0件確定ポーリング: 1秒毎にチェック、最大25秒待機して物件なし確定→batch-customer-done送信
    // ※ 4秒固定だとリアプロのサーバー応答が遅い場合（5〜10秒）に物件あっても0件と誤判定していた
    // ※ 15秒でも検索リロードのサーバー応答がそれを超えると誤0件になるため25秒に延長
    // BUG-C修正: タイマー設定時点でIDをキャプチャ（後で_pendingCustomerForAutoSendがnullになりうるため）
    var _armed0ItemCid = (_pendingCustomerForAutoSend && _pendingCustomerForAutoSend.customerId) || null;
    if (_zeroDetectTimer) { clearInterval(_zeroDetectTimer); _zeroDetectTimer = null; }
    var _zeroDeadline = Date.now() + 25000;
    _zeroDetectTimer = setInterval(function () {
      if (!_autoSendArmed) { clearInterval(_zeroDetectTimer); _zeroDetectTimer = null; return; }
      var _hasAnyNewBtnNow = tracked.some(function(item) {
        var k = item.btn.href || item.btn.getAttribute('href') || '';
        return k && !_preAutofillBtns.has(k);
      });
      if (_hasAnyNewBtnNow) {
        // 新ボタン出現 → Case A / 2秒フォールバックに任せてポーリング終了
        clearInterval(_zeroDetectTimer); _zeroDetectTimer = null; return;
      }
      if (Date.now() < _zeroDeadline) return;  // まだ待つ
      clearInterval(_zeroDetectTimer); _zeroDetectTimer = null;
      // 前顧客の結果ボタンが画面に残っている場合はここで0件確定しない。
      // リアプロの検索はページリロードで結果が戻るため、このタイマーが動いている時点で
      // 「まだ旧ページにいる＝リロード待ち」の可能性が高い。ここで0件送信＋フラグ削除すると
      // リロード後の Case C が起動できず全ページ送るが永久に死ぬ（複数顧客バッチの主要な失敗経路）。
      // リロード後は Case C が送信し、真の0件は新ページ側 autoSendOnePage が propertyCount:0 で報告する。
      if (tracked.length > 0) {
        console.log("[AXLX bulk-dl] 25秒経過・新ボタンなし（既存tracked=" + tracked.length + "）→ 0件確定せず リロード後のCase C / Case A に委譲");
        return;
      }
      // 物件ボタンが1つもないまま25秒経過 → 0件確定
      _autoSendArmed = false;
      // Case B/C が遅れて発火してリスト二重送信されるのを封印する
      _pendingAutoSendDispatched = true;
      // この顧客は0件確定 → 再開フラグを残すと次のページロードで誤発火するので消す
      try { chrome.storage.session.remove("axlx_pending_auto_send"); } catch (_) {}
      console.log("[AXLX bulk-dl] 25秒経過・新ボタンなし確定（tracked=0） → 0件としてbatch-customer-done送信");
      try {
        chrome.runtime.sendMessage(
          { type: "axlx-batch-customer-done", customerId: _armed0ItemCid, propertyCount: 0 },
          function () { void chrome.runtime.lastError; }
        );
      } catch (_) {}
    }, 1000);
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
        autoSendOnePage(autoState, function (ok, cnt) { autoState.sentCount = (autoState.sentCount || 0) + (cnt || 0); tryNext(autoState); });
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
