(function () {
  "use strict";

  // 物件詳細・その他ページでは動作不要（MutationObserver＋DOM走査によるメモリ圧迫を防ぐ）
  if (location.pathname.indexOf("main.php") === -1) return;

  var tracked = [];
  var injectTimer = null;
  var _pendingAutoSendDispatched = false; // inject() から autoSendAllPages を起動済みか
  var _autoSendArmed = false;            // fill-done 受信後、新結果待ちフラグ
  /**
   * 2026-11-12 竹内さん「自動で検索したら検索も条件入れる前にいま出ている物件のダウンロードを始めてしまう」
   *   原因: 自動入力が始まった瞬間（`axlx-autofill-initiated`）から、**画面に残っている前の一覧**を
   *     そのまま「検索結果」とみなして押し始めていた（`inject()` の末尾と `_maybeAutoPressOnLoad`）。
   *     条件を入れて検索を押す前なので、**別のお客様の・条件の違う一覧**を送ってしまう（一番まずい）。
   *   → **自動入力の間（initiated から fill-done まで）は自動で押さない**。
   *     押してよいのは「検索を押した合図（fill-done）が来て、**その後に出た新しい行**」だけ。
   *   ⚠ ページが読み直されるとこの変数は作り直される（＝新しい結果ページでは false から始まる）ので、
   *     検索後の一覧は今まで通り押せる。
   */
  var _autofillInProgress = false;       // 自動入力の最中（条件入力中・検索を押す前）＝押さない
  var _autofillStartedAt = 0;
  var _autofillStuckMs = 20 * 60 * 1000; // 念のため20分で解く（合図が来ないまま固まっても永久に押せなくしない）
  /**
   * ★ 2026-11-18 録画（17:38:49 平田さんの入力開始 → 17:39:00〜05 に大村さんの一覧の印刷用PDFを4回押した）:
   *   押し始めの後に「別の入力が始まった」かを見る印。0 に戻さない（解除と区別するため）。
   *   別のタブの入力も session の axlx_fill_busy で届く（initiated はそのタブの中にしか来ない）。
   */
  var _lastFillStartAt = 0;
  /**
   * 2026-11-12 竹内さん「自動で検索したら検索も条件入れる前にいま出ている物件のダウンロードを始めてしまう」:
   *   ⚠ この印は **sessionStorage に残さない**（わざと）。
   *     残すと、検索を押してページが読み直された後に「まだ入力中」と誤解し、
   *     せっかく出た検索結果を**20分間押せなくなる**（別のバグになる）。
   *     ページが読み直された＝検索を押した後なので、**押してよい**のが正しい。
   *   → 同じページの中でだけ効かせる（＋「新しい行か」の判定を併用する）。
   */
  function _setFillInProgress(on) {
    _autofillInProgress = !!on;
    _autofillStartedAt = on ? Date.now() : 0;
    if (on) {
      _lastFillStartAt = _autofillStartedAt;
      // ★ 2.8.191: 新しい入力開始で並べ替えカーソル予約を捨てる
      try {
        _sortCursorScheduled = false;
        if (_sortCursorTimer) { clearTimeout(_sortCursorTimer); _sortCursorTimer = null; }
        _autoPdfSig = "";
      } catch (_) {}
    }
    /**
     * ★ 2026-11-16 録画実測: 住居検索へ移るとページが読み直され、この変数が false に戻る。
     *   そのすきに前の一覧の印刷用PDFが走り、条件入力（所在地・間取り）と同時に動いていた。
     *   → session に印を残し、fill-done まで「検索前」と扱う（検索後の読み直しでは消えている）。
     */
    try {
      if (on) chrome.storage.session.set({ axlx_fill_busy: { at: Date.now() } });
      else chrome.storage.session.remove("axlx_fill_busy");
    } catch (_) {}
  }
  /** ページ読み直し後も「条件入力中」なら true（session の印を見る） */
  var _fillBusyFromSession = false;
  try {
    chrome.storage.session.get(["axlx_fill_busy"], function (r) {
      var b = r && r.axlx_fill_busy;
      if (b && b.at && Date.now() - Number(b.at) < 20 * 60 * 1000) {
        _fillBusyFromSession = true;
        _autofillInProgress = true;
        _autofillStartedAt = Number(b.at) || Date.now();
        console.log("[AXLX bulk-dl] 条件入力中の印が残っている → 検索前の一覧は押しません");
      }
    });
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== "session" || !ch.axlx_fill_busy) return;
      if (ch.axlx_fill_busy.newValue) {
        _fillBusyFromSession = true;
        _autofillInProgress = true;
        _autofillStartedAt = Number(ch.axlx_fill_busy.newValue.at) || Date.now();
        if (_autofillStartedAt > _lastFillStartAt) _lastFillStartAt = _autofillStartedAt;
        _haltAutoPdfForNewFill("fill_busy_changed");
        // ★ 2.8.191: 次の入力が始まったら並べ替えカーソル予約を捨てる（前の一覧へ行かない）
        try {
          _sortCursorScheduled = false;
          if (_sortCursorTimer) { clearTimeout(_sortCursorTimer); _sortCursorTimer = null; }
          _autoPdfSig = "";
        } catch (_) {}
      } else {
        _fillBusyFromSession = false;
        _autofillInProgress = false;
      }
    });
  } catch (_) {}
  function _isFillBusy() {
    return !!(_autofillInProgress || _fillBusyFromSession);
  }
  /** 押し始め（since）の後に別の入力が始まったか */
  function _newFillSince(since) {
    return !!(since && _lastFillStartAt && _lastFillStartAt > since);
  }
  /**
   * 押している途中で次のお客さんの入力が始まったら、黙って止める。
   *   ⚠ _autoFinish は使わない（今のお客さん＝次のお客さんの名前で「送り終わり」を返してしまう）。
   */
  function _haltAutoPdfForNewFill(why) {
    // ★ 2026-11-22: PDF押しが無くても並べ替えホバー中なら中断（駅選択との同時進行を止める）
    try { if (typeof _abortAdSort === "function") _abortAdSort("halt_" + why); } catch (_) {}
    if (!_autoPdfRun || !_newFillSince(_autoPdfRun.startedAt)) return false;
    // 止めたお客さんの番号（次のお客さんの名前で返さない・番号の分かる人にだけ「ここまで」の合図を送る・2026-11-20）
    var _haltCid = null;
    try { _haltCid = _autoRunCid || (_autoPdfRun && _autoPdfRun.customerId) || null; } catch (_) { _haltCid = null; }
    _autoPdfRun.stopped = true;
    _autoPdfRun = null;
    try { _autoRunCid = null; } catch (_) {}
    try { _sendSkipDoneFor(_haltCid, "halt_new_fill_" + why, _autoPdfTotalSent); } catch (_) {}
    console.warn("[AXLX bulk-dl][auto] 次の入力が始まった → 前の一覧の印刷用PDFを止めます（" + why + "）");
    _tmark("auto_pdf_end", "stopped_new_fill_" + why);
    try {
      var _sb0 = document.getElementById("axlx-autopdf-stop-btn");
      if (_sb0) _sb0.style.display = "none";
    } catch (_) {}
    return true;
  }
  var _autofillInitiated = false;        // 手動autofillボタン押下フラグ（fill-done到着前）
  var _preAutofillBtns = new Set();      // autofill前の 印刷用PDF ボタンスナップショット
  var _pendingCustomerForAutoSend = null; // autofill開始時点の顧客スナップショット（名前ずれ防止）
  var _zeroDetectTimer = null;            // 0件確定ポーリングタイマー（顧客切替時にクリア）

  // 2026-09-27 竹内「拡張ツールは人間らしい動きをするために全て時間ランダムにする」: 人の操作の間（human-wait.js・manifest で先に読む）。
  //   読めない時は元の値。_hd＝人の操作の間（0.8〜1.5倍）／_sd＝ページが落ち着くのを待つ固定の秒数（元より短くしない）
  function _hd(ms) { var H = (typeof self !== "undefined" ? self : window).AxlxHumanWait; return H ? H.humanDelay(ms) : ms; }
  function _sd(ms) { var H = (typeof self !== "undefined" ? self : window).AxlxHumanWait; return H ? H.settleDelay(ms) : ms; }

  // ── ページ離脱（検索リロード開始）時は0件確定ポーリングを必ず破棄する ──
  // 検索クリック→fill-done→リロード完了の間にサーバー応答が遅いと、旧ページ上の
  // 0件確定タイマーが誤発火して「0件」を background に送信し、さらに Case C の
  // 起動フラグ（axlx_pending_auto_send）まで消してしまう。
  // → リロード後の結果ページで全ページ送るが永久に起動しない
  //   （複数顧客バッチで2人目以降が無音で死ぬ根本原因の一つ）。
  window.addEventListener("pagehide", function () {
    if (_zeroDetectTimer) { clearInterval(_zeroDetectTimer); _zeroDetectTimer = null; }
  });

  /**
   * ★ 2.8.264 竹内さん「検索押してから結果表示までかなり遅い／その間にAD並び替えが走ってバグる」:
   *   リアプロの検索はページごと移る。押してからサーバーが返すまで古い一覧が画面に残るので、
   *   旧は「押して2.8秒たった・行がある」で古い一覧を結果と認め、並べ替えのリンクを押して検索を打ち消していた。
   *   → 検索押下から20秒以内に beforeunload が来たら「移動中」。このページでは並べ替えを始めない。
   *     （ダウンロードのリンクでも beforeunload は来るので、検索押下に紐づく時だけ・30秒で自然に解く）
   */
  var _AXLX_DOC_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  var _navPendingAt = 0;
  var _navPendingLogAt = 0;
  function _isNavPending() {
    return !!(_navPendingAt && Date.now() - _navPendingAt < 30000);
  }
  window.addEventListener("beforeunload", function () {
    try {
      var b = null;
      try { b = JSON.parse(sessionStorage.getItem("axlx_search_press_baseline") || "null"); } catch (_) { b = null; }
      var pAt = Number(b && b.at) || 0;
      if (!pAt || Date.now() - pAt >= 20000) return;
      _navPendingAt = Date.now();
      try { if (_sortCursorTimer) { clearTimeout(_sortCursorTimer); _sortCursorTimer = null; } } catch (_) {}
      try { if (_screenOkWatchTimer) { clearTimeout(_screenOkWatchTimer); _screenOkWatchTimer = null; } } catch (_) {}
      if (!_adSortInFlight) { try { _abortAdSort("nav_pending"); } catch (_) {} }
      console.log("[AXLX bulk-dl] 検索の移動中（サーバー応答待ち）→ 古い一覧で並べ替えしない ms=" + (Date.now() - pAt));
    } catch (_) {}
  });

  /**
   * ★ 2.8.264: 「押してから結果が出るまで遅い」の内訳を次の1回で測る。
   *   press→nav = 押してからリアプロへ問い合わせが出るまで（こちらの待ち）
   *   server = リアプロの応答待ち / dom・load = ページの組み立て（こちらの拡張の重さも入る）
   */
  var _navTimingBase = null;
  try { _navTimingBase = JSON.parse(sessionStorage.getItem("axlx_search_press_baseline") || "null"); } catch (_) { _navTimingBase = null; }
  function _logNavTiming() {
    try {
      var b = _navTimingBase;
      if (!b || !b.at || Date.now() - Number(b.at) > 180000) return;
      var nav = performance.getEntriesByType ? performance.getEntriesByType("navigation")[0] : null;
      if (!nav) return;
      var t0 = performance.timeOrigin || 0;
      var r = function (x) { return Math.round(x); };
      var msg = "press→nav=" + r(t0 + nav.startTime - Number(b.at))
        + " server=" + r(nav.responseStart - nav.requestStart)
        + " dl=" + r(nav.responseEnd - nav.responseStart)
        + " dom=" + r(nav.domContentLoadedEventEnd - nav.responseEnd)
        + " load=" + r(nav.loadEventEnd - nav.responseEnd)
        + " press→load=" + r(t0 + nav.loadEventEnd - Number(b.at));
      console.log("[AXLX bulk-dl] nav_timing " + msg);
      try { _liveDlStep("nav_timing", msg.slice(0, 140)); } catch (_) {}
    } catch (_) {}
  }
  try {
    if (_navTimingBase) {
      if (document.readyState === "complete") setTimeout(_logNavTiming, 50);
      else window.addEventListener("load", function () { setTimeout(_logNavTiming, 50); });
    }
  } catch (_) {}

  /** ★ 2.8.264: body の先頭の文字だけ（textContent／innerText で一覧全文を作らない） */
  function _bodyHeadText(max) {
    try {
      if (!document.body || !document.createTreeWalker) return "";
      var tw = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */, null);
      var out = "", n;
      while ((n = tw.nextNode())) {
        var p = n.parentNode;
        // 選択肢（「徒歩15分」「更新1日以内」等）は画面の条件ではないので読まない（旧 innerText と同じ扱い）
        if (p && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION|SELECT)$/.test(p.nodeName)) continue;
        out += n.nodeValue + " ";
        if (out.length >= max) break;
      }
      return out.slice(0, max);
    } catch (_) { return ""; }
  }


  // ── 2026-09-27 自動便（auto_schedule）の指定（background が storage に置く・chrome-extension/auto-run.js）──
  // 竹内「ITANDI もおねがい」: 午後の便＝1ページ・更新順／午前の便＝3ページ。お客様（とサイト）が合う時だけ使う（手動の検索は今までどおり）
  var _autoRunStored = null;
  function _AR() { return (typeof self !== "undefined" ? self : window).AxlxAutoRun || null; }
  try {
    var _arKey = _AR() ? _AR().STORAGE_KEY : "axlx_auto_run";
    chrome.storage.local.get([_arKey], function (r) { _autoRunStored = (r && r[_arKey]) || null; });
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area === "local" && ch[_arKey]) _autoRunStored = ch[_arKey].newValue || null;
    });
  } catch (_) {}
  function _autoRunFor(customerId) {
    var A = _AR();
    return A ? A.forCustomer(_autoRunStored, customerId, "realnetpro", Date.now()) : null;
  }

  // ── 2026-09-29 v2.5.41 送付済みの部屋（background が一括の1人ごとに storage.session に置く・chrome-extension/sent-skip.js）──
  // 竹内「一度送ったことがある物件はダウンロードもしないようにすれば更に問題なく物件検索できる。人間の動きのように」:
  //   全ページ送る時に、建物名＋号室がそのお客様に送付済みの部屋と同じ行は選ばない（資料の PDF を取りに行かない・判定にも渡さない）。
  //   号室が無い・名前が読めない行は選ぶ（迷ったら飛ばさない）。スタッフモードは飛ばさない
  var _sentRoomsStored = null;
  function _SK() { return (typeof self !== "undefined" ? self : window).AxlxSentSkip || null; }
  try {
    var _skKey = _SK() ? _SK().STORAGE_KEY : "axlx_sent_rooms";
    chrome.storage.session.get([_skKey], function (r) { _sentRoomsStored = (r && r[_skKey]) || null; });
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area === "session" && ch[_skKey]) _sentRoomsStored = ch[_skKey].newValue || null;
    });
  } catch (_) {}

  /**
   * 選んだ行のうち送付済みの部屋のチェックを外す（数える）＋一覧の更新日の経過を数える（点検の C2・count が true の時だけ）。
   *   先頭のセル（見出し「部屋名更新日」）「309 4日前 閲覧済」から号室と更新日を読む。見出しが別の物の時は読まない
   */
  function _applySentSkip(state, count) {
    var SK = _SK();
    if (!SK || !state) return { skipped: 0 };
    var idx = _staffModeOn ? null : SK.indexFor(_sentRoomsStored, state.customerId, Date.now());
    if (!idx && !count) return { skipped: 0 };
    var skipped = 0, names = [];
    var ages = state.updateAges || { n: 0, max_days: null, sample: [] };
    tracked.forEach(function (t) {
      if (!t.cb.checked) return;
      var card;
      try { card = extractCard(t.btn); } catch (_) { return; }
      var labels = card && card.headerIdx && card.headerIdx.labels;
      if (labels && labels.length && !/部屋|号室/.test(String(labels[0] || ""))) return;
      var c0 = card && card.cells ? card.cells[0] : null;
      if (count) {
        var a = SK.ageDaysOfCell(c0);
        if (a != null) { ages.n++; ages.max_days = ages.max_days == null ? a : Math.max(ages.max_days, a); if (ages.sample.length < 150) ages.sample.push(Math.round(a * 100) / 100); }
      }
      if (!idx) return;
      var room = SK.roomFromRealproCell(c0);
      if (room && SK.isSentRoom(idx, card.name, room)) { t.cb.checked = false; t.__axSkip = true; skipped++; if (names.length < 5) names.push(card.name + " " + room); }
    });
    if (count) {
      state.updateAges = ages;
      state.sentSkipped = (state.sentSkipped || 0) + skipped;
      state.pageSkipped = skipped;
      if (skipped) console.log("[AXLX bulk-dl] 送付済みの部屋 " + skipped + "件は選ばない（資料をダウンロードしない）: " + names.join("・"));
    }
    updateBar();
    return { skipped: skipped };
  }

  /**
   * 2026-11-14 竹内さん「同じ建物の場合平米数が同じなら一番低い家賃の物件1件だけにする」
   * ★ 2026-11-22「同じ建物だったら２㎡の違い以内は家賃低だけダウンロード／大量ダブり防止」
   *
   *   → **同じ建物・同じ間取り・面積差 2㎡以内**なら、**いちばん安い1件だけ**を選ぶ。
   *
   *   ⚠ 守る事:
   *     ・間取りが違う／面積差が2㎡超なら**別の部屋**として残す
   *     ・建物名・間取り・平米・家賃が**読めない時は絞らない**（迷ったら残す＝資料を落とさない）
   *     ・スタッフの**手選び**では絞らない（人が選んだ物を勝手に外さない）
   *     ・スタッフでも**自動押し**（forAuto）では絞る（大量ダブり防止・2.8.168）
   *   判定は `chrome-extension/room-dedupe.js`（純関数・試験あり）。
   */
  function _applyCheapestPerLayout(state, cand, opts) {
    if (!state) return { dropped: 0 };
    var forAuto = !!(opts && opts.forAuto);
    // スタッフの手選びは外さない。自動押し（スタッフ×自動含む）は 2㎡以内の最安だけ
    if (_staffModeOn && !forAuto) return { dropped: 0 };
    var RD = (typeof self !== "undefined" ? self : window).AxlxRoomDedupe;
    if (!RD || !RD.cheapestPerBuildingLayoutSize) return { dropped: 0 };
    /**
     * 2026-11-14 竹内さん「物件同じ平米数のもダウンロードまだしてしまっている
     *   平米数がおなじなら家賃は一番おさえれるのにする」→ **絞れていなかった**。
     *
     *   ⚠ 真の原因: 旧は `tracked` を **`t.cb.checked` で絞って**いた。
     *     だが `_selectAllowed` の時点では**1件もチェックされていない**
     *     （この後の `_doSend` が1件ずつチェックする形＝先に全行チェックしない）。
     *     → `items` が常に空 → `items.length < 2` で**必ず何も絞らずに抜けていた**。
     *       実測: 「同じ建物・同じ間取り・同じ平米」が全部ダウンロードされていた。
     *
     *   → 渡された**候補（cand＝これから送る行）**を対象にする（チェックの状態を見ない）。
     *     ⚠ 送付済み・古い行は呼ぶ側（`_selectAllowed`）で既に外れている。
     */
    var list = Array.isArray(cand) ? cand : tracked;
    var items = [], refs = [];
    list.forEach(function (t) {
      if (!t || !t.btn) return;
      // 送付済み・古い行として外された物は対象にしない（呼ぶ側の判断を尊重）
      if (t.__axSkip) return;
      var card;
      try { card = extractCard(t.btn); } catch (_) { return; }
      items.push({ name: card.name, cells: card.cells || [], texts: card.texts || [] });
      refs.push(t);
    });
    if (items.length < 2) return { dropped: 0 };
    var res = RD.cheapestPerBuildingLayoutSize(items);
    var dropped = 0, names = [];
    for (var i = 0; i < res.drop.length; i++) {
      var t = refs[res.drop[i]];
      if (!t) continue;
      /** チェックが付いていれば外す（付いていなくても、送らない印を立てる＝_doSend が選ばない） */
      try { if (t.cb) t.cb.checked = false; } catch (_) {}
      t.__axSkip = true;
      t.__axCheapestSkip = true;
      dropped++;
      if (names.length < 4) {
        var f = RD.factsOf(items[res.drop[i]]);
        names.push(f.name + " " + (f.room || "") + "（" + (f.layout || "?") + " " + (f.area != null ? f.area + "㎡" : "?") + "）");
      }
    }
    if (dropped) {
      state.cheapestSkipped = (state.cheapestSkipped || 0) + dropped;
      state.cheapestGroups = (state.cheapestGroups || 0) + res.groups.filter(function (g) { return g.dropped.length; }).length;
      console.log("[AXLX bulk-dl] 同じ建物・同じ間取り・2㎡以内は最安1件だけ選ぶ: " + dropped + "件を外しました: " + names.join("・"));
      updateBar();
    }
    return { dropped: dropped };
  }

  /** 一覧の1行（送る直前に選んだ1件）を pickedRooms に足す（2026-11-10・1件ずつ選ぶ形） */
  function _rememberPickedOne(state, item) {    var SK = _SK();
    if (!state || !item || !item.btn) return;
    var list = state.pickedRooms || (state.pickedRooms = []);
    if (list.length >= 150) return;
    var card;
    try { card = extractCard(item.btn); } catch (_) { return; }
    if (!card || !card.name) return;
    var labels = card.headerIdx && card.headerIdx.labels;
    var roomCell = labels && labels.length && !/部屋|号室/.test(String(labels[0] || "")) ? null : (card.cells ? card.cells[0] : null);
    var room = SK && roomCell ? SK.roomFromRealproCell(roomCell) : null;
    list.push({ n: String(card.name).slice(0, 60), r: room ? String(room).slice(0, 12) : null });
  }

  /** 一覧の更新日の経過を数える（点検の C2 用・チェックは触らない）。_applySentSkip(count=true) の数え方と同じ */
  function _countRowAges(state) {
    var SK = _SK();
    if (!SK || !state || _staffModeOn) return;
    var ages = state.updateAges || { n: 0, max_days: null, sample: [] };
    tracked.forEach(function (t) {
      var card;
      try { card = extractCard(t.btn); } catch (_) { return; }
      var labels = card && card.headerIdx && card.headerIdx.labels;
      if (labels && labels.length && !/部屋|号室/.test(String(labels[0] || ""))) return;
      var c0 = card && card.cells ? card.cells[0] : null;
      var a = SK.ageDaysOfCell(c0);
      if (a == null) return;
      ages.n++;
      ages.max_days = ages.max_days == null ? a : Math.max(ages.max_days, a);
      if (ages.sample.length < 150) ages.sample.push(Math.round(a * 100) / 100);
    });
    state.updateAges = ages;
  }

  /**
   * 2026-11-10 竹内さん「一気に選択されてしまうのでなくて1つ1つ行っていく形で」:
   *   1件ずつ選ぶ形では「先に全行へチェックを入れてから外す」ことをしない（画面で一気に選択される）。
   *   この1件が送ってよい行かを、チェックを触らずに判定する（送付済みの部屋・更新日で止める行は送らない）。
   *   _applySentSkip / _applyUpdateOrderStop と同じ物差し（SS/SK・UO）を使う＝2つの決まりを作らない。
   */
  function _rowSkipReason(state, item) {
    if (!state || !item || !item.btn) return "no-row";
    if (item.__axSkip) return "sent";            // _applySentSkip が印を付けた行
    /**
     * ★ 2026-11-16 竹内さん「送付済みとわかっていたら送らない／徹底」:
     *   画面に「送付済み」「送付済みの建物」と出ていれば送らない（複雑にしない）。
     *   DB照合（部屋一致）も従来どおり。どちらかで送付済みならスキップ。
     * ★ 2026-11-17: class が無くても行内テキスト「送付済み」で検知
     *   （1件目が送付済みなのに押して止まり、2件目へ進まない事故の予防）。
     */
    try {
      if (item.btn.classList && item.btn.classList.contains("axlx-pdf-sent")) return "sent";
      var parent = item.btn.parentNode;
      if (parent && parent.querySelector) {
        if (parent.querySelector(".axlx-pdf-sent-label")) return "sent";
        if (parent.querySelector(".axlx-sent-bld-badge")) return "sent";
      }
      var rowEl = item.btn.closest ? item.btn.closest("tr") : null;
      if (rowEl && rowEl.classList && rowEl.classList.contains("axlx-sent-hidden")) return "sent";
      if (rowEl && rowEl.querySelector && rowEl.querySelector(".axlx-sent-bld-badge,.axlx-pdf-sent-label")) return "sent";
      // 号室セル近傍の「送付済み」札（axlx／サイト素の両方）
      var near = parent || rowEl;
      if (near) {
        var nearTx = "";
        try { nearTx = String(near.innerText || near.textContent || ""); } catch (_) { nearTx = ""; }
        if (/送付済み/.test(nearTx)) return "sent";
      }
      if (rowEl) {
        var rowTx = "";
        try { rowTx = String(rowEl.innerText || rowEl.textContent || ""); } catch (_) { rowTx = ""; }
        // 行に「送付済み」があり、かつこの PDF ボタンの近く（同じセル／隣）なら送付済み
        if (/送付済み/.test(rowTx)) {
          var cell = item.btn.closest ? (item.btn.closest("td") || item.btn.closest("div")) : null;
          var cellTx = cell ? String(cell.innerText || cell.textContent || "") : "";
          if (/送付済み/.test(cellTx)) return "sent";
          // ラベルがボタン直後
          var sib = item.btn.nextSibling;
          var guard = 0;
          while (sib && guard < 4) {
            guard++;
            try {
              var sTx = String((sib.textContent || sib.innerText || "")).trim();
              if (/送付済み/.test(sTx)) return "sent";
            } catch (_) {}
            sib = sib.nextSibling;
          }
        }
      }
    } catch (_) {}
    var SK = _SK();
    if (SK && !_staffModeOn) {
      var idx = SK.indexFor(_sentRoomsStored, state.customerId, Date.now());
      if (idx) {
        var card = null;
        try { card = extractCard(item.btn); } catch (_) { card = null; }
        var labels = card && card.headerIdx && card.headerIdx.labels;
        var okCell = !(labels && labels.length && !/部屋|号室/.test(String(labels[0] || "")));
        var room = okCell && card && card.cells ? SK.roomFromRealproCell(card.cells[0]) : null;
        if (card && room && SK.isSentRoom(idx, card.name, room)) return "sent";
      }
    }
    var stop = state.updateStop;
    if (stop && stop.page === state.currentPage && stop.index != null) {
      var at = tracked.indexOf(item);
      if (at >= 0 && at >= stop.index) return "old"; // 前回の検索より古い行
    }
    return null;
  }

  // ── 2026-09-30 v2.5.43 竹内「更新順で検索していたら、その更新順以降は見なくて大丈夫」（chrome-extension/update-order-stop.js）──
  //   更新日順（新しい順）の一覧では、行の更新日（先頭のセル「309 4日前」「0405 2時間前」）が「このお客様×リアプロの前回の検索の時刻」
  //   （background が auto-run の record に載せる last_search_at＝サーバーの update_days_plan.by_customer[id].last_by_site.realpro）より
  //   古くなった行から先は選ばず、次のページも開かない。
  //   ⚠ 止めるのは「前回の検索より古い行」であって「送付済みの行」ではない（送付済みでも新しく更新された部屋は見る。送付済みの飛ばしは _applySentSkip のまま）。
  //   前回の時刻が無い・読めない・AD 高い順（多くの回）・並びが分からない（読めて単調な行が10行未満）時は今まで通り（ページの上限まで）。スタッフモードは見ない
  function _UO() { return (typeof self !== "undefined" ? self : window).AxlxUpdateOrderStop || null; }
  function _firstCellOf(t) {
    try {
      var card = extractCard(t.btn);
      var labels = card && card.headerIdx && card.headerIdx.labels;
      if (labels && labels.length && !/部屋|号室/.test(String(labels[0] || ""))) return null;
      return card && card.cells ? card.cells[0] : null;
    } catch (_) { return null; }
  }
  function _uncheckFromStop(state) {
    var s = state && state.updateStop;
    if (!s || s.page !== state.currentPage || s.index == null) return 0;
    var n = 0;
    tracked.slice(s.index).forEach(function (t) { if (t.cb.checked) { t.cb.checked = false; n++; } });
    return n;
  }
  function _applyUpdateOrderStop(state) {
    var U = _UO();
    if (!U || !state || _staffModeOn || !tracked.length) return null;
    if (state.updateStop) { _uncheckFromStop(state); updateBar(); return state.updateStop; }
    if (state.uoPage === state.currentPage) return null; // このページは見た
    var opts = _autoRunFor(state.customerId);
    var lastIso = opts && opts.last_search_at ? String(opts.last_search_at) : null;
    state.uoPage = state.currentPage;
    if (!lastIso) return null;
    var now = Date.now();
    var rows = tracked.map(function (t) {
      var c0 = _firstCellOf(t);
      return { newest: c0 ? U.newestPossibleMs(c0, now) : null, text: c0 || "" };
    });
    var dec = U.decideStop({ rows: rows, lastSearchMs: Date.parse(lastIso), nowMs: now, order: U.orderForRealpro(location.href, opts), carry: state.updateCarry || null });
    state.updateCarry = dec.carry;
    if (dec.stopIndex < 0) return null;
    state.updateStop = U.stopRecord(dec.carry, state.currentPage, lastIso, "realpro");
    var n = _uncheckFromStop(state);
    updateBar();
    console.log("[AXLX bulk-dl] " + (U.describeStop(state.updateStop) || "前回の検索より古い行で止めた") + " → この行から先の " + n + "件は選ばず、次のページも開かない");
    return state.updateStop;
  }

  /**
   * 2026-09-30 v2.5.42 竹内「画面見るところで、前に共有した物件はダウンロードされないようになっているのか読み取って」:
   *   資料を取りに行く直前に、一覧でチェックが入っている行（＝ダウンロードする部屋）の建物名＋号室を読んで残す（150件まで）。
   *   サーバーの点検（search-audit-check SENT_SELECTED）が、そのお客様の送付済みの部屋（/api/automation/sent-rooms と同じ出所）と照らす
   *   2026-11-10: 1件ずつ選ぶ形になったので、送る直前に _rememberPickedOne で1件ずつ足す（この関数はもう使わない）
   */

  // 2026-11-10 竹内さん「一気に選択されてしまうのでなくて1つ1つ行っていく形で」:
  //   旧の _humanCheckAll（全行を1件ずつ=最後には全部チェック）は使わない。1件ずつ「選ぶ→送る→次を選ぶ」で
  //   画面は常に1件だけになる（_oneByOneStart・_humanClickCb）。

  // 全ページ自動送信: sessionStorage キー ──────────────
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

  // ── ブレインのキャッシュ（2026-09-23 竹内「物件検索の拡張ツールでもブレインモードつくる」）──
  // 2026-09-25 竹内「ブレインだけ別で、ほかはドロップダウン。ブレインでもスタッフモードや AIX モード、通常モードを行う」:
  //   旧は aixMode と brainMode の両方 true の時だけ ON。新は **brainMode 単独で ON**（通常／スタッフ／AIX連動のどれとも組み合わせる）。
  //   組み合わせの仕様は mode-core.js（AxlxModeCore.behavior）。content script には読み込んでいないので、ここは同じ意味の分岐だけ持つ:
  //     brainJudge = brainMode ／ brainDrop = brainMode かつ スタッフでない ／ brainNote = brainMode（スタッフでも付ける・buildSendItemsBrain 参照）
  //   判定の失敗・タイムアウトは今までどおり全件送る（fail-open）。
  var _brainModeOn = false;
  try {
    chrome.storage.local.get(["brainMode"], function(res) {
      _brainModeOn = !!(res && res.brainMode);
    });
    chrome.storage.local.onChanged.addListener(function(changes) {
      if ("brainMode" in changes) _brainModeOn = !!changes.brainMode.newValue;
    });
  } catch (_e) {}

  // ── 操作ごとの時刻（2026-09-27 v2.5.31 竹内「操作ごとの待ち時間を本物の検索の記録で測れるように」）──
  // fill-done を受けた時（armed）から、結果を見た・並び替えの前の間・並び替えへ進んだ・ページ・資料の送信の束（送った／返った）・
  // 次のページへ、の時刻を sessionStorage に貯め（ページの読み直しでも消えない）、axlx-batch-customer-done の audit.timings に載せて渡す。
  // background（search-audit.js の tracker）が点検の段（steps）に "dl:" を付けて並べる。関数を大量に呼んで分布を取るのでなく、本物の検索の1回を読む
  var AUDIT_T_KEY = "axlx_audit_timings";
  function _treset(cid) {
    try { sessionStorage.setItem(AUDIT_T_KEY, JSON.stringify({ cid: cid != null ? String(cid) : null, list: [] })); } catch (_) {}
  }
  function _tmark(k, d, cid) {
    try {
      var raw = sessionStorage.getItem(AUDIT_T_KEY);
      var o = raw ? JSON.parse(raw) : null;
      if (!o || !Array.isArray(o.list)) o = { cid: null, list: [] };
      if (cid != null) {
        if (o.cid == null) o.cid = String(cid);
        else if (o.cid !== String(cid)) o = { cid: String(cid), list: [] }; // 別のお客様の回に変わった
      }
      o.list.push({ k: String(k).slice(0, 20), at: Date.now(), d: d == null ? null : String(d).slice(0, 60) });
      while (o.list.length > 50) o.list.shift();
      sessionStorage.setItem(AUDIT_T_KEY, JSON.stringify(o));
    } catch (_) {}
  }
  /**
   * ★ 2.8.186: 並べ替え／一覧照会の印を監査へ即送る（batch-done 待ち・死んだ _axlxAuditStep に頼らない）。
   *   timings にも残しつつ、live で steps に載せる＝途中停止でも印が残る。
   */
  /**
   * ★ 2.8.279 竹内さん「拡張ツールひらいているとき重すぎる／原因見つけて改善」:
   *   一覧のページで1分ごとに「画面が止まった処理（longtask・50ms超）の回数・合計・最大・JS メモリ」と、
   *   重くなりやすい処理の回数（印刷用PDF探し・チェック欄の作り直し・点検への送信）を数える。
   *   ⚠ 自動の回が無い時（人が一覧を見ているだけ）も残すため、重い時だけ10分に1回まで background 経由で
   *     既存の表 chrome_extension_feedback（category=other・"[perf]"）へ送る。動きは変えない。
   */
  var _perfC = { find: 0, rebuild: 0, live: 0 };
  (function _axlxDlPerf() {
    try {
      if (window.__axlxDlPerfOn) return;
      window.__axlxDlPerfOn = true;
      var n = 0, sum = 0, max = 0, lastSent = 0;
      if (typeof PerformanceObserver === "function") {
        try {
          new PerformanceObserver(function (list) {
            list.getEntries().forEach(function (e) { n++; sum += e.duration; if (e.duration > max) max = e.duration; });
          }).observe({ entryTypes: ["longtask"] });
        } catch (_) {}
      }
      setInterval(function () {
        try {
          if (document.hidden) { n = 0; sum = 0; max = 0; _perfC = { find: 0, rebuild: 0, live: 0 }; return; }
          var mem = null;
          try { if (performance && performance.memory) mem = Math.round(performance.memory.usedJSHeapSize / 1048576); } catch (_) {}
          var notable = n >= 5 || max >= 500 || sum >= 1500 || (mem != null && mem >= 500);
          var line = "止まり" + n + "回 計" + Math.round(sum) + "ms 最大" + Math.round(max) + "ms"
            + (mem != null ? " メモリ" + mem + "MB" : "")
            + " 探し" + _perfC.find + " 作り直し" + _perfC.rebuild + " 点検送信" + _perfC.live
            + " 行" + tracked.length;
          try { sessionStorage.setItem("axlx_perf_last", line); } catch (_) {}
          if (notable && Date.now() - lastSent > 600000) {
            lastSent = Date.now();
            var ver = "";
            try { ver = chrome.runtime.getManifest().version; } catch (_) {}
            var page = /method=estate|display=building/.test(String(location.search || "")) ? "一覧" : "その他";
            try {
              chrome.runtime.sendMessage({ type: "axlx-perf-report", text: "[perf] v" + ver + " realpro " + page + " " + line }, function () { void chrome.runtime.lastError; });
            } catch (_) {}
            try { _liveDlStep("perf_longtask", line.slice(0, 80)); } catch (_) {}
          }
          n = 0; sum = 0; max = 0; _perfC = { find: 0, rebuild: 0, live: 0 };
        } catch (_) {}
      }, 60000);
    } catch (_) {}
  })();
  function _liveDlStep(k, d, cid) {
    try { _perfC.live++; } catch (_) {}
    try { _tmark(k, d, cid); } catch (_) {}
    try {
      var _cid = cid != null ? cid : (typeof _pickCustomerIdForAuto === "function" ? _pickCustomerIdForAuto() : null);
      chrome.runtime.sendMessage({
        type: "axlx-audit-live-step",
        k: "dl:" + String(k || "").slice(0, 32),
        d: d == null ? null : String(d).slice(0, 80),
        customerId: _cid != null ? String(_cid) : null,
        site: "realpro",
      }, function () { void chrome.runtime.lastError; });
    } catch (_) {}
    try {
      if (window._axlxAuditStep) window._axlxAuditStep(k, d == null ? null : String(d).slice(0, 80));
    } catch (_) {}
  }
  /**
   * ★ 2.8.250 竹内さん「一連で止まったら画面把握→強化」:
   *   fill 沈黙は fill終了で外れる。一覧・並べ替え・送付で止まった時に
   *   page-script へ照会→スクショ→最善次手→強化継続を依頼する（隔離世界→MAIN）。
   */
  var _pipelineSilenceTimer = null;
  var _pipelineSilenceBusy = false;
  var _pipelineSilenceTicks = 0;
  var _pipelineStuckActAt = 0;
  /** 120〜150秒のあいだ。page-script の AXLX_STUCK_IDLE_MS と同じ。 */
  var AXLX_STUCK_IDLE_MS = 135000;
  /** 止まりと判断した後、まだ動かない時の次の撮影・次手までの間。page-script の AXLX_STUCK_RETRY_MS と同じ。 */
  var AXLX_STUCK_RETRY_MS = 45000;
  function _touchPipelineProgress(why) {
    try {
      window.__axlxPipelineTouchAt = Date.now();
      window.__axlxPipelineTouchWhy = String(why || "touch").slice(0, 24);
    } catch (_) {}
  }
  function _disarmPipelineSilence(why) {
    try { if (_pipelineSilenceTimer) clearInterval(_pipelineSilenceTimer); } catch (_) {}
    _pipelineSilenceTimer = null;
    _pipelineSilenceBusy = false;
    _pipelineSilenceTicks = 0;
    try { _liveDlStep("pipeline_silence_off", String(why || "off").slice(0, 36)); } catch (_) {}
  }
  function _armPipelineSilence(why) {
    if (!_autoModeOn) return;
    if (_pipelineSilenceTimer) {
      try { _liveDlStep("pipeline_silence_keep", String(why || "keep").slice(0, 36)); } catch (_) {}
      return;
    }
    _pipelineSilenceTicks = 0;
    _touchPipelineProgress("arm:" + String(why || "arm").slice(0, 12));
    try { _liveDlStep("pipeline_silence_on", String(why || "list").slice(0, 36)); } catch (_) {}
    _pipelineSilenceTimer = setInterval(function () {
      if (_pipelineSilenceBusy) return;
      if (!_autoModeOn) {
        _disarmPipelineSilence("auto_off");
        return;
      }
      var pipelineOn = false;
      try {
        pipelineOn = !!(_autoSendArmed || _autoPdfRun || _adSortInFlight
          || (typeof _searchGraspedMem === "object" && _searchGraspedMem && _searchGraspedMem.at));
      } catch (_) { pipelineOn = !!(_autoSendArmed || _autoPdfRun); }
      if (!pipelineOn) return;
      var touchAt = 0;
      try { touchAt = Number(window.__axlxPipelineTouchAt) || 0; } catch (_) { touchAt = 0; }
      var idleMs = touchAt ? (Date.now() - touchAt) : 999999;
      /**
       * ★ 2.8.269 竹内さん「止まったの120秒から150秒の間にした方が良い。処理もちゃんと1つずつ。混乱しないように統括」:
       *   送付の間隔は実測 47〜81秒。12秒で撮影すると、送付の途中で画面コピーとPDF開きが重なる。
       *   135秒空くまで撮影しない。1件の送付中・次のお客さんの入力中は、その処理が終わるまで始めない。
       */
      if (_pdfBusy || _isFillBusy()) return;
      if (idleMs < AXLX_STUCK_IDLE_MS) return;
      if (_pipelineStuckActAt && Date.now() - _pipelineStuckActAt < AXLX_STUCK_RETRY_MS) return;
      _pipelineStuckActAt = Date.now();
      _pipelineSilenceBusy = true;
      _pipelineSilenceTicks++;
      var idleS = Math.round(idleMs / 1000);
      try {
        _liveDlStep(
          "pipeline_silence_tick",
          "n=" + _pipelineSilenceTicks + " idle=" + idleS + "s " + String(why || "").slice(0, 16),
        );
      } catch (_) {}
      /**
       * ★ 2.8.255: 沈黙中に screenOk が無い＝検索後固着の本線。
       *   DOM推論→並べ替え kick。それでも無進捗なら客完了へ（次客を止めない）。
       */
      try {
        if (!_isSearchConfirmGrasp(_searchGraspedMem) && !_autoPdfRun && !_adSortInFlight) {
          if (_inferScreenOkFromDom("silence_tick")) {
            _liveDlStep("silence_task_advance", "dom_infer→sort");
            setTimeout(function () {
              try { _kickSortAfterSearch("silence_dom_infer"); } catch (_) {}
              _pipelineSilenceBusy = false;
            }, 300);
            return;
          }
        }
        if (
          _pipelineSilenceTicks >= 2
          && !_autoPdfRun
          && !_adSortInFlight
          && _autoSendArmed
        ) {
          var nSilence = 0;
          try { nSilence = tracked.filter(function (t) { return t && t.btn && t.btn.isConnected; }).length; } catch (_) { nSilence = 0; }
          if (nSilence < 1) {
            try { _liveDlStep("silence_task_advance", "no_rows→customer_done"); } catch (_) {}
            try { _autoFinish("沈黙・押せる行無し→客完了"); } catch (_) {}
            _pipelineSilenceBusy = false;
            return;
          }
        }
      } catch (_) {}
      try {
        window.postMessage({
          from: "axlx-pipeline-silence-tick",
          why: String(why || "pipeline").slice(0, 36),
          idleSec: idleS,
          tick: _pipelineSilenceTicks,
        }, "*");
      } catch (_) {
        _pipelineSilenceBusy = false;
      }
    }, 10000);
  }
  window.addEventListener("message", function (e) {
    try {
      if (!e || e.source !== window || !e.data || e.data.from !== "axlx-pipeline-silence-done") return;
      _pipelineSilenceBusy = false;
      try {
        _liveDlStep(
          "pipeline_silence_done",
          "stuck=" + String(e.data.stuck || "?").slice(0, 14)
            + " act=" + String(e.data.acted || "?").slice(0, 14)
            + (e.data.recovered ? " recovered" : ""),
        );
      } catch (_) {}
      if (e.data && e.data.recovered) _touchPipelineProgress("recovered");
    } catch (_) {
      _pipelineSilenceBusy = false;
    }
  });
  /**
   * ★ 2.8.256 竹内さん「時間かかったら録画→強化／止まったら次へつなぐ」:
   *   page `_bridgeTimeoutRecordStrengthen` の次手を bulk が必ず実行する。
   *   sort_or_press → DOM推論＋並べ替え kick／行0なら客完了。throttle 4秒。
   */
  var _timeoutBridgeBusy = false;
  var _timeoutBridgeLastAt = 0;
  window.addEventListener("message", function (e) {
    try {
      if (!e || e.source !== window || !e.data || e.data.from !== "axlx-timeout-bridge-next") return;
      if (!_autoModeOn) return;
      var nowBr = Date.now();
      if (_timeoutBridgeBusy || (nowBr - _timeoutBridgeLastAt < 4000)) {
        try { _liveDlStep("timeout_bridge_skip", "busy_or_throttle"); } catch (_) {}
        return;
      }
      _timeoutBridgeBusy = true;
      _timeoutBridgeLastAt = nowBr;
      var nextBr = String(e.data.next || "sort_or_press").slice(0, 24);
      try {
        _liveDlStep(
          "timeout_bridge_recv",
          "next=" + nextBr
            + " stuck=" + String(e.data.stuck || "?").slice(0, 14)
            + " ph=" + String(e.data.phase || "").slice(0, 12),
        );
      } catch (_) {}
      _touchPipelineProgress("timeout_bridge");
      var finishBr = function () { _timeoutBridgeBusy = false; };
      if (nextBr === "focus_tab") {
        try {
          chrome.runtime.sendMessage({ type: "axlx-stuck-focus-tab" }, function () {
            void chrome.runtime.lastError;
            finishBr();
          });
        } catch (_) { finishBr(); }
        return;
      }
      if (nextBr === "clear_or_form") {
        finishBr();
        return;
      }
      try {
        if (!_isSearchConfirmGrasp(_searchGraspedMem) && !_autoPdfRun && !_adSortInFlight) {
          if (_inferScreenOkFromDom("timeout_bridge") || _autoSendArmed) {
            try { _liveDlStep("timeout_bridge_kick", "sort"); } catch (_) {}
            setTimeout(function () {
              try { _kickSortAfterSearch("timeout_bridge"); } catch (_) {}
              finishBr();
            }, 280);
            return;
          }
        }
        if (_autoSendArmed && !_autoPdfRun && !_adSortInFlight) {
          var nBr = 0;
          try { nBr = tracked.filter(function (t) { return t && t.btn && t.btn.isConnected; }).length; } catch (_) { nBr = 0; }
          if (nBr < 1) {
            try { _liveDlStep("timeout_bridge_kick", "customer_done"); } catch (_) {}
            try { _autoFinish("timeout_bridge・押せる行無し→客完了"); } catch (_) {}
            finishBr();
            return;
          }
        }
        try { _liveDlStep("timeout_bridge_kick", "keep_pipeline"); } catch (_) {}
      } catch (_) {}
      finishBr();
    } catch (_) {
      _timeoutBridgeBusy = false;
    }
  });
  function _ttake() {
    try {
      var raw = sessionStorage.getItem(AUDIT_T_KEY);
      sessionStorage.removeItem(AUDIT_T_KEY);
      var o = raw ? JSON.parse(raw) : null;
      return o && Array.isArray(o.list) && o.list.length ? o.list : null;
    } catch (_) { return null; }
  }
  /**
   * ★ 2026-11-18 竹内さん「送付済みの物件はちゃんと送ったと把握する／取得タイミングと連携」:
   *   物件取得の段を1つずつ把握して印に残す（止まっても「どこで詰まったか」が分かる）。
   *   段: wait_fill → armed → sent_loaded → filter → press → all_sent_next → done
   *   送付済みを飛ばす＝失敗ではない。把握して次（未送付／次頁／客完了）へ進む。
   */
  var _ACQUIRE_PHASES = ["wait_fill", "armed", "sent_loaded", "filter", "press", "page_done", "batch_done"];
  var _acquireGrasp = { phases: {}, last: null, sentMarked: 0, sentSkipped: 0, pressed: 0, allowed: 0 };
  function _graspAcquire(phase, ok, detail) {
    try {
      var p = String(phase || "").slice(0, 24);
      var d = String(detail || "").slice(0, 80);
      var good = ok !== false;
      if (!_acquireGrasp.phases) _acquireGrasp.phases = {};
      _acquireGrasp.phases[p] = { ok: good, d: d, at: Date.now() };
      _acquireGrasp.last = p;
      _tmark("acq_" + p, (good ? "✓" : "✗") + d);
      console.log("[AXLX bulk-dl][把握:物件取得] " + p + (good ? "✓" : "✗") + " " + d);
      try {
        window.postMessage({
          from: "axlx-acquire-grasp",
          phase: p,
          ok: good,
          detail: d,
          ledger: {
            sentMarked: _acquireGrasp.sentMarked,
            sentSkipped: _acquireGrasp.sentSkipped,
            pressed: _acquireGrasp.pressed,
            allowed: _acquireGrasp.allowed,
            last: _acquireGrasp.last,
          },
          ts: Date.now(),
        }, "*");
      } catch (_) {}
      try {
        chrome.storage.session.set({
          axlx_acquire_grasp: {
            phases: _acquireGrasp.phases,
            last: _acquireGrasp.last,
            sentMarked: _acquireGrasp.sentMarked,
            sentSkipped: _acquireGrasp.sentSkipped,
            pressed: _acquireGrasp.pressed,
            allowed: _acquireGrasp.allowed,
            at: Date.now(),
          },
        });
      } catch (_) {}
    } catch (_) {}
  }

  /**
   * ★ 2026-11-22 竹内さん「AD後も次ページ／一連と次客も手順表×画面照合で把握」:
   *   手順書の場面 list（印刷用PDF）・next（次のページへ）と、画面の今（行・次ボタン・AD順）を照合する。
   *   条件画面の guide_plan と同型の「手順表×画面」を一覧〜次頁〜次客受け渡しにも載せる。
   */
  var _playbookCache = null; // null=未読 / false=無し / object=手順書
  function _withPlaybook(cb) {
    var done = typeof cb === "function" ? cb : function () {};
    if (_playbookCache !== null) { done(_playbookCache === false ? null : _playbookCache); return; }
    try {
      chrome.storage.local.get(["axlx_learn_playbook"], function (r) {
        _playbookCache = (r && r.axlx_learn_playbook && typeof r.axlx_learn_playbook === "object")
          ? r.axlx_learn_playbook : false;
        done(_playbookCache === false ? null : _playbookCache);
      });
    } catch (_) { _playbookCache = false; done(null); }
  }
  function _pbListNext(pb) {
    var out = { list: false, next: false, listStep: "", nextStep: "", ver: "" };
    if (!pb) return out;
    try { out.ver = String(pb.version || pb.rules_v || "").slice(0, 12); } catch (_) {}
    var scenes = Array.isArray(pb.scenes) ? pb.scenes : [];
    for (var i = 0; i < scenes.length; i++) {
      var sc = scenes[i] || {};
      var name = String(sc.scene || sc.name || sc.id || "").toLowerCase();
      var steps = sc.steps || sc.detail || [];
      var first = "";
      try {
        if (Array.isArray(steps) && steps[0] != null) {
          first = typeof steps[0] === "string" ? steps[0] : String(steps[0].text || steps[0].name || steps[0].op || "");
        }
      } catch (_) {}
      if (name === "list" || name === "一覧" || /印刷用pdf|pdf/i.test(first)) {
        out.list = true; out.listStep = first.slice(0, 40);
      }
      if (name === "next" || name === "次" || /次のページ|次へ|pager/i.test(first)) {
        out.next = true; out.nextStep = first.slice(0, 40);
      }
    }
    /**
     * ★ 2.8.221: scenes に list が薄い束でも flow_series に list/next/sort_ad があれば手順ありとみなす
     *   （実測: list_flow_grasp が「手順list無」で入忘れ扱い→把握力が弱いと誤認）
     */
    try {
      var fs = Array.isArray(pb.flow_series) ? pb.flow_series : [];
      for (var fi = 0; fi < fs.length; fi++) {
        var fid = String((fs[fi] && fs[fi].id) || "");
        var flab = String((fs[fi] && fs[fi].label) || "");
        if (fid === "list" || fid === "sort_ad" || /一覧|印刷|並べ替え/.test(flab)) {
          out.list = true;
          if (!out.listStep) out.listStep = (flab || fid).slice(0, 40);
        }
        if (fid === "next" || fid === "handoff" || /次ページ|次客/.test(flab)) {
          out.next = true;
          if (!out.nextStep) out.nextStep = (flab || fid).slice(0, 40);
        }
      }
    } catch (_) {}
    return out;
  }
  /**
   * ★ 2026-11-22 竹内さん「駅の選択中に並べ替えへ行って止まる」:
   *   沿線・駅・所在地のモーダルが開いている＝まだ条件入力中。並べ替え／物件送付の画面ではない。
   *   一覧の行が裏に残っていても、モーダル中は list 扱いにしない。
   *
   * ★ 2026-11-22 根本（再現 v2.8.175）:
   *   旧は `body.innerText.slice(0, 8000)` に「駅の設定」等が無いとモーダル無しと判定していた。
   *   検索結果一覧が長いと、裏の一覧文言が8000字を埋め、**開いている駅モーダルの見出しが切れる**
   *   → `_isCondModalOpen()=null` のまま並べ替えが始まる（把握の穴・変な学習データではない）。
   *   → 正本は **見えている** `label.one_station` / `one_line` / `one_city|one_town`（dept_dom_db と同じ）。
   */
  function _visCount(sel) {
    var n = 0;
    try {
      var els = document.querySelectorAll(sel);
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        try {
          if (el.offsetParent) { n++; continue; }
          if (el.getClientRects && el.getClientRects().length) n++;
        } catch (_) {}
      }
    } catch (_) {}
    return n;
  }
  function _hasVisibleShortText(re) {
    try {
      var els = document.querySelectorAll("div,span,a,button,h1,h2,h3,td,th,p,label,li");
      var lim = Math.min(els.length, 500);
      for (var i = 0; i < lim; i++) {
        var el = els[i];
        try {
          if (!(el.offsetParent || (el.getClientRects && el.getClientRects().length))) continue;
          var t = String(el.textContent || "").replace(/[\s\u3000]+/g, "");
          if (!t || t.length > 36) continue;
          if (re.test(t)) return true;
        } catch (_) {}
      }
    } catch (_) {}
    return false;
  }
  /**
   * ★ 2.8.192 竹内さん画面「1.1秒後に並べ替えへ」のまま止まる:
   *   旧文言フォールバックが左サイド常時の「所在地」に反応 → 条件モーダル中と誤判定
   *   → sort_cursor が defer し続け、カーソルが並べ替えへ行かない。
   *   → 正本は **モーダル固有のラベル／小窓**だけ。サイドの「所在地」単体は使わない。
   */
  /**
   * ★ 2.8.197 DB#1595: 「並べ替え」が div.main_table の巨大文言（大阪N棟N戸並べ替え）に埋もれ、
   *   完全一致／短い loose だけでは見つからず sort_no_head → 並べ替え無しで PDF へ進んでいた。
   * ★ 2.8.212: 棟戸パターンと under を本線に上げる。
   * ★ 2.8.218 DB#1600: TreeWalker＋div.under 明示／巨大表でも葉テキストから掴む。
   *   「とぶ」＝見出し0のまま sort_failed:continue→PDF。見出しを掴めるまで aim＋葉探索を尽くす。
   */
  function _findSortHeadEl() {
    try {
      var vis = function (el) {
        try { return !!el && !!(el.offsetParent || (el.getClientRects && el.getClientRects().length)); } catch (_) { return false; }
      };
      var norm = function (t) { return String(t == null ? "" : t).replace(/[\s\u3000]+/g, ""); };
      var re = /並[べび]替え|並び順|並替/;
      /** 人が学んだ形: 大阪36棟46戸並べ替え（棟戸＋並べ替え） */
      var reToori = /[0-9０-９]+棟[0-9０-９]+戸並[べび]?替え?/;
      var reTooriOnly = /[0-9０-９]+棟[0-9０-９]+戸/;
      var cands = [];
      var pushCand = function (el, ntHint) {
        if (!el || !vis(el)) return;
        var nt = ntHint != null ? ntHint : norm(el.textContent);
        if (!nt) return;
        /**
         * ★ 2.8.259: 短い棟戸 under は並べ替えホバー先（束キー正本）。
         *   文言に「並べ替え」が無くても候補にする（ナビだけ見える失敗の保険）。
         */
        var isUnderEarly = false;
        try {
          if (el.matches && el.matches("div.under, .under")) isUnderEarly = true;
          else if (el.closest && el.closest("div.under, .under")) isUnderEarly = true;
        } catch (_) {}
        if (!re.test(nt)) {
          if (!(isUnderEarly && reTooriOnly.test(nt) && nt.length <= 40)) return;
        }
        if (nt.length > 80 && !reToori.test(nt.slice(0, 48)) && !(isUnderEarly && reTooriOnly.test(nt.slice(0, 40)))) return;
        if (nt.length > 160) return;
        var isRootTable = false;
        var isUnder = false;
        try {
          if (el.matches && el.matches("div.main_table, table.main_table, .main_table, #result_list, .result_list")) isRootTable = true;
          if (el.matches && el.matches("div.under, .under")) isUnder = true;
          if (!isUnder && el.closest && el.closest("div.under, .under")) isUnder = true;
        } catch (_) { isRootTable = false; }
        if (isRootTable && nt.length > 48) {
          try {
            var kids = el.querySelectorAll("a,button,div,span,td,th,li,label,p");
            var bestKid = null, bestLen = 1e9;
            for (var ki = 0; ki < kids.length; ki++) {
              if (!vis(kids[ki])) continue;
              var kn = norm(kids[ki].textContent);
              if (!kn || !re.test(kn) || kn.length > 64) continue;
              if (kn.length < bestLen) { bestLen = kn.length; bestKid = kids[ki]; }
            }
            if (bestKid) {
              el = bestKid;
              nt = norm(el.textContent);
              isRootTable = false;
              try {
                if (el.matches && el.matches("div.under, .under")) isUnder = true;
                else if (el.closest && el.closest("div.under, .under")) isUnder = true;
              } catch (_) {}
            }
          } catch (_) {}
        }
        cands.push({
          el: el,
          len: nt.length,
          root: isRootTable,
          under: isUnder || isUnderEarly,
          toori: reToori.test(nt) || reTooriOnly.test(nt),
          nt: nt,
        });
      };
      // A) 通常タグ走査
      var els = document.querySelectorAll("a,button,div,span,td,th,li,label,p");
      for (var i = 0; i < els.length; i++) pushCand(els[i], null);
      // B) ★ 2.8.218: div.under を明示（束の学習セレクタ正本）
      try {
        var unders = document.querySelectorAll("div.under, .under");
        for (var ui = 0; ui < unders.length; ui++) {
          var uEl = unders[ui];
          pushCand(uEl, null);
          // 巨大 textContent の under は最初の短い子葉だけヒントに
          try {
            var uKids = uEl.querySelectorAll("a,button,span,div,label,p");
            for (var uk = 0; uk < uKids.length && uk < 40; uk++) {
              var ukn = norm(uKids[uk].textContent);
              if (ukn && ukn.length <= 40 && (re.test(ukn) || reTooriOnly.test(ukn))) {
                pushCand(uKids[uk], ukn);
              }
            }
          } catch (_) {}
        }
      } catch (_) {}
      // C) ★ 2.8.218/259: 葉テキスト（巨大 textContent に埋もれても短いノードを掴む）
      try {
        var tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        var tn, leafN = 0;
        while ((tn = tw.nextNode()) && leafN < 800) {
          var raw = String(tn.nodeValue || "");
          var ntLeaf = norm(raw);
          if (!ntLeaf || ntLeaf.length < 2 || ntLeaf.length > 48) continue;
          if (!re.test(ntLeaf) && !reTooriOnly.test(ntLeaf)) continue;
          leafN++;
          var par = tn.parentElement;
          if (par) pushCand(par, ntLeaf);
        }
      } catch (_) {}
      if (!cands.length) return null;
      cands.sort(function (a, b) { return a.len - b.len; });
      var j, c;
      // ① 短い見出し（並び替え／並べ替え／並び替えに戻る）＝本線
      for (j = 0; j < cands.length; j++) {
        c = cands[j];
        if (c.root) continue;
        if (c.len <= 24 && !c.toori && /並[べび]替え|並び順|並替/.test(c.nt || "")) return c.el;
      }
      for (j = 0; j < cands.length; j++) {
        c = cands[j];
        if (c.root) continue;
        if (c.len <= 24 && /並[べび]替え|並び順|並替/.test(c.nt || "")) return c.el;
      }
      // ①b ★ 2.8.259: 短い棟戸 under（束のホバー先）
      for (j = 0; j < cands.length; j++) {
        c = cands[j];
        if (c.root) continue;
        if (c.under && c.toori && c.len <= 40) return c.el;
      }
      // ② div.under の短い見出し（棟戸は後回し）
      for (j = 0; j < cands.length; j++) {
        c = cands[j];
        if (c.root || c.toori) continue;
        if (c.under && c.len <= 40) return c.el;
      }
      // ③ 中くらい（非棟戸）
      for (j = 0; j < cands.length; j++) {
        c = cands[j];
        if (c.root || c.toori) continue;
        if (c.len <= 60) return c.el;
      }
      // ④ 棟戸＋並べ替え（DOM表記がこれしかない時・①の別名ではない）
      for (j = 0; j < cands.length; j++) {
        c = cands[j];
        if (c.root) continue;
        if (c.under && c.toori && c.len <= 48) return c.el;
      }
      for (j = 0; j < cands.length; j++) {
        c = cands[j];
        if (c.root) continue;
        if (c.toori && c.len <= 48) return c.el;
      }
      // ⑤ div.under など
      for (j = 0; j < cands.length; j++) {
        c = cands[j];
        try {
          if (c.el.matches && c.el.matches("div.under, .under, a, button, span, label")) return c.el;
        } catch (_) {}
      }
      // ⑥ どうしても無ければ非ルートの最短
      for (j = 0; j < cands.length; j++) {
        if (!cands[j].root) return cands[j].el;
      }
      return null;
    } catch (_) {
      return null;
    }
  }
  /**
   * ★ 2.8.218: 束 points から①見出し aim を選ぶ（純関数相当・テスト可）。
   *   短い「並べ替え」優先。無ければ DOM表記の棟戸｜div.under（main_table は最後）。
   *   ⚠ 330797cb: 棟戸を③高→低の別名にはしない。ここは①見出しの学習座標だけ。
   *   ⚠ 旧 falseHead が棟戸｜under を全部落とし sort_head_aim_warm=0 → sort_no_head で PDF へ飛んでいた。
   */
  function _pickSortHeadAimFromPoints(pts) {
    try {
      if (!pts || typeof pts !== "object") return null;
      var bestShort = null, bestShortN = -1;
      var bestUnder = null, bestUnderN = -1;
      var bestTable = null, bestTableN = -1;
      Object.keys(pts).forEach(function (k) {
        var v = pts[k];
        if (!v || typeof v.x !== "number" || typeof v.y !== "number") return;
        if (/高.?低|sort_detail/i.test(k)) return;
        if (!/並[べび]替え|並び順|sort_head/i.test(k)) return;
        var nn = typeof v.n === "number" ? v.n : 0;
        var isToori = /棟.*戸/.test(k) || /div\.main_table|div\.under/.test(k);
        if (!isToori) {
          if (/並べ替え｜span|^並べ替え$|^並び替え$|sort_head/i.test(k)) nn += 100;
          if (nn > bestShortN) {
            bestShortN = nn;
            bestShort = { x: v.x, y: v.y, k: k, n: nn, src: "short" };
          }
          return;
        }
        if (/div\.under|\.under/.test(k)) {
          if (nn > bestUnderN) {
            bestUnderN = nn;
            bestUnder = { x: v.x, y: v.y, k: k, n: nn, src: "toori_under" };
          }
          return;
        }
        if (/div\.main_table|main_table/.test(k)) {
          var score = nn;
          if (v.x < 0.05) score -= 2;
          if (score > bestTableN) {
            bestTableN = score;
            bestTable = { x: v.x, y: v.y, k: k, n: nn, src: "toori_table" };
          }
        }
      });
      return bestShort || bestUnder || bestTable;
    } catch (_) {
      return null;
    }
  }
  /**
   * ★ 2.8.212/218: 学習座標から見出しを拾う。表ルートに当たったら短い子／under へ降りる。
   */
  function _findSortHeadByAim(aim) {
    try {
      if (!aim || typeof aim.x !== "number" || typeof aim.y !== "number") return null;
      var ax = aim.x * (window.innerWidth || 1);
      var ay = aim.y * (window.innerHeight || 1);
      var vis = function (el) {
        try { return !!el && !!(el.offsetParent || (el.getClientRects && el.getClientRects().length)); } catch (_) { return false; }
      };
      var norm = function (t) { return String(t == null ? "" : t).replace(/[\s\u3000]+/g, ""); };
      var re = /並[べび]替え|並び順/;
      var reToori = /[0-9０-９]+棟[0-9０-９]+戸並[べび]替え/;
      var shrink = function (el) {
        if (!el || !vis(el)) return null;
        var nt = norm(el.textContent);
        if (nt && nt.length <= 64 && re.test(nt)) return el;
        try {
          var kids = el.querySelectorAll("div.under, .under, a, button, span, label, div, p");
          var best = null, bestLen = 1e9;
          for (var i = 0; i < kids.length; i++) {
            if (!vis(kids[i])) continue;
            var kn = norm(kids[i].textContent);
            if (!kn || !re.test(kn) || kn.length > 64) continue;
            if (kn.length < bestLen) { bestLen = kn.length; best = kids[i]; }
          }
          if (best) return best;
        } catch (_) {}
        return nt && re.test(nt) && (reToori.test(nt.slice(0, 48)) || nt.length <= 80) ? el : null;
      };
      var hit = null;
      try {
        var top = document.elementFromPoint(ax, ay);
        var walk = top;
        for (var d = 0; walk && d < 10; d++) {
          var sh = shrink(walk);
          if (sh) { hit = sh; break; }
          walk = walk.parentElement;
        }
      } catch (_) {}
      if (hit) return hit;
      var best2 = null, bestD = 120;
      var nodes = document.querySelectorAll("a,button,div.under,.under,div,span,label");
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (!vis(el)) continue;
        var nt = norm(el.textContent);
        if (!nt || nt.length > 64 || !re.test(nt)) continue;
        var r = el.getBoundingClientRect();
        var cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.5;
        var dist = Math.hypot(cx - ax, cy - ay);
        if (dist < bestD) { bestD = dist; best2 = el; }
      }
      return best2;
    } catch (_) {
      return null;
    }
  }
  function _hasSortHeadVisible() {
    try {
      if (_findSortHeadEl()) return true;
      // 互換: 旧の完全一致も残す
      var els = document.querySelectorAll("a,button,div,span,td,th,li,label");
      for (var i = 0; i < els.length && i < 1200; i++) {
        var el = els[i];
        try {
          if (!(el.offsetParent || (el.getClientRects && el.getClientRects().length))) continue;
          var t = String(el.textContent || "").replace(/[\s\u3000]+/g, "");
          if (t === "並べ替え" || t === "並び替え" || t === "並び替えに戻る" || t === "並べ替えに戻る") return true;
          if (t.length <= 24 && /並[べび]替え/.test(t)) return true;
        } catch (_) {}
      }
    } catch (_) {}
    return false;
  }
  /**
   * ★ 2.8.194: 並べ替え中の中断判定は one_* 可視だけ（文言フォールバック禁止）。
   *   昔（Claude並べ替え）は一覧後にそのまま並べ替えていた。文言誤検知で途中 abort しない。
   */
  function _isCondModalLabelsOpen() {
    try {
      var stV = _visCount("label.one_station, .one_station");
      var lnV = _visCount("label.one_line, .one_line");
      var cityV = _visCount("label.one_city, label.one_town, .one_city, .one_town");
      if (stV > 0) return "station";
      if (lnV > 0) return "line";
      if (cityV > 0) return "area";
    } catch (_) {}
    return null;
  }
  function _isCondModalOpen() {
    try {
      var byLabel = _isCondModalLabelsOpen();
      if (byLabel) return byLabel;
      // 小窓の閉じるが見えて、かつラベルがある時だけ（閉じる単独は一覧の別メニューと取り違え得る）
      // class が変わった時の文言フォールバック（★サイド常時の「所在地」「市区郡」単体は禁止）
      if (_hasVisibleShortText(/駅の設定|沿線の設定へ戻る/)) return "station";
      if (_hasVisibleShortText(/沿線の設定|駅の設定へ進む/)) return "line";
      if (_hasVisibleShortText(/詳細な地域の設定|詳細地域の設定|確定してリスト|都道府県を選択/)) return "area";
      if (_hasVisibleShortText(/所在地の設定|地域の設定へ戻る/)) return "area";
    } catch (_) {}
    return null;
  }
  function _screenListNow() {
    var rows = 0, pdf = 0, next = false, adHi = false;
    var modal = _isCondModalOpen();
    var onlyOne = false;
    try {
      rows = tracked.filter(function (t) {
        return t && t.btn && t.btn.isConnected && AxlxSendPairing && AxlxSendPairing.isHttpUrl(t.btn.href);
      }).length;
    } catch (_) { rows = 0; }
    try {
      pdf = document.querySelectorAll("a.print, a[href*='print'], a[href*='Print']").length;
    } catch (_) { pdf = 0; }
    try {
      var pst = typeof _readPagerState === "function" ? _readPagerState() : null;
      if (pst) onlyOne = !!pst.onlyOnePage;
      next = !onlyOne && !!(typeof _findNextPageEl === "function" && _findNextPageEl());
    } catch (_) { next = false; }
    try {
      var p = new URLSearchParams(location.search || "");
      adHi = (p.get("key") === "ad" && p.get("odr") === "desc")
        || p.get("ad") === "odr_desc"
        || /(?:^|[?&])ad=odr_desc(?:&|$)/.test(String(location.search || ""));
    } catch (_) { adHi = false; }
    return { rows: rows, pdf: pdf, next: next, adHi: adHi, modal: modal, onlyOnePage: onlyOne };
  }
  /**
   * @param {"list_start"|"before_next"|"after_next"|"handoff"} phase
   * @param {function} [then]  (result) => void
   */
  function _guideLikeListFlowGrasp(phase, then) {
    var done = typeof then === "function" ? then : function () {};
    _withPlaybook(function (pb) {
      var plan = _pbListNext(pb);
      var sc = _screenListNow();
      var miss = [];
      var bits = [];
      if (!pb) miss.push("手順書なし");
      else {
        bits.push("v" + (plan.ver || "?"));
        if (plan.list) bits.push("list有"); else miss.push("手順list無");
        if (plan.next) bits.push("next有"); else bits.push("next無");
      }
      if (phase === "list_start" || phase === "after_next") {
        // ★ 2026-11-22: 条件モーダル中は一覧ではない（裏の行があっても入忘れ）
        if (sc.modal) miss.push("条件モーダル中(" + sc.modal + ")");
        if (sc.rows < 1 && sc.pdf < 1) miss.push("画面行0");
        else if (!sc.modal) bits.push("行" + (sc.rows || sc.pdf));
        if (sc.adHi) bits.push("AD高"); else bits.push("AD未");
      }
      if (phase === "before_next") {
        if (sc.onlyOnePage) {
          bits.push("1ページのみ");
          try { _liveDlStep("list_page_one_only", "1ページのみ把握・次ページ無し"); } catch (_) {}
        } else if (plan.next && !sc.next) miss.push("次ボタン画面に無し");
        else if (sc.next) bits.push("次画面あり");
        if (sc.rows < 1 && sc.pdf < 1) bits.push("行0でも次へ試す可");
      }
      if (phase === "handoff") {
        bits.push("P" + (Number(_autoPdfPage) || 1));
        bits.push("累計" + (Number(_autoPdfTotalSent) || 0));
        if (sc.onlyOnePage) bits.push("1ページのみ完了");
        else if (plan.next && sc.next) bits.push("次残あり→上限or完了");
        else bits.push("次無しor上限");
      }
      if (phase === "list_start" && sc.onlyOnePage) {
        bits.push("1ページのみ");
        try { _liveDlStep("list_page_one_only", "一覧開始・1ページのみ把握"); } catch (_) {}
      }
      var summary = String(phase) + " " + bits.join(" ")
        + (miss.length ? " 入忘れ" + miss.length + "(" + miss.slice(0, 3).join("・") + ")" : " 揃い");
      try { _liveDlStep("list_flow_grasp", summary.slice(0, 60)); } catch (_) {}
      console.log("[AXLX bulk-dl][手順表×画面:一覧] " + summary);
      var result = { ok: miss.length === 0, miss: miss, summary: summary, screen: sc, plan: plan, phase: phase };
      /**
       * ★ 2.8.231: 一覧の手順表×画面照合 → task_now/done/next（page と同型）
       * ★ 2.8.234: 1ページのみ／次無しなら「次ページを押す」を出さず、物件済→外すへ。
       */
      try {
        var _listNext = {
          list_start: "並べ替えor物件取得",
          before_next: "次ページを押す",
          after_next: "一覧照合→物件取得",
          handoff: "前客の選択を1つずつ外す",
        };
        var _listDone = {
          list_start: "一覧の手順×画面照合完了",
          before_next: "次ページ前照合完了",
          after_next: "次ページ到着照合完了",
          handoff: "客一覧完了の照合完了",
        };
        var _nt = _listNext[phase] || ("次(" + phase + ")");
        var _dt = _listDone[phase] || (phase + "照合完了");
        if (phase === "before_next" && (sc.onlyOnePage || !sc.next)) {
          _nt = "物件取得完了→外す";
          _dt = sc.onlyOnePage ? "1ページのみ・物件見終わった" : "次ページ無し・物件見終わった";
          try { _liveDlStep("list_no_next_advance", _dt); } catch (_) {}
        }
        if (phase === "list_start" && sc.onlyOnePage) {
          // 一覧開始時はまだ物件取得中。次の最終は外すだが、いまは物件取得を続ける
          if (!/物件/.test(_nt)) _nt = "物件を1つずつ取得";
        }
        if (miss.length) {
          window.postMessage({
            from: "axlx-task-grasp",
            now: "照合残:" + String(miss[0] || "").slice(0, 24),
            done: null,
            next: _nt,
            kind: "guide",
          }, "*");
        }
        window.postMessage({
          from: "axlx-task-grasp",
          now: null,
          done: _dt + (miss.length ? "(残あり)" : ""),
          next: _nt,
          kind: "guide",
        }, "*");
        try {
          if (typeof window.__axlxLinkGuidePhaseToTask === "function") {
            window.__axlxLinkGuidePhaseToTask(phase, miss.length ? miss.slice(0, 4) : [], miss.length ? "gap" : "ok");
          }
        } catch (_) {}
        try { _liveDlStep("guide_task_link", String(phase + "→task 次=" + _nt).slice(0, 48)); } catch (_) {}
      } catch (_) {}
      try {
        chrome.storage.session.set({
          axlx_list_flow_grasp: {
            phase: phase, ok: result.ok, summary: summary.slice(0, 120),
            rows: sc.rows, next: sc.next, adHi: sc.adHi, at: Date.now(),
          },
        });
      } catch (_) {}
      done(result);
    });
  }

  // ── 2026-10-01 竹内「押したら勝手に自動検索始まって自動で物件ダウンロード始まってしまったから防ぐ」──
  //   案内モード（storage.local guideMode・既定オン＝realpro-guide.js）の間は、自動の送信・ダウンロード・ページ送りを一切始めない。
  //   ・読み込みが間に合わない時も「案内モード」として止める（明示の OFF＝false の時だけ動く＝安全側）
  //   ・止めた時は再開の印（axlx_pending_auto_send・ページ送りの続き）も消す
  // 2026-11-10 v2.5.94 竹内「自動を昔のように動くように」:
  //   自動モード（通常／スタッフ／自動 の「自動」＝storage の aixMode=true ＋ autoModeAt>0）を選んでいる時だけ
  //   自動の送信・ページ送りを開く（mode-core.js の effectiveBehavior と同じ線。content script からは
  //   mode-core.js を読まないので、ここに同じ意味の判定を持つ）。通常・スタッフは今まで通り止めたまま。
  var _guideOff = false;
  var _autoModeOn = false;
  // ★ 2.8.280: 選んだモードを storage から読み終えたか。読み終えて「自動でない」＝通常／切れたスタッフ。
  //   その時は _forceAutoForPending で自動を開かない（通常モードで並べ替え AD が勝手に動く原因・竹内さん 2026-11-24）。
  var _modeLoaded = false;
  var _autoForceDeniedLogged = false;
  try {
    // v2.5.77 竹内「常に自動モードではなくて、光って選択するモードとする」: 案内モードは常に ON（古い OFF の値でも自動を始めない・mode-core.js GUIDE_ONLY）
    var _GUIDE_ONLY = true;
    var _AUTO_STAFF_TTL = 2 * 60 * 60 * 1000;
    function _readAutoMode(st) {
      var s = st || {};
      var at = s.staffModeAt || 0;
      var staffOn = !!s.staffMode && (!at || Date.now() - at <= _AUTO_STAFF_TTL);
      /**
       * 2026-11-11 竹内さん「AIXの場合光るのではなくて自動で押していく形となる」:
       *   → AIXモード（aiMode＋autoModeAt）も自動押下を開く。
       * ★ 2026-11-22: スタッフも選んだ客の検索〜物件送付まで自動押し（AIX相当）。
       *   一括・自動便は background がスタッフでは claim しない。押すのは fill-done 後の一覧だけ。
       */
      if (staffOn) return true;
      var chosen = Number(s.autoModeAt) > 0;
      return chosen && (!!s.aixMode || !!s.aiMode);
    }
    function _applyAutoMode(st) {
      _modeLoaded = true;
      _autoModeOn = _readAutoMode(st);
      _guideOff = !_GUIDE_ONLY || _autoModeOn;
      // 2026-11-10 竹内さん「自動モードの時は自動で押しておこなわれるようにする」:
      //   「自動」に切り替えた時点でも、いま出ている一覧で自動押下を始める（切り替え直後に押しに行く）
      if (_autoModeOn) { try { setTimeout(_maybeAutoPressOnLoad, 800); } catch (_) {} }
    }
    chrome.storage.local.get(["guideMode", "staffMode", "staffModeAt", "aixMode", "autoModeAt", "aiMode"], function (r) { _applyAutoMode(r); });
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== "local" || !ch) return;
      if (!("staffMode" in ch) && !("aixMode" in ch) && !("autoModeAt" in ch) && !("aiMode" in ch)) return;
      // モードと印は別々に書かれるので、どれか1つ変わったら全部を読み直す
      chrome.storage.local.get(["staffMode", "staffModeAt", "aixMode", "autoModeAt", "aiMode"], function (r2) { _applyAutoMode(r2); });
    });
  } catch (_) {}
  function _guideBlocksAuto(where) {
    if (_autoModeOn) return false; // 自動モードは昔のように拡張が送る・ページをめくる
    if (_guideOff) return false;
    console.warn("[AXLX bulk-dl] 案内モードのため自動の送信・ダウンロード・ページ送りをしない（" + where + "）");
    try { chrome.storage.session.remove("axlx_pending_auto_send"); } catch (_) {}
    try { sessionStorage.removeItem("axlx_pending_auto_send_sync"); } catch (_) {}
    try { sessionStorage.removeItem("axlx_search_grasped_sync"); } catch (_) {}
    try { chrome.storage.session.remove("axlx_auto_next_page"); } catch (_) {}
    try { clearAutoSendState(); } catch (_) {}
    return true;
  }

  /**
   * 2026-11-14 竹内さん「統括できる部分とできない部分の連携はちゃんとできているのか」
   *   → **できていなかった**。統括（learn-supervisor）の判断は storage に置かれているだけで、
   *     **誰も読んで動いていなかった**。統括が「渡すと危ない」と言っても自動検索は止まらなかった。
   *
   *   → **統括が「渡してよい」と言っていない時は、自動の送信・ダウンロードをしない**。
   *     ⚠ 止めるのは**自動モードの一括（`bulk-dl`）だけ**。人が1件ずつ押すのは止めない。
   *     ⚠ 案内モードと同じ扱い（送った印・続きの印も消す）。
   *     ⚠ 判断が無い（学習がまだ）時は**止めない**（今まで通り動く＝いきなり止めない）。
   */
  var _SUP_KEY = "axlx_learn_supervisor";
  var _supCache = null, _supAt = 0;
  function _readSupervisor(cb) {
    try {
      var now = Date.now();
      if (_supCache !== null && now - _supAt < 30000) { cb(_supCache); return; }
      _supAt = now;
      chrome.storage.local.get([_SUP_KEY], function (r) {
        _supCache = (r && r[_SUP_KEY]) || {};
        cb(_supCache);
      });
    } catch (_) { cb({}); }
  }
  /** 統括が「渡してよい」と言っているか（判断が無ければ true＝今まで通り動く） */
  function _supervisorAllowsAuto() {
    /**
     * ⚠ 同期的に読みたいので、**キャッシュだけ**を見る（無ければ「止めない」＝安全側で今まで通り）。
     *   起動時と storage の変化で更新する。
     */
    var v = _supCache || {};
    var verdict = String(v.verdict || "");
    if (!verdict) return true;               // 判断がまだ無い → 止めない
    return verdict === "ready";
  }
  /** 止める理由（人が読める形） */
  function _supervisorBlockReason() {
    var v = _supCache || {};
    var head = String(v.headline || "");
    var issues = (v.self_check && Array.isArray(v.self_check.issues)) ? v.self_check.issues : [];
    return "統括が「危ない」と言っています（" + (head || "判断なし") + "）" + (issues.length ? "／" + issues[0] : "");
  }
  /**
   * 2026-11-14 竹内さん「検索した後物件ダウンロードする動きにうつっていなかった」:
   *
   *   ⚠ **私が入れた関所が原因だった**。統括が `not_yet` を出していたので、
   *     `bulk-dl` の送信・ダウンロードが**全部止まっていた**（現場が止まる）。
   *   統括は「学びがまだ」と言っているだけで、**検索そのものを止めてよい理由ではない**
   *   （学びが薄くても、検索して物件を出す業務は回さないといけない）。
   *
   *   → **止めない。警告だけ出す**（小窓に赤字で「統括: まだ学べていません」）。
   *     ⚠ 本当に止めるべきは「**危ない**（unsafe）」時だけ。
   *       unsafe は「押す場所が0＝区・駅を押せない恐れ」のような**誤検索に直結する**時。
   *     ⚠ `not_yet` / `almost` は**止めない**（学びが薄いだけ）。
   */
  function _supBlocksAuto(where) {
    var v = _supCache || {};
    var verdict = String(v.verdict || "");
    /**
     * 2026-11-14 竹内さん「自動はとめないようにする」→ **統括で止めるのをやめた**。
     *
     *   ⚠ 旧は `unsafe`（押す場所が0＝区・駅を押せない恐れ）の時に**自動を止めていた**。
     *     だが止まると**物件が1件も出ない**（現場が止まる）＝一番困る結果になる。
     *   → **unsafe でも止めない**。警告だけ出す（小窓に赤字で理由を出す）。
     *
     *   ⚠ 本当に止めるのは**人の意思だけ**にする:
     *     ・スタッフモード（人が選んだ物を触らない）
     *     ・自動入力の最中（別のお客様の一覧を送ってしまう）
     *     ・停止ボタン（人が止めた）
     *   統括は**判断を出すだけ**（止める/止めないは人が決める）。
     *
     *   ⚠ 黙って続けない: `unsafe` の時は**必ず警告**を出す（画面＋ログ）。
     */
    if (!verdict || verdict === "ready") return false;
    if (verdict === "unsafe") {
      console.warn("[AXLX bulk-dl] 統括が「危ない」と言っています（" + where + "）が、**自動は止めません**（現場を止めないため）: " + _supervisorBlockReason());
      try { _nudge("⚠ 統括: " + _supervisorBlockReason().slice(0, 70) + "（続けます）"); } catch (_) {}
      return false;
    }
    // not_yet / almost … 学びが薄いだけ → 警告だけ（今まで通り）
    console.warn("[AXLX bulk-dl] 統括: " + verdict + "（学びが薄いが、検索は続けます）: " + String(v.headline || ""));
    try { _nudge("ℹ️ 統括: " + String(v.headline || "").slice(0, 60)); } catch (_) {}
    return false;
  }
  try {
    chrome.storage.local.get([_SUP_KEY], function (r) {
      try { _supCache = (r && r[_SUP_KEY]) || {}; _supAt = Date.now(); } catch (_) { _supCache = {}; }
      try {
        var v = _supCache || {};
        if (v.verdict && v.verdict !== "ready") console.warn("[AXLX bulk-dl] 統括の判断:", v.verdict, "-", v.headline || "");
      } catch (_) {}
    });
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== "local" || !ch || !ch[_SUP_KEY]) return;
      try { _supCache = ch[_SUP_KEY].newValue || {}; _supAt = Date.now(); } catch (_) {}
    });
  } catch (_) {}

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

  /**
   * ★ 2.8.279 竹内さん「拡張ツールひらいているとき重すぎる」:
   *   旧はページの**全部の文字**（数千〜数万）を TreeWalker でたどって trim していた。行の読み直し（_rescanRows）・
   *   ページの変化の見張りのたびに呼ばれ、一覧を見ているだけで重かった。→ リンクとボタンだけを見る（並びは同じ文書順）。
   */
  function findPrintBtns() {
    try { _perfC.find++; } catch (_) {}
    var seen = new Set();
    var results = [];
    if (!document.body) return results;
    var list = document.body.querySelectorAll("a, button");
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var tx = el.textContent;
      if (!tx || tx.indexOf("印刷用PDF") < 0) continue;
      // 中に別のリンク・ボタンがあれば、文字に近い方（内側）を使う（旧の「文字の親から上へ6段で最初の A/BUTTON」と同じ）
      var inner = el.querySelector("a, button");
      if (inner && inner.textContent && inner.textContent.indexOf("印刷用PDF") >= 0) continue;
      if (seen.has(el) || !el.offsetParent) continue;
      seen.add(el);
      results.push(el);
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
    try { _perfC.rebuild++; } catch (_) {}
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
    brainPreview();
    // ★ 2026-11-16: 一覧の描き直しで送付済み印が消える → 自動モードならすぐ付け直す
    try { if (_autoModeOn) setTimeout(_reapplySentMarksIfAny, 80); } catch (_) {}

    // Case A: fill-done 受信済み かつ スナップショット前にない新しい結果が出た
    // 2026-11-10 竹内さん「古い一括のなくした方がよいかも」: 古い「全ページ送る」（autoSendAllPages）は呼ばない。
    //   結果が出たら **印刷用PDFを1件ずつ押して送る**（自動モードなら自動で・それ以外は人が押す形のまま）。
    if (_autoSendArmed && tracked.length > 0 && !getAutoSendState() && !_pendingAutoSendDispatched) {
      var _hasNewBtn = tracked.some(function(item) { var k = item.btn.href || item.btn.getAttribute('href') || ''; return k && !_preAutofillBtns.has(k); });
      if (_hasNewBtn) {
        console.log("[AXLX bulk-dl] Case A: 新結果検出（" + (_autoModeOn ? "自動モードなので自動で押します" : "人が押す形で待ちます") + "）");
        _tmark("results", "rows=" + tracked.length);
        /**
         * ★ 2.8.207: 先に検索確認→≥1秒待ち→並べ替え専用道。
         *   旧は armed を消してから maybe（afterSearch無し）→ 待ち無し／ブロック混在。
         */
        try {
          if (_isSearchConfirmGrasp(_searchGraspedMem)) {
            _scheduleSortCursorAfterSearch("case_a_new_rows");
          } else {
            try { _liveDlStep("sort_gate_need_confirm", "case_a_no_confirm"); } catch (_) {}
          }
        } catch (_) {}
        _autoSendArmed = false;
        try { chrome.storage.session.remove("axlx_pending_auto_send"); } catch (_) {}
        try { sessionStorage.removeItem("axlx_pending_auto_send_sync"); } catch (_) {}
        _pendingAutoSendDispatched = true;
        try { _maybeAutoPressOnLoad({ afterSearch: true }); } catch (_) {}
      }
    }
    // Case B: AJAXページネーション継続
    // 2026-11-10 竹内さん「古い一括のなくした方がよいかも」: 旧のページ送りの継続は使わない（上の Case D で捨てる）。
    //   一覧が新しく出たら、その画面の行を1件ずつ押す（_maybeAutoPressOnLoad）。
    /**
     * 2026-11-10 竹内さん「手動でできた。自動でおこなっちく（自動で行ってほしい）」:
     *   自動モードの時は、**結果が出たら拡張が自分で印刷用PDFを1件ずつ押して送る**（Case C）。
     *   人がやる事と同じ: カーソルで行まで動く → 印刷用PDFを押す → 送る → 👀 資料を見る間 → 次の行。
     *   押さない/止めたい時は枠の「⏹ 止める」。スタッフモード・自動モードでない時は今まで通り何もしない。
     */
    else if (!_autoSendArmed && tracked.length > 0 && !_pendingAutoSendDispatched && _autoModeOn && !_autoPdfRun && !_isFillBusy()) {
      /**
       * 2026-11-12 / ★ 2026-11-16 録画「条件入れる前に物件ダウンロード」:
       *   Case C は fill-done 無しでも押せる穴だった。スナップショットが空のまま押し始めていた。
       *   → **fill-done で armed された道（Case A）だけ**物件取得する。ここからは押さない。
       */
      console.log("[AXLX bulk-dl][auto] 検索完了前の一覧 → 押しません（fill-done 後の新しい行だけ押す）");
      _tmark("auto_pdf_arm", "blocked_need_fill_done");
      try { _graspAcquire("wait_fill", false, "fill-done/search_armed前→物件取得はまだ（送付済把握の前段）"); } catch (_) {}
    }
    // ★ 2.8.190/207: sync/armed＋検索確認済みの一覧だけ並び替えへ（旧一覧×armed直後を止める）
    try {
      if (
        !_pendingAutoSendDispatched
        && tracked.length > 0
        && (_autoSendArmed || (typeof _hasSearchPendingSync === "function" && _hasSearchPendingSync()))
        && _isSearchConfirmGrasp(_searchGraspedMem)
      ) {
        _kickSortAfterSearch("inject_rows");
      }
    } catch (_) {}
    // 2026-11-10 竹内さん「自動モードの時は自動で押しておこなわれるようにする」: 一覧が出た時点で自動で押し始める（検索の完了合図に頼らない）
    _maybeAutoPressOnLoad();
  }
  // 自動で押し始めた一覧の印（同じ一覧で二度始めない）
  var _autoPdfSig = "";

  /**
   * 2026-11-10 竹内さん「自動モードの時は自動で押しておこなわれるようにする」:
   *   検索の完了合図（fill-done）が来ない経路でも、**自動モードなら一覧が出た時点で自動で押し始める**。
   *   画面を開いた時・一覧が描き直された時に呼ぶ（同じ一覧で二度始めない・スタッフモードでは動かない）。
   */
  /**
   * ★ 2026-11-22 2.8.190: 検索後に一覧があるのに並び替えへ行かない穴を塞ぐ。
   */
  function _hasSearchPendingSync() {
    try {
      var raw = sessionStorage.getItem("axlx_pending_auto_send_sync");
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.ts) return null;
      if (Date.now() - Number(o.ts) > 600000) return null;
      return o;
    } catch (_) { return null; }
  }
  function _forceAutoForPending(why) {
    if (_autoModeOn) return false;
    /**
     * ★ 2.8.280 竹内さん「通常モードでも並べ替えのADが勝手になってしまっている」:
     *   旧は通常モードでも、検索後の印（自動入力が検索の直前に書く）があれば「この一覧だけ自動ON」にしていた
     *   → 並べ替え AD → 印刷用PDF押しまで始まった。
     *   選んだモードを読み終えていて自動でない（通常／切れたスタッフ）なら、強制しない。
     *   強制してよいのは、モードの読み込みが間に合う前の一瞬だけ（読み終えたら _applyAutoMode が正しい値に戻す）。
     */
    if (_modeLoaded) {
      if (!_autoForceDeniedLogged) {
        _autoForceDeniedLogged = true;
        try { _liveDlStep("auto_force_denied", "normal_mode:" + String(why || "").slice(0, 30)); } catch (_) {}
      }
      return false;
    }
    try {
      var p = _hasSearchPendingSync();
      if (!p && !_autoSendArmed) return false;
      _autoModeOn = true;
      _guideOff = true;
      console.warn("[AXLX bulk-dl][auto] 検索後印ありなのに自動OFF → この一覧だけ自動を開く (" + String(why || "") + ")");
      try { _liveDlStep("auto_force", String(why || "pending").slice(0, 40)); } catch (_) {}
      return true;
    } catch (_) { return false; }
  }
  /**
   * ★ 2026-11-22 2.8.191 竹内さん「検索押した＝トリガー → 1秒以降の人間ランダムで並べ替えへカーソル」:
   *   監査#1588: search_to_sort まで付いたが sort_* が0・idle_close。
   *   原因=_autoPdfSig を見る間の前に立て、キャンセル後も再試行できずカーソルが並べ替えへ行かない。
   */
  var _sortCursorScheduled = false;
  /** ★ 2.8.247: 並べ替えホバー飛行中に kick が重なると「並べ替え」ループに見える */
  var _adSortInFlight = false;
  /**
   * ★ 2.8.255: screenOk が来ないまま「送付中」で止まるのを解く。
   *   画面に結果（estate＋印刷用PDF）があるのに page の変化検知が失敗すると
   *   並べ替えも送付も次客も永久に動かない（竹内さん画像）。
   */
  var _screenOkWatchTimer = null;
  /**
   * ★ 2.8.263 竹内さん「検索押してページ表示されてから並べ替え／先に並べ替えがバグ」:
   *   押下直前の基準（axlx_search_press_baseline）と比べ、結果ページが出てからだけ screenOk。
   *   旧 dom_infer は estate+行ありだけで OK → 旧一覧のまま並べ替えが走り検索を邪魔した。
   */
  function _readSearchPressBaseline() {
    try {
      var raw = sessionStorage.getItem("axlx_search_press_baseline");
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }
  /**
   * ★ 2.8.264: 結果ページの軽い目印（件数「○棟○戸」＋PDFの数＋先頭のPDFリンク）。
   *   旧は700要素の textContent を毎回作っていた（親 div は一覧全文）→ 表示を遅らせ固まる根。
   *   押下時の目印（axlx_search_press_sig）と同じ作り方で比べる。
   */
  function _localScreenEvidenceBrief() {
    var out = { pdf: 0, count: "-", first: "", brief: "" };
    try {
      var head = _bodyHeadText(6000);
      var m = head.match(/([0-9０-９,，]+)\s*棟\s*([0-9０-９,，]+)\s*戸/);
      if (m) out.count = m[1] + "/" + m[2];
    } catch (_) {}
    try {
      var links = document.querySelectorAll("a.print, a[href*='print'], a[href*='Print']");
      out.pdf = links.length;
      if (links[0]) out.first = String(links[0].getAttribute("href") || "").slice(-48);
    } catch (_) {}
    out.brief = "cnt=" + out.count + " pdf=" + out.pdf + " f=" + out.first;
    return out;
  }
  function _readSearchPressSig() {
    try { return sessionStorage.getItem("axlx_search_press_sig") || ""; } catch (_) { return ""; }
  }
  function _pressAtForPageGate() {
    var base = _readSearchPressBaseline();
    if (base && base.at) return Number(base.at) || 0;
    try {
      var sync = sessionStorage.getItem("axlx_pending_auto_send_sync");
      if (sync) {
        var p = JSON.parse(sync);
        if (p && p.ts) return Number(p.ts) || 0;
      }
    } catch (_) {}
    try {
      if (_searchGraspedMem && (_searchGraspedMem.pressed || _searchGraspedMem.intent)
        && _searchGraspedMem.at) {
        return Number(_searchGraspedMem.at) || 0;
      }
    } catch (_) {}
    return 0;
  }
  function _pageDisplayedAfterThisSearch(why) {
    try {
      if (_isNavPending()) {
        if (Date.now() - _navPendingLogAt > 3000) {
          _navPendingLogAt = Date.now();
          try { _liveDlStep("page_nav_pending", "検索の移動中→古い一覧 " + String(why || "").slice(0, 24)); } catch (_) {}
        }
        return { ok: false, path: "nav_pending", why: "nav_pending" };
      }
      var pressAt = _pressAtForPageGate();
      if (!pressAt) {
        try { _liveDlStep("page_display_need_press", String(why || "").slice(0, 28)); } catch (_) {}
        return { ok: false, path: "need_press", why: "no_press" };
      }
      var elapsed = Math.max(0, Date.now() - pressAt);
      if (elapsed < 700) {
        try { _liveDlStep("page_display_too_soon", "ms=" + elapsed); } catch (_) {}
        return { ok: false, path: "too_soon", why: "ms=" + elapsed, elapsed: elapsed };
      }
      var n = 0;
      try { n = tracked.filter(function (t) { return t && t.btn && t.btn.isConnected; }).length; } catch (_) { n = 0; }
      if (n < 1) {
        try { if (typeof _rescanRows === "function") _rescanRows(); } catch (_) {}
        try { n = tracked.filter(function (t) { return t && t.btn && t.btn.isConnected; }).length; } catch (_) { n = 0; }
      }
      var look = false;
      try { look = !!_looksLikeSearchResult(); } catch (_) { look = false; }
      var estate = false;
      try {
        estate = /[?&]method=estate\b/.test(String(location.search || ""))
          || /[?&]display=building\b/.test(String(location.search || ""));
      } catch (_) { estate = false; }
      if (!(n > 0 && (look || estate))) {
        try { _liveDlStep("page_display_wait_rows", "n=" + n + " ms=" + elapsed); } catch (_) {}
        return { ok: false, path: "wait_rows", why: "n=" + n, elapsed: elapsed };
      }
      /**
       * ★ 2.8.264: 押した時のページか、移った先の新しいページかで分ける。
       *   新しいページ … 読み込みが終わっていれば（readyState=complete）この検索の結果。
       *   同じページ（AJAX）… 目印が変わった時だけ。変わらない時は6秒以上・移動なしの時だけ保険で認める。
       */
      var pressDoc = "";
      try { pressDoc = sessionStorage.getItem("axlx_search_press_doc") || ""; } catch (_) { pressDoc = ""; }
      var sameDoc = !pressDoc || pressDoc === _AXLX_DOC_ID;
      var nowEv = _localScreenEvidenceBrief();
      if (!sameDoc) {
        if (document.readyState !== "complete") {
          try { _liveDlStep("page_display_wait_load", "rs=" + document.readyState + " ms=" + elapsed); } catch (_) {}
          return { ok: false, path: "wait_load", why: "loading", elapsed: elapsed, n: n };
        }
        try { _liveDlStep("page_displayed_ok", "new_doc n=" + n + " ms=" + elapsed + " " + nowEv.brief); } catch (_) {}
        return { ok: true, path: "new_doc", why: "new_doc", elapsed: elapsed, brief: nowEv.brief, n: n };
      }
      var base = _readSearchPressBaseline();
      var pressSig = _readSearchPressSig();
      var changed = false;
      try {
        if (pressSig && nowEv.brief && pressSig !== nowEv.brief) changed = true;
        if (base && base.href && String(location.href || "") !== String(base.href)) changed = true;
        if (base && base.pdf != null && Number(base.pdf) !== Number(nowEv.pdf)) changed = true;
      } catch (_) { changed = false; }
      if (changed) {
        try { _liveDlStep("page_displayed_ok", "changed n=" + n + " ms=" + elapsed + " " + nowEv.brief); } catch (_) {}
        return { ok: true, path: "changed", why: "changed", elapsed: elapsed, brief: nowEv.brief, n: n };
      }
      if (elapsed >= 6000) {
        try { _liveDlStep("page_displayed_ok", "settle n=" + n + " ms=" + elapsed + " " + nowEv.brief); } catch (_) {}
        return { ok: true, path: "settle", why: "settle", elapsed: elapsed, brief: nowEv.brief, n: n };
      }
      try {
        _liveDlStep(
          "page_display_wait",
          "ms=" + elapsed + " same n=" + n + " base=" + String(pressSig || "-").slice(0, 28),
        );
      } catch (_) {}
      _nudge("⏳ 検索結果のページ表示を待っています");
      return { ok: false, path: "wait_display", why: "same_brief", elapsed: elapsed, n: n };
    } catch (_) {
      return { ok: false, path: "err", why: "err" };
    }
  }
  function _inferScreenOkFromDom(why) {
    try {
      if (_isSearchConfirmGrasp(_searchGraspedMem)) return true;
      if (_isFillBusy && _isFillBusy()) return false;
      var gate = _pageDisplayedAfterThisSearch(why || "dom_infer");
      if (!gate.ok) return false;
      var n = gate.n || 0;
      _searchGraspedMem = {
        at: Date.now(),
        why: "screen:page_displayed:" + String(gate.path || why || "watch").slice(0, 20),
        screenOk: true,
        confirmed: true,
        pressed: true,
        customerId: (_autoRunCid || null),
        pageDisplayed: true,
        displayPath: String(gate.path || "").slice(0, 16),
      };
      try { sessionStorage.setItem("axlx_search_grasped_sync", JSON.stringify(_searchGraspedMem)); } catch (_) {}
      try { chrome.storage.session.set({ axlx_search_grasped: _searchGraspedMem }); } catch (_) {}
      // ★ 2.8.263: 押下基準は1回の検索で1回だけ使う（残すと次の客で古い一覧を結果と誤認する）
      try { sessionStorage.removeItem("axlx_search_press_baseline"); } catch (_) {}
      try { sessionStorage.removeItem("axlx_search_press_sig"); } catch (_) {}
      try { sessionStorage.removeItem("axlx_search_press_doc"); } catch (_) {}
      try { _liveDlStep("search_customer_screen_ok", "page_displayed n=" + n + " " + String(gate.path || "").slice(0, 16)); } catch (_) {}
      try { _liveDlStep("search_results_ready", "page_displayed→AD可 n=" + n); } catch (_) {}
      _autoSendArmed = true;
      try { _forceAutoForPending("page_displayed"); } catch (_) {}
      try { _touchPipelineProgress("dom_screen_ok"); } catch (_) {}
      return true;
    } catch (_) { return false; }
  }
  function _armScreenOkWatchdog(why) {
    try { if (_screenOkWatchTimer) clearTimeout(_screenOkWatchTimer); } catch (_) {}
    _screenOkWatchTimer = setTimeout(function () {
      _screenOkWatchTimer = null;
      try {
        if (_isSearchConfirmGrasp(_searchGraspedMem)) return;
        if (!_autoSendArmed && !_hasSearchPendingSync()) return;
        if (_autoPdfRun || _adSortInFlight) return;
        if (!_inferScreenOkFromDom(why || "watchdog")) {
          _nudge("⏳ 検索結果のページ表示を待っています");
          return;
        }
        console.warn("[AXLX bulk-dl] 結果ページ表示確認 → 並べ替えへ (" + why + ")");
        _nudge("🔀 検索結果ページ表示済 → 並べ替えへ進みます");
        setTimeout(function () {
          try { _kickSortAfterSearch("page_displayed_watch"); } catch (_) {}
        }, 200);
      } catch (err) {
        console.warn("[AXLX bulk-dl] screenOk watchdog 失敗", err && err.message);
      }
    }, 5500);
  }
  /**
   * ★ 2.8.254: 並べ替え時に隠すのは案内パネルだけ（お客様パネル・物件送る枠は触らない）
   *   旧 `[id^='aixlinx-']` は #aixlinx-float-wrap まで消し、戻さず消えたままになる。
   */
  function _tuckGuidesForSort() {
    var sel = "#axlx-guide-panel, #axlx-guide-layer, #axlx-guide, #axlx-guide-root, #axlx-guide-overlay";
    var list = document.querySelectorAll(sel);
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      try {
        var el = list[i];
        if (!el || !el.style) continue;
        // お客様パネル・物件送る枠は絶対に隠さない
        var id = String(el.id || "");
        if (id === "aixlinx-float-wrap" || id === "aixlinx-mini-btn" || id === "axlx-bar") continue;
        if (!el.getAttribute("data-axlx-sort-prev-display")) {
          el.setAttribute("data-axlx-sort-prev-display", String(el.style.display || ""));
        }
        el.style.display = "none";
        n++;
      } catch (_) {}
    }
    try { _liveDlStep("sort_guide_tuck", "n=" + n); } catch (_) {}
    try { _tmark("sort_guide_tuck", "n=" + n); } catch (_) {}
    return n;
  }
  function _restoreGuidesAfterSort() {
    var list = document.querySelectorAll("[data-axlx-sort-prev-display]");
    for (var i = 0; i < list.length; i++) {
      try {
        var el = list[i];
        var prev = el.getAttribute("data-axlx-sort-prev-display");
        el.style.display = prev == null ? "" : prev;
        el.removeAttribute("data-axlx-sort-prev-display");
      } catch (_) {}
    }
    // 万一 float-wrap が display:none のままなら強制で戻す
    try {
      var wrap = document.getElementById("aixlinx-float-wrap");
      if (wrap && wrap.style && wrap.style.display === "none" && wrap.getAttribute("data-axlx-user-mini") !== "1") {
        wrap.style.display = "flex";
      }
    } catch (_) {}
    try {
      var bar = document.getElementById("axlx-bar");
      if (bar && bar.style && bar.style.display === "none" && bar.getAttribute("data-axlx-force-hide") !== "1") {
        // tracked が有る／検索結果画面なら再表示は updateBar に任せる
        try { updateBar(); } catch (_) {}
      }
    } catch (_) {}
    try { _liveDlStep("sort_guide_restore", "ok"); } catch (_) {}
  }
  var _sortCursorTimer = null;
  var _sortCursorDeferN = 0;
  /** 保険（強制）使用回数。本線で動くのが正・保険は最後の1回だけ */
  var _sortCursorInsuranceUsed = false;
  function _humanWaitAfterSearchMs() {
    var H = (typeof self !== "undefined" ? self : window).AxlxHumanWait;
    var base = H && H.logNormalDelay ? H.logNormalDelay(1800, 0.4) : (1800 + Math.floor(Math.random() * 900));
    if (base < 1000) base = 1000 + Math.floor(Math.random() * 400);
    if (base > 3500) base = 3500;
    return Math.round(base);
  }
  /**
   * ★ 2.8.207 竹内さん「検索押したと確認 → そのあと1秒以上空けて並べ替え」:
   *   意図(intent/直前)だけでは未確認。press_ok / screen / confirmed だけ本線。
   */
  /**
   * ★ 2.8.240: AD並び替え可＝検索**結果**が画面に出た（screenOk）。
   *   旧は search_press_ok / confirmed だけで true → 結果未反映なのに AD が走った。
   */
  function _isSearchConfirmGrasp(g) {
    if (!g || !g.at) return false;
    // ★ 2.8.241: 薄い／TTL切れ／旧版は使わない
    try {
      if (Date.now() - Number(g.at || 0) > 15 * 60 * 1000) return false;
      if (
        g.confirmed == null && g.screenOk == null && g.pressed == null
        && !g.screen && !g.customerId && !g.pageVer
      ) {
        return false;
      }
    } catch (_) {}
    if (g.intent === true && !g.screenOk) return false;
    if (g.screenOk === true) return true;
    var w = String(g.why || "");
    if (/^screen:|after_search_screen|customer_screen|reload_resume/i.test(w)) return true;
    /**
     * ★ 2.8.244: armed_rows／sync_pending／list_visible は「武装・行あり」の印であり
     *   screenOk ではない。旧は why だけで確認扱いにし AD へ進む＝240関所と衝突。
     */
    if (/直前|intent_only|sort_cursor:|armed_only|legacy_after_search|ungrasped_but_list|search_press_ok|press_ok|armed_rows|armed_list|sync_pending|pending_armed|list_visible/i.test(w)) {
      return false;
    }
    if (g.pressed === true && !g.screenOk) return false;
    if (g.confirmed === true && !g.screenOk) return false;
    // human_search も画面照合が無い限り確認にしない（旧一覧の人検索誤認を止める）
    return false;
  }
  function _msSinceSearchConfirm() {
    try {
      if (_searchGraspedMem && _isSearchConfirmGrasp(_searchGraspedMem)) {
        return Math.max(0, Date.now() - Number(_searchGraspedMem.at || 0));
      }
    } catch (_) {}
    return null;
  }
  /** 確認時刻から合計≥1秒になる残り待ち（人間ランダムを下限に載せる） */
  function _waitMsFromSearchConfirm() {
    var human = _humanWaitAfterSearchMs();
    var elapsed = _msSinceSearchConfirm();
    if (elapsed == null) return human;
    var need = Math.max(1000, human);
    var remain = need - elapsed;
    if (remain < 1000 && elapsed < 1000) remain = 1000 - elapsed;
    if (remain < 50) remain = 50;
    return Math.round(remain);
  }
  /** 検索後一覧の地図原子（手順書×画面: 1つずつ） */
  function _stampSortFlowAtom(atom, ok, detail) {
    try { _liveDlStep("flow_atom_" + (ok ? "ok_" : "gap_") + atom, String(detail || "").slice(0, 50)); } catch (_) {}
    try {
      window.postMessage({
        from: "axlx-bulk-flow-atom",
        atom: String(atom || "").slice(0, 28),
        ok: !!ok,
        detail: String(detail || "").slice(0, 80),
      }, "*");
    } catch (_) {}
  }
  /**
   * ★ 2.8.193 竹内さん「強制は保険として使う／本線は細分化して動く」:
   *   関所を1つずつ判定。誤検知は本線の再分類。保険は本線が何度も詰まった時だけ。
   *   path: main | reclassify | wait_modal | wait_fill | wait_rows | insurance
   */
  function _gateSortCursorReady() {
    var rows = 0;
    try { rows = tracked.filter(function (t) { return t && t.btn && t.btn.isConnected; }).length; } catch (_) { rows = 0; }
    var sortHead = false;
    try { sortHead = !!_hasSortHeadVisible(); } catch (_) { sortHead = false; }
    var mod = null;
    try { mod = _isCondModalOpen(); } catch (_) { mod = null; }
    var fillBusy = false;
    try { fillBusy = !!(_isFillBusy() && !_autoSendArmed); } catch (_) { fillBusy = false; }
    var listEvidence = rows > 0 && sortHead;
    var brief = "rows=" + rows + " head=" + (sortHead ? "Y" : "N") + " mod=" + (mod || "-") + " fill=" + (fillBusy ? "Y" : "N");
    try { _liveDlStep("sort_gate_check", brief.slice(0, 55)); } catch (_) {}
    _stampSortFlowAtom("sort_gate", true, brief);

    // ① 本線: モーダル無し・入力中でない
    if (!mod && !fillBusy) {
      if (rows < 1 && !sortHead) {
        try { _liveDlStep("sort_gate_wait_rows", brief.slice(0, 40)); } catch (_) {}
        return { ok: false, path: "wait_rows", why: "rows0", brief: brief };
      }
      /**
       * ★ 2.8.259 DB#1600: rows>0 でも head=N のまま main に通すと
       *   sort_no_head 連発→止まって見える。見出しが出るまで待つ。
       */
      if (rows > 0 && !sortHead) {
        try { _liveDlStep("sort_gate_wait_head", brief.slice(0, 40)); } catch (_) {}
        return { ok: false, path: "wait_head", why: "head0", brief: brief };
      }
      try { _liveDlStep("sort_gate_main", brief.slice(0, 40)); } catch (_) {}
      return { ok: true, path: "main", why: "clear", brief: brief };
    }

    // ② 再分類（本線）: 判定は modal だが一覧の並べ替え＋行が見える＝誤検知
    //    → 強制ではなく本線で進む（保険を使わない）
    if (mod && listEvidence) {
      try { _liveDlStep("sort_gate_reclassify", String(mod).slice(0, 16) + ":list_ok"); } catch (_) {}
      _stampSortFlowAtom("sort_reclassify", true, String(mod || ""));
      return { ok: true, path: "reclassify", why: "false_modal:" + mod, brief: brief };
    }

    // ③ 待つ（本線の細分化）: 本物の条件画面／入力中
    if (fillBusy) {
      try { _liveDlStep("sort_gate_wait_fill", brief.slice(0, 40)); } catch (_) {}
      return { ok: false, path: "wait_fill", why: "fill", brief: brief };
    }
    try { _liveDlStep("sort_gate_wait_modal", String(mod || "modal").slice(0, 24)); } catch (_) {}
    return { ok: false, path: "wait_modal", why: String(mod || "modal"), brief: brief };
  }
  function _goSortCursorNow(why, path) {
    try {
      if (_autoPdfRun || _adSortInFlight) {
        try { _liveDlStep("sort_cursor_skip", _adSortInFlight ? "ad_sort_inflight" : "already_running"); } catch (_) {}
        return { ok: false, reason: "running" };
      }
      _autoPdfSig = "";
      _forceAutoForPending("sort_cursor_go");
      var p = String(path || "main").slice(0, 16);
      _stampSortFlowAtom("sort_cursor", true, p + ":" + (why || "go"));
      try { _liveDlStep("sort_cursor_go", p + ":" + String(why || "").slice(0, 28)); } catch (_) {}
      _nudge("🔀 並べ替えへカーソル移動");
      var r = autoPressPdfs({
        afterSearch: true,
        fromSortCursor: true,
        sortPath: p,
        allowModalReclassify: p === "reclassify" || p === "insurance",
      });
      if (!r || r.ok === false) {
        _sortCursorScheduled = false;
        _autoPdfSig = "";
        _stampSortFlowAtom("sort_menu", false, (r && r.reason) || "fail");
        try { _liveDlStep("sort_cursor_fail", String((r && r.reason) || "fail").slice(0, 40)); } catch (_) {}
        return r || { ok: false, reason: "fail" };
      }
      _stampSortFlowAtom("sort_menu", true, "started:" + p);
      return r;
    } catch (err) {
      _sortCursorScheduled = false;
      console.warn("[AXLX bulk-dl] goSortCursor 失敗", err && err.message);
      return { ok: false, reason: "err" };
    }
  }
  var _pageWaitN = 0;
  function _scheduleSortCursorAfterSearch(why) {
    try {
      if (_sortCursorScheduled || _autoPdfRun) return false;
      // ★ 2.8.264: 検索の移動中は行の読み直しもしない（死にゆく古い一覧を重く読まない）
      if (_isNavPending()) {
        try { _pageDisplayedAfterThisSearch(why || "schedule"); } catch (_) {}
        return false;
      }
      try { if (typeof _rescanRows === "function") _rescanRows(); } catch (_) {}
      var n = 0;
      try { n = tracked.filter(function (t) { return t && t.btn && t.btn.isConnected; }).length; } catch (_) { n = 0; }
      var sync = _hasSearchPendingSync();
      if (n < 1 && !sync && !_autoSendArmed) return false;
      /**
       * ★ 2.8.207: 検索「確認」が無いと並べ替えスケジュールしない。
       * ★ 2.8.263: 結果ページ表示前は並べ替えしない（先に並べ替え→検索ラグ／バグの根）。
       */
      var graspOk = _isSearchConfirmGrasp(_searchGraspedMem);
      if (!graspOk) {
        try {
          var _gs = sessionStorage.getItem("axlx_search_grasped_sync");
          if (_gs) {
            var _gp = JSON.parse(_gs);
            if (_isSearchConfirmGrasp(_gp)) {
              _searchGraspedMem = _gp;
              graspOk = true;
            }
          }
        } catch (_) {}
      }
      if (!graspOk) {
        var pageGate = _pageDisplayedAfterThisSearch(why || "schedule");
        if (!pageGate.ok) {
          _stampSortFlowAtom("sort_wait", false, "need_page_display:" + String(pageGate.path || "").slice(0, 16));
          try { _liveDlStep("sort_gate_need_page", String(pageGate.path || "wait") + ":" + String(why || "").slice(0, 24)); } catch (_) {}
          console.log("[AXLX bulk-dl][auto] 結果ページ表示前 → 並べ替え待ち (" + (pageGate.path || why) + ")");
          /**
           * ★ 2.8.264: 旧は0.9秒ごとに無限に読み直し（毎回ページ全体を走査）→ 固まりの一因。
           *   60回（約1分）で打ち切り、後は沈黙見張り・新しいページの読み込みに任せる。
           */
          _pageWaitN++;
          if (_pageWaitN > 60) {
            if (_pageWaitN === 61) {
              try { _liveDlStep("page_display_give_up", "n=60 " + String(pageGate.path || "").slice(0, 16)); } catch (_) {}
              console.warn("[AXLX bulk-dl] 結果ページ表示待ちを打ち切り（約1分）→ 見張りに任せる");
            }
            return false;
          }
          if (!_sortCursorTimer && pageGate.path !== "nav_pending") {
            _sortCursorTimer = setTimeout(function () {
              _sortCursorTimer = null;
              try { _scheduleSortCursorAfterSearch((why || "wait") + "_page"); } catch (_) {}
            }, 900);
          }
          return false;
        }
        try { _inferScreenOkFromDom("schedule_page"); } catch (_) {}
        graspOk = _isSearchConfirmGrasp(_searchGraspedMem);
      }
      if (!graspOk) {
        _stampSortFlowAtom("sort_wait", false, "need_search_confirm");
        try { _liveDlStep("sort_gate_need_confirm", String(why || "schedule").slice(0, 40)); } catch (_) {}
        console.log("[AXLX bulk-dl][auto] 検索確認前 → 並べ替え待ちしない (" + why + ")");
        return false;
      }
      if (n < 1) {
        if (_sortCursorTimer) return false;
        _stampSortFlowAtom("after_search_rows", false, "rows0");
        try { _liveDlStep("sort_gate_wait_rows", "pre_schedule"); } catch (_) {}
        _sortCursorTimer = setTimeout(function () {
          _sortCursorTimer = null;
          try { _scheduleSortCursorAfterSearch((why || "wait") + "_retry"); } catch (_) {}
        }, 800);
        return false;
      }
      _stampSortFlowAtom("after_search_rows", true, "rows=" + n);
      _forceAutoForPending(why || "sort_cursor");
      if (!_autoModeOn) return false;
      _autoSendArmed = true;
      try { _touchPipelineProgress("armed_sort"); _armPipelineSilence("after_search"); } catch (_) {}
      if (sync && sync.customerId) _autoRunCid = sync.customerId;
      try {
        chrome.storage.session.set({ axlx_search_grasped: _searchGraspedMem });
        try { sessionStorage.setItem("axlx_search_grasped_sync", JSON.stringify(_searchGraspedMem)); } catch (_) {}
      } catch (_) {}
      _sortCursorScheduled = true;
      // ★ 2.8.207: 待ちは「検索確認時刻」から合計1秒以上（スケジュール時刻基準にしない）
      var wait = _waitMsFromSearchConfirm();
      var elapsed = _msSinceSearchConfirm();
      _stampSortFlowAtom("sort_wait", true, wait + "ms_from_confirm");
      try {
        _liveDlStep(
          "sort_cursor_wait",
          wait + "ms:" + String(why || "").slice(0, 20)
            + ":elapsed=" + (elapsed != null ? elapsed : "-"),
        );
      } catch (_) {}
      try { _liveDlStep("search_to_sort", "cursor_in_" + wait + "ms_after_confirm"); } catch (_) {}
      try {
        _liveDlStep(
          "search_confirm_gap",
          "confirm→wait " + wait + "ms (elapsed " + (elapsed != null ? elapsed : "-") + ")",
        );
      } catch (_) {}
      console.log("[AXLX bulk-dl][auto] 検索確認済 → " + (wait / 1000).toFixed(1) + "秒後に並べ替えへカーソル (" + why + ", rows=" + n + ", elapsed=" + elapsed + "ms)");
      _nudge("🔀 " + (wait / 1000).toFixed(1) + "秒後に並べ替えへカーソル移動");
      if (_sortCursorTimer) { try { clearTimeout(_sortCursorTimer); } catch (_) {} }
      _sortCursorTimer = setTimeout(function () {
        _sortCursorTimer = null;
        try {
          if (_autoPdfRun) {
            try { _liveDlStep("sort_cursor_skip", "already_running"); } catch (_) {}
            return;
          }
          var gate = _gateSortCursorReady();
          /**
           * 本線: main / reclassify → そのまま並べ替えへ（強制ではない）
           * 待ち: wait_* → 細分化して再スケジュール
           * 保険: 本物の待ちが5回続き、その後一覧証拠が出た時だけ1回
           */
          if (!gate.ok) {
            _sortCursorDeferN++;
            try {
              _liveDlStep(
                "sort_cursor_defer",
                String(gate.path || "wait") + ":n=" + _sortCursorDeferN + ":" + String(gate.why || "").slice(0, 20),
              );
            } catch (_) {}
            // 待ちのあいだに一覧証拠が揃ったら本線再分類へ（保険より先）
            if (_sortCursorDeferN >= 2) {
              var again = _gateSortCursorReady();
              if (again.ok && (again.path === "main" || again.path === "reclassify")) {
                _sortCursorDeferN = 0;
                _goSortCursorNow(why || "gate_recover", again.path);
                return;
              }
            }
            // 保険: 本線が5回待っても進まない・一覧証拠あり・未使用 → 1回だけ
            if (!_sortCursorInsuranceUsed && _sortCursorDeferN >= 5) {
              var rowsI = 0, headI = false;
              try { rowsI = tracked.filter(function (t) { return t && t.btn && t.btn.isConnected; }).length; } catch (_) {}
              try { headI = !!_hasSortHeadVisible(); } catch (_) {}
              if (rowsI > 0 && headI) {
                _sortCursorInsuranceUsed = true;
                _sortCursorDeferN = 0;
                console.warn("[AXLX bulk-dl][auto] 本線が5回待ち → 保険で並べ替えへ（1回だけ）");
                try { _liveDlStep("sort_cursor_insurance", "after_defer5:" + String(gate.why || "").slice(0, 20)); } catch (_) {}
                _stampSortFlowAtom("sort_insurance", true, "defer5");
                _goSortCursorNow("insurance", "insurance");
                return;
              }
              /**
               * ★ 2.8.259: wait_head が続く＝見出しDOMが取れないページ。
               *   永遠に defer せず、回復探索付きで1回だけ並べ替えを試す（保険）。
               */
              if (rowsI > 0 && String(gate.path || "") === "wait_head") {
                _sortCursorInsuranceUsed = true;
                _sortCursorDeferN = 0;
                console.warn("[AXLX bulk-dl][auto] 見出し待ち5回 → 回復探索つきで1回だけ並べ替え");
                try { _liveDlStep("sort_cursor_insurance", "wait_head5_recover"); } catch (_) {}
                _stampSortFlowAtom("sort_insurance", true, "wait_head5");
                _goSortCursorNow("insurance_head", "insurance");
                return;
              }
            }
            _sortCursorScheduled = false;
            setTimeout(function () {
              try { _scheduleSortCursorAfterSearch("defer_" + String(gate.path || "wait")); } catch (_) {}
            }, 1200);
            return;
          }
          _sortCursorDeferN = 0;
          var r2 = _goSortCursorNow(why || "timer", gate.path || "main");
          if (!r2 || r2.ok === false) {
            setTimeout(function () {
              try {
                _sortCursorScheduled = false;
                _autoPdfSig = "";
                // 失敗後も本線で再試行（保険ではない）
                var g2 = _gateSortCursorReady();
                _goSortCursorNow("retry", (g2 && g2.ok && g2.path) || "main");
              } catch (_) {}
            }, 1500);
          }
        } catch (err) {
          _sortCursorScheduled = false;
          console.warn("[AXLX bulk-dl] sort_cursor 失敗", err && err.message);
        }
      }, wait);
      return true;
    } catch (err) {
      console.warn("[AXLX bulk-dl] schedule sort_cursor 失敗", err && err.message);
      return false;
    }
  }
  function _kickSortAfterSearch(why) {
    try {
      if (_pendingAutoSendDispatched || _autoPdfRun) return false;
      if (_adSortInFlight) {
        try { _liveDlStep("sort_skip_inflight", String(why || "kick").slice(0, 36)); } catch (_) {}
        return false;
      }
      return _scheduleSortCursorAfterSearch(why || "kick");
    } catch (err) {
      console.warn("[AXLX bulk-dl] kick失敗", err && err.message);
      return false;
    }
  }
  /**
   * @param {{ afterSearch?: boolean }} [opt]
   *   afterSearch=true … 検索後の読み直し（pending）から。条件入力中ではない。
   */
  function _maybeAutoPressOnLoad(opt) {
    // ★ 2026-11-22: スタッフでも _autoModeOn（選んだ客の自動）なら押す。旧は _staffModeOn で止めていた。
    // ★ 2.8.190: 検索後印があるのに auto OFF ならこの一覧だけ開く（止まらない）
    if (!_autoModeOn) _forceAutoForPending((opt && opt.afterSearch) ? "afterSearch" : "onLoad");
    if (_autoPdfRun || !_autoModeOn) return;
    if (_guideBlocksAuto("autoOnLoad")) return;
  if (_supBlocksAuto("autoOnLoad")) return;
    /**
     * ★ 2026-11-22: 駅・沿線・所在地モーダル中は一覧が裏にあっても押さない／並べ替えない。
     */
    var _modLoad = _isCondModalOpen();
    if (_modLoad) {
      console.log("[AXLX bulk-dl][auto] 条件モーダル中(" + _modLoad + ") → 一覧押ししない");
      _tmark("auto_pdf_load", "blocked_cond_modal:" + _modLoad);
      return;
    }
    /**
     * 2026-11-12 竹内さん「自動で検索したら検索も条件入れる前にいま出ている物件のダウンロードを始めてしまう」:
     *   自動入力の最中（条件を入れて検索を押す前）は**押さない**。
     *   ここで押すと、画面に残っている**前の一覧（別のお客様・条件違い）**を送ってしまう。
     *   押してよいのは「検索を押した合図（fill-done）の後に出た新しい行」だけ。
     */
    if (_isFillBusy() && !(opt && opt.afterSearch)) {
      // 合図が来ないまま固まった時は解く（永久に押せなくしない・20分）
      if (_autofillStartedAt && Date.now() - _autofillStartedAt > _autofillStuckMs) {
        _autofillInProgress = false;
        _fillBusyFromSession = false;
        try { chrome.storage.session.remove("axlx_fill_busy"); } catch (_) {}
        console.warn("[AXLX bulk-dl][auto] 自動入力の合図が来ないまま20分 → 念のため解きます");
      } else {
        console.log("[AXLX bulk-dl][auto] 自動入力の最中（条件を入れる前）→ いま出ている一覧は押しません");
        _tmark("auto_pdf_load", "blocked_during_fill");
        return;
      }
    }
    /**
     * ★ 2026-11-16: ちゃんと検索してから物件取得。
     *   fill-done（armed）か、検索後の pending 再開だけ許可。勝手に一覧を押さない。
     */
    if (!_autoSendArmed && !(opt && opt.afterSearch)) {
      console.log("[AXLX bulk-dl][auto] 検索完了の合図前 → 一覧を押しません");
      _tmark("auto_pdf_load", "blocked_need_search_first");
      return;
    }
    if (tracked.length === 0) return;
    /** ★ 2.8.277 結果ページの見出しを希望と照らす（記録・警告・旗がある時だけ止める） */
    var _rvr = _resultVerifyOnce();
    if (_rvr && (_rvr.verdict === "mismatch" || _rvr.verdict === "full") && _resultVerifyEnforce(_rvr)) {
      _tmark("auto_pdf_load", "blocked_result_mismatch");
      _resultVerifyReport(_rvr);   // 1回だけ・background が前の条件を外して入れ直す
      return;
    }
    /**
     * 2026-11-11 竹内さん「AD順などするときにページ更新してしまっている。ページ更新すると拡張ツールの検索のところが
     *   閉じてしまうのにそのまま物件取得にうつってしまうので全物件が対象となってしまう」
     *
     *   ⚠ AD順へ移った直後は**条件が効いていない一覧（全物件）**の事がある。
     *     そこで押し始めると**全物件を送ってしまう**（一番まずい）。
     *   → 並び替えで飛んだ直後（`axlx_ad_sort_pending` が新しい）は、
     *     **本当にその検索の一覧か**を確かめてから押す。確かめられなければ**押さない**。
     */
    if (_adSortJustHappened()) {
      var _okSearch = _looksLikeSearchResult();
      if (!_okSearch) {
        /**
         * 2026-11-11 v2.7.2 竹内さん「並べ替えした後物件選択するところでとまってしまった」:
         *   並べ替えの後は読み直しの直後で**条件の欄がまだ描かれていない**事がある。
         *   旧はここで即あきらめて**静かに止まった**（0件を選択中のまま動かない＝バグに見える）。
         *   → ① 少し待って**何度か見直す**（描かれてから判定する・25秒まで）
         *     ② それでも読めない時は**枠に理由と「もう一度ためす」**を出す（黙って止まらない）
         *     ③ 押すのは「条件が効いている」と分かった時だけ（全物件は送らない）
         */
        var _pv = null;
        try { _pv = window.__axlxAdSortPending; } catch (_) {}
        var _elapsed = _pv ? Date.now() - Number(_pv.at || 0) : 0;
        if (_elapsed < _AD_SORT_GRACE_MS && !_adSortChecking) {
          _adSortChecking = true;
          console.warn("[AXLX bulk-dl][auto] AD順の直後・条件がまだ読めない → 少し待って見直します（" + Math.round(_elapsed / 1000) + "秒）");
          _tmark("auto_pdf_load", "retry_after_sort");
          _nudge("👀 並べ替えの後に条件を確かめています");
          setTimeout(function () {
            _adSortChecking = false;
            try { _maybeAutoPressOnLoad(); } catch (_) {}
          }, 1400);
          return;
        }
        if (_elapsed < _AD_SORT_GRACE_MS) return; // 見直しの待ちが既に入っている（二重に積まない）
        /**
         * 2026-11-14 竹内さん「出来なくても止まらずにそのまま動かすようにする」:
         *   ⚠ 旧は `_adSortBlocked = true` にして **押さない**で止めていた。
         *     ＝「条件が読めない」だけで**物件が1件も出ない**（現場が止まる）。
         *   → **警告を出して続行**する（竹内さんの判断: 止まる方が困る）。
         *     ⚠ 黙って続けない: 点検に `proceed_unverified` を残し、画面にも警告を出す。
         *     ⚠ 止めるのは「統括が unsafe」「スタッフモード」「停止ボタン」だけ（本当に危ない時）。
         */
        console.warn("[AXLX bulk-dl][auto] 条件が効いているか確かめられない → **このまま押します**（止まらない）");
        _tmark("auto_pdf_load", "proceed_unverified");
        _blockedAfterSortNote();   // 警告は出す（止めない）
        _adSortDone = true;
        // ← ここで return しない（下の押す処理へ進む）
      }
      console.log("[AXLX bulk-dl][auto] AD順に移った直後・条件が効いている一覧 → 押します");
      _adSortDone = true; // 判定おわり（この一覧ではもう聞かない）
    }
    /**
     * ★ 2.8.191 竹内さん「検索押下＝トリガー → 1秒以降の人間ランダムで並べ替えへカーソル」:
     *   afterSearch は長い「見る間」経由ではなく、検索把握→待ち→並べ替えカーソル専用道。
     *   固まった `_autoPdfSig` があっても外してスケジュールする（#1588）。
     */
    if (opt && opt.afterSearch) {
      if (!_autoPdfRun) _autoPdfSig = "";
      console.log("[AXLX bulk-dl][auto] 検索後 → 並べ替えカーソル待ちへ (" + tracked.length + "行)");
      _tmark("auto_pdf_load", "afterSearch_sort_cursor rows=" + tracked.length);
      _scheduleSortCursorAfterSearch("maybe_afterSearch");
      return;
    }
    var sig = tracked.map(function (t) { return _urlKey(t.btn && t.btn.href); }).join(",").slice(0, 3000);
    if (!sig || sig === _autoPdfSig) return;
    // まだ1件も押していない一覧だけ（既に送った行がある一覧の描き直しでは始めない）
    var fresh = tracked.some(function (t) { return t.btn && !_onePdfSent[t.btn.href]; });
    if (!fresh) return;
    // ★ 2.8.191: 見る間の前に sig を立てない（キャンセル後に再試行不能になるため）
    console.log("[AXLX bulk-dl][auto] 自動モード: 一覧が出たので印刷用PDFを1件ずつ押して送ります（" + tracked.length + "行）");
    _tmark("auto_pdf_load", "rows=" + tracked.length);
    _startAutoPressAfterLook(tracked.length, { pendingSig: sig });
  }

  /**
   * 2026-11-11 竹内さん「AD順などするときにページ更新してしまっている」:
   *   直近の「AD順へ移った」印があるか（＝この読み込みは並び替えのための物）
   *
   * 2026-11-11 v2.7.2 竹内さん「並べ替えした後物件選択するところでとまってしまった」:
   *   旧は `_adSortChecked` で **1回だけ** 判定して、だめなら**そのまま永久に止まっていた**
   *   （ページが読み直された直後は条件の欄がまだ描かれていない事があり、1回目だけ見ると必ず外れる）。
   *   → **時間で区切って何度か見直す**（`_AD_SORT_GRACE_MS` の間）。
   *     ⚠ 回数で数えると、一覧の描き直しのたびに減って**すぐ尽きる**（＝結局1回で止まる）。
   *     だから「並べ替えから何秒たったか」で見る。
   */
  var _adSortDone = false;      // この一覧では判定が済んだ（押すと決まった）
  /**
   * ★ 2026-11-22 竹内さん「検索押したって把握してからADの並び替え」:
   *   page-script が検索 click 後に `axlx-search-grasped` を送る／session に残る。
   *   AD 並び替えはこの印（または一覧確定の推定）が無いと始めない。
   */
  var _searchGraspedMem = null; // { at, why }
  var _adSortBlocked = false;   // 見直しても読めなかった（人が「もう一度ためす」を押すまで押さない）
  var _adSortChecking = false;  // いま見直しの待ちを入れている（二重に積まない）
  var _AD_SORT_GRACE_MS = 25000;
  function _adSortJustHappened() {
    if (_adSortDone || _adSortBlocked) return false;
    try {
      var pv = window.__axlxAdSortPending;
      return !!pv && (Date.now() - Number(pv.at || 0) < 120000);
    } catch (_) { return false; }
  }
  /**
   * 検索の条件が効いている一覧に見えるか（全物件ではないか）を、URL・フォーム・**結果の見出しの文字**で見る。
   *
   * 2026-11-11 v2.7.2 竹内さん「並べ替えした後物件選択するところでとまってしまった。ここ何かバグが起きているのではないか」
   *
   *   原因: 並べ替えの後は**ページが読み直される**ので、
   *     ① URL に条件が載っていない（`key=ad&odr=desc` だけ）
   *     ② 検索の欄は**畳まれている**（`検索条件を表示`）＝入力欄の値が既定に戻っている
   *     ③ 区・駅の小窓は閉じている＝チェックが1つも無い
   *   → 旧の判定は ①②③ だけ見ていたので **必ず false**。すると
   *     「並べ替えの後に条件が消えている可能性 → 自動で押しません」で**そのまま止まる**（画面は 0件を選択中）。
   *   ⚠ 止まる事自体は安全側（全物件を送らない）だが、**本当は条件が効いている**ので押すべきだった。
   *
   *   → 画面の一番上に出ている**効いている条件の文字**（例:「家賃 ～10.5万 / 徒歩15分 / 2LDK-3LDK / 更新1日内」）と、
   *     検索した時の印（`AxlxSearchStamp`・案内で「検索」を押した時に残る）も見る。
   *     **全件（16338棟など）と分かる時は必ず false**（押さない）。
   */
  /**
   * ★ 2.8.264: 0.9秒ごと・見張りごとに呼ばれる。旧は body.textContent／innerText（innerText は
   *   ページ全体の配置計算を強制）を毎回作り、表示中の新しいページの描画を止めていた。
   *   → 先頭の文字だけを辿る＋同じURLなら1.5秒は前の答えを使う。
   */
  var _lsrCache = { at: 0, href: "", v: false };
  function _looksLikeSearchResult() {
    var href = "";
    try { href = String(location.href || ""); } catch (_) { href = ""; }
    var now = Date.now();
    if (now - _lsrCache.at < 1500 && _lsrCache.href === href) return _lsrCache.v;
    var v = _looksLikeSearchResultRaw();
    _lsrCache = { at: now, href: href, v: v };
    return v;
  }
  function _looksLikeSearchResultRaw() {
    try {
      // ⓪ いちばん強い印: 全件の数が出ている一覧は「条件なし」と決めつける（押さない）
      var _head = _bodyHeadText(3000);
      if (/全件/.test(_head) && !/条件/.test(_head)) return false;

      var p = new URLSearchParams(location.search);
      // URL に条件が載っている（所在地・駅・賃料など）
      var keys = ["city_code", "station_id", "route_id", "rental_cost1", "rental_cost2", "update_date", "room_layout", "square_meter"];
      for (var i = 0; i < keys.length; i++) {
        if (p.has(keys[i]) || (p.has(keys[i] + "[]") && p.get(keys[i] + "[]"))) return true;
      }

      // ① 検索した時の印（案内で「検索」を押した時にタブへ残る）。今のお客様の物で新しいなら条件つきの一覧
      try {
        var st = window.AxlxSearchStamp && window.AxlxSearchStamp.read ? window.AxlxSearchStamp.read() : null;
        if (st && st.cid && Date.now() - Number(st.at || 0) < 3 * 60 * 60 * 1000) return true;
      } catch (_) {}

      // ② 結果の上に出ている「効いている条件」の文字（畳まれた欄の値より確か）
      //    例: 「家賃 ～10.5万」「徒歩15分」「2LDK-3LDK」「更新1日内」「築20年以内」「〇〇区」
      try {
        var _top = _head.slice(0, 2500);
        var _cond = 0;
        if (/(家賃|賃料)\s*[:：]?\s*[^/\n]{0,14}(万|円|下限なし|上限なし)/.test(_top)) _cond++;
        if (/徒歩\s*[0-9]{1,3}\s*分/.test(_top)) _cond++;
        if (/[0-9SLDK]+\s*[-〜~]\s*[0-9SLDK]+/.test(_top)) _cond++;
        if (/更新\s*[0-9]{1,3}\s*日以内/.test(_top)) _cond++;
        if (/築\s*[0-9]{1,3}\s*年(以内|未満)/.test(_top)) _cond++;
        if (_cond >= 2) return true;
      } catch (_) {}

      // ③ フォームに条件が入っていれば「条件つきの検索」の結果
      var formOk = 0;
      if (document.querySelector('select[name="rental_cost2"]')) {
        var r2 = document.querySelector('select[name="rental_cost2"]');
        if (r2 && r2.value && r2.value !== "-1") formOk++;
      }
      var checkedWard = document.querySelectorAll('input[name="city_code[]"]:checked').length;
      var checkedSt = document.querySelectorAll('input[name="station_id[]"]:checked').length;
      if (checkedWard || checkedSt) formOk++;
      if (formOk > 0) return true;
      return false;
    } catch (_) { return false; }
  }
  /**
   * ★ 2.8.277 竹内さん「前客の駅外すようにちゃんと確認できないのか／画面を見て確認、問題あれば外す」
   *   統括Pro「外し確認の正本は結果ページの『効いている条件』の文字＋棟戸数」
   *
   *   リアプロのフォームには選んだ駅の一覧が出ない（写真で確認）。結果ページの上の文字が
   *   **実際に何で検索されたか**の証拠。検索を押した時の希望（page-script が sessionStorage に残す）と照らす。
   *     ・ok／unknown … そのまま
   *     ・mismatch（前客の家賃・徒歩などが残る）／full（全件）… 点検に差を残し、枠に警告を出す
   *   ⚠ 止める（物件を送らない）のは旗 `axlx_result_verify_enforce=1` の時だけ。
   *     見出しの実物の形を点検（dl:result_verify）で確かめてから既定にする（誤検知でお客さんを飛ばさない）。
   */
  var _rvDone = {};
  var _rvTries = {};
  /**
   * ★ 2.8.278 竹内さん「外せていなければやり直す」→ 既定を「止めてやり直す」に変えた（旗 "0" で切る）。
   *   ただし**その客の検索だと番号で確かめられた時だけ**（番号が取れない時は警告だけ・誤って別の客を止めない）。
   *   見出しから読めない（unknown）は止めない。止めるのは「読めて・希望と違う／全件」の時だけ。
   */
  function _resultVerifyEnforce(r) {
    try {
      if (localStorage.getItem("axlx_result_verify_enforce") === "0") return false;
    } catch (_) {}
    return !!(r && r.cidOk);
  }
  /** 資料を取らずに止め、完了合図に印を付けて返す（background が1回だけ入れ直す・ITANDI の guard_stopped と同じ道） */
  function _resultVerifyReport(r) {
    try {
      if (!r || r.reported) return;
      r.reported = true;
      var RV = (typeof self !== "undefined" ? self : window).AxlxResultVerify;
      var why = r.verdict === "full" ? "全件（" + (r.count ? r.count.b : "?") + "棟）＝条件が効いていない" : (r.diffs || []).slice(0, 3).join("／");
      try { _liveDlStep("result_verify_stop", why.slice(0, 80), r.expectCid); } catch (_) {}
      chrome.runtime.sendMessage({
        type: "axlx-batch-customer-done",
        customerId: r.expectCid || null,
        propertyCount: null,
        audit: { result_mismatch: { verdict: r.verdict, why: why, brief: RV && RV.brief ? RV.brief(r) : "" } },
      }, function () { void chrome.runtime.lastError; });
    } catch (_) {}
  }
  function _resultVerifyOnce() {
    try {
      var RV = (typeof self !== "undefined" ? self : window).AxlxResultVerify;
      if (!RV) return null;
      var raw = null;
      try { raw = JSON.parse(sessionStorage.getItem("axlx_result_expect") || "null"); } catch (_) { raw = null; }
      if (!raw || !raw.at || Date.now() - Number(raw.at) > 20 * 60 * 1000) return null;
      var cid = null;
      try { cid = _pickCustomerIdForAuto(); } catch (_) { cid = null; }
      if (cid && raw.cid && String(cid) !== String(raw.cid)) return null;
      var key = String(raw.at);
      if (_rvDone[key]) return _rvDone[key];
      var r = RV.verify(_bodyHeadText(3000), raw);
      r.cidOk = !!(cid && raw.cid && String(cid) === String(raw.cid));
      r.expectCid = r.cidOk ? String(raw.cid) : null;
      // 見出しがまだ描かれていない時は少し待って見直す（4回まで）
      _rvTries[key] = (_rvTries[key] || 0) + 1;
      if (r.verdict === "unknown" && !r.count && _rvTries[key] < 4) return null;
      _rvDone[key] = r;
      try { _liveDlStep("result_verify", RV.brief(r)); } catch (_) {}
      if (r.verdict === "mismatch" || r.verdict === "full") {
        var why = r.verdict === "full" ? "全件（" + (r.count ? r.count.b : "?") + "棟）＝条件が効いていない" : r.diffs.slice(0, 2).join("／");
        try { _liveDlStep("result_verify_diff", why); } catch (_) {}
        try { _nudge("⚠ 検索結果の条件が希望と違います（" + why.slice(0, 40) + "）" + (_resultVerifyEnforce(r) ? "→送らず、前の条件を外して入れ直します" : "")); } catch (_) {}
      }
      return r;
    } catch (_) { return null; }
  }
  /**
   * 2026-11-11 v2.7.2 竹内さん「並べ替えした後物件選択するところでとまってしまった」
   *
   * 2026-11-14 竹内さん「出来なくても止まらずにそのまま動かすようにする」→ **方針を変えた**。
   *   ⚠ 旧は「条件が読めない → 自動では押しません」で**止めていた**（全物件を送らないための安全弁）。
   *     だが現場では **止まる＝物件が1件も出ない** の方が困る（竹内さんの判断）。
   *   → **警告を出して続行**する。止めるのは「本当に危ない時」（統括が unsafe・スタッフモード・停止ボタン）だけ。
   *     ⚠ 黙って続けない: 点検に残し、画面にも警告を出す（後から「なぜ並びが違うか」を追える）。
   */
  function _blockedAfterSortNote() {
    _setStatusNowNext("並べ替えの後に条件が読めない（このまま続けます）", "物件送付を続ける");
    var box = document.getElementById("axlx-blocked-note");
    if (box) { box.style.display = "block"; return; }
    var bar = document.getElementById("axlx-bar");
    if (!bar) return;
    box = document.createElement("div");
    box.id = "axlx-blocked-note";
    box.style.cssText = "margin-top:6px;font-size:10px;line-height:1.5;background:rgba(0,0,0,0.25);border:1px dashed rgba(255,255,255,0.5);border-radius:8px;padding:6px 8px;color:#fff;";
    box.innerHTML = [
      '<div>並べ替えの後、検索の条件が画面から読めませんでした（<b>止めずに続けます</b>）。</div>',
      '<div style="margin-top:4px;opacity:.9">左の条件（家賃・間取り・徒歩など）が入っているか、念のため見てください。</div>',
      '<div style="display:flex;gap:6px;margin-top:6px">',
      '  <button id="axlx-blocked-retry" style="flex:1;padding:5px 6px;background:#1976d2;border:none;border-radius:6px;color:#fff;font-size:11px;font-weight:700;cursor:pointer;">もう一度ためす</button>',
      "</div>",
    ].join("");
    bar.appendChild(box);
    var rb = document.getElementById("axlx-blocked-retry");
    if (rb) rb.addEventListener("click", function () {
      box.style.display = "none";
      _adSortBlocked = false;
      _adSortDone = false;
      _adSortChecking = false;
      try { window.__axlxAdSortPending = null; } catch (_) {}
      try { _maybeAutoPressOnLoad(); } catch (_) {}
    });
  }
  // 起動時に「AD順へ移った印」を読む（読み込み直しても分かるように）
  try {
    chrome.storage.session.get(["axlx_ad_sort_pending"], function (r) {
      var v = r && r.axlx_ad_sort_pending;
      if (v && Date.now() - Number(v.at || 0) < 60000) window.__axlxAdSortPending = v;
    });
  } catch (_) {}

  /**
   * 2026-11-11 竹内さん「検索して決定おしたら検索結果の部分で一息つくなど。人間のように区切って一息つく部分。
   *   ずっとひたすら動き続けたら人間らしくない。一瞬の一息が重要となる」
   *
   *   検索結果が出た直後に、人が**一覧を見渡す間**を必ず取る（押し始めるまでの間）。
   *   ・ふつう 2.5〜6秒（対数正規・中央値3.5秒）… 上から下まで目で追う
   *   ・25% で長く見る（+2〜5秒）… 気になる物件を少し見る
   *   ・8% でかなり長い（+6〜12秒）… 「お、いいのがある」と手が止まる
   *   ・件数が多いほど少し長い（20件超で+0.5〜2秒）
   *   枠には「👀 検索結果を見ています（あとN秒）」と出す（黙って止まらない）。
   */
  function _resultsLookMs(n) {
    var H = (typeof self !== "undefined" ? self : window).AxlxHumanWait;
    var base = H && H.logNormalDelay ? H.logNormalDelay(3500, 0.35) : 3500;
    if (base < 2500) base = 2500;
    if (base > 6000) base = 6000;
    var r = Math.random();
    if (r < 0.08) base += 6000 + Math.floor(Math.random() * 6000);
    else if (r < 0.33) base += 2000 + Math.floor(Math.random() * 3000);
    if (n > 20) base += 500 + Math.floor(Math.random() * 1500);
    return Math.round(base);
  }
  /** 検索結果を見る間に入ってから押し始める（自動モードのときだけ） */
  function _startAutoPressAfterLook(n, opt) {
    var look = _resultsLookMs(n);
    console.log("[AXLX bulk-dl][auto] 検索結果を一覧で見る間 " + (look / 1000).toFixed(1) + "秒（" + n + "行）"
      + (opt && opt.continuePages ? "・次ページ続き" : ""));
    _tmark("results_look", Math.round(look) + "ms");
    _axlxWorkNote("👀 検索結果を見ています", Date.now() + look);
    var lookFrom = Date.now();
    setTimeout(function () {
      _axlxClearWorkNote();
      if (_newFillSince(lookFrom)) {
        console.warn("[AXLX bulk-dl][auto] 見ている間に次の入力が始まった → この一覧は押しません");
        _tmark("auto_pdf_load", "look_cancel_new_fill");
        // ★ 2.8.191: 印を外して再試行可能に（#1588 固着の本因）
        try { _autoPdfSig = ""; } catch (_) {}
        try { _sortCursorScheduled = false; } catch (_) {}
        return;
      }
      if (opt && opt.pendingSig) _autoPdfSig = opt.pendingSig;
      _pressSince = lookFrom;
      var r = autoPressPdfs(opt);
      if (!r || r.ok === false) {
        try { _autoPdfSig = ""; } catch (_) {}
        try { _sortCursorScheduled = false; } catch (_) {}
      }
    }, look);
  }

  // ── フローティングバー ────────────────────────────
  /**
   * ★ 2.8.213 竹内さん「今やっていることと次やることをわかりやすく／ボタンは物件送る以外いらない／名前は物件送る」:
   *   旧は全選択・一括DL・結合・自動押し・プレビュー・画像・キャッシュが並び、進捗が1行に潰れていた。
   *   → 「いま／つぎ」2段＋主ボタン「物件送る」だけ。止める・見た→次へは必要な時だけ出す。
   * ★ 2.8.217 竹内さん「誰を一括で／合計何件／次のお客さん／把握できているか」を表示:
   *   「把握」行を足し、一括中は客名・件数・次客をいま／つぎに載せる。
   */
  var _bulkGraspState = null;
  function ensureBar() {
    var existing = document.getElementById("axlx-bar");
    // ★ 2.8.213: 旧バー（いま／つぎ無し）は作り直す
    // ★ 2.8.217: 把握行が無い旧バーも作り直す
    if (existing && (!document.getElementById("axlx-next") || !document.getElementById("axlx-grasp"))) {
      try { existing.remove(); } catch (_) {}
      existing = null;
    }
    // ★ 2.8.261: 版表示が無い旧バーは作り直す（反映確認のため）
    if (existing && !document.getElementById("axlx-bar-ver")) {
      try { existing.remove(); } catch (_) {}
      existing = null;
    }
    if (existing) {
      try {
        var _ve0 = document.getElementById("axlx-bar-ver");
        var _mv0 = (chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest().version : "";
        if (_ve0 && _mv0) _ve0.textContent = "v" + _mv0;
      } catch (_) {}
      return;
    }
    var bar = document.createElement("div");
    bar.id = "axlx-bar";
    bar.style.cssText = [
      // ★ 2.8.260: z-index を float-wrap(…645) より上(…647)に。右ドックに隠れない。
      "position:fixed;top:50%;right:12px;transform:translateY(-50%);z-index:2147483647;",
      "background:#0f172a;",
      "color:#f8fafc;border-radius:16px;padding:14px 16px;",
      "font-size:13px;font-weight:600;",
      "box-shadow:0 8px 28px rgba(15,23,42,0.45);",
      "border:1px solid rgba(148,163,184,0.25);",
      "display:none;flex-direction:column;gap:10px;min-width:240px;max-width:300px;",
      "font-family:'Segoe UI','Hiragino Sans','Noto Sans JP',sans-serif;",
    ].join("");
    bar.innerHTML = [
      '<div id="axlx-drag-handle" style="display:flex;align-items:center;justify-content:space-between;cursor:grab;padding:0 0 2px;user-select:none;" title="ドラッグで移動">',
      '  <span style="font-size:11px;letter-spacing:0.08em;color:#93c5fd;font-weight:800;">AIXLINX <span id="axlx-bar-ver" style="opacity:0.7;font-weight:700;"></span></span>',
      '  <span style="font-size:10px;opacity:0.45;letter-spacing:2px;">⠿</span>',
      "</div>",
      '<div style="background:rgba(15,23,42,0.35);border:1px solid rgba(148,163,184,0.2);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;">',
      '  <div>',
      '    <div style="font-size:10px;font-weight:700;color:#38bdf8;letter-spacing:0.06em;margin-bottom:3px;">いま</div>',
      '    <div id="axlx-count" style="font-size:13px;font-weight:700;line-height:1.45;color:#f8fafc;">待機中</div>',
      "  </div>",
      '  <div style="height:1px;background:rgba(148,163,184,0.2);"></div>',
      '  <div>',
      '    <div style="font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:0.06em;margin-bottom:3px;">つぎ</div>',
      '    <div id="axlx-next" style="font-size:12px;font-weight:600;line-height:1.45;color:#cbd5e1;">一覧を待ちます</div>',
      "  </div>",
      '  <div style="height:1px;background:rgba(148,163,184,0.2);"></div>',
      '  <div>',
      '    <div style="font-size:10px;font-weight:700;color:#a78bfa;letter-spacing:0.06em;margin-bottom:3px;">把握</div>',
      '    <div id="axlx-grasp" style="font-size:11px;font-weight:600;line-height:1.45;color:#c4b5fd;">一括の客をまだ把握していない</div>',
      "  </div>",
      "</div>",
      // 次回の自動便（小さめ・補助）
      '<div id="axlx-autorun-note" style="font-size:10px;font-weight:500;line-height:1.45;color:#94a3b8;white-space:normal;"></div>',
      '<button id="axlx-line-btn" style="width:100%;padding:12px 14px;background:#06c755;border:none;border-radius:12px;color:white;font-size:15px;font-weight:800;cursor:pointer;letter-spacing:0.04em;" title="選んだ物件を送ります">物件送る</button>',
      // 自動中だけ出す（普段は隠す）
      '<button id="axlx-autopdf-stop-btn" style="width:100%;padding:8px 10px;background:transparent;border:1px solid rgba(248,113,113,0.55);border-radius:10px;color:#fecaca;font-size:12px;font-weight:700;cursor:pointer;display:none;" title="自動を止める（いまの1件が終わってから）">⏹ 自動を止める</button>',
      // ★ 2.8.275 いつでも押せる: 止めて、一括・ロック・入力中を全部戻し、このタブを読み直して最初の状態にする
      '<button id="axlx-reset-stop-btn" style="width:100%;padding:8px 10px;background:rgba(220,38,38,0.18);border:1px solid rgba(248,113,113,0.8);border-radius:10px;color:#fecaca;font-size:12px;font-weight:800;cursor:pointer;" title="いま動いている自動をその場で止めて、全部リセットします（このページを読み直します）">⏹ 止めてリセット</button>',
      // 資料確認中だけ出す
      '<button id="axlx-look-next-btn" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.08);border:1px dashed rgba(255,255,255,0.35);border-radius:10px;color:#e2e8f0;font-size:12px;font-weight:700;cursor:pointer;display:none;" title="資料に目を通し終えたら押す（押さなくても自動で次へ）">見た → 次へ</button>',
      '<div id="axlx-cache-out" style="display:none;"></div>',
    ].join("");
    document.body.appendChild(bar);
    // ★ 2.8.261: 枠に拡張版を出し「反映されたか」を目で確認できるようにする
    try {
      var _verEl = document.getElementById("axlx-bar-ver");
      var _mv = (chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest().version : "";
      if (_verEl) _verEl.textContent = _mv ? ("v" + _mv) : "";
      try { _liveDlStep("bulk_alive", "v" + String(_mv || "?") + " estate_bar"); } catch (_) {}
    } catch (_) {}
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
        bar.removeAttribute("data-axlx-docked"); // v2.5.74: スタッフが動かした位置は自動で動かさない
        try { bar.setAttribute("data-axlx-user-drag", "1"); } catch (_) {}
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
    // ★ 2.8.213: 主ボタンは「物件送る」のみ。自動停止・見た→次へは必要時だけ。
    var lineBtn = document.getElementById("axlx-line-btn");
    if (lineBtn) lineBtn.addEventListener("click", function () {
      if (_forwardTimer) { clearTimeout(_forwardTimer); _forwardTimer = null; }
      getCustomerFromPopup(function (customerName, customerConditions, customerId) {
        mergePdfs(true, customerName, customerConditions, customerId);
      });
    });
    var stopBtn = document.getElementById("axlx-autopdf-stop-btn");
    if (stopBtn) stopBtn.addEventListener("click", function () {
      stopAutoPdfs();
      this.style.display = "none";
      try { _paintPdfProgress(); } catch (_) {}
    });
    var resetBtn = document.getElementById("axlx-reset-stop-btn");
    if (resetBtn) resetBtn.addEventListener("click", function () {
      try { _stopAndReset("button"); } catch (_) { try { location.reload(); } catch (__) {} }
    });
    var lookBtn = document.getElementById("axlx-look-next-btn");
    if (lookBtn) lookBtn.addEventListener("click", function () {
      if (_lookWait && _lookWait.skip) _lookWait.skip("skip");
    });
  }

  /** ★ 2.8.213: 「つぎ」行の既定文（いまの状態から推測） */
  function _statusNextHint(nowText) {
    try {
      if (_autoPdfRun && !_autoPdfRun.stopped) {
        if (_pdfSending) return "送り終わり → 資料を確認";
        if (_pdfBusy) return "確認のあと次の物件へ";
        return "次の物件を自動で送る";
      }
      if (_pdfSending) return "送り終わり → 資料を確認";
      if (_pdfBusy || (_lookWait && _lookWait.timer)) return "次の物件へ進む";
      if (/並べ替|ソート|AD/i.test(String(nowText || ""))) return "並べ替えのあと物件を送る";
      if (/検索結果を見て|条件を入れ|検索/i.test(String(nowText || ""))) return "一覧が出たら並べ替え → 物件送る";
      var checked = tracked.filter(function (t) { return t && t.cb && t.cb.checked; }).length;
      var done = Object.keys(_onePdfSent || {}).length;
      if (checked > 0) return "「物件送る」で送付（" + checked + "件）";
      if (done > 0) return "続きの物件を選ぶ／自動で送る";
      if (tracked.length > 0) return "自動で送るか、「物件送る」";
      return "一覧を待ちます";
    } catch (_) {
      return "続きの作業へ";
    }
  }

  /** ★ 2.8.213: いま／つぎを同時に書く（旧 axlx-count 互換） */
  function _setStatusNowNext(nowText, nextText) {
    var nowEl = document.getElementById("axlx-count");
    var nextEl = document.getElementById("axlx-next");
    if (nowEl) nowEl.textContent = nowText == null ? "" : String(nowText);
    if (nextEl) {
      var n = nextText == null || nextText === "" ? _statusNextHint(nowText) : String(nextText);
      nextEl.textContent = n;
    }
  }

  /**
   * ★ 2.8.227: page から「いまの行動」（外している最中／入れ最中）を受けて枠へ反映
   * ★ 2.8.228: task_now（間取外:2LDK 等）も枠へ
   * ★ 2.8.229: axlx-task-grasped（検索の search_grasped と同型・次タスク移行のAPI把握）
   */
  window.addEventListener("message", function (e) {
    try {
      if (!e.data) return;
      if (!_bulkGraspState || !(Number(_bulkGraspState.total) > 0)) {
        if (e.data.from === "axlx-task-grasped" && e.data.confirmed) {
          try {
            sessionStorage.setItem("axlx_task_grasped_sync", JSON.stringify({
              at: e.data.ts || Date.now(),
              phase: e.data.phase || "",
              why: e.data.why || "",
              confirmed: true,
              playbookOk: !!e.data.playbookOk,
              clearMethods: e.data.clearMethods || [],
            }));
          } catch (_) {}
          try {
            if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.session) {
              chrome.storage.session.set({
                axlx_task_grasped: {
                  at: e.data.ts || Date.now(),
                  phase: e.data.phase || "",
                  why: e.data.why || "",
                  confirmed: true,
                  playbookOk: !!e.data.playbookOk,
                  clearMethods: e.data.clearMethods || [],
                },
              });
            }
          } catch (_) {}
          try { _liveDlStep("task_transition_grasp", String(e.data.phase || e.data.why || "ok").slice(0, 40)); } catch (_) {}
        }
        return;
      }
      if (e.data.from === "axlx-now-action") {
        _bulkGraspState.currentAction = String(e.data.currentAction || "").slice(0, 28);
        if (e.data.nextMove) {
          var nmA = String(e.data.nextMove).slice(0, 40);
          /** ★ 2.8.233: 検索未確認の並べ替えをパネルでも拒否 */
          if (/並べ替え|並び替え|AD→高/.test(nmA) && !_isSearchConfirmGrasp(_searchGraspedMem)) {
            nmA = "検索を押す";
            try { _liveDlStep("next_move_premature_block", "検索未確認→並べ替え拒否"); } catch (_) {}
          }
          /** ★ 2.8.234: 1ページのみなのに次ページを押す → 外すへ */
          try {
            var _pA = typeof _readPagerState === "function" ? _readPagerState() : null;
            if (/次ページ|次のページ|次頁/.test(nmA) && _pA && _pA.onlyOnePage) {
              nmA = "物件取得完了→外す";
              _liveDlStep("list_page_one_only", "パネル次=次ページ拒否・1ページのみ");
            }
          } catch (_) {}
          _bulkGraspState.nextMove = nmA;
        }
        _applyBulkGrasp(_bulkGraspState);
        return;
      }
      if (e.data.from === "axlx-task-grasp") {
        if (e.data.now) {
          _bulkGraspState.taskNow = String(e.data.now).slice(0, 28);
          _bulkGraspState.currentAction = String(e.data.now).slice(0, 28);
        }
        if (e.data.done) _bulkGraspState.lastDone = String(e.data.done).slice(0, 28);
        if (e.data.next) {
          var nmT = String(e.data.next).slice(0, 40);
          if (/並べ替え|並び替え|AD→高/.test(nmT) && !_isSearchConfirmGrasp(_searchGraspedMem)) {
            nmT = "検索を押す";
            try { _liveDlStep("next_move_premature_block", "検索未確認→並べ替え拒否"); } catch (_) {}
          }
          try {
            var _pT = typeof _readPagerState === "function" ? _readPagerState() : null;
            if (/次ページ|次のページ|次頁/.test(nmT) && _pT && _pT.onlyOnePage) {
              nmT = "物件取得完了→外す";
              _liveDlStep("list_page_one_only", "task次=次ページ拒否・1ページのみ");
            }
          } catch (_) {}
          _bulkGraspState.nextMove = nmT;
        }
        _applyBulkGrasp(_bulkGraspState);
        return;
      }
      if (e.data.from === "axlx-task-grasped") {
        if (e.data.currentAction) {
          _bulkGraspState.taskNow = String(e.data.currentAction).slice(0, 28);
          _bulkGraspState.currentAction = String(e.data.currentAction).slice(0, 28);
        }
        if (e.data.nextMove) {
          var nmG = String(e.data.nextMove).slice(0, 40);
          if (/並べ替え|並び替え|AD→高/.test(nmG) && !_isSearchConfirmGrasp(_searchGraspedMem)) {
            nmG = "検索を押す";
            try { _liveDlStep("next_move_premature_block", "検索未確認→並べ替え拒否"); } catch (_) {}
          }
          try {
            var _pG = typeof _readPagerState === "function" ? _readPagerState() : null;
            if (/次ページ|次のページ|次頁/.test(nmG) && _pG && _pG.onlyOnePage) {
              nmG = "物件取得完了→外す";
              _liveDlStep("list_page_one_only", "grasped次=次ページ拒否・1ページのみ");
            }
          } catch (_) {}
          _bulkGraspState.nextMove = nmG;
        }
        if (e.data.phase) _bulkGraspState.loopPhase = String(e.data.phase).slice(0, 20);
        if (e.data.clearMethods) _bulkGraspState.clearMethods = e.data.clearMethods;
        _applyBulkGrasp(_bulkGraspState);
        try {
          sessionStorage.setItem("axlx_task_grasped_sync", JSON.stringify({
            at: e.data.ts || Date.now(),
            phase: e.data.phase || "",
            why: e.data.why || "",
            confirmed: !!e.data.confirmed,
            playbookOk: !!e.data.playbookOk,
            clearMethods: e.data.clearMethods || [],
          }));
        } catch (_) {}
        try { _liveDlStep("task_transition_grasp", String(e.data.phase || "ok").slice(0, 40)); } catch (_) {}
      }
    } catch (_) {}
  });

  /** ★ 2.8.217: 一括把握の配信を枠へ反映 */
  function _applyBulkGrasp(g) {
    _bulkGraspState = g && Number(g.total) > 0 ? g : null;
    ensureBar();
    try {
      var bar0 = document.getElementById("axlx-bar");
      if (bar0 && _bulkGraspState) bar0.style.display = "flex";
    } catch (_) {}
    /** ★ 2.8.219: MAIN（page-script）へ次客・次の動きを渡す */
    try {
      window.postMessage({
        from: "axlx-bulk-next",
        nextName: _bulkGraspState ? String(_bulkGraspState.nextName || "") : "",
        currentName: _bulkGraspState ? String(_bulkGraspState.currentName || "") : "",
        nextMove: _bulkGraspState ? String(_bulkGraspState.nextMove || _bulkGraspState.waitingFor || "") : "",
      }, "*");
    } catch (_) {}
    var graspEl = document.getElementById("axlx-grasp");
    var lines = null;
    try {
      if (window.AxlxBulkPanelGrasp && window.AxlxBulkPanelGrasp.formatBulkPanelGrasp) {
        lines = window.AxlxBulkPanelGrasp.formatBulkPanelGrasp(_bulkGraspState);
      }
    } catch (_) { lines = null; }
    if (!lines && _bulkGraspState) {
      var total = Math.floor(Number(_bulkGraspState.total) || 0);
      var index = Math.max(0, Math.floor(Number(_bulkGraspState.index) || 0));
      var cur = String(_bulkGraspState.currentName || "").trim();
      var nxt = String(_bulkGraspState.nextName || "").trim();
      if (cur && !/さん$/.test(cur)) cur += "さん";
      if (nxt && !/さん$/.test(nxt)) nxt += "さん";
      lines = {
        now: index <= 0 ? ("一括" + total + "人を把握（開始前）") : (cur ? cur + "を検索中（" + index + "/" + total + "）" : ("一括 " + index + "/" + total)),
        next: nxt ? ("次は " + nxt) : (index >= total && index > 0 ? "一括の最後（次の客なし）" : "次の客を把握中…"),
        grasp: "一括" + total + "人" + (cur || index === 0 ? " ✓把握" : " ✗未把握")
          + (cur ? "／いま" + cur.replace(/さん$/, "") : "")
          + (nxt ? "／次" + nxt.replace(/さん$/, "") : ""),
        graspOk: !!(cur || index === 0),
      };
    }
    if (graspEl) {
      graspEl.textContent = lines ? lines.grasp : "一括の客をまだ把握していない";
      graspEl.style.color = lines && lines.graspOk ? "#c4b5fd" : "#fca5a5";
    }
    if (lines) {
      _setStatusNowNext(lines.now, lines.next);
    } else {
      try { _paintPdfProgress(); } catch (_) {}
    }
  }

  // v2.5.60 竹内「印刷用PDF おしたら転送されれば理想」: スタッフが押して開いた資料が手元に残ったら、その行にチェックを入れて印を付ける
  //   （送る時は手元から読む＝リアプロに届くのは押した1回だけ・background の axlx-pdf-captured）。拡張はリンクを押さない
  // 2026-11-10 竹内さん「リアプロの一気に選択されてしまうのでなくて1つ1つ行っていく形で。チェックボックスはこの印刷用PDFのところの部分のことだから
  //   印刷用PDF押したら、チェックボックス押して物件検索がされるように、印刷用PDFで出た資料をそのまま売り上げ番長におくられるようにすれば
  //   1つずつおこなったのとおなじかたちにできるようになる」:
  //   押した1件だけをチェックし（他の行は外す）、**その1件をその場で売上番長へ送る**（20秒まとめて待たない）。
  //   押す順＝送る順。押した順に1件ずつ流す（前の1件が終わってから次を送る＝人の1件ずつの形）。
  var _onePdfSent = {};          // 送り終わった URL（同じ行を二度送らない）
  var _pdfBusy = false;          // いま1件を送信中・確認中（この間は次の押下を受け付けない＝1件ずつ）
  /** ★ 2026-11-22: 通常の手押しで busy 中に押した分（捨てると AIX 未反映に見える） */
  var _pdfQueue = [];
  var _pdfSending = null;        // いま送っている URL
  function _onePdfBadge(item, state, extra) {
    var old = item.btn.parentNode && item.btn.parentNode.querySelector(".axlx-pressed-badge");
    if (old) old.remove();
    var b = document.createElement("span");
    b.className = "axlx-pressed-badge";
    var style = state === "sent" ? "background:#e3f2fd;color:#0d47a1;"
      : state === "look" ? "background:#fff8e1;color:#ef6c00;"
      : state === "wait" ? "background:#ede7f6;color:#4527a0;"
      : state === "sending" ? "background:#e1f5fe;color:#01579b;"
      : state === "error" ? "background:#ffebee;color:#c62828;"
      : extra ? "background:#e8f5e9;color:#2e7d32;" : "background:#fff3e0;color:#e65100;";
    b.style.cssText = "margin-left:4px;font-size:10px;font-weight:700;padding:1px 5px;border-radius:6px;vertical-align:middle;" + style;
    b.textContent = state === "sent" ? "📤 送信済み"
      : state === "look" ? "👀 確認中…"
      : state === "wait" ? "⏳ 送る順番待ち"
      : state === "sending" ? "📤 送信中…"
      : state === "error" ? "⚠ 送れませんでした"
      : extra ? "✅ 受け取り済み" : "☑ 送る物に入れました";
    b.title = state === "sent" ? "この資料は売上番長へ送りました"
      : state === "look" ? "送りました。資料に目を通してから次の物件へ進みます"
      : state === "wait" ? "押した順に1件ずつ送ります（前の1件が終わってから）"
      : state === "sending" ? "いま売上番長へ送っています"
      : state === "error" ? "もう一度押すと送り直します"
      : extra ? "押した資料を受け取りました。送る時はリアプロにもう一度取りに行きません" : "資料が手元に残らなかったので、送る時に取りに行きます";
    item.btn.parentNode.insertBefore(b, item.btn.nextSibling);
  }

  /**
   * 2026-11-10 竹内さん「一件ずつ確認するので一気に押すのではなくてひとつずつ押す形」:
   *   押した分を **溜めて自動で続けるのをやめた**。1回押したらその1件を送り、終わるまで次は受け付けない。
   *   送り終わったら「👀 確認中…」で資料に目を通す間 → 終わったら **押せる状態に戻る**（次は人が押す）。
   *
   * 旧の作りで詰まっていた原因（重要・これは残す）:
   *   ・組（url・説明文）を「画面でチェックが入っている行」から作っていた（buildSendItems）＋送る直前に他の行のチェックを外していた
   *     → 素早く2件押すと、後から押した行がチェックを奪い、先に押した1件が「組が作れない（no-item）」で落ちていた
   *   新: 組は **押した行そのもの** から作る（チェックに頼らない）・判定もその1件だけ。
   */
  function sendOnePdfNow(item) {
    if (!item || !item.btn || !item.btn.href) return;
    var url = item.btn.href;
    if (_onePdfSent[url]) return; // 送った行はもう送らない（押し直しても二重に送らない）
    // 1件ずつ: いま送信中・確認中なら受け付けない（溜めない）。人が「終わってから次」を守れる形にする
    if (_pdfBusy) {
      /**
       * ★ 2026-11-22 竹内さん「通常モードで物件おくってAIXツールに反映されないことがある」:
       *   旧: busy 中の2件目以降を捨てるだけ → 押したのに送られない＝「AIXに無い」に見える。
       * ★ 2026-11-22b 永成（えいせい）brain: 自動押し中も捨てると AIX 0件。待ち行列は手押し・自動とも使う。
       */
      _pdfQueue = _pdfQueue || [];
      if (_pdfQueue.length >= 12) {
        _nudge("⚠ 待ちが満杯です。少し待ってから押してください");
        _tmark("pdf_queue_full", String(url).slice(0, 40));
        return;
      }
      if (_pdfQueue.some(function (q) { return q && q.url === url; })) return;
      _pdfQueue.push({ item: item, url: url });
      _nudge("⏳ 送信待ち " + _pdfQueue.length + "件（終わってから送ります）");
      _tmark("pdf_queued", _pdfQueue.length + ":" + String(url).slice(0, 40));
      return;
    }
    _pdfBusy = true;
    _pdfSending = url;
    _paintPdfProgress();
    /**
     * ★ 2026-11-19 竹内さん「AIXモードで検索している際、物件ダウンロードする際にチェックボックスにチェックをつけてしまっている。
     *   印刷用PDFを押す部分なのに、なぜかチェックボックスにチェックをつける昔のやり方が起きてしまっている」:
     *   原因: 自動の押下（_pressPrintPdf）も手で押した時と同じ sendOnePdfNow を通り、ここで無条件に _selectOnly（item.cb.checked = true を
     *   カーソル無しで直接代入）が走っていた。押した直後に行頭のチェックが勝手に入って見えていた。
     *   → 自動モード（拡張が自分で印刷用PDFを押している間・または自動の印が立っている間）はチェックを触らない。
     *   1件の送信はチェックに依存しない（_sendOnePdf は押したリンクから組を作る）ので、送る物・記録・判定は変わらない。
     *   手で押した時（自動でない時）の 2026-11-10 の形（押した1件だけチェック）はそのまま残す。
     */
    if (!_axlxNoRowCheck()) {
      // 送る1件だけを選ぶ（画面を見ている人に「いま何を送っているか」が分かる・他の行は触らない）
      _selectOnly(item);
    }
    _onePdfBadge(item, "sending");
    _sendOnePdf(item, url, function (ok, reason, tm) {
      _pdfSending = null;
      if (tm) {
        try {
          _liveDlStep("one_send_ms", "判定" + (tm.judgeMs / 1000).toFixed(1) + "s 送り" + (tm.sendMs / 1000).toFixed(1) + "s 手元" + (tm.fromCache == null ? "?" : tm.fromCache) + (ok ? "" : " 失敗"));
        } catch (_) {}
      }
      if (ok) {
        _onePdfSent[url] = true;
        _onePdfBadge(item, "sent");
        _tmark("sent", "pdf 1件");
      } else {
        _onePdfBadge(item, "error");
        console.warn("[AXLX bulk-dl] 1件送信（印刷用PDF）を送れませんでした:", reason, String(url).slice(0, 80));
        // ★ 2026-11-22: 失敗理由を画面に出す（黙って「AIXに無い」に見えないように）
        var why = String(reason || "");
        if (why === "brain-skip") _nudge("⚠ ブレインが外す判定 → AIXへ送っていません");
        else if (why === "no-customer") _nudge("⚠ お客様未選択 → AIXへ送れません");
        else if (why === "guard") _nudge("⚠ 確かめが要ります（送る前の関所）");
        else if (why) _nudge("⚠ 送れませんでした: " + why.slice(0, 28));
        _tmark("pdf_send_fail", why.slice(0, 40));
      }
      _paintPdfProgress();
      if (!ok) { _idleAfterOne(item); return; } // 送れなかった1件は見る物が無い → すぐ押せる状態に戻る
      // 送れた1件は「スタッフが資料に目を通す間」→ 終わったら押せる状態に戻る（次は人が押す）
      _lookAtDocThenGo(item, function () { _idleAfterOne(item); });
    });
  }

  /** 1件終わったら押せる状態に戻す（次は人が押す・溜めない）／待ち行列があれば続けて送る */
  function _idleAfterOne(item) {
    _pdfBusy = false;
    if (_lookWait) { clearTimeout(_lookWait.timer); _lookWait = null; }
    var ln = document.getElementById("axlx-look-next-btn");
    if (ln) ln.style.display = "none";
    if (item && item.cb && item.cb.checked) { item.cb.checked = false; updateBar(); }
    _paintPdfProgress();
    // 送った行の札を「送信済み」に戻す（確認中の見た目を残さない）
    if (item && _onePdfSent[item.btn.href]) { try { _onePdfBadge(item, "sent"); } catch (_) {} }
    // ★ 2026-11-22: 通常手押しの待ち行列を1件ずつ消化（捨てない＝AIX未反映を防ぐ）
    try {
      while (_pdfQueue && _pdfQueue.length) {
        var next = _pdfQueue.shift();
        if (!next || !next.item || !next.url) continue;
        if (_onePdfSent[next.url]) continue;
        setTimeout(function () { try { sendOnePdfNow(next.item); } catch (_) {} }, 80);
        break;
      }
    } catch (_) {}
  }

  /** 短い知らせ（枠の「いま」に出す・数秒で戻す） */
  var _nudgeTimer = null;
  function _nudge(text) {
    _setStatusNowNext(text, null);
    if (_nudgeTimer) clearTimeout(_nudgeTimer);
    _nudgeTimer = setTimeout(function () { _nudgeTimer = null; _paintPdfProgress(); }, 3000);
  }

  /**
   * 送った1件を人が見る間（資料に目を通してから次を押す）。
   *   ・行を画面の真ん中に置く（資料を見る位置に戻す）
   *   ・中央値 3.5秒（1.8〜13秒に収める・5%ほどは長く見る＝7〜13秒）
   *   ・待っている間は札を「👀 確認中…」にして、人が「いま見ている」と分かる形にする
   *   ・「👀 見た → 次へ」を押せば待ちを打ち切って、すぐ次を押せる状態に戻る
   */
  var _lookWait = null;
  function _lookAtDocThenGo(item, goNext) {
    var H = (typeof self !== "undefined" ? self : window).AxlxHumanWait;
    // 2026-11-11 竹内さん「また時間はランダム性をちゃんと徹底する人間のうごきを」:
    //   長さの決まりは auto-run.js の lookAtDocMs 1か所（一括検索の background と同じ関数を使う＝2か所で別々に乱数を作らない）
    var base = 3500;
    try {
      if (self.AxlxAutoRun && self.AxlxAutoRun.lookAtDocMs) base = self.AxlxAutoRun.lookAtDocMs();
      else if (H && H.logNormalDelay) base = H.logNormalDelay(3500, 0.4);
    } catch (_) { base = 3500; }
    if (base < 1800) base = 1800;
    if (base > 13000) base = 13000;
    _humanScrollToEl(item.btn);
    _onePdfBadge(item, "look");
    _setStatusNowNext("資料を確認中…（" + Math.round(base / 1000) + "秒ほど）", "次の物件へ進む");
    // 2026-11-11: 枠にも「あと何秒」を出す（人が見て人間の動きだと分かる形）
    _axlxWorkNote("資料を確認中", Date.now() + base);
    _tmark("look_doc", Math.round(base) + "ms");
    var _lnBtn0 = document.getElementById("axlx-look-next-btn");
    if (_lnBtn0) _lnBtn0.style.display = "block";
    var finished = false;
    var finish = function (why) {
      if (finished) return;
      finished = true;
      if (_lookWait) { clearTimeout(_lookWait.timer); _lookWait = null; }
      _axlxClearWorkNote(); // 2026-11-11: 資料を見る間の表示を消す
      var _lnBtn = document.getElementById("axlx-look-next-btn");
      if (_lnBtn) _lnBtn.style.display = "none";
      if (why === "skip") { _tmark("look_skip", "人が先へ"); console.log("[AXLX bulk-dl] 資料の確認を打ち切って次の物件へ進みます"); }
      else console.log("[AXLX bulk-dl] 資料に目を通す間が終わり → 次の1件を押せる状態に戻ります（" + Math.round(base / 1000) + "秒）");
      _nudge("✅ 送りました。次の物件を押してください");
      goNext();
    };
    _lookWait = { timer: setTimeout(function () { _lookWait = null; finish("time"); }, base), skip: finish };
  }

  /** 自動（AIX／スタッフ選んだ客）の間は行のチェックを付けない（印刷用PDFを押すだけ）。手で押す時は今まで通り */
  function _axlxNoRowCheck() {
    try { return !!(_autoPdfRun || _autoModeOn); } catch (_) { return false; }
  }

  /** 画面でその1行だけチェックを入れる（他の行のチェックは外す） */
  function _selectOnly(item) {
    tracked.forEach(function (t) { if (t.cb && t.cb !== item.cb && t.cb.checked) t.cb.checked = false; });
    if (item.cb && item.cb.isConnected && !item.cb.checked) item.cb.checked = true;
    updateBar();
  }

  // ─────────── 2026-11-10 自動モード: 印刷用PDFを拡張が1件ずつ押していく ───────────
  // 竹内さん「手動でできた。自動でおこなっちく（自動で行ってほしい）」:
  //   手動の1件ずつの流れ（押す → 送る → 👀 資料を見る → 次）を、**自動モードの時だけ拡張が押して回す**。
  //   人がやる事と同じ順番・同じ間（カーソルで行まで動く → 押す → 送る → 資料を見る間 → 次）。
  //   ・対象は一覧の行（tracked）。送付済み・前回の検索より古い行は送らない（今までの選別と同じ物差し）
  //   ・1件ごとに 送ったら「👀 確認中…」で資料を見る間を置いてから次へ
  //   ・止める: 右下の枠の「⏹ 自動を止める」。スタッフモード・自動モードでない時は動かない
  var _autoPdfRun = null;   // { total, done, index, stopped, startedAt }
  /**
   * ★ 2026-11-19 (2.8.127) 竹内さん「次のお客さんに移る場面のところで固まってしまった」:
   *   完了合図（axlx-batch-customer-done）のお客さん番号を、終わる時に chrome.storage の current_customer_id から読んでいた。
   *   押している間（10分以上）に画面側（AIXLINX の枠・読み直し）でお客さんが選び直されると番号が変わり、
   *   background は番号が一致する待ちしか解かないため、送り終わっても20〜45分次へ進まなかった。
   *   → 押し始めた時のお客さん番号を控え、終わりの合図は**その番号**で送る（読み直しをまたぐ時は session の印からも戻す）。
   */
  var _autoRunCid = null;
  function _doneCidFrom(r) {
    try { if (_autoRunCid) return _autoRunCid; } catch (_) {}
    return (r && r.current_customer_id) || null;
  }
  var _pressSince = 0;      // 見る間を始めた時刻（autoPressPdfs が受け取る）
  var _pressRunSince = 0;   // この回の押し始め（_startAutoPressRun が startedAt にする）
  /**
   * @param {{ continuePages?: boolean }} [opt]
   *   continuePages=true … 次ページ再開。ページカウンタをリセットしない。
   */
  function autoPressPdfs(opt) {
    _pressRunSince = _pressSince || Date.now();
    _pressSince = 0;
    if (!_autoModeOn) {
      _nudge("自動／AIX／スタッフ（選んだ客）の時だけ自動で押せます");
      return { ok: false, reason: "not-auto" };
    }
    /**
     * ★ 2026-11-16 竹内さん「2の画面まではいくけど3にいかないことが多い」:
     *   ⚠ 旧は次ページ再開のたびに `_autoPdfPage=1` / `_autoNextPageTries=0` に戻していた。
     *     → 内部ではいつも「1ページ目」扱い／累計送信も消える／進行が壊れる。
     *   → **新しい検索の開始時だけ**リセット。次ページ続きは `continuePages`。
     */
    if (!(opt && opt.continuePages)) {
      try { _autoNextPageTries = 0; _autoPdfPage = 1; _autoPdfTotalSent = 0; } catch (_) {}
    }
    // ★ 2026-11-22: スタッフでも選んだ客の自動押しは開く（_autoModeOn が関所）
    if (_autoPdfRun) { _nudge("いま自動で送っています（⏹ で止められます）"); return { ok: false, reason: "running" }; }
    /**
     * 2026-11-12 竹内さん「自動で検索したら検索も条件入れる前にいま出ている物件のダウンロードを始めてしまう」:
     *   自動入力の最中（条件を入れて検索を押す前）は、画面に残っている前の一覧しかない。
     *   ここで押すと**別のお客様・条件違いの一覧**を送ってしまう → 押さない。
     */
    if (_isFillBusy() && !(Date.now() - _autofillStartedAt > _autofillStuckMs)) {
      _nudge("⏳ いま条件を入れています（検索の後で押します）");
      console.warn("[AXLX bulk-dl][auto] 条件の入力中なので押しません（前の一覧を送らないため）");
      _tmark("auto_pdf_start", "blocked_during_fill");
      return { ok: false, reason: "filling" };
    }
    /**
     * ★ 2026-11-22 竹内さん「駅の選択中に並べ替えへ行って止まる」:
     *   並べ替えは条件を全部入れて検索した**後**の一覧動作。駅・沿線・所在地モーダル中は禁止。
     */
    var _modalNow = _isCondModalOpen();
    if (_modalNow) {
      /**
       * ★ 2.8.193: 強制ではなく関所の再分類。
       *   allowModalReclassify / fromSortCursor + 並べ替え見出し＋行 → 本線で続行。
       *   保険 path=insurance も同じ再分類（止めないため）。
       */
      var _listOk = false;
      try {
        var _rowsOk = tracked.filter(function (t) { return t && t.btn && t.btn.isConnected; }).length > 0;
        _listOk = _hasSortHeadVisible() && _rowsOk
          && !!(opt && (opt.allowModalReclassify || opt.fromSortCursor || opt.sortPath === "reclassify" || opt.sortPath === "insurance"));
      } catch (_) {
        _listOk = !!(opt && opt.allowModalReclassify && _hasSortHeadVisible());
      }
      if (_listOk) {
        console.warn("[AXLX bulk-dl][auto] 条件判定=" + _modalNow + " → 関所で一覧再分類（本線・強制ではない）");
        try { _liveDlStep("sort_gate_reclassify", String(_modalNow).slice(0, 16) + ":" + String((opt && opt.sortPath) || "press")); } catch (_) {}
        _modalNow = null;
      } else {
        _nudge("⏳ 条件画面です（検索の後で並べ替え・送付します）");
        console.warn("[AXLX bulk-dl][auto] 条件モーダル中(" + _modalNow + ") → 並べ替え／送付しない");
        _tmark("auto_pdf_start", "blocked_cond_modal:" + _modalNow);
        _tmark("sort_blocked", "cond_modal:" + _modalNow);
        try { _liveDlStep("sort_blocked", "cond_modal:" + String(_modalNow).slice(0, 20)); } catch (_) {}
        return { ok: false, reason: "cond_modal" };
      }
    }
    if (_guideBlocksAuto("autoPressPdfs")) return { ok: false, reason: "guide" };
    if (_supBlocksAuto("autoPressPdfs")) return { ok: false, reason: "supervisor" };
    /**
     * 2026-11-10 竹内さん「ADの並びはちゃんと使えるようにする」:
     *   旧の一括を消した時に AD 高→低の並べ替えも一緒に落ちていた。押す前に戻す。
     *   ・AD 高い順（返金・広告費の高い部屋から見る）＝物件出しの今までの決まり
     *   ・自動便で「更新順」を指定している時（_AR().allowAdSort が false）は並べ替えない（午後の便は更新順のまま）
     *   ・並べ替えるとページが読み直されるので、その時は読み直した後にまた自動で押す（_maybeAutoPressOnLoad）
     */
    var _arOpts = _autoRunFor(_pickCustomerIdForAuto());
    var _allowAd = _AR() ? _AR().allowAdSort(_arOpts) : true;
    // 2026-11-11 v2.7.2: この画面ではもう並べ替えた（見直しのたびに何度も並べ替えない）
    if (_adSortDone) _allowAd = false;
    var _params = new URLSearchParams(location.search);
    /**
     * ★ 2026-11-22 竹内さん録画: 高→低の URL は `ad=odr_desc` の形もある（旧は key=ad&odr=desc だけ見ていた）。
     */
    var _isAdDesc = (_params.get("key") === "ad" && _params.get("odr") === "desc")
      || _params.get("ad") === "odr_desc"
      || /(?:^|[?&])ad=odr_desc(?:&|$)/.test(String(location.search || ""));
    /**
     * ★ 2026-11-22: AD並び替えの前に「検索を押した」把握（手順書×画面）。無いと並べ替えない。
     */
    function _beginAdSortLikeHuman() {
      /**
       * 2026-11-11／★ 2026-11-22 竹内さん（録画＋画像）:
       *   「並べ替えのところにマウスを置くとクリックせずに下に展開 → ADにマウスを置くと右の2つが出現 → 高→低へカーソルを移してクリック」
       *
       * ⚠ 旧バグ: 閉メニューに `a[href*="key=ad"]` が無いと並べ替え自体をスキップしていた。
       *   高→低のリンクは **AD にホバーした後だけ**出るので、予め探す前提は誤り。
       * → メニュー操作を**必ず試す**（リンクの有無で止めない）。
       */
      _liveDlStep("sort_menu", "start");
      /** ★ 2.8.185/186: 検索完了→並べ替えへ移る印（ライブで監査へ・batch待ちしない） */
      try { _liveDlStep("search_to_sort", "after_search_grasp"); } catch (_) {}
      /** ★ 2.8.226: ループ段=並べ替え／次の動きを page 側で把握（タスク一覧に sort が入る） */
      try { _requestLoopGrasp("sort", "sort_menu_start", false); } catch (_) {}
      console.log("[AXLX bulk-dl][auto] AD 高い順に並べ替えます（並べ替え→AD→高→低・URL直はしない）");
      // ★ 2.8.263: 「検索完了」は結果ページ表示後だけ。押下直後の文言にしない
      _nudge("🔀 検索結果ページ表示済 → AD 高い順に並べ替えます");
      try {
        chrome.storage.session.set({
          axlx_ad_sort_pending: {
            at: Date.now(),
            customerId: _pickCustomerIdForAuto() || null,
            from: location.href,
            sig: tracked.length + ":" + String(document.body ? document.body.textContent.length : 0),
          },
        });
      } catch (_) {}
      _autoPdfRunPending = function () {
        try { _rescanRows(); } catch (_) {}
        _startAutoPressRun();
      };
      _sortGenAtStart = _sortGen;
      /**
       * ★ 2.8.186: 並べ替え前に一覧×手順書を1回照合（止まっても list_flow 印が残る）。
       *   旧は並べ替え成功後だけ → 赤丸③で止まると list_flow=0。
       */
      _guideLikeListFlowGrasp("list_start", function () {
      _sortByAdLikeHuman(function (okSort) {
        var go = _autoPdfRunPending;
        _autoPdfRunPending = null;
        // 並べ替えの途中で条件入力が始まった／モーダルが開いた → 押さない
        if (_sortGen !== _sortGenAtStart || _isFillBusy() || _isCondModalLabelsOpen()) {
          console.warn("[AXLX bulk-dl][auto] 並べ替え後に条件画面へ戻った → 送付しない");
          _liveDlStep("sort_abort", "after_sort_cond");
          return;
        }
        if (!okSort) {
          /**
           * ★ 2.8.197 竹内さん「検索把握→並べ替えしてから物件取得」:
           *   旧は sort_no_head のまま PDF へ進み、並べ替えを飛ばしていた（#1595）。
           *   → 並べ替え見出しの再探索を1回入れてから、それでも駄目なら続行（物件は落とさない）。
           */
          var alreadyAd = false;
          try {
            var _pAd = new URLSearchParams(location.search || "");
            alreadyAd = (_pAd.get("key") === "ad" && _pAd.get("odr") === "desc")
              || _pAd.get("ad") === "odr_desc"
              || /(?:^|[?&])ad=odr_desc(?:&|$)/.test(String(location.search || ""));
          } catch (_) { alreadyAd = false; }
          if (!alreadyAd && typeof _findSortHeadEl === "function" && _findSortHeadEl()) {
            console.warn("[AXLX bulk-dl][auto] 並べ替え失敗だが見出しは見える → 1回だけ再試行してから取得");
            _liveDlStep("sort_retry_before_pdf", "head_visible");
            setTimeout(function () {
              if (_isFillBusy() || _isCondModalLabelsOpen()) {
                _liveDlStep("sort_failed", "continue_busy");
                _guideLikeListFlowGrasp("list_start", function (gr2) {
                  if (gr2 && gr2.ok === false && Array.isArray(gr2.miss) && gr2.miss.some(function (m) {
                    return /条件モーダル|画面行0/.test(String(m || ""));
                  })) {
                    _liveDlStep("list_flow_block", String(gr2.summary || "").slice(0, 50));
                    return;
                  }
                  if (typeof go === "function") go();
                });
                return;
              }
              _sortByAdLikeHuman(function (ok2) {
                if (ok2) _liveDlStep("sort_done", "hilo_retry");
                else {
                  console.warn("[AXLX bulk-dl][auto] 再試行も並べ替えできず → この並びのまま押します");
                  _nudge("⚠ 並べ替えできませんでした（この並びのまま続けます）");
                  _liveDlStep("sort_failed", "continue_after_retry");
                }
                _guideLikeListFlowGrasp("list_start", function (gr3) {
                  if (gr3 && gr3.ok === false && Array.isArray(gr3.miss) && gr3.miss.some(function (m) {
                    return /条件モーダル|画面行0/.test(String(m || ""));
                  })) {
                    _liveDlStep("list_flow_block", String(gr3.summary || "").slice(0, 50));
                    return;
                  }
                  if (typeof go === "function") go();
                });
              });
            }, 1600);
            return;
          }
          console.warn("[AXLX bulk-dl][auto] 並べ替えできず → **この並びのまま押します**（物件を落とさない）");
          _nudge("⚠ 並べ替えできませんでした（この並びのまま続けます）");
          _liveDlStep("sort_failed", "continue");
        } else {
          _liveDlStep("sort_done", "hilo");
          try { _requestLoopGrasp("list", "sort_done", true); } catch (_) {}
        }
        // AD後も手順書 list×画面照合してから押す（揃わなければ押さない＝駅選択中の誤送付を止める）
        _guideLikeListFlowGrasp("list_start", function (gr) {
          if (gr && gr.ok === false && Array.isArray(gr.miss) && gr.miss.some(function (m) {
            return /条件モーダル|画面行0/.test(String(m || ""));
          })) {
            console.warn("[AXLX bulk-dl][auto] 一覧照合 NG → 送付しない: " + (gr.summary || ""));
            _liveDlStep("list_flow_block", String(gr.summary || "").slice(0, 50));
            return;
          }
          if (typeof go === "function") go();
        });
      });
      }); // list_start 前照合のあと並べ替え
      return { ok: true, sorting: true, menu: true };
    }
    function _beginListPressNoSort() {
      // 並べ替えが要らない時は、一覧照合してから押し始める（モーダル中・行0は押さない）
      _guideLikeListFlowGrasp("list_start", function (gr) {
        if (gr && gr.ok === false && Array.isArray(gr.miss) && gr.miss.some(function (m) {
          return /条件モーダル|画面行0/.test(String(m || ""));
        })) {
          console.warn("[AXLX bulk-dl][auto] 一覧照合 NG → 送付しない: " + (gr.summary || ""));
          _liveDlStep("list_flow_block", String(gr.summary || "").slice(0, 50));
          return;
        }
        _startAutoPressRun();
      });
      return { ok: true, pending: true, list_grasp: true };
    }
    function _withSearchGraspThenAdOrPress() {
      var recent = function (o) {
        return !!(o && o.at && (Date.now() - Number(o.at) < 15 * 60 * 1000));
      };
      var rowNow = function () {
        try { return tracked.filter(function (t) { return t && t.btn && t.btn.isConnected; }).length; } catch (_) { return 0; }
      };
      var markGrasp = function (why, confirmed) {
        _searchGraspedMem = {
          at: Date.now(),
          why: String(why || "infer").slice(0, 40),
          confirmed: confirmed !== false,
          intent: confirmed === false,
        };
        try { chrome.storage.session.set({ axlx_search_grasped: _searchGraspedMem }); } catch (_) {}
        try { sessionStorage.setItem("axlx_search_grasped_sync", JSON.stringify(_searchGraspedMem)); } catch (_) {}
      };
      var finishGate = function (okGate, why) {
        try { _liveDlStep("search_grasp_gate", String(why || (okGate ? "ok" : "ng")).slice(0, 48)); } catch (_) {}
        /**
         * ★ 2.8.244: finishGate(true) でも screenOk 必須（一本化）。
         *   旧の armed_rows／armed_list／list_visible／sync_pending／mem は
         *   okGate=true で AD へ直進し、240/243 関所と衝突していた。
         */
        if (okGate && String(why || "") !== "continue_pages") {
          if (!_isSearchConfirmGrasp(_searchGraspedMem)) {
            try { _liveDlStep("legacy_blocked_no_screen", "finishGate:" + String(why || "ok").slice(0, 28)); } catch (_) {}
            try { _liveDlStep("sort_blocked", "no_screen:" + String(why || "").slice(0, 24)); } catch (_) {}
            console.warn("[AXLX bulk-dl][auto] 関所未達(" + why + ") → ADしない（screenOk必須）");
            _nudge("⏳ 検索結果の表示を待ってから並べ替えます");
            return { ok: false, reason: "search_ungrasped" };
          }
          return _beginAdSortLikeHuman();
        }
        if (!okGate) {
          /**
           * ★ 2.8.194: 一覧証拠があれば進めようとしていた。
           * ★ 2.8.243/244: 旧一覧（前客の行）でも AD していた＝screenOk関所と衝突。
           *   → 行があっても screenOk／確認把握が無ければ止め、結果待ちへ戻す。
           */
          var rn = rowNow();
          var head = false;
          try { head = !!_hasSortHeadVisible(); } catch (_) {}
          if ((rn > 0 || head) && !_isFillBusy() && _isSearchConfirmGrasp(_searchGraspedMem)) {
            markGrasp("list_with_screen:" + String(why || "").slice(0, 20));
            try { _liveDlStep("search_grasp_infer", "list_and_screen:" + String(why || "").slice(0, 24)); } catch (_) {}
            return _beginAdSortLikeHuman();
          }
          if ((rn > 0 || head) && !_isSearchConfirmGrasp(_searchGraspedMem)) {
            try { _liveDlStep("legacy_blocked_no_screen", "list_without_screenOk"); } catch (_) {}
            try { _liveDlStep("sort_blocked", "list_without_screen:" + String(why || "").slice(0, 20)); } catch (_) {}
            console.warn("[AXLX bulk-dl][auto] 一覧ありだが結果確認前 → ADしない (" + why + ")");
            _nudge("⏳ 検索結果の表示を待ってから並べ替えます");
            return { ok: false, reason: "search_ungrasped" };
          }
          console.warn("[AXLX bulk-dl][auto] 検索把握なし・一覧も無い → 待つ (" + why + ")");
          _nudge("⏳ 検索結果のあと並べ替えます");
          _liveDlStep("sort_blocked", "search_ungrasped:" + String(why || "").slice(0, 24));
          return { ok: false, reason: "search_ungrasped" };
        }
        return _beginAdSortLikeHuman();
      };
      /**
       * ★ 2.8.240/243/248: legacy_claude_path（把握無しAD）は廃止済。
       *   正本は screenOk → sort_screen_ok → hover並べ替え→AD→高→低のみ。
       *   旧印 sort_legacy:claude_path は出さない（再発したら衝突）。
       */
      if (opt && opt.continuePages) return finishGate(true, "continue_pages");
      if (opt && (opt.afterSearch || opt.fromSortCursor)) {
        if (!_isSearchConfirmGrasp(_searchGraspedMem)) {
          try { _liveDlStep("search_grasp_gate", "legacy_blocked_no_screen"); } catch (_) {}
          try { _liveDlStep("legacy_blocked_no_screen", opt.afterSearch ? "afterSearch" : "fromSortCursor"); } catch (_) {}
          try { _liveDlStep("sort_blocked", "no_screen_ok"); } catch (_) {}
          _nudge("⏳ 検索結果の表示を待ってから並べ替えます");
          return { ok: false, reason: "search_ungrasped" };
        }
        try { _liveDlStep("search_grasp_gate", "screen_ok_path"); } catch (_) {}
        _stampSortFlowAtom("sort_screen_ok", true, "screen_ok_path");
        // ★ 2.8.248: 旧 sort_legacy 原子は刻まない（廃止の証拠＝この経路だけ）
        return _beginAdSortLikeHuman();
      }
      /**
       * ★ 2.8.249 統括Pro協力「一連・連携の古い残り徹底確認」:
       *   正本は screenOk 把握だけ。武装・行あり・list_visible で markGrasp→finishGate(true)
       *   していた旧は (1) 関所で落ちるだけなのに把握 why を汚す (2) 良い screenOk を上書きし得る。
       *   → 確認把握が無い時は finishGate(false) で待つ。武装印は刻まない。
       */
      if (_searchGraspedMem && recent(_searchGraspedMem) && _isSearchConfirmGrasp(_searchGraspedMem)) {
        return finishGate(true, "mem:" + (_searchGraspedMem.why || ""));
      }
      if (_autoSendArmed && !_isFillBusy()) {
        try { _liveDlStep("legacy_blocked_no_screen", "armed_wait_screen"); } catch (_) {}
        try { _armScreenOkWatchdog("armed_wait"); } catch (_) {}
        return finishGate(false, "armed_wait_screen");
      }
      try {
        var _gSync0 = null;
        try {
          var _gs0 = sessionStorage.getItem("axlx_search_grasped_sync");
          if (_gs0) _gSync0 = JSON.parse(_gs0);
        } catch (_) { _gSync0 = null; }
        if (recent(_gSync0) && _isSearchConfirmGrasp(_gSync0)) {
          _searchGraspedMem = _gSync0;
          return finishGate(true, "sync_grasp");
        }
        chrome.storage.session.get(["axlx_search_grasped"], function (r) {
          var g = r && r.axlx_search_grasped;
          if (recent(g) && _isSearchConfirmGrasp(g)) {
            _searchGraspedMem = g;
            finishGate(true, "session_grasp");
            return;
          }
          var rowN = rowNow();
          var head = false;
          try { head = !!_hasSortHeadVisible(); } catch (_) {}
          if ((rowN > 0 || head) && !_isFillBusy() && !(opt && opt.fromAutofill)) {
            try { _liveDlStep("legacy_blocked_no_screen", "list_wait_screen"); } catch (_) {}
            try { _tmark("search_wait_screen", "list_or_head_no_screenOk"); } catch (_) {}
            try { _armScreenOkWatchdog("list_wait"); } catch (_) {}
            finishGate(false, "list_wait_screen");
            return;
          }
          finishGate(false, "no_grasp");
        });
        return { ok: true, pending: true, waiting_search_grasp: true };
      } catch (_) {
        return finishGate(false, "session_err");
      }
    }
    if (_allowAd && !_isAdDesc) {
      return _withSearchGraspThenAdOrPress();
    }
    if (!_allowAd) {
      console.log("[AXLX bulk-dl][auto] 自動便が更新順の指定 → AD へ並べ替えずに押します");
    }
    return _beginListPressNoSort();
  }

  /** 並べ替えの後に実行する物（無ければ null） */
  var _autoPdfRunPending = null;
  /**
   * ★ 2026-11-22: 並べ替えホバー中に条件入力が始まっても、世代を上げて途中の hover を無効化する。
   *   旧は `_autoPdfRun` だけ止めて `_sortByAdLikeHuman` が走り続け、駅選択中にカーソルが並べ替え位置へ飛んだ。
   */
  var _sortGen = 0;
  var _sortGenAtStart = 0;
  function _abortAdSort(why) {
    _sortGen++;
    _autoPdfRunPending = null;
    // ★ 2026-11-22: 世代上げだけでは飛行中の moveTo が並べ替えへ着地し続ける → カーソルを止める
    // ★ 2.8.226: cancelMove は今座標を残す（中心やり直し禁止）
    try {
      var Pstop = (typeof self !== "undefined" ? self : window).AxlxPointerUi;
      if (Pstop && typeof Pstop.cancelMove === "function") {
        var kept = Pstop.cancelMove();
        try {
          _tmark(
            "pointer_cancel",
            "sort_abort keep=" + (kept && kept.kept ? "Y" : "N")
              + (kept && kept.x != null ? (" @" + Math.round(kept.x) + "," + Math.round(kept.y)) : ""),
          );
        } catch (_eK) {}
      }
    } catch (_) {}
    try { _tmark("sort_abort", String(why || "abort").slice(0, 40)); } catch (_) {}
    console.warn("[AXLX bulk-dl][sort] 中断: " + String(why || ""));
  }

  /** ★ 2.8.226: 並べ替え／一覧をループ段として page に把握依頼 */
  function _requestLoopGrasp(phase, why, doneFlag) {
    try {
      window.postMessage({
        from: "axlx-loop-phase-req",
        phase: String(phase || "").slice(0, 16),
        why: String(why || "bulk").slice(0, 40),
        done: !!doneFlag,
      }, "*");
    } catch (_) {}
    try { _liveDlStep("loop_phase_req", String(phase || "") + ":" + String(why || "").slice(0, 24)); } catch (_) {}
  }

  /**
   * ★ 2026-11-22 竹内さん録画（正本）／★ 2026-11-22「並び替えからカーソルを動かして人間の動き／直接入力しない」:
   *   ① 「並べ替え」へ**カーソルを動かして置くだけ**（クリックしない）→ 下に展開
   *   ② 「AD」へ**並べ替えからカーソルを動かして置くだけ**（クリックしない）→ 右に「低→高／高→低」
   *   ③ 「高→低」へカーソルを移して**クリック**
   *   ⚠ URL 直書き（location.href / key=ad）・メニューを飛ばした直接クリックは禁止。
   *   ページは読み込み直さない。押すのは③の1回だけ。
   */
  function _sortByAdLikeHuman(done) {
    /**
     * 2026-11-14 竹内さん「検索した後並び替えしっぱいしたとでてから印刷用PDF押す前に止まってしまった
     *   原因見つけて改善する」:
     *
     *   ⚠ 旧は**1回試して失敗したら即やめて**、呼ぶ側も「押さない」で止まっていた。
     *     だが**検索条件はもう入っている**（並び順が変わるだけ）ので、止める理由が無い。
     *     現場では「並び替え失敗 → 印刷用PDF を押す前に停止」＝**物件が1件も出ない**になっていた。
     *
     *   → ① **3回まで試す**（メニューが開くまでの時間が足りないだけの事が多い）
     *     ② それでも駄目なら**並びはそのままに続行**する（物件を落とさない方を優先）
     *        ⚠ ただし点検に「並べ替えできなかった」を必ず残す（黙って続けない）。
     * ★ 2.8.247: 飛行中に再kickしない（並べ替えヘッダのホバーループを止める）
     */
    // ★ 2.8.194: 並べ替え中断は one_* ラベルのみ（文言誤検知で昔できた並べ替えを壊さない）
    var _m0 = _isCondModalLabelsOpen();
    if (_m0 || _isFillBusy()) {
      console.warn("[AXLX bulk-dl][sort] 条件入力中のため並べ替えしない modal=" + (_m0 || "-"));
      try { _tmark("sort_blocked", "before:" + (_m0 || "fill")); } catch (_) {}
      try { _liveDlStep("sort_blocked", "before:" + (_m0 || "fill")); } catch (_) {}
      done(false); return;
    }
    if (_adSortInFlight) {
      try { _liveDlStep("sort_skip_inflight", "sortByAd_reentry"); } catch (_) {}
      done(false); return;
    }
    _adSortInFlight = true;
    try { _touchPipelineProgress("ad_sort"); _armPipelineSilence("ad_sort"); } catch (_) {}
    var _finishSort = function (ok) {
      _adSortInFlight = false;
      try { _restoreGuidesAfterSort(); } catch (_) {}
      // ★ 2.8.259: 並べ替え中に左へ退避したお客様パネルを戻す
      try {
        var _pwBack = document.getElementById("aixlinx-float-wrap");
        if (_pwBack && _pwBack.getAttribute("data-axlx-sort-panel-left") != null) {
          var _prevL = _pwBack.getAttribute("data-axlx-sort-panel-left");
          _pwBack.style.setProperty("left", (parseInt(_prevL, 10) || 8) + "px", "important");
          _pwBack.style.removeProperty("pointer-events");
          _pwBack.removeAttribute("data-axlx-sort-panel-left");
          try { _liveDlStep("sort_panel_restore", "left=" + _prevL); } catch (_) {}
          try { _placeSendBarVisible(); } catch (_) {}
        }
      } catch (_) {}
      try { if (ok) _touchPipelineProgress("ad_done"); } catch (_) {}
      try { done(!!ok); } catch (_) {}
    };
    var myGen = _sortGen;
    var _try = 0;
    var _maxTry = 3;
    var _alive = function () {
      return myGen === _sortGen && !_isFillBusy() && !_isCondModalLabelsOpen();
    };
    var attempt = function () {
      if (!_alive()) {
        console.warn("[AXLX bulk-dl][sort] 世代切れ／条件画面 → 並べ替え中断");
        _finishSort(false); return;
      }
      _try++; _sortOnce(function (ok) {
      if (!_alive()) { _finishSort(false); return; }
      if (ok) { _finishSort(true); return; }
      if (_try < _maxTry) {
        console.warn("[AXLX bulk-dl][sort] 失敗（" + _try + "/" + _maxTry + "）→ 少し待ってやり直します");
        setTimeout(function () { attempt(); }, 1500 + Math.floor(Math.random() * 1200));
        return;
      }
      console.warn("[AXLX bulk-dl][sort] " + _maxTry + "回試して並べ替えできません → **この並びのまま続行**（物件を落とさない）");
      _finishSort(false);
    }, _alive); };
    /**
     * ★ 2.8.185: 束の「左の高→低｜span.sort_detail」学習位置を暖めてから並べ替え開始。
     * ★ 2.8.218: ①見出し aim は _pickSortHeadAimFromPoints（短い優先・無ければ棟戸｜under）。
     *   旧 falseHead が棟戸｜under を全除外 → sort_head_aim_warm が出ず sort_no_head で PDF へ飛んだ。
     */
    try {
      chrome.storage.local.get(["axlx_learn_points", "axlx_learn_scene_flows"], function (st) {
        try {
          var pts = (st && st.axlx_learn_points) || {};
          var best = null;
          Object.keys(pts).forEach(function (k) {
            var v = pts[k];
            if (!v || typeof v.x !== "number" || typeof v.y !== "number") return;
            if (/高.?低|sort_detail/i.test(k)) {
              if (!best || /sort_detail/.test(k)) best = { x: v.x, y: v.y, k: k };
            }
          });
          var bestHead = typeof _pickSortHeadAimFromPoints === "function"
            ? _pickSortHeadAimFromPoints(pts)
            : null;
          if (best) {
            window.__axlxSortHiloAim = best;
            try { _liveDlStep("sort_aim_warm", String(best.k || "").slice(0, 36) + " x=" + best.x + " y=" + best.y); } catch (_) {}
            try { _tmark("sort_aim_warm", String(best.k || "").slice(0, 36) + " x=" + best.x + " y=" + best.y); } catch (_) {}
          }
          if (!bestHead) {
            // ★ 2.8.259: 束に見出しが無い時は DOM の under／表上端から aim を合成
            try {
              var _synEl = typeof _findSortHeadEl === "function" ? _findSortHeadEl() : null;
              if (!_synEl) {
                var _uAll = document.querySelectorAll("div.under, .under");
                for (var _si = 0; _si < _uAll.length; _si++) {
                  var _su = _uAll[_si];
                  var _sn = String(_su.textContent || "").replace(/[\s\u3000]+/g, "");
                  if (_sn && _sn.length <= 48 && /[0-9０-９]+棟[0-9０-９]+戸/.test(_sn)) {
                    _synEl = _su; break;
                  }
                }
              }
              if (_synEl && _synEl.getBoundingClientRect) {
                var _sr = _synEl.getBoundingClientRect();
                var _iw = window.innerWidth || 1, _ih = window.innerHeight || 1;
                bestHead = {
                  x: Math.max(0.02, Math.min(0.98, (_sr.left + _sr.width * 0.5) / _iw)),
                  y: Math.max(0.02, Math.min(0.98, (_sr.top + _sr.height * 0.5) / _ih)),
                  k: String((_synEl.textContent || "").replace(/[\s\u3000]+/g, "")).slice(0, 28),
                  src: "dom_synth",
                };
              } else {
                var _mt = document.querySelector("div.main_table, .main_table, #result_list");
                if (_mt && _mt.getBoundingClientRect) {
                  var _mr = _mt.getBoundingClientRect();
                  var _ih2 = window.innerHeight || 1;
                  bestHead = {
                    x: 0.12,
                    y: Math.max(0.05, Math.min(0.5, (_mr.top - 24) / _ih2)),
                    k: "table_above",
                    src: "dom_table_above",
                  };
                }
              }
            } catch (_) {}
          }
          if (bestHead) {
            window.__axlxSortHeadAim = bestHead;
            try {
              _liveDlStep(
                "sort_head_aim_warm",
                String(bestHead.src || "") + ":" + String(bestHead.k || "").slice(0, 32) + " x=" + bestHead.x + " y=" + bestHead.y
              );
            } catch (_) {}
            try {
              _tmark(
                "sort_head_aim_warm",
                String(bestHead.src || "") + ":" + String(bestHead.k || "").slice(0, 32) + " x=" + bestHead.x + " y=" + bestHead.y
              );
            } catch (_) {}
          } else {
            try { _liveDlStep("sort_head_aim_miss", "points_have_no_head"); } catch (_) {}
            try { _tmark("sort_head_aim_miss", "points_have_no_head"); } catch (_) {}
          }
          /**
           * ★ 2.8.247: 通常録画の scene_flows から並べ替え流れを把握（hoverはclickに残らない）。
           *   高→低／並べ替え／AD が list|other|search 流れにあれば正本印を残す。
           */
          try {
            var sflows = (st && st.axlx_learn_scene_flows) || window.__axlxLearnSceneFlows || null;
            var flowHit = "";
            if (Array.isArray(sflows)) {
              for (var fi = 0; fi < sflows.length && !flowHit; fi++) {
                var fl = sflows[fi];
                var steps = (fl && (fl.steps || fl.ops || fl.labels)) || [];
                var blob = "";
                if (Array.isArray(steps)) {
                  blob = steps.map(function (s) {
                    if (typeof s === "string") return s;
                    return String((s && (s.label || s.name || s.k || s.text)) || "");
                  }).join("|");
                } else {
                  blob = JSON.stringify(fl || {}).slice(0, 400);
                }
                if (/高.?低|sort_detail|並べ替え|並び替え/.test(blob) && /AD|ＡＤ/.test(blob)) {
                  flowHit = String((fl && (fl.scene || fl.id || "list")) || "list").slice(0, 20);
                } else if (/高.?低|sort_detail/.test(blob)) {
                  flowHit = String((fl && (fl.scene || fl.id || "hilo")) || "hilo").slice(0, 20);
                }
              }
            }
            if (flowHit) {
              _tmark("sort_flow_from_rec", "scene=" + flowHit + " ①hover②AD③高→低");
              window.__axlxSortFlowFromRec = { scene: flowHit, at: Date.now() };
            } else {
              _tmark("sort_flow_from_rec", "no_scene_hilo（pointsでaim）");
            }
          } catch (_) {}
        } catch (_) {}
        attempt();
      });
    } catch (_) {
      attempt();
    }
  }

  /**
   * 並べ替えを**1回**試す（2026-11-14: リトライするために中身を分けた）。
   *   ⚠ 見つからない段は点検に残す（`sort_no_head` / `sort_no_ad` / `sort_no_hilo`）。
   */
  function _sortOnce(done, aliveFn) {
    var H = (typeof self !== "undefined" ? self : window).AxlxHumanWait;
    var P = (typeof self !== "undefined" ? self : window).AxlxPointerUi;
    var alive = typeof aliveFn === "function" ? aliveFn : function () {
      return !_isFillBusy() && !_isCondModalLabelsOpen();
    };
    var wait = function (ms) { return H && H.logNormalDelay ? H.logNormalDelay(ms, 0.35) : ms; };
    var step = function (ms, fn) {
      setTimeout(function () {
        if (!alive()) { done(false); return; }
        fn();
      }, Math.max(60, Math.round(wait(ms))));
    };
    var visible = function (el) { try { return !!el && !!(el.offsetParent || (el.getClientRects && el.getClientRects().length)); } catch (_) { return false; } };
    var norm = function (t) { return String(t == null ? "" : t).replace(/[\s\u3000]+/g, ""); };
    /**
     * 2026-11-14 竹内さん「検索した後並び替えしっぱいしたとでてから印刷用PDF押す前に止まってしまった
     *   原因見つけて改善する」:
     *
     *   ⚠ 旧は `_tmark("ad_sort", "failed")` を **sessionStorage** に書くだけで、
     *     私（サーバー側）からは**何が起きたか一切見えなかった**。
     *     ＝「失敗した」しか分からず、**どの段で・何が見つからなかったか**が追えない。
     *   → **失敗した段と、画面にあった候補**を点検（`search_audits.steps`）に送る。
     *     ・sort_no_head   … 「並べ替え」が見つからない
     *     ・sort_no_ad     … 「AD」の項目が見つからない
     *     ・sort_no_hilo   … 「高→低」が見つからない（小メニューが開いていない）
     *   ⚠ 送るのは**段の名前と、見えていた短い文字（上位6件・各20字）だけ**。
     *     ⚠ 物件名・家賃・お客様の情報は入れない（メニューの文字だけ）。
     */
    var _auditSort = function (k, detail) {
      // ★ 2.8.186/247: ライブ＋session（途中停止でも dl:sort_* が残る）
      try { _liveDlStep(k, detail == null ? null : String(detail).slice(0, 60)); } catch (_) {}
      try { _tmark(k, detail); } catch (_) {}
    };
    /**
     * その時画面に見えていた「短い文字」を集める（失敗の手がかり・最大6件）
     * ★ 2.8.212: 棟戸並べ替え（〜40字）も先頭に載せる。旧は ≤12字だけ→ナビしか残らず原因が隠れた。
     */
    var _visibleWords = function () {
      try {
        var out = [];
        var els = Array.prototype.slice.call(document.querySelectorAll("a,button,div,span,td,th,li,p,label"));
        // 先に並べ替え候補（診断用）
        for (var i0 = 0; i0 < els.length && out.length < 3; i0++) {
          var e0 = els[i0];
          if (!visible(e0)) continue;
          var t0 = String(e0.textContent || "").replace(/[\s\u3000]+/g, "");
          if (!t0 || t0.length < 2 || t0.length > 40) continue;
          if (!/並[べび]替え|並び順|高.?低|sort_detail|^AD$|^ＡＤ$/.test(t0)) continue;
          if (out.indexOf(t0) >= 0) continue;
          out.push(t0.slice(0, 28));
        }
        for (var i = 0; i < els.length && out.length < 6; i++) {
          var e = els[i];
          if (!visible(e)) continue;
          var t = String(e.textContent || "").replace(/[\s\u3000]+/g, "");
          if (!t || t.length < 2 || t.length > 12) continue;
          if (out.indexOf(t) >= 0) continue;
          // 数字・家賃・㎡ は入れない（個人情報・物件情報を送らない）
          if (/^[0-9.,]+$/.test(t) || /万円|円|㎡|m2/.test(t)) continue;
          out.push(t);
        }
        return out.join("/");
      } catch (_) { return ""; }
    };
    /** 文字で探す（見えている物だけ・小さい物から・完全一致） */
    var byText = function (list, root) {
      var r = root || document;
      var els = Array.prototype.slice.call(r.querySelectorAll("a,button,div,span,td,th,li,p,label"));
      for (var i = 0; i < list.length; i++) {
        var t = norm(list[i]);
        var hit = null;
        for (var j = 0; j < els.length; j++) {
          if (!visible(els[j])) continue;
          if (norm(els[j].textContent) === t) { if (!hit || els[j].textContent.length <= hit.textContent.length) hit = els[j]; }
        }
        if (hit) return hit;
      }
      return null;
    };
    /**
     * ★ 2026-11-22 録画: 「並べ替え」は巨大な main_table 文言に埋もれる事がある。
     *   含む一致で、短い要素を優先（一覧ヘッダ全体は捨てる）。
     */
    var byTextLoose = function (list, maxLen) {
      var lim = typeof maxLen === "number" ? maxLen : 28;
      var els = Array.prototype.slice.call(document.querySelectorAll("a,button,div,span,td,th,li,p,label"));
      var best = null, bestLen = 1e9;
      for (var i = 0; i < list.length; i++) {
        var want = norm(list[i]);
        if (!want) continue;
        for (var j = 0; j < els.length; j++) {
          var el = els[j];
          if (!visible(el)) continue;
          var nt = norm(el.textContent);
          if (!nt || nt.length > lim) continue;
          if (nt !== want && nt.indexOf(want) < 0) continue;
          if (nt.length < bestLen) { bestLen = nt.length; best = el; }
        }
        if (best) return best;
      }
      return null;
    };
    /**
     * ★ 2026-11-22: 一覧表の列見出し（AD列）・表セルは並べ替えメニューではない。
     *   ここを掴むと「いきなり違う場所のADを押す」になる。
     */
    var isListChrome = function (el) {
      try {
        if (!el || !el.closest) return false;
        // ★ 2.8.185: 並べ替え小メニュー（AD／高→低／低→高）は一覧列ではない（画像赤丸）
        var ntMenu = norm(el.textContent);
        if (ntMenu && ntMenu.length <= 18 && /^(AD|ＡＤ|AD順|高→低|高⇒低|高・低|低→高|高い順|低い順)/.test(ntMenu)) return false;
        if (el.matches && el.matches("span.sort_detail, .sort_detail")) return false;
        if (el.closest("thead, th, table.main_table, .main_table, #result_list, .result_list, .property_list")) return true;
        var tag = String(el.tagName || "").toUpperCase();
        if (tag === "TH" || tag === "TD") return true;
        var r = el.getBoundingClientRect();
        // 表の列見出しは横に広いことが多い（メニュー項目は狭い）
        if (r.width > 120 && r.height < 36 && /AD|更新|賃料|間取/.test(norm(el.textContent))) return true;
      } catch (_) {}
      return false;
    };
    /**
     * ★ 2026-11-22: 並べ替えメニュー近傍だけ探す（一覧の「AD」列見出しと取り違えない）。
     *   mode=below … 並べ替えの下（ドロップダウン）／mode=right … AD の右（高→低）
     */
    var findNear = function (list, anchor, mode) {
      if (!anchor) return null;
      var ar = anchor.getBoundingClientRect();
      var els = Array.prototype.slice.call(document.querySelectorAll("a,button,div,span,li,p,label"));
      var best = null, bestScore = 1e15;
      for (var i = 0; i < list.length; i++) {
        var want = norm(list[i]);
        for (var j = 0; j < els.length; j++) {
          var el = els[j];
          if (!visible(el) || el === anchor) continue;
          if (isListChrome(el)) continue;
          var nt = norm(el.textContent);
          if (nt !== want) {
            // 短い「AD」は完全一致のみ（AD月・AD料などを拾わない）
            if (want.length <= 2) continue;
            if (!(want.length <= 4 && nt.indexOf(want) === 0 && nt.length <= want.length + 6)) continue;
          }
          var r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          /**
           * ★ 2.8.247 竹内さん画像: ADはメニュー下部（更新日時〜管理会社の長い列）。
           *   旧 below+220 だと AD が届かず sort_no_ad → 並べ替えへ戻りホバーループ。
           *   → 下方向 560px・横 200（メニュー縦長を把握）。
           */
          if (mode === "below") {
            if (r.top < ar.bottom - 4) continue;
            if (r.top > ar.bottom + 560) continue;
            if (Math.abs(r.left - ar.left) > 200) continue;
          } else {
            if (r.left < ar.left - 20) continue;
            if (r.left > ar.right + 320) continue;
            if (Math.abs(r.top - ar.top) > 120) continue;
          }
          var score = (mode === "below")
            ? (Math.abs(r.left - ar.left) + Math.max(0, r.top - ar.bottom) * 0.45 + nt.length * 0.2 + r.width * 0.05)
            : (Math.abs(r.top - ar.top) + Math.max(0, r.left - ar.right) * 0.35 + nt.length * 0.2);
          if (score < bestScore) { bestScore = score; best = el; }
        }
      }
      return best;
    };
    /**
     * ★ 2026-11-22 直近通常録画（2.8.154・02:49）正本:
     *   人が押したのは `span.sort_detail`（文言「高→低」）。
     *   ★ 2026-11-22 改善: AD 近傍だけ（ページ全体の sort_detail を掴むと場所が違う）。
     */
    var findSortDetailByRec = function (wantTexts, anchor) {
      var wants = (wantTexts || ["高→低"]).map(norm);
      var nodes = [];
      try { nodes = Array.prototype.slice.call(document.querySelectorAll("span.sort_detail, .sort_detail")); } catch (_) { nodes = []; }
      var ar = null;
      try { if (anchor) ar = anchor.getBoundingClientRect(); } catch (_) { ar = null; }
      var best = null, bestScore = 1e15;
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (!visible(el)) continue;
        if (isListChrome(el)) continue;
        var nt = norm(el.textContent);
        if (!nt || nt.length > 24) continue;
        var ok = false;
        for (var w = 0; w < wants.length; w++) {
          if (nt === wants[w] || nt.indexOf(wants[w]) >= 0) { ok = true; break; }
        }
        if (!ok) continue;
        var r = el.getBoundingClientRect();
        var score = nt.length;
        if (ar) {
          // AD の右・同じ高さ帯だけ
          if (r.left < ar.left - 20) continue;
          if (r.left > ar.right + 360) continue;
          if (Math.abs(r.top - ar.top) > 140) continue;
          score += Math.abs(r.top - ar.top) + Math.max(0, r.left - ar.right) * 0.3;
        }
        if (score < bestScore) { bestScore = score; best = el; }
      }
      return best;
    };
    var centerOf = function (el) {
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width * 0.55, y: r.top + r.height * 0.5 };
    };
    /**
     * ★ 2.8.247: 展開済みメニュー内の「AD」だけ（一覧AD列禁止）。
     *   兄弟に「更新日時」「所在地」等がある親配下を優先＝通常の下展開メニューを把握。
     */
    var findAdInOpenMenu = function (sortHead) {
      if (!sortHead) return null;
      var ar = sortHead.getBoundingClientRect();
      var MENU_HINTS = ["更新日時", "所在地", "物件名", "賃料", "敷金", "礼金", "専有面積", "間取り", "築年", "共益費", "管理会社"];
      var ads = [];
      var els = Array.prototype.slice.call(document.querySelectorAll("a,button,div,span,li,p,label,td"));
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        if (!visible(el) || el === sortHead) continue;
        if (isListChrome(el)) continue;
        var nt = norm(el.textContent);
        if (!(nt === "AD" || nt === "ＡＤ" || nt === "AD順")) continue;
        var r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (r.top < ar.bottom - 4) continue;
        if (r.top > ar.bottom + 560) continue;
        if (Math.abs(r.left - ar.left) > 220) continue;
        var score = Math.abs(r.left - ar.left) + Math.max(0, r.top - ar.bottom) * 0.2 + r.width * 0.05;
        var sibBoost = 0;
        try {
          var par = el.parentElement;
          var blob = par ? norm(par.textContent).slice(0, 400) : "";
          for (var h = 0; h < MENU_HINTS.length; h++) {
            if (blob.indexOf(norm(MENU_HINTS[h])) >= 0) sibBoost += 8;
          }
        } catch (_) {}
        ads.push({ el: el, score: score - sibBoost });
      }
      if (!ads.length) return null;
      ads.sort(function (a, b) { return a.score - b.score; });
      return ads[0].el;
    };
    /** 押さずに「カーソルをその上へ移す」（展開を待つだけ・click しない・座標は要素の真ん中） */
    var hover = function (el, cb) {
      var doneHover = typeof cb === "function" ? cb : function () {};
      if (!el) { doneHover(false); return; }
      if (!alive()) { doneHover(false); return; }
      // ★ 2026-11-22: ホバー前にカーソル1本化（二重マウス防止）
      try { if (P && typeof P.forceOneCursor === "function") P.forceOneCursor(); } catch (_) {}
      var c = centerOf(el);
      var fire = function () {
        // ★ 2026-11-22: 飛行中に条件入力／駅モーダルが始まったらホバーしない
        if (!alive()) { doneHover(false); return; }
        try {
          var opts = { bubbles: true, cancelable: true, view: window, clientX: c.x, clientY: c.y };
          ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"].forEach(function (t) {
            try { el.dispatchEvent(new MouseEvent(t, opts)); } catch (_) {}
          });
        } catch (_) {}
        // ★ 2.8.247: リアプロは jQuery hover の事が多い → あれば mouseenter も叩く（clickは絶対しない）
        try {
          var $ = window.jQuery || window.$;
          if ($ && el) $(el).trigger("mouseenter").trigger("mouseover");
        } catch (_) {}
        doneHover(true);
      };
      try {
        if (P && P.moveToEl) {
          P.moveToEl(el).then(function (moved) {
            if (moved === false || !alive()) { doneHover(false); return; }
            setTimeout(fire, 140 + Math.floor(Math.random() * 220));
          }, function () {
            if (!alive()) { doneHover(false); return; }
            try { if (P.moveTo) P.moveTo(c.x, c.y); } catch (_) {}
            setTimeout(fire, 120);
          });
          return;
        }
        if (P && P.moveTo) {
          P.moveTo(c.x, c.y);
          setTimeout(fire, 120 + Math.floor(Math.random() * 180));
          return;
        }
      } catch (_) {}
      fire();
    };
    /**
     * 押すのは「高→低」だけ（カーソルを移してから・URL直は禁止）。
     * ★ 2.8.247: 並べ替え見出し／メニュー内AD への click は禁止（ホバーループの根）。
     */
    var press = function (el, cb) {
      if (!el) { cb(false); return; }
      if (!alive()) { cb(false); return; }
      try {
        var ntP = norm(el.textContent);
        if (ntP === "並べ替え" || ntP === "並び替え" || ntP === "AD" || ntP === "ＡＤ" || ntP === "AD順") {
          _auditSort("sort_forbid_click", "禁止click:" + ntP.slice(0, 12));
          console.warn("[AXLX bulk-dl][sort] 並べ替え/AD は押さない（ホバーのみ）: " + ntP.slice(0, 20));
          cb(false); return;
        }
      } catch (_) {}
      var go = function () {
        if (!alive()) { cb(false); return; }
        try { if (P && P.tap) P.tap(); } catch (_) {}
        try { if (typeof window.__axlxRecNoteOp === "function") window.__axlxRecNoteOp("click", el); } catch (_) {}
        try { el.click(); } catch (_) {}
        cb(true);
      };
      try {
        if (P && P.moveToEl) {
          P.moveToEl(el).then(function (moved) {
            if (moved === false || !alive()) { cb(false); return; }
            setTimeout(go, 180 + Math.floor(Math.random() * 420));
          }, function () {
            if (!alive()) { cb(false); return; }
            var c = centerOf(el);
            try { if (P.moveTo) P.moveTo(c.x, c.y); } catch (_) {}
            setTimeout(go, 200);
          });
          return;
        }
      } catch (_) {}
      try {
        var c2 = centerOf(el);
        el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, view: window, clientX: c2.x, clientY: c2.y }));
      } catch (_) {}
      setTimeout(go, 140);
    };
    /**
     * ★ 2.8.185 竹内さん画像（赤丸）正本:
     *   ①並べ替え ②AD ③右の「高→低」（低→高の隣）。文言ゆれ・中黒・全角矢印も拾う。
     */
    var HILO_TEXTS = ["高→低", "高 → 低", "高⇒低", "高・低", "高い順", "高→低（高い順）", "高い→低い", "降順", "高い→低"];
    /** 学習束の「左の高→低｜span.sort_detail」位置（比率）を読む */
    var _hiloAim = null;
    try {
      var _pts = null;
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        // 同期キャッシュ（page へ push 済みなら window 経由は MAIN のみ。isolated は storage）
      }
      // bulk-dl は isolated: 直前に session/local から暖めた物があれば使う
      if (window.__axlxSortHiloAim && typeof window.__axlxSortHiloAim.x === "number") {
        _hiloAim = window.__axlxSortHiloAim;
      }
    } catch (_) {}
    /** 高→低: 録画の span.sort_detail（AD近傍）最優先 → AD右近傍 → href（URL直はしない）→ 学習 aim 近傍 */
    var findHiToLoNear = function (adEl) {
      var fromRec = findSortDetailByRec(HILO_TEXTS, adEl);
      if (fromRec) return fromRec;
      var hit = adEl ? findNear(HILO_TEXTS, adEl, "right") : null;
      if (hit) return hit;
      if (!adEl) return null;
      try {
        var ar = adEl.getBoundingClientRect();
        var links = Array.prototype.slice.call(document.querySelectorAll("a[href], span.sort_detail, .sort_detail, span, a, li, div"));
        for (var i = 0; i < links.length; i++) {
          if (!visible(links[i])) continue;
          // 並べ替えの小メニュー内は main_table 配下でも一覧列扱いしない
          var inSortMenu = false;
          try {
            var nt0 = norm(links[i].textContent);
            if (HILO_TEXTS.some(function (t) { return nt0 === norm(t) || nt0.indexOf(norm(t)) >= 0; })) inSortMenu = true;
          } catch (_) {}
          if (!inSortMenu && isListChrome(links[i])) continue;
          var r = links[i].getBoundingClientRect();
          if (r.left < ar.left - 20 || r.left > ar.right + 360) continue;
          if (Math.abs(r.top - ar.top) > 140) continue;
          var h = String(links[i].getAttribute && links[i].getAttribute("href") || "");
          if (/ad=odr_desc/i.test(h) || (/key=ad/i.test(h) && /odr=desc/i.test(h))) return links[i];
          var nt = norm(links[i].textContent);
          if (nt && nt.length <= 16 && HILO_TEXTS.some(function (t) { return nt === norm(t) || nt.indexOf(norm(t)) >= 0; })) return links[i];
        }
      } catch (_) {}
      // 学習位置（束 points: 左の高→低｜span.sort_detail ≈ x0.15 y0.47）の近傍要素
      if (_hiloAim && typeof _hiloAim.x === "number" && typeof _hiloAim.y === "number") {
        try {
          var ax = _hiloAim.x * (window.innerWidth || 1);
          var ay = _hiloAim.y * (window.innerHeight || 1);
          var best = null, bestD = 80;
          var nodes = Array.prototype.slice.call(document.querySelectorAll("span.sort_detail, .sort_detail, a, span, li"));
          for (var j = 0; j < nodes.length; j++) {
            if (!visible(nodes[j])) continue;
            var rr = nodes[j].getBoundingClientRect();
            var cx = rr.left + rr.width * 0.5, cy = rr.top + rr.height * 0.5;
            var d = Math.hypot(cx - ax, cy - ay);
            if (d < bestD) { bestD = d; best = nodes[j]; }
          }
          if (best) {
            _auditSort("sort_hilo_aim", "d=" + Math.round(bestD) + " " + norm(best.textContent).slice(0, 12));
            return best;
          }
        } catch (_) {}
      }
      return null;
    };
    /** ADホバー後、小メニューが出るまで最大 ~2.8秒ポーリング（1回で諦めない） */
    var waitHiToLo = function (adEl, cb) {
      var tries = 0;
      var maxTries = 8;
      var tick = function () {
        if (!alive()) { cb(null); return; }
        var el = findHiToLoNear(adEl);
        if (el) { cb(el); return; }
        tries++;
        if (tries >= maxTries) { cb(null); return; }
        // 小メニューが閉じたら AD を再ホバー
        hover(adEl, function () {
          setTimeout(tick, 320 + Math.floor(Math.random() * 180));
        });
      };
      setTimeout(tick, 500);
    };
    /**
     * ★ 2.8.247: 並べ替えホバー後、下メニューに AD が出るまで待つ（固定1.4秒で諦めない）。
     *   メニューが開いている間は見出しを連打ホバーしない（ループに見えるのを止める）。
     */
    var waitAdBelowHead = function (sortHead, cb) {
      var tries = 0;
      var maxTries = 10;
      var tick = function () {
        if (!alive()) { cb(null); return; }
        var ad = findAdInOpenMenu(sortHead) || findNear(["AD", "ＡＤ", "AD順", "AD（広告費）"], sortHead, "below");
        if (ad && !isListChrome(ad)) {
          _auditSort("sort_menu_open", "ad_visible try=" + tries);
          cb(ad); return;
        }
        var menuHint = findNear(["更新日時", "所在地", "物件名", "賃料"], sortHead, "below");
        tries++;
        if (tries >= maxTries) { cb(null); return; }
        if (menuHint) {
          // メニューは開いている → 見出し再ホバーせず待つだけ（ADが下にある）
          _auditSort("sort_menu_wait_ad", "open try=" + tries);
          setTimeout(tick, 280 + Math.floor(Math.random() * 120));
          return;
        }
        // メニューが閉じた時だけ見出しを再ホバー
        hover(sortHead, function () {
          setTimeout(tick, 360 + Math.floor(Math.random() * 160));
        });
      };
      setTimeout(tick, 450);
    };

    // ① 「並べ替え」へカーソルを動かして置くだけ（クリックしない → 下に展開）
    // ★ 2.8.194: 中断は one_* だけ（文言誤検知で Claude 時代の並べ替えを壊さない）
    if (_isCondModalLabelsOpen() || _isFillBusy()) {
      _auditSort("sort_blocked", "modal_or_fill_vis");
      done(false); return;
    }
    /**
     * ★ 2.8.200 統括Pro/F53: 案内小窓が一覧右側を覆い並べ替え見出しが取れない。
     *   探す前に案内パネルだけ一時的に避け、一覧を画面内へ。
     * ★ 2.8.254 竹内さん画像「物件送る等の拡張が消える」:
     *   旧セレクタ `[id^='aixlinx-']` が **#aixlinx-float-wrap（お客様パネル）** まで display:none し、
     *   戻す処理が無かった＝右ドック／物件送る枠が消えたままになる。案内系だけ隠す。
     */
    try {
      _tuckGuidesForSort();
    } catch (_) {}
    /**
     * ★ 2.8.259 DB#1600 sort_no_head 連発「見えていた:ヘルプ/住居検索…」:
     *   旧は見出し探索の前に main_table を scrollIntoView(start) しており、
     *   表の上にある「並べ替え」を画面外／overflow 外へ追い出し、見出し0のまま止まっていた。
     *   → 表スクロールは禁止。先に見出しを掴み、掴めたら見出しを中央へ。
     */
    try { if (P && typeof P.forceOneCursor === "function") P.forceOneCursor(); } catch (_) {}
    /** 右ドックが結果ツールバーを覆う時、探索中だけ左へ退避（復元は _finishSort） */
    var _panelMovedForSort = false;
    try {
      var _pw = document.getElementById("aixlinx-float-wrap");
      if (_pw && _pw.getAttribute("data-axlx-user-mini") !== "1") {
        var _pr = _pw.getBoundingClientRect();
        var _vw = window.innerWidth || 1200;
        if (_pr.width > 180 && _pr.right > _vw - 100 && _pr.left > _vw * 0.4) {
          if (!_pw.getAttribute("data-axlx-sort-panel-left")) {
            _pw.setAttribute("data-axlx-sort-panel-left", String(parseInt(_pw.style.left, 10) || Math.round(_pr.left)));
          }
          _pw.style.setProperty("left", "8px", "important");
          _pw.style.setProperty("pointer-events", "none", "important");
          _panelMovedForSort = true;
          _auditSort("sort_panel_clear", "dock→left for head");
        }
      }
    } catch (_) {}
    /**
     * ★ 2.8.197: 完全一致 → 短い loose → _findSortHeadEl（含む・最短・表ルート除外）
     * ★ 2.8.212: 棟戸並べ替え loose → 学習 aim 保険
     * ★ 2.8.218: aim が画面外なら scroll→再探索。無いまま PDF へ飛ばないよう把握印を厚く。
     * ★ 2.8.259: 見出し再探索（scroll0→panel退避後→aim）を1回の _sortOnce 内で尽くす。
     */
    var _headAim = null;
    try { _headAim = window.__axlxSortHeadAim || null; } catch (_) { _headAim = null; }
    var _pickHead = function () {
      return byText(["並び替え", "並べ替え", "並び順", "ソート", "並び替えに戻る", "並べ替えに戻る"])
        || byTextLoose(["並べ替え", "並び替え", "並び順", "ソート", "並び替えに戻る", "並べ替えに戻る"], 28)
        || byTextLoose(["並べ替え", "並び替え"], 48)
        || (typeof _findSortHeadEl === "function" ? _findSortHeadEl() : null);
    };
    var sortHead = _pickHead();
    if (!sortHead && _headAim && typeof _findSortHeadByAim === "function") {
      try {
        sortHead = _findSortHeadByAim(_headAim);
        if (sortHead) {
          _auditSort("sort_head_aim_hit", String(_headAim.src || "") + ":" + String(_headAim.k || "").slice(0, 28));
        }
      } catch (_) {}
    }
    // 見出しが無い時: ページ上端へ戻して再探索（表スクロールの残骸を戻す）
    if (!sortHead) {
      try {
        window.scrollTo(0, 0);
        _auditSort("sort_head_scroll0", "recover");
      } catch (_) {}
      try { sortHead = _pickHead(); } catch (_) {}
      if (sortHead) _auditSort("sort_head_recover", "after_scroll0");
    }
    // aim があるのに取れない＝画面外の可能性 → 文書座標へ寄せて再探索（とび防止）
    if (!sortHead && _headAim && typeof _headAim.y === "number") {
      try {
        var _docH = Math.max(
          document.documentElement ? document.documentElement.scrollHeight : 0,
          document.body ? document.body.scrollHeight : 0,
          1
        );
        var _targetY = Math.max(0, Math.round(_headAim.y * _docH - (window.innerHeight || 600) * 0.45));
        window.scrollTo(0, _targetY);
        _auditSort("sort_head_aim_scroll", "y=" + _headAim.y + "→" + _targetY + " src=" + String(_headAim.src || ""));
      } catch (_) {}
      try {
        sortHead = _pickHead()
          || (typeof _findSortHeadByAim === "function" ? _findSortHeadByAim(_headAim) : null);
        if (sortHead) _auditSort("sort_head_aim_hit_after_scroll", String(_headAim.src || "").slice(0, 20));
      } catch (_) {}
    }
    // ★ 2.8.259: 文言0でも aim 座標の elementFromPoint で掴む（最後の保険）
    if (!sortHead && _headAim && typeof _headAim.x === "number" && typeof _headAim.y === "number") {
      try {
        var _axP = _headAim.x * (window.innerWidth || 1);
        var _ayP = _headAim.y * (window.innerHeight || 1);
        var _topP = document.elementFromPoint(_axP, _ayP);
        var _walkP = _topP;
        for (var _pd = 0; _walkP && _pd < 8; _pd++) {
          var _pnt = norm(_walkP.textContent);
          if (_pnt && _pnt.length <= 64 && (/並[べび]?替え?|並び順|棟.*戸/.test(_pnt))) {
            sortHead = _walkP;
            _auditSort("sort_head_point", "aim@" + Math.round(_axP) + "," + Math.round(_ayP));
            break;
          }
          _walkP = _walkP.parentElement;
        }
        if (!sortHead && _topP) {
          sortHead = _topP;
          _auditSort("sort_head_point_raw", "el=" + String(_topP.tagName || "").slice(0, 8));
        }
      } catch (_) {}
    }
    if (!sortHead) {
      console.warn("[AXLX bulk-dl][sort] 「並べ替え」が見つかりません");
      var _diag = "見えていた: " + _visibleWords();
      try {
        _diag += " aim=" + (_headAim ? ("Y:" + String(_headAim.src || "?") + "@" + _headAim.x + "," + _headAim.y) : "N");
        var _uN = 0;
        try { _uN = document.querySelectorAll("div.under, .under").length; } catch (_) {}
        _diag += " under=" + _uN + (_panelMovedForSort ? " panelCleared" : "");
      } catch (_) {}
      _auditSort("sort_no_head", _diag.slice(0, 80));
      try {
        if (typeof window.__axlxForceAuditStepsFlush === "function") {
          window.__axlxForceAuditStepsFlush("sort_no_head");
        }
      } catch (_) {}
      done(false); return;
    }
    try {
      var _shNt = norm(sortHead.textContent);
      if (_shNt && _shNt.length > 24) {
        _auditSort("sort_head_buried", "len=" + _shNt.length + ":" + _shNt.slice(0, 28));
      }
    } catch (_) {}
    _auditSort("sort_head_hover", norm(sortHead.textContent).slice(0, 20));
    // ★ 2.8.212: 押す前に画面内へ（ec99869c・統括Pro）
    try {
      if (sortHead.scrollIntoView) {
        sortHead.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        _auditSort("sort_head_scroll", "center");
      }
    } catch (_) {}
    /**
     * ★ 2.8.247 竹内さん「並べ替えは押さずカーソル→下展開→ADカーソル→右に高→低を押す／通常録画からも流れ学習」:
     *   正本: ①hover並べ替え ②hover AD ③click 高→低のみ。clickループ禁止。
     */
    _auditSort("sort_flow_grasp", "①hover並べ替え→②hoverAD→③click高→低");
    console.log("[AXLX bulk-dl][sort] ① 並べ替えへカーソルを動かします（クリックしない・URL直しない）");
    hover(sortHead, function () {
      if (_isCondModalLabelsOpen() || _isFillBusy()) { _auditSort("sort_abort", "during_hover_head"); done(false); return; }
      waitAdBelowHead(sortHead, function (adItem) {
        if (_isCondModalLabelsOpen() || _isFillBusy()) { _auditSort("sort_abort", "during_menu"); done(false); return; }
        if (!adItem) {
          console.warn("[AXLX bulk-dl][sort] AD の項目が見つかりません（メニューが開いていない・一覧列は使わない）");
          _auditSort("sort_no_ad", "menu_only 見えていた: " + _visibleWords());
          done(false); return;
        }
        if (isListChrome(adItem)) {
          console.warn("[AXLX bulk-dl][sort] AD が一覧表の列だったので中止（場所が違う）");
          _auditSort("sort_ad_wrong", "list_chrome:" + norm(adItem.textContent).slice(0, 20));
          done(false); return;
        }
        _auditSort("sort_ad_hover", "menu:" + norm(adItem.textContent).slice(0, 18));
        _auditSort("sort_ad_found", "dy=" + Math.round((adItem.getBoundingClientRect().top - sortHead.getBoundingClientRect().bottom)));
        console.log("[AXLX bulk-dl][sort] ② 並べ替えから AD へカーソルを動かします（クリックしない・一覧列禁止）");
        hover(adItem, function () {
          if (_isCondModalLabelsOpen() || _isFillBusy()) { _auditSort("sort_abort", "during_hover_ad"); done(false); return; }
          waitHiToLo(adItem, function (hiToLo) {
            if (_isCondModalLabelsOpen() || _isFillBusy()) { _auditSort("sort_abort", "during_hilo"); done(false); return; }
            if (!hiToLo) {
              console.warn("[AXLX bulk-dl][sort] 「高→低」が見つかりません（小メニューが開いていない）");
              _auditSort("sort_no_hilo", "見えていた: " + _visibleWords());
              done(false); return;
            }
            var _hiloHow = (hiToLo.matches && hiToLo.matches("span.sort_detail, .sort_detail")) ? "rec:sort_detail" : "near";
            _auditSort("sort_hilo", _hiloHow + ":" + norm(hiToLo.textContent || hiToLo.getAttribute("href") || "").slice(0, 22));
            console.log("[AXLX bulk-dl][sort] ③ 高→低へカーソルを動かして押します（赤丸=AD右の高→低・URL直しない）");
            press(hiToLo, function (okPress) {
              if (!okPress) { done(false); return; }
              step(1200, function () { done(true); });
            });
          });
        });
      });
    });
  }

  /** 押す所（候補を集めて、人の順で1件ずつ押し始める） */
  function _startAutoPressRun() {
    var pick = function () {
      return tracked.filter(function (t) { return t.cb && t.btn && t.btn.isConnected && AxlxSendPairing.isHttpUrl(t.btn.href); });
    };
    var cand = pick();
    /**
     * 2026-11-11 v2.7.2 竹内さん「並べ替えした後物件選択するところでとまってしまった」:
     *   並べ替えで一覧が描き直されると、`tracked` の要素は画面から外れる。
     *   そのまま進むと **1件も押せずに終わる**（止まったように見える）→ 一度だけ作り直す。
     */
    if (!cand.length && tracked.length > 0) {
      console.warn("[AXLX bulk-dl][auto] 行が画面から入れ替わった → 一覧を作り直します");
      try { _rescanRows(); } catch (_) {}
      cand = pick();
    }
    /**
     * ★ 2.8.248 竹内さん画像「送付済みで次もないのに止まる／改善仕組みが効いていない」:
     *   図面PDFが全部「送付済み」表記になると print URL が無く cand=0。
     *   旧は no-rows で return して客完了へ進まなかった＝ボトルネック。
     *   → 画面の送付済みを数えて all_sent 扱いで _autoFinish（次頁無ければ客完了→外す）。
     */
    var _countSentOnScreen = function () {
      var n = 0;
      try {
        var els = document.querySelectorAll("a,span,td,div,button");
        for (var i = 0; i < els.length; i++) {
          var t = String(els[i].textContent || "").replace(/\s+/g, "");
          if (t === "送付済み" || t === "送付済") n++;
        }
      } catch (_) { n = 0; }
      return n;
    };
    if (!cand.length) {
      var sentVis0 = _countSentOnScreen();
      var lookResult = false;
      try { lookResult = !!_looksLikeSearchResult(); } catch (_) { lookResult = false; }
      if (sentVis0 > 0 || lookResult) {
        _nudge("👀 送る部屋がありません（画面送付済み " + sentVis0 + "・押せるPDF0）→ 次へ／客完了");
        _tmark("auto_pdf_start", "all_sent_no_press sentVis=" + sentVis0);
        try { _liveDlStep("all_sent_no_press", "sentVis=" + sentVis0 + "→客完了へ"); } catch (_) {}
        try {
          _graspAcquire("all_sent", true, "押せる行0・画面送付済" + sentVis0 + "＝失敗ではない→次頁/客完了");
        } catch (_) {}
        _autoPdfRun = {
          total: 0,
          done: 0,
          index: 0,
          skipped: Math.max(sentVis0, 1),
          order: [],
          customerId: _pickCustomerIdForAuto() || null,
          startedAt: Date.now(),
        };
        try { _touchPipelineProgress("all_sent_no_press"); } catch (_) {}
        _autoFinish("送付済みのみ・押せる行無し");
        return { ok: true, all_sent: true, reason: "all_sent_no_press" };
      }
      _nudge("⚠ 押せる行が見つかりません（条件を確かめてください）");
      _tmark("auto_pdf_start", "no-rows");
      return { ok: false, reason: "no-rows" };
    }
    var cid = _pickCustomerIdForAuto();
    /**
     * ★ 2026-11-16: 送付済みを読んでから絞る（読めなくても絞れる物だけ絞る＝検索は止めない）。
     */
    _ensureSentRoomsForAuto(cid, function () {
      var filtered = _filterCandForAuto(cand, cid);
      var list = filtered.allowed || [];
      try {
        _acquireGrasp.sentSkipped = filtered.sent || 0;
        _acquireGrasp.allowed = list.length;
        _graspAcquire(
          "filter",
          true,
          "候補" + cand.length + "→送る" + list.length + "／送付済除外" + (filtered.sent || 0) + "／最安除外" + (filtered.cheapest || 0)
        );
      } catch (_) {}
      if (!list.length) {
        var skippedAll = (filtered.sent || 0) + (filtered.cheapest || 0);
        var sentVis = 0;
        try { sentVis = _countSentOnScreen(); } catch (_) { sentVis = 0; }
        var skipN = Math.max(filtered.sent || 0, sentVis, skippedAll ? skippedAll : 0, 1);
        _nudge(skippedAll || sentVis
          ? ("👀 このページは送る部屋がありません（送付済み " + (filtered.sent || sentVis) + "／同じ平米の高い部屋 " + (filtered.cheapest || 0) + "）→ 次へ")
          : "⚠ 押せる行が見つかりません");
        _tmark("auto_pdf_start", "all-filtered sent=" + (filtered.sent || 0) + " cheap=" + (filtered.cheapest || 0) + " vis=" + sentVis);
        try {
          _graspAcquire(
            "all_sent",
            true,
            "送付済み" + skipN + "で送る部屋0＝失敗ではない→次頁/客完了へ"
          );
        } catch (_) {}
        try { _liveDlStep("all_sent_page", "filtered0 skip=" + skipN); } catch (_) {}
        // 全部送付済みなら次ページへ／無ければ客完了（_autoFinish 一本化）
        _autoPdfRun = { total: 0, done: 0, index: 0, skipped: skipN, order: [], customerId: cid || null, startedAt: Date.now() };
        _autoFinish("このページは送る部屋が無い");
        return;
      }
      // 2026-11-11 竹内さん「資料を全部上から順にやるようになっていないか。完全に人間の動きを再現していく」:
      //   旧は必ず上から1件ずつ＝機械的。人が一覧を見て「気になった所から」押す形にする。
      var order = _humanPickOrder(list.length);
      var ordered = order.map(function (i) { return list[i]; }).filter(Boolean);
      _autoPdfRun = {
        total: 0,
        done: 0,
        index: 0,
        order: order,
        skipped: filtered.sent || 0,
        customerId: cid || null,
        startedAt: _pressRunSince || Date.now(),
      };
      if (cid && !_autoRunCid) _autoRunCid = cid; // 終わりの合図は押し始めたお客さんの番号で送る（途中の選び直しに引きずられない）
      try { _touchPipelineProgress("press_start"); _armPipelineSilence("press"); } catch (_) {}
      _tmark("auto_pdf_start", String(list.length) + "件（元" + cand.length + "・送付済除外" + (filtered.sent || 0) + "・最安絞り" + (filtered.cheapest || 0) + "）");
      try { _graspAcquire("press_start", true, "未送付" + list.length + "件を押す（送付済は把握済で除外）"); } catch (_) {}
      console.log("[AXLX bulk-dl][auto] 押す順（人が見て回る順）: " + order.slice(0, 12).join("→") + (order.length > 12 ? "…" : "")
        + "／送付済み除外 " + (filtered.sent || 0) + "／同じ平米の高い部屋除外 " + (filtered.cheapest || 0));
      if (filtered.sent || filtered.cheapest) {
        _nudge("📋 送る部屋 " + list.length + "件（送付済み " + (filtered.sent || 0) + "・同じ平米の高い部屋 " + (filtered.cheapest || 0) + " は外しました）");
      }
      _autoPressNext(ordered);
    });
    return { ok: true, count: cand.length, pending: true };
  }
  /**
   * 2026-11-11 押す順を人のように決める（上から順に全部ではない）。
   *   ・最初の 1〜3件は上から（人が一覧の上から見始める）
   *   ・その後は「今の位置の近く（±3行）」「少し飛ぶ（±4〜10行）」「たまに大きく飛ぶ（下の方へ）」を混ぜる
   *   ・6〜9件に1回ほど「1つ前・2つ前に戻って見直す」
   *   ・全部を1回ずつ（重複なし）。残りが少なくなったら残りを近い順に
   */
  function _humanPickOrder(n) {
    if (n <= 1) return [0];
    var picked = {};
    var out = [];
    var startCount = Math.min(n, 1 + Math.floor(Math.random() * 3)); // 1〜3件は上から
    for (var i = 0; i < startCount; i++) { picked[i] = 1; out.push(i); }
    var guard = 0;
    while (out.length < n && guard++ < n * 60) {
      var cur = out[out.length - 1];
      var r = Math.random();
      var next = -1;
      if (r < 0.10 && out.length >= 3) {
        // 戻って見直す（1つ前・2つ前）
        var idx = out.length - 1 - (1 + Math.floor(Math.random() * Math.min(2, out.length - 1)));
        var bk = out[idx];
        if (bk != null && !picked[bk]) next = bk;
      }
      if (next < 0) {
        // 少ない件数でも「上から順」にしない: まず 1つ飛ばし以上を狙う
        if (n >= 4 && r < 0.6) {
          var far = cur + 2 + Math.floor(Math.random() * Math.min(5, n - 2));
          if (far < n && !picked[far]) next = far;
          else if (cur - 2 >= 0 && !picked[cur - 2]) next = cur - 2;
        }
        if (next < 0) {
          if (r < 0.55) next = cur + (1 + Math.floor(Math.random() * 3)) * (Math.random() < 0.82 ? 1 : -1); // 近く
          else if (r < 0.85) next = cur + (4 + Math.floor(Math.random() * 7)) * (Math.random() < 0.6 ? 1 : -1); // 少し飛ぶ
          else next = Math.floor(Math.random() * n); // 大きく飛ぶ（目にとまった所）
        }
      }
      // 範囲外・もう押した所なら捨てる（必ず空いている所を選ぶ）
      if (!(next >= 0 && next < n) || picked[next]) next = -1;
      if (next < 0) {
        // 前後で空いている所を探す（近い順）
        for (var k = 1; k <= n && next < 0; k++) {
          if (cur + k < n && !picked[cur + k]) next = cur + k;
          else if (cur - k >= 0 && !picked[cur - k]) next = cur - k;
        }
      }
      if (next < 0) { for (var j = 0; j < n; j++) if (!picked[j]) { next = j; break; } }
      if (next < 0) break;
      picked[next] = 1; out.push(next);
    }
    return out;
  }
  /** 自動便の指定を引く時の顧客 ID（スナップショット → キャッシュ → null） */
  var _currentCustomerIdCache = null;
  try {
    chrome.storage.local.get(["current_customer_id"], function (r) {
      _currentCustomerIdCache = (r && r.current_customer_id) || null;
    });
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area === "local" && ch.current_customer_id) {
        _currentCustomerIdCache = (ch.current_customer_id.newValue != null) ? ch.current_customer_id.newValue : null;
      }
    });
  } catch (_) {}
  function _pickCustomerIdForAuto() {
    try {
      if (_pendingCustomerForAutoSend && _pendingCustomerForAutoSend.customerId) return _pendingCustomerForAutoSend.customerId;
      return _currentCustomerIdCache || null;
    } catch (_) { return null; }
  }

  /** 最後に付けた送付済みの材料（一覧が描き直されても再付与できる） */
  var _sentMarkCtx = null; // { customerId, resp, at }

  /**
   * ★ 2026-11-16: 自動押下の直前に送付済みを読む（通常＝案内と同じ出所）。
   *   バッチ以外でも `axlx_sent_rooms` を埋めてから選別する。
   *   さらに通常と同じ印（`.axlx-pdf-sent`）を付けて、画面でも「把握できている」状態にする。
   */
  function _ensureSentRoomsForAuto(customerId, done) {
    var cb = typeof done === "function" ? done : function () {};
    // ★ 2026-11-22: スタッフ選んだ客の自動でも送付済みを読んで飛ばす
    if (!customerId || (_staffModeOn && !_autoModeOn)) { cb(false); return; }
    try {
      // 通常（案内）と同じ API 経路 → storage にも置き、印も付ける
      chrome.runtime.sendMessage({ type: "axlx-guide-sent-rooms", customerId: String(customerId) }, function (resp) {
        try { if (chrome.runtime.lastError) { cb(false); return; } } catch (_) {}
        try {
          var SK = _SK();
          var key = SK ? SK.STORAGE_KEY : "axlx_sent_rooms";
          chrome.storage.session.get([key], function (r) {
            _sentRoomsStored = (r && r[key]) || null;
            if (!_sentRoomsStored && resp && Array.isArray(resp.rooms)) {
              _sentRoomsStored = { customerId: String(customerId), rooms: resp.rooms, at: Date.now() };
            }
            var n = _sentRoomsStored && Array.isArray(_sentRoomsStored.rooms) ? _sentRoomsStored.rooms.length : 0;
            console.log("[AXLX bulk-dl][auto] 送付済みを読み込み: " + n + "件 customer=" + customerId + (resp && resp.ok ? "" : "（読込失敗→絞らず）"));
            _sentMarkCtx = { customerId: String(customerId), resp: resp || null, at: Date.now() };
            try { _markSentLikeGuide(customerId, resp); } catch (_) {}
            try { _markSentBuildingsLikeGuide(customerId); } catch (_) {}
            try {
              _graspAcquire(
                "sent_loaded",
                !!(resp && resp.ok) || n > 0,
                "DB送付済" + n + "件" + (resp && resp.ok ? "" : "（API弱→印だけで把握）")
              );
            } catch (_) {}
            cb(!!(resp && resp.ok));
          });
        } catch (_) { cb(!!(resp && resp.ok)); }
      });
    } catch (_) { cb(false); }
  }

  /** 一覧が描き直されたあと、キャッシュで印を付け直す（API を叩き直さない） */
  function _reapplySentMarksIfAny() {
    // ★ 2026-11-22: スタッフ選んだ客の自動でも印を付け直す（送付済みを飛ばすため）
    if (!_autoModeOn) return;
    var ctx = _sentMarkCtx;
    var cid = (ctx && ctx.customerId) || _pickCustomerIdForAuto();
    if (!cid) return;
    // 材料が新しい（15分以内）なら付け直し。古ければ読み直す
    if (ctx && ctx.customerId === String(cid) && ctx.at && Date.now() - ctx.at < 15 * 60 * 1000) {
      try { _markSentLikeGuide(cid, ctx.resp); } catch (_) {}
      try { _markSentBuildingsLikeGuide(cid); } catch (_) {}
      return;
    }
    try { _ensureSentRoomsForAuto(cid, function () {}); } catch (_) {}
  }

  /**
   * ★ 2026-11-16: 通常（案内）と同じ見た目・印を自動にも付ける。
   *   PDF に「送付済み」ラベル・チェック不可。押す選別（_rowSkipReason）もこれを見る。
   *   号室一致 → 「送付済み」。案内の clearPdfMarks で消されても inject/rescan で付け直す。
   */
  function _markSentLikeGuide(customerId, resp) {
    var SK = _SK();
    var R = (typeof self !== "undefined" ? self : window).AxlxRealproRows;
    if (!SK || !customerId) return;
    // 案内 CSS が無い自動モードでも印が見えるようにする
    try {
      if (!document.getElementById("axlx-auto-sent-css")) {
        var st = document.createElement("style");
        st.id = "axlx-auto-sent-css";
        st.textContent = ".axlx-pdf-sent{opacity:.45;cursor:not-allowed}.axlx-pdf-sent-label{margin-left:4px;font-size:10px;font-weight:700;padding:1px 5px;border-radius:6px;background:#e3f2fd;color:#0d47a1;vertical-align:middle}";
        (document.head || document.documentElement).appendChild(st);
      }
    } catch (_) {}
    var rooms = (resp && Array.isArray(resp.rooms)) ? resp.rooms
      : (_sentRoomsStored && Array.isArray(_sentRoomsStored.rooms) ? _sentRoomsStored.rooms : []);
    var custRooms = (resp && Array.isArray(resp.customerRooms)) ? resp.customerRooms : null;
    // indexFor は TTL 付き。付け直し用に buildIndex を直接も使う
    var idx = SK.indexFor({ customerId: String(customerId), rooms: rooms, at: Date.now() }, customerId, Date.now());
    if (!idx && rooms.length) idx = SK.buildIndex(rooms);
    var custIdx = custRooms ? SK.indexFor({ customerId: String(customerId), rooms: custRooms, at: Date.now() }, customerId, Date.now()) : null;
    if (!custIdx && custRooms && custRooms.length) custIdx = SK.buildIndex(custRooms);
    if (!idx && !custIdx) {
      console.log("[AXLX bulk-dl][auto] 送付済み印: 索引0（rooms=" + rooms.length + "）");
      return;
    }
    var rows = (R && typeof R.list === "function") ? (R.list() || []) : [];
    // tracked が空だと list も空 → tracked から直接作る
    if (!rows.length && tracked.length) {
      rows = tracked.map(function (t) {
        if (!t || !t.btn) return null;
        var card = null;
        try { card = extractCard(t.btn); } catch (_) { card = null; }
        if (!card) return { name: null, room: null, btn: t.btn, cb: t.cb };
        var labels = card.headerIdx && card.headerIdx.labels;
        var roomCol = !(labels && labels.length && !/部屋|号室/.test(String(labels[0] || "")));
        var c0 = card.cells ? card.cells[0] : null;
        return { name: card.name, room: roomCol && SK ? SK.roomFromRealproCell(c0) : null, btn: t.btn, cb: t.cb };
      }).filter(Boolean);
    }
    var marked = 0;
    var noRoom = 0;
    rows.forEach(function (r) {
      if (!r || !r.btn || !r.btn.classList) return;
      if (!r.room) { noRoom++; return; }
      // 通常（案内）と同じ: お客様に届けた部屋を優先。無い時は共有含む全部
      var sentCust = !!(custIdx && SK.isSentRoom(custIdx, r.name, r.room));
      var sent = !!(idx && SK.isSentRoom(idx, r.name, r.room));
      if (!(sentCust || sent)) return;
      r.btn.classList.add("axlx-pdf-sent");
      if (r.cb) try { r.cb.disabled = true; r.cb.checked = false; } catch (_) {}
      var lab = null;
      try {
        if (r.btn.parentNode) {
          lab = r.btn.parentNode.querySelector(".axlx-pdf-sent-label");
        }
      } catch (_) {}
      if (!lab && r.btn.parentNode) {
        lab = document.createElement("span");
        lab.className = "axlx-pdf-sent-label";
        lab.textContent = "送付済み";
        try { lab.style.cssText = "margin-left:4px;font-size:10px;font-weight:700;padding:1px 5px;border-radius:6px;background:#e3f2fd;color:#0d47a1;vertical-align:middle"; } catch (_) {}
        r.btn.parentNode.insertBefore(lab, r.btn.nextSibling);
      }
      marked++;
    });
    console.log("[AXLX bulk-dl][auto] 送付済み印: " + marked + "件／行" + rows.length + "（号室なし" + noRoom + "・rooms" + rooms.length + "）");
    try { _acquireGrasp.sentMarked = marked; } catch (_) {}
    if (marked) _nudge("👀 送付済み " + marked + "件を把握（通常と同じ）");
    try {
      _graspAcquire(
        "sent_marked",
        true,
        "画面印" + marked + "/" + rows.length + "（号室なし" + noRoom + "）→送った行は押さない"
      );
    } catch (_) {}
  }

  /** 号室の無い送付記録は建物印（通常の sent-check と同じ） */
  var _sentCheckSigAuto = "";
  function _markSentBuildingsLikeGuide(customerId) {
    if (!customerId || (_staffModeOn && !_autoModeOn)) return;
    var R = (typeof self !== "undefined" ? self : window).AxlxRealproRows;
    if (!R || typeof R.list !== "function" || typeof R.markSentForServer !== "function") return;
    var rows = R.list() || [];
    if (!rows.length) return;
    var payload = rows.map(function (r) { return { name: (r && r.name) || "", room: (r && r.room) || "", url: (r && r.url) || null }; });
    var sig = String(customerId) + "#" + payload.map(function (p) { return p.name + "|" + p.room; }).join(",");
    if (sig === _sentCheckSigAuto) return;
    _sentCheckSigAuto = sig;
    try {
      chrome.runtime.sendMessage({ type: "axlx-guide-sent-check", customerId: String(customerId), rows: payload }, function (resp) {
        try { if (chrome.runtime.lastError) return; } catch (_) {}
        if (!resp || !resp.ok) return;
        try { R.markSentForServer(resp.dropped || []); } catch (_) {}
      });
    } catch (_) {}
  }

  /**
   * ★ 2026-11-16 竹内さん「同じ平米は最安／送付済みは自動でも理解」:
   *   ⚠ 真の原因: `_startAutoPressRun` が **全行をそのまま押す**だけで、
   *     旧一括の `_selectAllowed`（送付済み・同じ建物×間取り×平米の最安）を通していなかった。
   *     通常（案内）は `axlx-guide-sent-rooms` で隠すので分かっていた。自動は別経路。
   *   → 押す前に同じ物差しで絞る。
   */
  function _filterCandForAuto(cand, customerId) {
    var list = Array.isArray(cand) ? cand.slice() : [];
    var state = {
      customerId: customerId || null,
      currentPage: 1,
      updateStop: null,
      cheapestSkipped: 0,
      pageSkipped: 0,
    };
    // 前回の印を消す（行の再利用対策）
    list.forEach(function (t) {
      if (!t) return;
      try { delete t.__axSkip; delete t.__axCheapestSkip; } catch (_) {}
    });
    var allowed = [];
    var sent = 0;
    list.forEach(function (t) {
      var why = _rowSkipReason(state, t);
      if (why === "sent") { sent++; t.__axSkip = true; return; }
      allowed.push(t);
    });
    if (sent) {
      console.log("[AXLX bulk-dl][auto] 送付済みの部屋 " + sent + "件は押さない（通常と同じ物差し）");
      _tmark("auto_sent_skip", String(sent) + "件");
    }
    try {
      // スタッフでも自動押しでは 2㎡以内の高い部屋を落とす（手選びは別経路）
      var cheap = _applyCheapestPerLayout(state, allowed, { forAuto: true });
      if (cheap && cheap.dropped) {
        allowed = allowed.filter(function (t) { return !(t && t.__axCheapestSkip); });
        _tmark("auto_cheapest_skip", cheap.dropped + "件を最安1件に(≤2㎡)");
      }
    } catch (e) {
      console.warn("[AXLX bulk-dl][auto] 最安絞り失敗（絞らず続行）:", (e && e.message) || e);
    }
    return { allowed: allowed, sent: sent, cheapest: state.cheapestSkipped || 0, state: state };
  }
  /**
   * ★ 2026-11-20 (2.8.143) 実測 audit #1551 P2: 「送る8件」のうち送ったのは1件・押したのは2回で、
   *   残り6件を押さずに飛ばした理由がどこにも残らず、正しく飛ばしたのか取りこぼしたのか分からなかった。
   *   → 押す途中で飛ばした理由を数え、auto_pdf_end に載せる。
   */
  function _tallySkip(why) {
    try {
      if (!_autoPdfRun) return;
      var w = _autoPdfRun.skipWhy || (_autoPdfRun.skipWhy = {});
      var key = String(why || "?").slice(0, 20);
      w[key] = (Number(w[key]) || 0) + 1;
    } catch (_) {}
  }
  function _skipWhyText(run) {
    var w = run && run.skipWhy;
    if (!w) return "";
    var parts = [];
    for (var k in w) parts.push(k + "×" + w[k]);
    return parts.length ? "／途中で飛ばした理由: " + parts.join("・") : "";
  }
  function _autoPressNext(list) {
    if (!_autoPdfRun) return;
    if (_haltAutoPdfForNewFill("press_next")) return;
    if (_autoPdfRun.stopped) { _autoFinish("止めました"); return; }
    if (!_autoModeOn) { _autoFinish("モードが変わったので止めました"); return; }
    if (_autoPdfRun.index >= list.length) { _autoFinish("全部終わりました"); return; }
    var item = list[_autoPdfRun.index++];
    /** 飛ばしは setTimeout で次へ（同期再帰でスタック／1件目送付済みで止まるのを防ぐ） */
    var _skipToNext = function (why) {
      _autoPdfRun.skipped = (Number(_autoPdfRun.skipped) || 0) + 1;
      _tallySkip(why);
      console.log("[AXLX bulk-dl][auto] 飛ばして次へ:", why, String((item && item.btn && item.btn.href) || "").slice(0, 70));
      // ★ 2026-11-17: 80-200ms一様は機械的。人間は次行を目で追う（中央≈450・長尾）
      var Hsk = (typeof self !== "undefined" ? self : window).AxlxHumanWait;
      var skipMs = Hsk && Hsk.logNormalDelay ? Hsk.logNormalDelay(450, 0.55) : (280 + Math.floor(Math.random() * 420));
      if (skipMs < 160) skipMs = 160;
      if (skipMs > 1600) skipMs = 1600;
      setTimeout(function () { _autoPressNext(list); }, Math.round(skipMs));
    };
    if (!item || !item.cb || !item.btn || !item.btn.isConnected) { _skipToNext("行なし"); return; }
    var url = item.btn.href;
    // 送った行は押さない（この回で既に押した URL）
    if (_onePdfSent[url]) {
      /**
       * ★ 2026-11-14 竹内さん「送付済みで物件なければ次へ移動する部分」
       *   ⚠ 旧は**飛ばすだけで数えていなかった**ので、「全部送付済み」を判定できず、次ページへ進めなかった。
       *   → 飛ばした数を数える（`_autoFinish` が「0件送信＋1件以上飛ばした」で次ページへ進む）。
       */
      _skipToNext("送った行");
      return;
    }
    /**
     * ★ 2026-11-16: 押す直前にもう一度送付済み／最安除外を確かめる（一覧の作り直し対策）。
     * ★ 2026-11-17: 1件目送付済みでも2件目へ必ず進む（同期再帰やぶら下がり待ちで止まらない）。
     */
    if (item.__axSkip || item.__axCheapestSkip) {
      _skipToNext(item.__axCheapestSkip ? "最安除外" : "送付済み印");
      return;
    }
    try {
      var _st = { customerId: (_autoPdfRun && _autoPdfRun.customerId) || _pickCustomerIdForAuto(), currentPage: 1 };
      if (_rowSkipReason(_st, item) === "sent") {
        item.__axSkip = true;
        try {
          if (item.btn.classList) item.btn.classList.add("axlx-pdf-sent");
        } catch (_) {}
        _skipToNext("送付済み");
        return;
      }
    } catch (_) {}
    _autoPdfRun.total++;
    _setStatusNowNext(
      "自動で物件を送っています（" + _autoPdfRun.total + "件目）",
      "資料確認 → 次の物件"
    );
    try {
      var _sbAuto = document.getElementById("axlx-autopdf-stop-btn");
      if (_sbAuto) _sbAuto.style.display = "block";
    } catch (_) {}
    // 人が押すのと同じ: 行までカーソルが動いて「印刷用PDF」を押す → 押した合図（axlx-pdf-captured）で1件送る
    _pressPrintPdf(item, function (pressed) {
      try { if (pressed) _touchPipelineProgress("pdf_press"); } catch (_) {}
      if (!pressed) {
        _tallySkip("押せず");
        console.warn("[AXLX bulk-dl][auto] 印刷用PDFを押せませんでした（次へ）:", String(url).slice(0, 70));
        var Hf = (typeof self !== "undefined" ? self : window).AxlxHumanWait;
        var failMs = Hf && Hf.logNormalDelay ? Hf.logNormalDelay(1100, 0.45) : (900 + Math.floor(Math.random() * 600));
        setTimeout(function () { _autoPressNext(list); }, Math.round(failMs));
        return;
      }
      // 押した直後にもう一度送付済みなら送信待ちせず次へ（confirm やぶら下がり防止）
      try {
        var _st2 = { customerId: (_autoPdfRun && _autoPdfRun.customerId) || _pickCustomerIdForAuto(), currentPage: 1 };
        if (_rowSkipReason(_st2, item) === "sent") {
          item.__axSkip = true;
          _autoPdfRun.skipped = (Number(_autoPdfRun.skipped) || 0) + 1;
          _tallySkip("押した直後に送付済み");
          console.log("[AXLX bulk-dl][auto] 押した直後に送付済みと判明 → 次へ");
          var Hs2 = (typeof self !== "undefined" ? self : window).AxlxHumanWait;
          var sentMs = Hs2 && Hs2.logNormalDelay ? Hs2.logNormalDelay(480, 0.5) : (320 + Math.floor(Math.random() * 360));
          setTimeout(function () { _autoPressNext(list); }, Math.round(sentMs));
          return;
        }
      } catch (_) {}
      // 押した合図で sendOnePdfNow が走る。終わる（_pdfBusy が false に戻る）のを待ってから次へ
      var _wpCid = (_autoPdfRun && _autoPdfRun.customerId) || _pickCustomerIdForAuto();
      _waitPdfIdle(function () {
        if (_autoPdfRun) _autoPdfRun.done++;
        var Hn = (typeof self !== "undefined" ? self : window).AxlxHumanWait;
        // 人間実測 p50≈1s。500+一様700 は機械的 → 対数正規
        var nextMs = Hn && Hn.logNormalDelay ? Hn.logNormalDelay(900, 0.55) : (500 + Math.floor(Math.random() * 900));
        if (Math.random() < 0.1) nextMs += 600 + Math.floor(Math.random() * 1200);
        if (nextMs < 350) nextMs = 350;
        if (nextMs > 4500) nextMs = 4500;
        setTimeout(function () { _autoPressNext(list); }, Math.round(nextMs));
      }, _wpCid);
    });
  }
  /** 「印刷用PDF」のリンクを人が押す形で押す（カーソル → 押す → 反応を見る） */
  function _pressPrintPdf(item, cb) {
    var P = (typeof self !== "undefined" ? self : window).AxlxPointerUi;
    var H = (typeof self !== "undefined" ? self : window).AxlxHumanWait;
    var btn = item.btn;
    var fired = false;
    var fire = function () {
      if (fired) return;
      fired = true;
      _humanScrollToEl(btn);
      /**
       * 2026-11-11 竹内さん「ボタンを押す際のたまにある迷いや選択の部分も人間のように動くよう」:
       *   押す前に「ためらい」を入れる（人が『これでいいかな』と手を止める形）。
       *   ・15% … 迷い（3段: 250〜650ms／700〜1600ms／1800〜4500ms）
       *   ・その間、カーソルが目標の周りで小さく漂う（pointer-ui の drift）
       *   ・押す直前に狙いを少し外して戻す（wander）こともある
       *   ⚠ 合計は最大 5.2秒まで（止まったように見せない）
       */
      var hesitate = 0;
      if (Math.random() < 0.15 * (0.75 + Math.random() * 0.5)) {
        var hr = Math.random();
        hesitate = hr < 0.65 ? 250 + Math.floor(Math.random() * 400)
          : hr < 0.95 ? 700 + Math.floor(Math.random() * 900)
          : 1800 + Math.floor(Math.random() * 2700);
      } else if (Math.random() < 0.10) {
        hesitate = 300 + Math.floor(Math.random() * 600); // 軽い一息
      }
      if (hesitate > 5200) hesitate = 5200;
      var doClick = function () {
        // 押す前の狙い直し（10%で少し外して戻る）
        var pre = function (next) {
          if (Math.random() < 0.10 && P && P.wander) {
            P.wander(btn, 300 + Math.floor(Math.random() * 500)).then(next, next);
          } else next();
        };
        pre(function () {
          var gap = 90 + Math.floor(Math.random() * 260); // 押す直前の「狙いを定める」間
          setTimeout(function () {
            try { if (P && P.tap) P.tap(); } catch (_) {}
            setTimeout(function () {
              try { btn.click(); } catch (_) {}
              console.log("[AXLX bulk-dl][auto] 印刷用PDFを押しました:", String(btn.href || "").slice(0, 80));
              cb(true);
            }, 70 + Math.floor(Math.random() * 130));
          }, gap);
        });
      };
      if (hesitate > 0 && P && P.drift) {
        // 迷いの間、カーソルがその場で小さく漂う（人が考えながら手を漂わせる形）
        P.drift(Math.min(hesitate, 1500), { radius: 10 + Math.random() * 16 }).then(doClick, doClick);
        if (hesitate > 1500) setTimeout(doClick, hesitate); // 長い迷いは後半は止まって考える
      } else if (hesitate > 0) {
        setTimeout(doClick, hesitate);
      } else {
        doClick();
      }
    };
    if (P && P.moveToEl) {
      try { P.ensure(); } catch (_) {}
      P.moveToEl(btn).then(fire, fire);
      // カーソルが動けない時も必ず押す（止まらない）
      setTimeout(function () { if (!fired) fire(); }, 3000);
    } else fire();
  }
  /**
   * 2026-11-11 竹内さん「弱い部分あれば人間の動きになるように強化する」:
   *   その行を画面に入れる。⚠ 2026-10-06 v2.6.12 の決定「真ん中へ寄せて細かく往復しない」は今も守る
   *   （block を center/start に散らすと、行が上下して画面が暴れる）。人の揺らぎは待ち時間の方で出す。
   */
  function _humanScrollToEl(el) {
    if (!el || !el.scrollIntoView) return;
    try { el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" }); } catch (_) {
      try { el.scrollIntoView(); } catch (__) {}
    }
  }
  /**
   * 1件の処理（送信中・確認中）が終わるまで待つ。
   * ★ 2026-11-17: 送付済み1件目で `_pdfBusy` が立たない／立ったまま → 2件目の前で止まるのを防ぐ。
   *   ・一度も busy にならなければ約2.5秒で次へ（キャプチャ未発火）
   *   ・busy が立ったら終わるまで待つ（上限45秒）
   */
  function _waitPdfIdle(cb, customerId) {
    var waited = 0;
    var sawBusy = !!_pdfBusy;
    var done = false;
    var lastPing = 0;
    var finish = function (why) {
      if (done) return;
      done = true;
      if (why) console.warn("[AXLX bulk-dl][auto] 1件待ち打ち切り → 次へ:", why);
      try { cb(); } catch (_) {}
    };
    var poll = function () {
      if (_pdfBusy) sawBusy = true;
      if (!_pdfBusy && sawBusy) { finish(null); return; }
      // 押した後、捕捉を待っている間（_clickSendPending）はまだ始まっていないだけ＝次を押さない（1件ずつ）
      if (!_pdfBusy && !sawBusy && waited >= 2500 && !_clickSendPending()) { finish("送信が始まらない"); return; }
      var now = Date.now();
      if (sawBusy && now - lastPing > 5000) {
        lastPing = now;
        try { _batchProgressPing(customerId || _pickCustomerIdForAuto()); } catch (_) {}
      }
      var Hp = (typeof self !== "undefined" ? self : window).AxlxHumanWait;
      var tick = Hp && Hp.logNormalDelay ? Hp.logNormalDelay(420, 0.35) : (320 + Math.floor(Math.random() * 200));
      if (tick < 220) tick = 220;
      if (tick > 900) tick = 900;
      waited += tick;
      if (waited > 45000) { finish("45秒タイムアウト"); return; }
      setTimeout(poll, Math.round(tick));
    };
    var H0 = (typeof self !== "undefined" ? self : window).AxlxHumanWait;
    var first = H0 && H0.logNormalDelay ? H0.logNormalDelay(380, 0.4) : 400;
    setTimeout(poll, Math.round(first));
  }
  /**
   * ★ 2026-11-16 竹内さん「送ったら次のページへ／最大3で大丈夫／新着は最大5」
   *   ⚠ 旧の自動押下は「全部送付済みの時だけ次へ・最大3回」。
   *     → 未送付を1件でも送ると**そのページで終わって**2ページ目以降へ行かなかった。
   *   新: このページの処理が終わったら（送った／全部送付済みのどちらでも）次へ。
   *     上限は resolveMaxPages（既定3・新着/言い直し5）。次が無ければ終わる。
   */
  var _autoNextPageTries = 0;
  var _autoPdfPage = 1;
  var _autoPdfTotalSent = 0;
  function _autoMaxPages() {
    // 2026-11-16 竹内「最大3で大丈夫／新着のお客さんは最大5まで」
    try {
      var cid = _pickCustomerIdForAuto();
      var opts = _autoRunFor(cid);
      var A = _AR();
      if (A && A.resolveMaxPages) return A.resolveMaxPages(opts, null);
      var lim = A ? A.pageLimit(opts, null) : null;
      if (lim && lim > 0) return lim;
      if (A && A.DEFAULT_MAX_PAGES) return A.DEFAULT_MAX_PAGES;
    } catch (_) {}
    return 3;
  }
  function _autoFinish(why) {
    var n = _autoPdfRun ? _autoPdfRun.done : 0;
    var skipped = _autoPdfRun ? (Number(_autoPdfRun.skipped) || 0) : 0;
    var whyText = _skipWhyText(_autoPdfRun);
    _autoPdfRun = null;
    _autoPdfTotalSent = (Number(_autoPdfTotalSent) || 0) + (Number(n) || 0);
    var allSkipped = (n === 0 && skipped > 0);
    var page = Number(_autoPdfPage) || 1;
    var maxP = _autoMaxPages();
    try {
      _acquireGrasp.pressed = n;
      _acquireGrasp.sentSkipped = skipped;
      _graspAcquire(
        allSkipped ? "all_sent_page" : "page_done",
        true,
        "P" + page + " 送った" + n + "／送付済飛ばし" + skipped + "／" + String(why || "").slice(0, 40)
          + (allSkipped ? "→送付済把握OK・次へ" : "")
      );
    } catch (_) {}
    _tmark("auto_pdf_end", "P" + page + " " + why + " " + n + "件" + (skipped ? "（送付済みで飛ばした " + skipped + "件）" : "") + whyText);
    console.log("[AXLX bulk-dl][auto] P" + page + "/" + maxP + " 終了: " + why + "（この頁 " + n + "件送信・飛ばし " + skipped + "・累計 " + _autoPdfTotalSent + "件）");
    var stopBtn = document.getElementById("axlx-autopdf-stop-btn");
    if (stopBtn) stopBtn.style.display = "none";
    _paintPdfProgress();
    /**
     * 次ページへ進む条件:
     *   ・まだ上限（既定5）未満
     *   ・次ボタンがある
     *   ・このページで「何かしら処理した」（送った／送付済みで飛ばした）
     *   ※ 送ったあとでも次へ行く（旧は送ったら止まっていた）
     */
    var canNext = page < maxP && (n > 0 || allSkipped);
    // ★ 2026-11-16: 次ページ直後に行がまだ無くて 0件で終わっても、上限未満なら次を試す
    //   （「2までは行くが3に行かない」＝行待ち失敗で止まっていた）
    if (!canNext && page < maxP && /見つかりません|no-rows|行/.test(String(why || ""))) {
      canNext = true;
    }
    if (canNext) {
      var hasNext = false;
      try { hasNext = !!(typeof _findNextPageEl === "function" && _findNextPageEl()); } catch (_) { hasNext = false; }
      if (hasNext) {
        if (allSkipped) _nudge("👀 P" + page + " は全部送付済み（" + skipped + "件）→ 次のページへ");
        else if (n > 0) _nudge("✅ P" + page + " で " + n + "件送った → 次のページへ（上限 " + maxP + "）");
        else _nudge("👉 P" + page + " の行が揃わなかった → 次のページを試す（上限 " + maxP + "）");
        // 手順書 next×画面の次ボタンを照合してから進む（AD後も次ページへ）
        _guideLikeListFlowGrasp("before_next", function (g) {
          try { _liveDlStep("next_flow_grasp", (g && g.summary ? g.summary : "before_next").slice(0, 60)); } catch (_) {}
          try {
            _autoNextPageThenRestart(why, { sentThisPage: n, skipped: skipped, allSkipped: allSkipped });
          } catch (_) {
            _nudge("🤖 自動 " + why + "（累計 " + _autoPdfTotalSent + "件）");
            _sendBatchDone(_autoPdfTotalSent, why, skipped);
          }
        });
        return;
      }
      // ★ 2.8.248: 次無し／1ページのみ → _sendBatchDone 一本化（旧は印だけ残して客完了が薄かった）
      _guideLikeListFlowGrasp("before_next", function (g) {
        try {
          _liveDlStep(
            "next_flow_grasp",
            (g && g.summary ? g.summary : "before_next_no_btn").slice(0, 60),
          );
        } catch (_) {}
        var onlyOne = false;
        try {
          var _pstEnd = typeof _readPagerState === "function" ? _readPagerState() : null;
          onlyOne = !!( _pstEnd && _pstEnd.onlyOnePage);
          if (onlyOne) {
            _liveDlStep("list_page_one_only", "物件見終わった・1ページのみ→外す");
          } else {
            _liveDlStep("list_no_next_advance", "次ページ無し→客完了へ");
          }
        } catch (_) {}
        if (allSkipped) {
          try { _liveDlStep("all_sent_done", "次無し・送付済のみ→客完了→外す"); } catch (_) {}
        }
        _nudge("🤖 自動 " + why + "（累計 " + _autoPdfTotalSent + "件・P" + page + "/" + maxP + "・次無し→外す）");
        _sendBatchDone(
          _autoPdfTotalSent,
          why + (onlyOne ? "・1ページのみ" : "・次ページ無し") + (allSkipped ? "・送付済のみ" : ""),
          skipped,
        );
      });
      return;
    }
    /**
     * ★ 2026-11-20 (2.8.146) 竹内さん「次へのところも２つ目で終わって3つ目にいかなかった」:
     *   実測 #1556: 午後の便の命令は max_pages=2（PM_PLAN）。上限で止まったのに記録も画面も「P2 全部終わりました」で、
     *   上限で止めたのか次のページが無かったのか分からなかった。→ 止めた理由（上限・次のページの有無・上限の出どころ）を残して見せる。
     * ★ 2.8.248: 上限到達なども _sendBatchDone 一本化（二重送信・series印抜けを廃止）
     */
    var _nextLeft = false;
    try { _nextLeft = !!(typeof _findNextPageEl === "function" && _findNextPageEl()); } catch (_) { _nextLeft = false; }
    var _limSrc = "既定";
    try {
      var _ro = _autoRunFor(_pickCustomerIdForAuto());
      if (_ro && Number(_ro.max_pages) > 0) _limSrc = "便の指定" + Number(_ro.max_pages);
    } catch (_) {}
    if (page >= maxP) {
      _tmark("auto_page_limit", "P" + page + "/" + maxP + " 上限で終わり（" + _limSrc + "）" + (_nextLeft ? "・次のページあり" : "・次のページ無し"));
      if (_nextLeft) _nudge("📄 上限 " + maxP + "ページ（" + _limSrc + "）で終わり・次のページは見ていません");
    } else {
      _tmark("auto_page_stop", "P" + page + "/" + maxP + " 上限前に終わり" + (_nextLeft ? "（次のページあり・送った" + n + "件）" : "（次のページ無し）"));
    }
    _nudge("🤖 自動 " + why + "（累計 " + _autoPdfTotalSent + "件・P" + page + "/" + maxP + "）");
    _sendBatchDone(_autoPdfTotalSent, why + "・P" + page + "/" + maxP, skipped);
  }
  /**
   * ★ 2026-11-14／2026-11-16: 次のページへ進んで押し直す（上限5ページ）。
   *   送付済みだけの頁でも、未送付を送った頁のあとでも進む。
   */
  function _autoNextPageThenRestart(why, meta) {
    var maxP = _autoMaxPages();
    if (_autoNextPageTries >= (maxP - 1)) {
      console.log("[AXLX bulk-dl][auto] ページ上限 " + maxP + " に達した → 終わります");
      _nudge("🤖 自動 " + why + "（" + maxP + "ページまで見ました・累計 " + _autoPdfTotalSent + "件）");
      _sendBatchDone(_autoPdfTotalSent, why + "・P" + maxP + "まで", meta && meta.skipped);
      return;
    }
    var btn = null;
    try { btn = (typeof _findNextPageEl === "function") ? _findNextPageEl() : null; } catch (_) { btn = null; }
    if (!btn) {
      console.log("[AXLX bulk-dl][auto] 次のページが無い → 終わります");
      _nudge("🤖 自動 " + why + "（次のページなし・累計 " + _autoPdfTotalSent + "件）");
      _sendBatchDone(_autoPdfTotalSent, why + "・次ページ無し", meta && meta.skipped);
      return;
    }
    _autoNextPageTries++;
    _autoPdfPage = (Number(_autoPdfPage) || 1) + 1;
    _tmark("auto_next_page", "→P" + _autoPdfPage + "（" + _autoNextPageTries + "回目）");
    /**
     * ★ 2026-11-18 DB実測: `td.pager`（onclick="pager(...)"）を押すと 2〜6秒後に録画の ring_empty が出る
     *   ＝**ページ全体が読み直される**（直近2日の3回とも）。下の `_waitRows` はメモリ上の続きなので読み直しで消え、
     *   自動は2頁目で黙って止まっていた（直近2日、自動が次を押した後に送った例は0）。
     *   → 押す前に続きの印を session に置き、読み直した画面の start() で続きから押し直す。
     */
    // 番号は押し始めたお客さん（_autoRunCid）を先に使う。時刻は押す直前にも付け直す（待ちの間に古くならない・2026-11-20）
    var _nextMark = {
      page: _autoPdfPage,
      tries: _autoNextPageTries,
      total: _autoPdfTotalSent,
      customerId: _autoRunCid || _pickCustomerIdForAuto() || null,
      at: Date.now(),
    };
    try { chrome.storage.session.set({ axlx_auto_next_page: _nextMark }); } catch (_) {}
    console.log("[AXLX bulk-dl][auto] 次のページへ進みます → P" + _autoPdfPage + "/" + maxP
      + (meta && meta.allSkipped ? "（前頁は全部送付済み）" : "（前頁で送信あり）"));
    _nudge("👉 次のページへ（P" + _autoPdfPage + "/" + maxP + "）");
    /**
     * ★ 2026-11-16: 次へもカーソル付きで押す（通常の「左の次｜td.pager」と同じ形）。
     */
    try {
      if (typeof _humanScrollToEl === "function") _humanScrollToEl(btn);
    } catch (_) {}
    var _oldRowBtns = [];
    try { _oldRowBtns = tracked.map(function (t) { return t && t.btn; }).filter(Boolean); } catch (_) { _oldRowBtns = []; }
    setTimeout(function () {
      try {
        if (!btn || !btn.isConnected) {
          try { btn = (typeof _findNextPageEl === "function") ? _findNextPageEl() : null; } catch (_) { btn = null; }
        }
        if (!btn || !btn.isConnected) {
          // 黙って止まらない: 次が押せないなら、ここまでで終わりの合図を出す（2026-11-20 連続のお客さんが待たされない）
          try { chrome.storage.session.remove("axlx_auto_next_page"); } catch (_) {}
          _tmark("auto_next_page", "btn_gone");
          _sendBatchDone(_autoPdfTotalSent, why + "・次ボタンが外れた", meta && meta.skipped);
          return;
        }
        var P = window.AxlxPointerUi;
        var fire = function () {
          try {
            try { _nextMark.at = Date.now(); chrome.storage.session.set({ axlx_auto_next_page: _nextMark }); } catch (_) {}
            if (typeof window.__axlxRecNoteOp === "function") window.__axlxRecNoteOp("click", btn);
            btn.click();
          } catch (_) {}
        };
        if (P && P.moveToEl) {
          try { if (P.ensure) P.ensure(); } catch (_) {}
          // 着いてすぐ押さない（人は目で確かめてから押す・2026-11-20）
          P.moveToEl(btn).then(function () {
            setTimeout(function () {
              try { if (P.tap) P.tap(); } catch (_) {}
              fire();
            }, 160 + Math.floor(Math.random() * 420));
          }, fire);
        } else {
          fire();
        }
      } catch (_) {}
    }, 700 + Math.floor(Math.random() * 1200));
    // ページが読み直されるのを待って、もう一度押し始める（行が出るまで短くリトライ）
    var _waitRows = function (triesLeft) {
      /**
       * 前の頁の行がまだ画面にある＝読み直しの前。ここで続けると前の頁を押し直し、印も消してしまう。
       *   → 前の行が消えるまで待つ。消えないまま尽きたら、続きは読み直し後の start() に任せる（印は残す）。
       */
      var stillOld = false;
      try { stillOld = _oldRowBtns.some(function (b) { return b && b.isConnected; }); } catch (_) { stillOld = false; }
      if (stillOld) {
        if (triesLeft > 0) {
          setTimeout(function () { _waitRows(triesLeft - 1); }, 900 + Math.floor(Math.random() * 500));
          return;
        }
        console.warn("[AXLX bulk-dl][auto] 次を押しても前の頁の行が残ったまま → 読み直し後の続きに任せます");
        _tmark("auto_next_wait_reload", "P" + _autoPdfPage);
        _nudge("⏳ 次のページの読み込みを待っています（P" + _autoPdfPage + "）");
        return;
      }
      try {
        if (typeof _rescanRows === "function") _rescanRows();
      } catch (_) {}
      var n = 0;
      try { n = tracked.filter(function (t) { return t && t.btn && t.btn.isConnected; }).length; } catch (_) { n = 0; }
      if (n > 0 || triesLeft <= 0) {
        if (n <= 0) {
          console.warn("[AXLX bulk-dl][auto] 次ページの行がまだ出ない → それでも押せる物を探す");
          _tmark("auto_next_no_rows", "P" + _autoPdfPage);
        }
        // 読み直し無しで続けられた → 読み直し用の印は要らない（二重に始めない）
        try { chrome.storage.session.remove("axlx_auto_next_page"); } catch (_) {}
        // ★ continuePages: ページカウンタを消さない（3ページ目に進むため）
        // 次ページ到着後も手順表×画面照合（行が出たか）
        _guideLikeListFlowGrasp("after_next", function () {
          _startAutoPressAfterLook(n || 10, { continuePages: true });
        });
        return;
      }
      setTimeout(function () { _waitRows(triesLeft - 1); }, 900 + Math.floor(Math.random() * 500));
    };
    setTimeout(function () { _waitRows(4); }, 2600 + Math.floor(Math.random() * 1400));
  }
  /**
   * ★ 2.8.235: 物件取得完了→次客へ の一連把握を必ず残す（loop_advance 欠を止める）
   *   DB: series_done はあるが loop_advance／who／next_move が薄い。
   */
  function _stampSeriesToNextCustomer(why) {
    try {
      var bg = _bulkGraspState || {};
      var cur = String(bg.currentName || "").slice(0, 16) || "-";
      var nxt = String(bg.nextName || "").slice(0, 16);
      var pos = "";
      try {
        if (bg.index != null && bg.total) pos = "（" + bg.index + "/" + bg.total + "）";
      } catch (_) {}
      var onePage = false;
      try {
        var pst = typeof _readPagerState === "function" ? _readPagerState() : null;
        onePage = !!(pst && pst.onlyOnePage);
      } catch (_) {}
      if (onePage) {
        try { _liveDlStep("list_page_one_only", "取得完了・1ページのみ→次客"); } catch (_) {}
      }
      try {
        _liveDlStep(
          "loop_advance",
          (nxt
            ? ("客完了→次へ" + pos + " いま=" + cur + " 次=" + nxt)
            : ("客完了・一括末" + pos + " いま=" + cur)
          ).slice(0, 100),
        );
      } catch (_) {}
      try {
        _liveDlStep("loop_who_grasp", "いま客=" + cur + " 次客=" + (nxt || "（末）"));
      } catch (_) {}
      try {
        _liveDlStep("next_customer_grasp", "いま=" + cur + " 次客=" + (nxt || "（末）") + " " + String(why || "").slice(0, 20));
      } catch (_) {}
      try {
        _liveDlStep("next_move_grasp", "次の動き=前客の選択を1つずつ外す " + String(why || "").slice(0, 20));
      } catch (_) {}
      try {
        _liveDlStep("handoff_grasp", "取得完了→外す " + String(why || "").slice(0, 28));
      } catch (_) {}
      try {
        if (_bulkGraspState) {
          _bulkGraspState.nextMove = "前客の選択を1つずつ外す";
          _bulkGraspState.lastDone = onePage ? "1ページのみ物件取得完了" : "物件取得完了";
          _applyBulkGrasp(_bulkGraspState);
        }
      } catch (_) {}
      try {
        window.postMessage({
          from: "axlx-bulk-next",
          currentName: String(bg.currentName || ""),
          nextName: String(bg.nextName || ""),
          nextMove: "前客の選択を1つずつ外す",
        }, "*");
      } catch (_) {}
      try {
        window.postMessage({
          from: "axlx-series-handoff",
          why: String(why || "batch_done").slice(0, 40),
          currentName: String(bg.currentName || ""),
          nextName: String(bg.nextName || ""),
          nextMove: "前客の選択を1つずつ外す",
          onlyOnePage: onePage,
          sent: Number(bg.sentCount) || null,
        }, "*");
      } catch (_) {}
      try {
        window.postMessage({
          from: "axlx-task-grasp",
          now: null,
          done: onePage ? "1ページのみ・物件取得完了" : "物件取得完了",
          next: "前客の選択を1つずつ外す",
          kind: "handoff",
        }, "*");
      } catch (_) {}
    } catch (_) {}
  }
  try { window.__axlxStampSeriesToNext = _stampSeriesToNextCustomer; } catch (_) {}

  /**
   * ★ 2.8.265 竹内さん「なぜ次のお客さんのところに移らないのか／止まったら次に移る部分の把握できていないのか／
   *   画面照会して次に移る行動拡張ツールが指示出す形になっていないのか」:
   *   旧は送付完了の合図を送ったら画面の見張りを外し、その後に裏（一括のループ）が次のお客さんへ進んだかを誰も見ていなかった。
   *   → 合図の後も15秒ごとに裏へ「いまどの段か」を聞き、枠に出す。
   *     裏のループが消えている／段が上限を過ぎて動かない／裏がまだ送付完了を待っている（合図が届いていない）時は、
   *     裏へ「次へ進める」を指示する（axlx-bulk-kick）。次のお客さんが始まる・一括が終わる・30分で外す。
   */
  var _handoffWatch = null;
  var HANDOFF_POLL_MS = 15000;
  var HANDOFF_MAX_MS = 30 * 60000;
  var HANDOFF_RESEND_AFTER_MS = 45000;
  function _stopHandoffWatch(w, why) {
    try { if (w && w.timer) clearInterval(w.timer); } catch (_) {}
    if (_handoffWatch === w) _handoffWatch = null;
    try { _liveDlStep("handoff_watch_end", String(why || "").slice(0, 40) + " 回=" + (w ? w.polls : 0), w && w.cid); } catch (_) {}
    try { console.log("[AXLX bulk-dl] handoff_watch 終了: " + why); } catch (_) {}
  }
  function _handoffKick(w, reason) {
    if (w.kicks >= 3) return;
    w.kicks++;
    try { _liveDlStep("handoff_kick", String(reason).slice(0, 60), w.cid); } catch (_) {}
    try { console.warn("[AXLX bulk-dl] handoff_kick（裏へ次へ進めるよう指示）: " + reason); } catch (_) {}
    try { _nudge("⏭ 次のお客さんへ進めます（" + String(reason).slice(0, 24) + "）"); } catch (_) {}
    try {
      chrome.runtime.sendMessage({ type: "axlx-bulk-kick", cid: w.cid, why: "page_watch:" + reason, propertyCount: w.n }, function (res) {
        void chrome.runtime.lastError;
        try { _tmark("handoff_kick_res", res ? JSON.stringify(res).slice(0, 80) : "no_response", w.cid); } catch (_) {}
      });
    } catch (_) {}
  }
  function _handoffWatchTick(w) {
    if (_handoffWatch !== w) { try { clearInterval(w.timer); } catch (_) {} return; }
    w.polls++;
    if (Date.now() - w.at > HANDOFF_MAX_MS) { _stopHandoffWatch(w, "timeout_30m"); return; }
    try {
      chrome.runtime.sendMessage({ type: "axlx-bulk-status" }, function (r) {
        void chrome.runtime.lastError;
        if (_handoffWatch !== w) return;
        if (!r || !r.ok) {
          // 裏が寝ていた（この問い合わせで起きる）→ 次の回で見る
          try { _tmark("handoff_watch_noreply", "poll=" + w.polls, w.cid); } catch (_) {}
          return;
        }
        var q = r.queue, p = r.phase;
        if (!q) { _stopHandoffWatch(w, "no_bulk"); return; }
        if (q.done) { _stopHandoffWatch(w, "bulk_done"); return; }
        if (w.cid && q.cid && String(q.cid) !== w.cid && q.stage === "running") { _stopHandoffWatch(w, "advanced"); return; }
        var key = (r.alive ? "A" : "D") + ":" + (p ? p.phase : "-") + ":" + (q.cid || "") + ":" + (q.stage || "");
        if (key !== w.lastKey) {
          w.lastKey = key;
          try { _liveDlStep("handoff_watch", ((r.alive ? "" : "裏ループ無し ") + (p ? p.ja : (q.stage || "?")) + " " + ((q.index != null ? q.index + 1 : "?") + "/" + (q.total || "?"))).slice(0, 60), w.cid); } catch (_) {}
        }
        if (p && r.alive) {
          var left = p.until ? Math.max(0, Math.round((p.until - (r.now || Date.now())) / 1000)) : null;
          try { _nudge("⏭ 次のお客さんへ: " + p.ja + (left != null ? "（上限まであと" + left + "秒）" : "")); } catch (_) {}
        }
        if (!r.alive) { _handoffKick(w, "裏の一括ループが消えていた"); return; }
        if (r.stuck) { _handoffKick(w, "段が上限を過ぎて動かない:" + (p ? p.phase : "?")); return; }
        if (!w.resent && p && p.phase === "wait_batch_done" && w.cid && p.cid && String(p.cid) === w.cid && Date.now() - w.at > HANDOFF_RESEND_AFTER_MS) {
          w.resent = true;
          _handoffKick(w, "裏が送付完了をまだ待っている（合図が届いていない）");
        }
      });
    } catch (_) {}
  }
  function _armHandoffWatch(cid, n, why) {
    try {
      if (_handoffWatch) _stopHandoffWatch(_handoffWatch, "re_arm");
      var w = { cid: cid ? String(cid) : null, n: n == null ? null : Number(n) || 0, at: Date.now(), polls: 0, kicks: 0, resent: false, lastKey: "", timer: null };
      _handoffWatch = w;
      w.timer = setInterval(function () { _handoffWatchTick(w); }, HANDOFF_POLL_MS);
      try { _liveDlStep("handoff_watch_arm", (String(why || "") + " cid=" + String(w.cid || "?").slice(0, 8)).slice(0, 60), w.cid); } catch (_) {}
      try { console.log("[AXLX bulk-dl] handoff_watch 開始（送付完了の後、裏が次のお客さんへ進むかを15秒ごとに確かめる） cid=" + w.cid); } catch (_) {}
    } catch (_) {}
  }

  /** 完了の合図だけ送る（`_autoFinish` と共通） */
  function _sendBatchDone(n, why, skipped) {
    try { _disarmPipelineSilence("batch_done"); } catch (_) {}
    try {
      // 次のお客さんへの受け渡し: 一覧〜次ページの照合結果を残す
      _guideLikeListFlowGrasp("handoff", function (g) {
        try { _tmark("handoff_grasp", (g && g.summary ? g.summary : "handoff").slice(0, 60)); } catch (_) {}
        try { _stampSeriesToNextCustomer(why || "send_batch_done"); } catch (_) {}
      });
    } catch (_) {}
    try {
      chrome.storage.local.get(["current_customer_id", "current_customer_name"], function (r) {
        var cid = _doneCidFrom(r);
        chrome.runtime.sendMessage({
          type: "axlx-batch-customer-done",
          customerId: cid,
          propertyCount: Number(n) || 0,
          audit: _auditResult({ currentPage: _autoPdfPage, sentCount: Number(n) || 0, sentSkipped: Number(skipped) || 0 }, { auto_pdf: true }),
          auto_pdf: { why: why, sent: Number(n) || 0, skipped: Number(skipped) || 0, next_page: true },
        }, function () { void chrome.runtime.lastError; });
        _autoRunCid = null;
        _armHandoffWatch(cid, Number(n) || 0, why || "batch_done");
      });
    } catch (_) {}
  }
  /**
   * ★ 2026-11-20 竹内さん「連続でお客さんちゃんと検索できるように」:
   *   読み直し後の続き（Case C／Case E）が押さずに終わる道は、旧は何も知らせず background が 20分待っていた。
   *   → 番号が分かっているお客さんにだけ「押さずに終わった」合図を送る（番号の無い合図は送らない＝取り違えない）。
   */
  function _sendSkipDoneFor(cid, why, sentSoFar) {
    if (!cid) { _tmark("auto_skip_done", "no_cid_" + why); return; }
    try {
      chrome.runtime.sendMessage({
        type: "axlx-batch-customer-done",
        customerId: String(cid),
        propertyCount: sentSoFar == null ? null : (Number(sentSoFar) || 0),
        skipped: true,
        audit: _auditResult({ currentPage: _autoPdfPage, sentCount: Number(sentSoFar) || 0, sentSkipped: 0 }, { auto_pdf: true }),
        auto_pdf: { why: why, sent: Number(sentSoFar) || 0, skipped_run: true },
      }, function () { void chrome.runtime.lastError; });
      _tmark("auto_skip_done", why);
      _armHandoffWatch(cid, sentSoFar, "skip_done:" + why);
    } catch (_) {}
  }
  /**
   * ★ 2.8.275 竹内さん「ストップボタンを付け、押したらそこでストップしてリセットされるように」:
   *   「⏹ 止めてリセット」。旧の「自動を止める」は PDF を押している間しか出ず、裏の一括も止めなかった。
   *   ① この画面の自動（押す・送る・見る待ち）を止める ② 裏へ「全部止めて戻す」（一括・ロック・入力中）③ 返事のあと（最大6秒）このタブを読み直す
   *   ＝画面の中の残りの待ち・印も全部消えて、最初の状態に戻る。
   */
  var _resetting = false;
  function _stopAndReset(why) {
    if (_resetting) return false;
    _resetting = true;
    try { _nudge("⏹ 止めてリセットします…"); } catch (_) {}
    try { var b = document.getElementById("axlx-reset-stop-btn"); if (b) { b.disabled = true; b.textContent = "⏹ リセット中…"; } } catch (_) {}
    try { if (_autoPdfRun) _autoPdfRun.stopped = true; } catch (_) {}
    try { if (_lookWait && _lookWait.skip) _lookWait.skip("reset"); } catch (_) {}
    try { _pdfQueue = []; } catch (_) {}
    try { chrome.storage.session.remove(["axlx_auto_next_page", "axlx_search_grasped"]); } catch (_) {}
    try { sessionStorage.removeItem(AUTO_SEND_KEY); } catch (_) {}
    var reloaded = false;
    var reload = function () { if (reloaded) return; reloaded = true; try { location.reload(); } catch (_) {} };
    try {
      chrome.runtime.sendMessage({ type: "axlx-reset-all", why: String(why || "button") }, function () {
        void chrome.runtime.lastError;
        setTimeout(reload, 400);
      });
    } catch (_) { reload(); }
    setTimeout(reload, 6000); // 裏の返事が来なくても必ず読み直す
    return true;
  }
  function stopAutoPdfs() {
    if (!_autoPdfRun) { _nudge("自動は動いていません"); return false; }
    _autoPdfRun.stopped = true;
    try { chrome.storage.session.remove("axlx_auto_next_page"); } catch (_) {}
    _nudge("⏹ 止めます（いまの1件が終わってから）");
    return true;
  }

  /**
   * 2026-11-11 竹内さん「AIXの部分に休憩時間等もちゃんと書いといて。人間が動いているように見たらわかるように。昼休みなら昼休みと」:
   *   右下の枠に「いま何をしているか」を人が読める形で出す（画面を見た人が人間の動きだと分かるように）。
   *   例: ☕ 休憩中（あと42秒）／🍱 昼休み（13:00まで）／👀 資料を見る（あと3秒）／⏳ 次のお客様まで（あと18秒）／🤖 1件ずつ押しています
   *   ・_axlxWorkNote(text, untilMs) で出し、untilMs を過ぎたら自動で戻す（残り秒も毎秒更新）
   *   ・_axlxClearWorkNote() で消す
   */
  var _workNoteTimer = null;
  var _workNoteUntil = 0;
  function _axlxClearWorkNote() {
    if (_workNoteTimer) { clearInterval(_workNoteTimer); _workNoteTimer = null; }
    _workNoteUntil = 0;
  }
  function _axlxWorkNote(text, untilMs) {
    if (!document.getElementById("axlx-count")) return;
    _axlxClearWorkNote();
    _workNoteUntil = typeof untilMs === "number" ? untilMs : 0;
    var paint = function () {
      var left = _workNoteUntil ? Math.max(0, Math.round((_workNoteUntil - Date.now()) / 1000)) : 0;
      _setStatusNowNext(text + (left > 0 ? "（あと" + left + "秒）" : ""), null);
      if (_workNoteUntil && Date.now() >= _workNoteUntil) { _axlxClearWorkNote(); _paintPdfProgress(); }
    };
    paint();
    if (_workNoteUntil) _workNoteTimer = setInterval(paint, 1000);
  }

  /**
   * いまの時刻が昼休み（JST 12:00〜13:00）なら残り時間を返す（ミリ秒）。違えば 0。
   * 竹内さん「昼休みなら昼休みと人間のようにするかたちで」: 自動便の勤務時間のゲートと同じ区切り（12〜13時）。
   */
  function _lunchRestMs() {
    try {
      var now = Date.now();
      var j = new Date(now + 9 * 3600 * 1000);
      var h = j.getUTCHours(), m = j.getUTCMinutes();
      var mins = h * 60 + m;
      if (mins >= 12 * 60 && mins < 13 * 60) {
        return (13 * 60 - mins) * 60 * 1000 - j.getUTCSeconds() * 1000;
      }
    } catch (_) {}
    return 0;
  }

  /** 進み具合（いま／つぎ） ※一括把握中は客名・件数・次客を優先 */
  function _paintPdfProgress() {
    if (!document.getElementById("axlx-count")) return;
    if (_nudgeTimer) return; // 知らせを出している間は上書きしない
    if (_workNoteTimer) return; // 休憩などの表示中は上書きしない
    /** ★ 2.8.217: 一括中は「誰・何件・次客」をいま／つぎに載せる（物件送付の細部は副） */
    if (_bulkGraspState && Number(_bulkGraspState.total) > 0) {
      _applyBulkGrasp(_bulkGraspState);
      return;
    }
    var done = Object.keys(_onePdfSent).length;
    var checked = tracked.filter(function (t) { return t && t.cb && t.cb.checked; }).length;
    var now = "";
    var next = "";
    if (_autoPdfRun && !_autoPdfRun.stopped) {
      now = "自動で物件を送っています"
        + (_autoPdfRun.total ? "（" + _autoPdfRun.total + "件目）" : "")
        + (done ? "／済" + done : "");
      next = _pdfBusy || _pdfSending ? "資料確認 → 次の物件" : "次の物件を送る";
      try {
        var sb = document.getElementById("axlx-autopdf-stop-btn");
        if (sb) sb.style.display = "block";
      } catch (_) {}
    } else if (_pdfSending) {
      now = "物件を送っています";
      next = "送り終わり → 資料を確認";
    } else if (_pdfBusy) {
      now = "資料を確認中";
      next = "次の物件へ";
    } else if (done) {
      now = "送付済み " + done + "件"
        + (checked ? "／選択 " + checked + "件" : "");
      next = checked ? "「物件送る」で続きを送付" : "続きの物件を選ぶ／自動待ち";
    } else if (checked > 0) {
      now = checked + "件を選択中";
      next = "「物件送る」で送付";
    } else if (tracked.length > 0) {
      now = "一覧 " + tracked.length + "件";
      next = "自動で送るか、「物件送る」";
    } else {
      now = "待機中";
      next = "一覧を待ちます";
    }
    _setStatusNowNext(now, next);
  }

  /** 押した1件だけの組を作る（チェックの状態に頼らない＝後から押した行に奪われない） */
  function _buildOneItem(btn) {
    if (!btn || !AxlxSendPairing.isHttpUrl(btn.href)) return null;
    var card;
    try { card = extractCard(btn); } catch (_) { return null; }
    if (!card) return null;
    return { url: btn.href, summary: buildPropertySummary(card, 0), data: buildPropertyData(card, 0), card: card, image_url: card.imageUrl || null };
  }

  /** 1件だけを送る（判定も1件だけ・失敗したら理由を返す） */
  function _sendOnePdf(item, url, done) {
    var one = _buildOneItem(item.btn);
    if (!one) { done(false, "no-item"); return; }
    var t0 = Date.now();
    getCustomerFromPopup(function (customerName, customerConditions, customerId) {
      if (!customerId) { done(false, "no-customer"); return; }
      if (!_sendGuardOk(customerName, customerId)) { done(false, "guard"); return; }
      var judged = function (kept, brain) {
        var tj = Date.now();
        var send = (kept && kept.length ? kept : [one]).filter(function (it) { return it && it.url === url; });
        if (!send.length) { done(false, "brain-skip"); return; }
        try {
          chrome.runtime.sendMessage({
            type: "axlx-send-to-line",
            urls: AxlxSendPairing.pluck(send, "url"),
            customer_name: customerName || null,
            property_summaries: AxlxSendPairing.pluck(send, "summary"),
            property_pool: poolWithUrl(send),
            customer_id: customerId,
            customer_conditions: customerConditions || null,
            site: "realpro",
            sent_skipped: 0,
            search_stamp: (function () { var SS = (typeof self !== "undefined" ? self : window).AxlxSearchStamp; return SS ? SS.forSend(SS.read(), customerId, Date.now()) : null; })(),
          }, function (resp) {
            var err = chrome.runtime.lastError ? chrome.runtime.lastError.message : (!resp || !resp.ok ? ((resp && resp.error) || "応答なし") : null);
            if (err) console.error("[AXLX bulk-dl] 1件送信（印刷用PDF）のエラー:", err);
            done(!err, err || "", { judgeMs: tj - t0, sendMs: Date.now() - tj, fromCache: resp && resp.from_cache != null ? Number(resp.from_cache) : null });
          });
        } catch (e) { done(false, String((e && e.message) || e)); }
      };
      // ブレインの時だけ、その1件の判定（全件は呼ばない＝重くしない・待たせない）
      if (_brainModeOn) _judgeOneBrain(customerId, one, function (kept, brain) { void brain; judged(kept, brain); });
      else judged([one], null);
    });
  }

  /** 1件だけブレインに判定してもらう（外す判定なら送らない・失敗したら送る＝fail-open） */
  function _judgeOneBrain(customerId, one, cb) {
    var finished = false;
    var finish = function (kept, brain) { if (finished) return; finished = true; cb(kept, brain); };
    var watchdog = setTimeout(function () { console.warn("[AXLX bulk-dl][brain] 1件判定の応答が20秒無い → そのまま送る"); finish([one], null); }, 20000);
    try {
      var jd = Object.assign({}, one.data); delete jd.cells; delete jd.head; delete jd.bld_text;
      chrome.runtime.sendMessage({
        type: "axlx-brain-judge", property_customer_id: customerId, site: "realpro",
        items: [{ summary: one.summary, data: jd, url: one.url, image_url: one.image_url || null }],
      }, function (resp) {
        clearTimeout(watchdog);
        if (chrome.runtime.lastError || !resp || !resp.ok || !resp.data || !Array.isArray(resp.data.judgments)) {
          finish([one], null);
          return;
        }
        var d = resp.data;
        var j = d.judgments[0];
        if (d.apply_drop && j && j.verdict === "drop" && !_staffModeOn) {
          console.log("[AXLX bulk-dl][brain] 1件を外す判定（送りません）:", one.summary && String(one.summary).slice(0, 40));
          finish([], d);
          return;
        }
        finish([one], d);
      });
    } catch (e) { clearTimeout(watchdog); console.warn("[AXLX bulk-dl][brain] 1件判定の呼び出しに失敗 → 送る:", e && e.message); finish([one], null); }
  }
  /** 押してから送るまでの人の間（0.6〜1.8秒・たまに一息） */
  function _humanGapThen() {
    return new Promise(function (resolve) {
      var H = (typeof self !== "undefined" ? self : window).AxlxHumanWait;
      var g = H && H.logNormalDelay ? H.logNormalDelay(1000, 0.4) : (600 + Math.floor(Math.random() * 1200));
      if (g > 4000) g = 4000;
      setTimeout(resolve, g);
    });
  }
  /** URL の比べ方（?の後ろの並び・#以降の違いで行を見失わない）。スキーム/ホスト/パスと id だけで比べる */
  function _urlKey(u) {
    var s = String(u || "");
    try {
      var x = new URL(s);
      var id = (x.search.match(/[?&]id=([^&]+)/) || [])[1] || "";
      return x.host + x.pathname + "|" + id;
    } catch (_) { return s; }
  }
  /** 押した資料の行を探す（URL の書き方が少し違っても当てる） */
  function _findItemByUrl(url) {
    var exact = tracked.find(function (t) { return t.btn && t.btn.href === url; });
    if (exact) return exact;
    var k = _urlKey(url);
    return tracked.find(function (t) { return t.btn && _urlKey(t.btn.href) === k; }) || null;
  }
  /**
   * 一覧の行を作り直す（チェックは足さない・自動送信の続きも起動しない）。
   * inject() は Case A/B（自動送信の続き）も始めてしまうので、押した1件を探す時はこちらを使う。
   */
  function _rescanRows() {
    var btns = findPrintBtns();
    /**
     * ★ 2.8.279 竹内さん「拡張ツールひらいているとき重すぎる」:
     *   旧は呼ばれるたびに全行のチェック欄を消して作り直していた（一覧を見ているだけで4.5秒ごと）。
     *   作り直すと案内の見張りが反応して一覧を読み直す。→ 行が同じなら何もしない。
     */
    if (btns.length === tracked.length) {
      var _same = true;
      for (var _si = 0; _si < btns.length; _si++) {
        var _t = tracked[_si];
        if (!_t || _t.btn !== btns[_si] || !_t.cb || !_t.cb.isConnected) { _same = false; break; }
      }
      if (_same) return;
    }
    try { _perfC.rebuild++; } catch (_) {}
    var keep = {};
    tracked.forEach(function (t) { if (t.cb && t.cb.checked && t.btn) keep[_urlKey(t.btn.href)] = true; });
    document.querySelectorAll(".axlx-cb").forEach(function (el) { el.remove(); });
    tracked = [];
    btns.forEach(function (btn) {
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "axlx-cb";
      cb.style.cssText = "width:14px;height:14px;margin-right:3px;cursor:pointer;accent-color:#1565C0;vertical-align:middle;flex-shrink:0;";
      cb.checked = !!keep[_urlKey(btn.href)]; // 押した1件のチェックは残す
      cb.addEventListener("change", updateBar);
      btn.parentNode.insertBefore(cb, btn);
      tracked.push({ cb: cb, btn: btn });
    });
    updateBar();
    // ★ 2026-11-16: rescan で行が入れ替わっても送付済み印を付け直す
    try { if (_autoModeOn) _reapplySentMarksIfAny(); } catch (_) {}
  }
  /**
   * ★ 2026-11-22b: ダウンロード完了（axlx-pdf-captured）が来ないと送られない穴。
   *   永成 brain 録画: 印刷用PDFを何百回も押した記録があるのに property_pickups=0。
   *   → 印刷用PDFリンクのクリックでも送る（捕捉が先に来れば _onePdfSent / busy 待ち行列で二重にならない）。
   */
  var _clickSendArmed = {};
  /**
   * 押してからダウンロードの捕捉（axlx-pdf-captured）を待つ上限。捕捉が来れば手元（キャッシュ）の資料で送る。
   * 2.8.272 までは 0.9秒で送り始めていたため、自動の1件はいつも捕捉の前＝リアプロへ同じ資料をもう一度取りに行っていた（1件 45〜80秒）。
   * 捕捉が来ない時（永成の録画の穴）だけ、この時間の後にクリックから送る。
   */
  var AXLX_CLICK_SEND_WAIT_MS = 6000;
  function _clickSendPending() {
    for (var u in _clickSendArmed) { if (Object.prototype.hasOwnProperty.call(_clickSendArmed, u)) return true; }
    return false;
  }
  function _itemFromPrintEl(btn) {
    if (!btn || !btn.href) return null;
    var item = _findItemByUrl(btn.href);
    if (!item) {
      try { _rescanRows(); } catch (_) {}
      item = _findItemByUrl(btn.href);
    }
    if (item) return item;
    return { btn: btn, cb: null };
  }
  function _armClickSend(btn) {
    if (!btn || !btn.href) return;
    var url = btn.href;
    if (_onePdfSent[url]) return;
    if (_clickSendArmed[url]) return;
    _clickSendArmed[url] = Date.now();
    _tmark("pdf_click_arm", String(url).slice(0, 40));
    setTimeout(function () {
      if (!Object.prototype.hasOwnProperty.call(_clickSendArmed, url)) return; // 捕捉が先に来て送り始めた
      try { delete _clickSendArmed[url]; } catch (_) {}
      if (_onePdfSent[url] || _pdfSending === url) return;
      try { _liveDlStep("pdf_click_nocap", Math.round(AXLX_CLICK_SEND_WAIT_MS / 1000) + "秒捕捉なし→押した印から送る"); } catch (_) {}
      var item = _itemFromPrintEl(btn);
      if (!item) {
        _nudge("⚠ 押した行が見つかりません");
        _tmark("pdf_click_miss", String(url).slice(0, 40));
        return;
      }
      try { sendOnePdfNow(item); } catch (e) {
        console.warn("[AXLX bulk-dl] クリック経由の送信に失敗:", e && e.message);
        _tmark("pdf_click_err", String((e && e.message) || e).slice(0, 40));
      }
    }, AXLX_CLICK_SEND_WAIT_MS);
  }
  try {
    document.addEventListener("click", function (ev) {
      try {
        var el = ev && ev.target;
        if (!el) return;
        var btn = null;
        for (var i = 0; i < 8 && el && el !== document.body; i++, el = el.parentElement) {
          if ((el.tagName === "A" || el.tagName === "BUTTON") && /印刷用PDF/.test(String(el.textContent || ""))) {
            btn = el;
            break;
          }
        }
        if (!btn || !btn.href) return;
        _armClickSend(btn);
      } catch (_) {}
    }, true);
  } catch (_) {}
  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      // 2026-11-11 竹内さん「AIXの部分に休憩時間等もちゃんと書いといて」: 休憩・昼休み・次のお客様までの間を枠に出す
      if (msg && msg.type === "axlx-work-note") {
        _axlxWorkNote(String(msg.text || ""), Number(msg.untilMs) || 0);
        return;
      }
      if (msg && msg.type === "axlx-work-note-clear") {
        _axlxClearWorkNote();
        _paintPdfProgress();
        return;
      }
      /** ★ 2.8.217: 一括の誰・何件・次客・把握 */
      if (msg && msg.type === "axlx-bulk-grasp") {
        _applyBulkGrasp(msg.grasp || null);
        return;
      }
      if (!msg || msg.type !== "axlx-pdf-captured") return;
      var item = _findItemByUrl(msg.url);
      if (!item) {
        // 2026-11-10: 一覧が描き直された直後・URL の書き方が少し違う時は、行を作り直してからもう一度探す（取りこぼさない）
        try { _rescanRows(); } catch (_) {}
        item = _findItemByUrl(msg.url);
      }
      if (!item) {
        console.warn("[AXLX bulk-dl] 押した資料の行が見つかりません（送れませんでした）:", String(msg.url || "").slice(0, 100));
        var _c0 = document.getElementById("axlx-count");
        if (_c0) _c0.textContent = "⚠ 押した行が見つかりません";
        return;
      }
      try { if (msg.url) delete _clickSendArmed[msg.url]; } catch (_) {}
      _onePdfBadge(item, msg.ok, false);
      updateBar();
      // 押した1件をその場で送る（まとめて20秒待たない＝1つずつ行ったのと同じ形）
      sendOnePdfNow(item);
    });
  } catch (_) {}

  /**
   * v2.5.62 竹内「印刷用PDF おしたら…そのまま AIX ツールに転送されるようにする」:
   *   2026-11-10 からは押した1件をその場で送る（sendOnePdfNow）。このまとめて送る道は、
   *   手で複数にチェックを入れて「📤 売上番長に送る」を押した時（mergePdfs(true)）だけが使う。
   */
  var _forwardTimer = null;
  var _autoForwarding = false;
  /** v2.5.80 送る前の確かめ（search-stamp.js）。ok なら true。手で押した時は確かめの小窓、20秒後のまとめて送るは送らずボタンに出す */
  function _sendGuardOk(customerName, customerId) {
    var SS = (typeof self !== "undefined" ? self : window).AxlxSearchStamp;
    if (!SS) return true;
    var sel = tracked.filter(function (t) { return t.cb && t.cb.checked; }).map(function (t) { return { area: (t.btn && t.btn.getAttribute && t.btn.getAttribute("data-axlx-area")) || "" }; });
    var r = SS.check({ stamp: SS.read(), cur: { cid: customerId, name: customerName }, now: Date.now(), selected: sel });
    if (r.ok) return true;
    console.warn("[AXLX bulk-dl] 送る前の確かめ: " + r.reasons.join(","));
    // 2026-11-10 竹内さん「押したらちゃんと送られるようになっているから、自動モードの場合押したらちゃんとそのまま売り上げ番長に送られるようにする」:
    //   自動モード（ヘッダーの「自動」を選んでいる時＝_autoModeOn）は **小窓で止めない**（押した＝送る）。
    // ★ 2026-11-22b 永成 brain 実測: pickups=0。案内の incomplete 等で confirm が毎回出て、押したのに AIX に残らない。
    //   ブレインONも自動と同じく小窓で止めない（判定は _judgeOneBrain、客IDは getCustomerFromPopup）。
    if (_autoModeOn || _brainModeOn) {
      _tmark("guard_pass", (_autoModeOn ? "auto:" : "brain:") + r.reasons.join(",").slice(0, 60));
      console.log("[AXLX bulk-dl] " + (_autoModeOn ? "自動" : "ブレイン") + "なので確かめの小窓は出さずに送ります（" + r.reasons.join(",") + "）");
      return true;
    }
    if (_autoForwarding) {
      var lb = document.getElementById("axlx-line-btn");
      if (lb) lb.textContent = "⚠ 確かめが要ります（押して確かめてから送る）";
      return false;
    }
    return window.confirm(r.message);
  }
  function scheduleForwardUnused() { /* 2026-11-10 押した1件をその場で送る形にしたので、20秒まとめて送る道は使わない（手で「売上番長に送る」を押した時だけ mergePdfs） */ }

  /**
   * v2.5.59 キャッシュ確認: この画面の「印刷用PDF」の資料が、ブラウザの手元に残っているかを確かめる。
   *   手元に無い資料はリアプロに取りに行かない（cache: "only-if-cached"）＝リアプロには何も届かない。
   *   使い方: 物件の「印刷用PDF」を人が1〜2件押して開く → 一覧に戻ってこのボタン → 開いた物が ✅・開いていない物が ✗ なら、この方向で作れる
   */
  function probeCache() {
    var out = document.getElementById("axlx-cache-out");
    var urls = [];
    findPrintBtns().forEach(function (b) { if (b.href && urls.indexOf(b.href) === -1) urls.push(b.href); });
    out.style.display = "block";
    if (!urls.length) { out.textContent = "この画面に「印刷用PDF」が見つかりません"; return; }
    out.textContent = "確かめ中…（" + urls.length + "件・リアプロには取りに行きません）";
    try {
      chrome.runtime.sendMessage({ type: "axlx-cache-probe", urls: urls }, function (resp) {
        if (chrome.runtime.lastError || !resp) { out.textContent = "確かめられませんでした: " + ((chrome.runtime.lastError && chrome.runtime.lastError.message) || "応答なし"); return; }
        if (!resp.ok) { out.textContent = "確かめられませんでした: " + resp.error; return; }
        var rs = resp.results || [];
        var hit = rs.filter(function (r) { return r.ok; });
        var lines = ["手元に残っていた資料: " + hit.length + " / " + rs.length + "件"];
        rs.forEach(function (r) {
          var id = (String(r.url).match(/id=(\d+)/) || [])[1] || r.url;
          if (r.ok) lines.push("✅ " + id + "  " + Math.round(r.bytes / 1024) + "KB  " + (r.type || "") + (r.cacheControl ? "  Cache-Control: " + r.cacheControl : "  (Cache-Control なし)"));
          else if (hit.length || rs.length <= 10) lines.push("✗ " + id + "  " + (r.error === "origin" ? r.note : r.status ? "HTTP " + r.status + " " + (r.type || "") : "手元に無い"));
        });
        if (!hit.length) lines.push("\n開いた資料が ✗ の時は、リアプロが「取っておかない」指定で返している可能性が高い → 「開かずに保存させる」方法に切り替え");
        out.textContent = lines.join("\n");
        console.log("[AXLX cache-probe]", rs);
      });
    } catch (e) { out.textContent = "確かめられませんでした: " + e.message; }
  }

  // 2026-10-06 v2.5.74（ITANDI で枠がサイトの「まとめて図面取得」に重なっていた件の確かめ）: リアプロの枠は右の縦の真ん中で、
  //   リアプロの一括のボタンとは重ならない作りだが、画面の大きさ次第で重なる時は、重なったサイトの固定のボタンの上へ逃がす（bar-dock.js）。
  //   スタッフが動かした位置は変えない（動かす前の既定の位置か、逃がした位置の時だけ見直す）
  var _rpDockTimer = null;
  /**
   * ★ 2.8.262: お客様パネルが中央に居ると「右側のボックスが消えた」ように見える。
   *   人がミニにした時以外は右ドックへ戻す（underbar の初回 heal だけでは足りない）。
   */
  function _snapCustomerPanelRight() {
    try {
      var w = document.getElementById("aixlinx-float-wrap");
      if (!w) return false;
      if (w.getAttribute("data-axlx-user-mini") === "1") return false;
      if (w.getAttribute("data-axlx-sort-panel-left") != null) return false; // 並べ替え退避中は触らない
      var mini = document.getElementById("aixlinx-mini-btn");
      if (mini && mini.style && mini.style.display === "flex") return false;
      var ww = window.innerWidth || 1200;
      var pw = Math.max(420, parseInt(w.style.width, 10) || Math.round(w.getBoundingClientRect().width) || 660);
      var dockX = Math.max(10, ww - pw - 20);
      var curX = parseInt(w.style.left, 10);
      if (!Number.isFinite(curX)) {
        try { curX = Math.round(w.getBoundingClientRect().left); } catch (_) { curX = dockX; }
      }
      if (Math.abs(curX - dockX) > 80 || curX < ww * 0.4) {
        w.style.setProperty("left", dockX + "px", "important");
        w.style.setProperty("display", "flex", "important");
        try { _liveDlStep("panel_snap_right", "left=" + dockX); } catch (_) {}
        return true;
      }
    } catch (_) {}
    return false;
  }
  /**
   * ★ 2.8.258 竹内さん画像「物件送るボックスがまだ出ない」(v2.8.257):
   *   お客様パネル #aixlinx-float-wrap は z-index が枠より上で右ドックに居ると、
   *   右端の axlx-bar が完全に下に隠れ「消えた」ように見える。
   * ★ 2.8.260 竹内さん画像(v2.8.259): パネルが広いと「左隣」でも重なり、z-index も wrap=MAX で
   *   常に下。→ wrap を下げ・bar を上げ、左余白不足時は画面下へ退避。
   */
  function _placeSendBarVisible() {
    var bar = document.getElementById("axlx-bar");
    if (!bar) return;
    var hidden = false;
    try {
      var cs = window.getComputedStyle ? window.getComputedStyle(bar) : null;
      hidden = bar.style.display === "none" || (cs && cs.display === "none");
    } catch (_) { hidden = bar.style.display === "none"; }
    if (hidden) return;
    // 枠がパネルに完全に隠れている／画面外なら、人ドラッグ印を捨てて位置を直す
    try {
      if (bar.getAttribute("data-axlx-user-drag") === "1") {
        var brU = bar.getBoundingClientRect();
        var wrapU = document.getElementById("aixlinx-float-wrap");
        var wrU = wrapU ? wrapU.getBoundingClientRect() : null;
        var offScreen = !brU || brU.width < 20 || brU.right < 8 || brU.left > (window.innerWidth || 0) - 8;
        var buried = wrU && wrU.width > 180
          && brU.left >= wrU.left - 4 && brU.right <= wrU.right + 4
          && brU.top >= wrU.top - 4 && brU.bottom <= wrU.bottom + 4;
        if (offScreen || buried) {
          bar.removeAttribute("data-axlx-user-drag");
          try { _liveDlStep("send_bar_undrag", buried ? "buried" : "offscreen"); } catch (_) {}
        } else {
          return;
        }
      }
    } catch (_) {
      if (bar.getAttribute("data-axlx-user-drag") === "1") return;
    }
    try {
      if (String(bar.style.zIndex) !== "2147483647") bar.style.setProperty("z-index", "2147483647", "important");
    } catch (_) {}
    var wrap = null;
    try { wrap = document.getElementById("aixlinx-float-wrap"); } catch (_) { wrap = null; }
    // 既存 wrap が MAX z-index のままなら下げる（ぶつかり解消）
    try {
      if (wrap) {
        var wz = window.getComputedStyle ? window.getComputedStyle(wrap).zIndex : "";
        if (String(wz) === "2147483647" || String(wrap.style.zIndex) === "2147483647") {
          wrap.style.setProperty("z-index", "2147483645", "important");
          try { _liveDlStep("send_bar_zfix", "wrap→645"); } catch (_) {}
        }
      }
    } catch (_) {}
    var vw = window.innerWidth || 1200;
    var vh = window.innerHeight || 800;
    var barW = 280;
    var barH = 200;
    try {
      var br0 = bar.getBoundingClientRect();
      if (br0 && br0.width > 40) barW = Math.ceil(br0.width);
      if (br0 && br0.height > 40) barH = Math.ceil(br0.height);
    } catch (_) {}
    if (wrap) {
      var wr = null;
      try { wr = wrap.getBoundingClientRect(); } catch (_) { wr = null; }
      if (wr && wr.width > 180 && wr.height > 180) {
        var coversRight = wr.right >= vw - 36 && wr.left < vw - 40;
        var overlapsDefault = wr.right > vw - barW - 28 && wr.left < vw - 8;
        if (coversRight || overlapsDefault) {
          var roomLeft = wr.left >= barW + 24;
          /**
           * ★ 2.8.279 竹内さん「拡張ツールひらいているとき重すぎる」:
           *   2秒ごとに同じ位置を書き直し、そのたび点検へ送っていた（DB: send_bar_dock が12時間で71回）。
           *   → 置き場所が変わった時だけ書く・記録する。
           */
          var _dockSig = roomLeft
            ? "beside|" + Math.max(8, Math.round(wr.left - barW - 12)) + "|" + Math.max(56, Math.min(Math.round(wr.top + 20), vh - barH - 24))
            : "bottom-left";
          if (bar.__axlxDockSig === _dockSig && bar.getAttribute("data-axlx-docked") === (roomLeft ? "beside-wrap" : "bottom-left")) return;
          bar.__axlxDockSig = _dockSig;
          try {
            bar.style.setProperty("transform", "none", "important");
            bar.style.setProperty("right", "auto", "important");
            if (roomLeft) {
              var left = Math.max(8, Math.round(wr.left - barW - 12));
              var top = Math.max(56, Math.min(Math.round(wr.top + 20), vh - barH - 24));
              bar.style.setProperty("bottom", "auto", "important");
              bar.style.setProperty("left", left + "px", "important");
              bar.style.setProperty("top", top + "px", "important");
              bar.setAttribute("data-axlx-docked", "beside-wrap");
              try { _liveDlStep("send_bar_dock", "beside left=" + left); } catch (_) {}
            } else {
              // 左余白不足（パネルが広い）→ 画面下へ（wrap の BOTTOM_GAP 付近）
              bar.style.setProperty("top", "auto", "important");
              bar.style.setProperty("left", "12px", "important");
              bar.style.setProperty("bottom", "16px", "important");
              bar.setAttribute("data-axlx-docked", "bottom-left");
              try { _liveDlStep("send_bar_dock", "bottom-left room0"); } catch (_) {}
            }
          } catch (_) {}
          return;
        }
      }
    }
    // 右端の既定位置へ（beside / bottom から戻す／初回）
    try {
      var mode = bar.getAttribute("data-axlx-docked") || "";
      if (mode === "1" && bar.__axlxDockSig === "right") return; // もう右端に居る（書き直さない）
      bar.__axlxDockSig = "right";
      if (mode === "beside-wrap" || mode === "bottom-left" || mode === "" || mode === "1") {
        bar.style.setProperty("left", "auto", "important");
        bar.style.setProperty("right", "12px", "important");
        bar.style.setProperty("top", "50%", "important");
        bar.style.setProperty("bottom", "auto", "important");
        bar.style.setProperty("transform", "translateY(-50%)", "important");
        bar.setAttribute("data-axlx-docked", "1");
      }
    } catch (_) {}
  }
  function dockRpBar() {
    var D = (typeof self !== "undefined" ? self : window).AxlxBarDock;
    var bar = document.getElementById("axlx-bar");
    if (!bar || bar.style.display === "none") return;
    if (bar.getAttribute("data-axlx-user-drag") === "1") return; // スタッフが動かした
    try { _placeSendBarVisible(); } catch (_) {}
    var dockMode = bar.getAttribute("data-axlx-docked") || "";
    if (dockMode === "beside-wrap" || dockMode === "bottom-left") return;
    if (!D) return;
    var docked = dockMode === "1";
    if (!docked && bar.style.top && bar.style.top !== "50%") return;
    bar.style.top = "50%"; bar.style.transform = "translateY(-50%)";
    if (D.applyTopAvoid(bar, 10)) bar.setAttribute("data-axlx-docked", "1"); else bar.setAttribute("data-axlx-docked", "1");
  }
  function dockRpBarSoon() {
    if (_rpDockTimer) return;
    _rpDockTimer = setTimeout(function () { _rpDockTimer = null; if (!document.hidden) dockRpBar(); }, 250);
  }
  window.addEventListener("resize", dockRpBarSoon);

  /**
   * 2026-11-11 竹内さん「自動検索日によって何時にスタートされるかもUIに表示されていたらわかりやすい」:
   *   枠に「次回の自動便は 16:23 ごろ（午後の便）」を出す。1分ごとに描き直す（時刻が進むため）。
   */
  function _paintAutoRunNote() {
    var el = document.getElementById("axlx-autorun-note");
    if (!el) return;
    var N = (typeof self !== "undefined" ? self : window).AxlxAutoRunNote;
    if (!N || !N.noteLine) { el.textContent = ""; return; }
    try { el.textContent = N.noteLine(Date.now()); } catch (_) { el.textContent = ""; }
  }
  var _autoRunNoteTimer = null;
  function _startAutoRunNote() {
    _paintAutoRunNote();
    if (_autoRunNoteTimer) return;
    _autoRunNoteTimer = setInterval(_paintAutoRunNote, 60000);
  }

  function updateBar() {
    ensureBar();
    var bar = document.getElementById("axlx-bar");
    if (!bar) return;
    /** ★ 2.8.217: 一括把握中は一覧0件でも枠を出す（誰・何件・次客を見せる） */
    /** ★ 2.8.254: 検索結果画面（estate）では常に「物件送る」枠を出す（消えたように見せない） */
    /** ★ 2.8.258: display は !important（サイトCSS／残骸で消えない）＋パネルと重ならぬ位置へ */
    var onEstate = false;
    try {
      onEstate = /[?&]method=estate\b/.test(String(location.search || ""))
        || /[?&]display=building\b/.test(String(location.search || ""));
    } catch (_) { onEstate = false; }
    var show = tracked.length > 0
      || !!( _bulkGraspState && Number(_bulkGraspState.total) > 0 )
      || onEstate;
    try {
      if (show) {
        bar.style.setProperty("display", "flex", "important");
        bar.removeAttribute("data-axlx-force-hide");
      } else {
        bar.style.setProperty("display", "none", "important");
      }
    } catch (_) {
      bar.style.display = show ? "flex" : "none";
    }
    if (show && tracked.length === 0 && onEstate) {
      try {
        var nowEl = document.getElementById("axlx-count");
        if (nowEl && (!nowEl.textContent || /待機中|読み込み中/.test(nowEl.textContent))) {
          nowEl.textContent = "一覧の物件を読み込み中…";
        }
      } catch (_) {}
    }
    if (show) {
      try { _placeSendBarVisible(); } catch (_) {}
      try {
        var _sbAt = Number(window.__axlxSendBarShowAt) || 0;
        if (Date.now() - _sbAt > 15000) {
          window.__axlxSendBarShowAt = Date.now();
          _liveDlStep(
            "send_bar_show",
            (onEstate ? "estate" : ("tracked=" + tracked.length))
              + " dock=" + String(bar.getAttribute("data-axlx-docked") || "?"),
          );
        }
      } catch (_) {}
    }
    dockRpBarSoon();
    _paintPdfProgress();
    _startAutoRunNote(); // 2026-11-11: 次回の自動便の時刻を出す（1分ごとに描き直す）
  }

  /** ★ 2.8.217: ページ読込時に session の一括把握を復元 */
  try {
    chrome.storage.session.get(["axlx_bulk_grasp"], function (r) {
      try {
        if (r && r.axlx_bulk_grasp) {
          _applyBulkGrasp(r.axlx_bulk_grasp);
          updateBar();
        }
      } catch (_) {}
    });
  } catch (_) {}

  function toggleAll() {
    var checked = tracked.filter(function (t) { return t.cb.checked; });
    var newState = checked.length < tracked.length;
    tracked.forEach(function (t) { t.cb.checked = newState; });
    updateBar();
  }

  // 2026-09-18: 「送れる行」の判定は send-pairing.js の1か所だけ。
  //   旧: ここは「checked かつ http(s) の href」で絞るのに、送信側は「checked」だけで
  //   説明文を作っていたため、href の無い行があるとその行以降の PDF と説明文が全部ズレた。
  function getSelectedTargets() {
    return AxlxSendPairing.selectSendableTargets(tracked);
  }

  function getSelectedUrls() {
    return getSelectedTargets().map(function (t) { return t.btn.href; });
  }

  // 1件 = 1つの組（url・説明文・学習用データ）にしてから送る。
  // 同じ組から作るので、PDF と説明文がズレようがない。
  // ── 一覧の下見: ブレインの点数を行ごとに出す（2026-10-01）──────────────────
  // 竹内「ここの点数のスコアリングも事前に可能なら、ちゃんと物件検索ブレインの判断の方でおこなう」:
  //   建物の上の「◎85点」は拡張の中の簡易の点（score-overlay.js）で、送る時のブレインの判定とは別物だった。
  //   → 一覧が出たら、送る時と同じ材料（説明文・data）で /api/property-brain/judge を dry_run で呼び（記録しない・画像も読まない＝決定論だけ）、
  //     行ごとに「🧠 点・通す/保留/外す」を出す。出せた時は簡易の点（.axlx-score-badge）を隠す。送る時の判定（buildSendItemsBrain）は今まで通り
  var _brainPrevSig = "";
  var _VERDICT_JA = { pass: ["通す", "#2e7d32", "#e8f5e9"], hold: ["保留", "#ef6c00", "#fff3e0"], drop: ["外す", "#c62828", "#ffebee"] };
  function brainPreview() {
    if (!tracked.length) return;
    try {
      chrome.storage.local.get(["current_customer_id"], function (r) {
        var cid = r && r.current_customer_id;
        if (!cid) return;
        var prepared = AxlxSendPairing.prepareItems(tracked.map(function (t) { return { url: t.btn.href, btn: t.btn }; }));
        var items = prepared.items.map(function (it) {
          var card = extractCard(it.btn);
          return { btn: it.btn, url: it.url, summary: buildPropertySummary(card, it.rank - 1), data: buildPropertyData(card, it.rank - 1) };
        });
        if (!items.length) return;
        var sig = cid + "#" + items.map(function (x) { return x.url; }).join(",");
        if (sig === _brainPrevSig) return;
        _brainPrevSig = sig;
        chrome.runtime.sendMessage({
          type: "axlx-brain-judge", dry_run: true, property_customer_id: cid, site: "realpro",
          items: items.map(function (x) { var jd = Object.assign({}, x.data); delete jd.cells; delete jd.head; delete jd.bld_text; return { summary: x.summary, data: jd, url: x.url }; }),
        }, function (resp) {
          void chrome.runtime.lastError;
          if (!resp || !resp.ok || !resp.data || !Array.isArray(resp.data.judgments)) { _brainPrevSig = ""; return; }
          document.querySelectorAll(".axlx-brain-badge").forEach(function (el) { el.remove(); });
          resp.data.judgments.forEach(function (j) {
            var x = items[j.index];
            if (!x || !x.btn || !x.btn.parentNode) return;
            var v = _VERDICT_JA[j.verdict] || ["?", "#455a64", "#eceff1"];
            var b = document.createElement("span");
            b.className = "axlx-brain-badge";
            b.style.cssText = "margin-left:4px;font-size:10px;font-weight:700;padding:1px 5px;border-radius:6px;vertical-align:middle;white-space:nowrap;color:" + v[1] + ";background:" + v[2] + ";";
            b.textContent = "🧠 " + j.score + " " + v[0];
            b.title = "物件検索ブレインの下見（送る時と同じ判定・記録しない）\n" + (Array.isArray(j.reasons_ja) ? j.reasons_ja.join("\n") : "");
            x.btn.parentNode.insertBefore(b, x.btn.nextSibling);
            // 2026-10-02 v2.5.69: 案内モード（realpro-guide.js）が「通す」の印刷用PDF を光らせるための印（読むだけ）
            try { x.btn.setAttribute("data-axlx-verdict", String(j.verdict || "")); } catch (_) {}
            // v2.5.80: 場所の判定（AREA_FAR＝希望の場所から遠い）も印に（送る前の確かめ search-stamp.js が数える）
            try { var _codes = Array.isArray(j.reason_codes) ? j.reason_codes : []; x.btn.setAttribute("data-axlx-area", _codes.indexOf("AREA_FAR") >= 0 ? "far" : _codes.some(function (c) { return /^AREA_(CLOSE|IN|REACH|NEAR|ANCHOR_REACH)/.test(c); }) ? "close" : ""); } catch (_) {}
          });
          if (!document.getElementById("axlx-brain-hide-simple")) {
            var st = document.createElement("style");
            st.id = "axlx-brain-hide-simple";
            st.textContent = ".axlx-score-badge{display:none!important}";
            document.head.appendChild(st);
          }
        });
      });
    } catch (_) {}
  }
  try {
    chrome.storage.onChanged.addListener(function (ch, area) { if (area === "local" && ch.current_customer_id) { _brainPrevSig = ""; brainPreview(); } });
  } catch (_) {}

  function buildSendItems() {
    var prepared = AxlxSendPairing.prepareItems(
      getSelectedTargets().map(function (t) { return { url: t.btn.href, btn: t.btn }; })
    );
    if (prepared.dropped > 0) {
      console.warn("[AXLX bulk-dl] 印刷用PDFのリンクが取れない行を " + prepared.dropped + "件 送信から外しました");
    }
    return prepared.items.map(function (it) {
      var card = extractCard(it.btn);
      return {
        url:     it.url,
        summary: buildPropertySummary(card, it.rank - 1),
        data:    buildPropertyData(card, it.rank - 1),
        card:    card,                 // ブレインで外した後に番号を振り直すため（送信の payload には入れない＝pluck で取らない）
        image_url: card.imageUrl || null,
      };
    });
  }

  // ── ブレインモード: 送信前に判定して、外す物を外す（2026-09-23）─────────────
  // 流れ: 組（url・説明文・data）を作る → background 経由で /api/property-brain/judge → 返ってきた判定で
  //   drop（apply_drop=true の時だけ）を外す → 【1】【2】… を1から詰め直す → 末尾の説明文に判定の1ブロックを足す。
  // ⚠ 影の運用（サーバーの PROPERTY_BRAIN_DROP 未設定）では apply_drop=false ＝ 1件も外さず、印（末尾のブロック）だけ付く。
  // ⚠ 失敗・タイムアウト・顧客IDなし・ブレインOFF → そのまま全件（fail-open）。
  // 2026-09-25 ブレイン×スタッフ（竹内「ブレインでもスタッフモードを行う」・旧はスタッフ中は呼ばなかった）: 判定は呼ぶ
  //   （property_brain_judgments に残り、売上サポの記録と並ぶ）が、
  //   ① 1件も外さない（サーバーも staff_mode=true で apply_drop=false・拡張でも apply_drop を見ない＝二重の歯止め）
  //   ② 説明文の末尾に判定のまとめ（外す候補・保留と理由）の1ブロックを付ける（2026-09-25 竹内「共有しておく」・売上番長グループ向け）。
  //   判定を待つ分（ふだん数秒・最大35秒）だけ送信が遅くなる。
  function buildSendItemsBrain(customerId, cb) {
    var items = buildSendItems();
    if (!_brainModeOn || !customerId || !items.length) { cb(items, null); return; }
    var _staffAtJudge = _staffModeOn; // 呼んだ時点のスタッフモード（応答までに切り替わっても、呼んだ時の扱いで通す）
    var done = false;
    var finish = function (kept, brain) { if (done) return; done = true; cb(kept, brain); };
    var watchdog = setTimeout(function () {
      console.warn("[AXLX bulk-dl][brain] 判定の応答が 35秒 無い → 全件送る（fail-open）");
      finish(items, null);
    }, 35000);
    try {
      chrome.runtime.sendMessage({
        type: "axlx-brain-judge",
        property_customer_id: customerId,
        site: "realpro",
        // 2026-09-25: 候補の記録用の生の文字（cells・head・bld_text）は判定に送らない（判定の payload は今まで通り）
        items: items.map(function (it) { var jd = Object.assign({}, it.data); delete jd.cells; delete jd.head; delete jd.bld_text; return { summary: it.summary, data: jd, url: it.url, image_url: it.image_url || null }; }),
      }, function (resp) {
        clearTimeout(watchdog);
        if (chrome.runtime.lastError || !resp || !resp.ok || !resp.data || !Array.isArray(resp.data.judgments)) {
          var why = chrome.runtime.lastError ? chrome.runtime.lastError.message : (resp && resp.error) || "応答なし";
          console.warn("[AXLX bulk-dl][brain] 判定できず → 全件送る（fail-open）:", why);
          finish(items, null);
          return;
        }
        var d = resp.data;
        var dropIdx = {};
        if (d.apply_drop && !_staffAtJudge) d.judgments.forEach(function (j) { if (j.verdict === "drop") dropIdx[j.index] = true; });
        var kept = items.filter(function (_, i) { return !dropIdx[i]; });
        // 外した後は【N】を1から詰め直す（send-pairing.prepareItems と同じ考え・ズレたまま送らない）
        if (kept.length !== items.length) {
          kept = kept.map(function (it, i) {
            return { url: it.url, summary: buildPropertySummary(it.card, i), data: buildPropertyData(it.card, i), card: it.card, image_url: it.image_url };
          });
        }
        // 判定のまとめ（外した物・保留の物と理由）を末尾の説明文に1ブロック
        // 2026-09-25 竹内「共有しておく」: スタッフモード中も売上番長グループに判定のまとめを付ける（外しはしない）
        if (d.note_line && kept.length) kept[kept.length - 1].summary += "\n\n" + d.note_line;
        var c = d.counts || {};
        console.log("[AXLX bulk-dl][brain] 判定 " + items.length + "件: 通す" + (c.pass || 0) + "・保留" + (c.hold || 0) + "・外す候補" + (c.drop || 0) +
          (_staffAtJudge ? "（スタッフモード・外さない・まとめは付ける）" : d.apply_drop ? "（外した " + (items.length - kept.length) + "件）" : "（影の運用・外さない）") + " " + (d.ms || 0) + "ms");
        d.judgments.forEach(function (j) {
          if (j.verdict !== "pass") console.log("[AXLX bulk-dl][brain] " + (j.verdict === "drop" ? "見送り候補" : "保留") + ": " + j.name + "（" + (j.reasons_ja || []).slice(0, 3).join("・") + "）" + (j.profit_yen != null ? " 利益目安 " + j.profit_yen + "円" : ""));
        });
        finish(kept, d);
      });
    } catch (e) {
      clearTimeout(watchdog);
      console.warn("[AXLX bulk-dl][brain] 判定の呼び出しに失敗 → 全件送る:", e && e.message);
      finish(items, null);
    }
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
    dlBtn.style.background = "#43a047";
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
      // btn.click() だとAdobeがPDF URLを横取りする。background経由でchrome.downloads.download()を使う。
      var dlUrl = targets[i].btn.href || targets[i].btn.getAttribute("href") || "";
      if (dlUrl && dlUrl.includes("realnetpro.com")) {
        chrome.runtime.sendMessage({ type: "axlx-download-realpro-pdf", url: dlUrl }, function () { void chrome.runtime.lastError; });
      } else {
        targets[i].btn.click();
      }
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
    // 2026-09-24 竹内「拡張ツールの方もこれで反映」: 列の見出し（th）から読むために、**間引かない**セル配列も持つ
    //   （texts は空セル・60字超を落とすので見出しの列番号と合わない）
    var allCells = cells.map(function (td) { return td.textContent.replace(/\s+/g, " ").trim(); });
    var texts = allCells.filter(function (t) { return t && t.length > 0 && t.length < 60; });

    // AD列はリアプロで10〜12列目あたりのため15まで取得
    // 2026-09-23 ブレインの画像フェーズ用: 行の中の間取り図らしい <img>（アイコン・ボタン画像は除く）。無ければ null。
    //   ⚠ リアプロの一覧に間取り図があるかは実機未確認。無ければ null のまま＝画像の読み取りはしない（判定は表の文字だけ）。
    return { name: name || "物件", texts: texts.slice(0, 15), cells: allCells, headerIdx: findHeaderIndex(row), imageUrl: findFloorPlanImage(row), bldText: findBuildingText(row) };
  }

  // ── 建物の段の文字（候補の記録用）─────────────────────────
  // 2026-09-25 竹内「候補の記憶を太くする」: リアプロの部屋の行（印刷用PDF のある行）には駅・徒歩・所在地・築年が無く、
  //   候補の記録で徒歩 0%・築年 0件だった。建物名を探す所（extractCard）と同じく、行より前の「住所・沿線・徒歩」を含む段の文字を
  //   そのまま残し、読むのはサーバー（candidate-facts.ts）に任せる（画面の並びを推測で決め打ちしない・後で読み直せる）。
  //   ⚠ 見つからなければ null（今までと同じ）。説明文・送る物は変えない（候補の記録にだけ入る）
  function findBuildingText(row) {
    try {
      if (!row) return null;
      var pick = function (el) {
        if (!el || el.textContent.indexOf("印刷用PDF") !== -1) return null;
        var t = (el.innerText || el.textContent || "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
        if (t.length < 6 || t.length > 1500) return null;
        return /住所|所在地|沿線|徒歩|築/.test(t) ? t.slice(0, 600) : null;
      };
      // ① 同じ tbody の前の行（8行まで）
      var p = row.previousElementSibling;
      for (var i = 0; i < 8 && p; i++, p = p.previousElementSibling) { var a = pick(p); if (a) return a; }
      // ② 親をたどって、その前の兄弟（6段まで）
      var cur = row.parentElement;
      for (var j = 0; j < 6 && cur; j++, cur = cur.parentElement) { var b = pick(cur.previousElementSibling); if (b) return b; }
    } catch (_) {}
    return null;
  }

  /** 候補の記録（property_pool）に、その1件の資料（印刷用PDF）の URL を足す（送る物・説明文は変えない） */
  function poolWithUrl(items) {
    return items.map(function (it) {
      var d = Object.assign({}, it.data || {});
      if (it.url && !d.pdf_url) d.pdf_url = it.url;
      return d;
    });
  }

  // ── 列の見出し（th）→ 列番号 ─────────────────────────────
  // 2026-09-24 竹内「AD − 見積書の割引が利益。拡張ツールの方もこれで反映」:
  //   AD は「間取りの後ろの Nヶ月 セル」で探していたため候補の 37% しか取れず、家賃は 0%・敷礼は説明文だけだった
  //   （実測 property_candidate_pools 30,681件・設計知見 2026-09-23）。score-overlay.js は th「AD」の列番号から取れている
  //   （extractAdMonthsFromRealproDom）ので、同じ考え方で AD・賃料・管理費・敷金・礼金・間取り・徒歩・築年を**見出しの列から**読む。
  //   ⚠ 見出しの文言・列の並びは実機で確かめていない。見出しが見つからない項目は**今までの読み方に戻る**（推測で別の列を触らない）。
  //   使った読み方は data.read_mode（header / heuristic）に残し、候補プールで率を数えられるようにする。
  var _headerLogged = false;
  /** セルの文字が「AD」か（th でも td でも） */
  function _isAdCell(el) { return !!el && el.textContent.replace(/\s+/g, "").toUpperCase() === "AD"; }
  /**
   * 見出し行を探す（2026-09-24 実測: 5件全部 read_mode=heuristic ＝ 今までの「row.closest('table') の th」では見つからなかった。
   *   リアプロは見出しが td だったり、見出しとデータ行が別の table だったりし得る）。順に:
   *   ① 同じ table の中で「AD」のセル（th/td）がある行 ② 親の table（3段まで） ③ 同じ table 内で row より前の行を遡る
   *   ④ 文書全体で row より前にある最後の「AD」セルの行。見つかった手段を strategy に残す
   */
  function _findHeadRow(row) {
    var table = row && row.closest("table");
    var t = table, depth = 0;
    while (t && depth < 4) {
      var cells = Array.from(t.querySelectorAll("th,td"));
      for (var i = 0; i < cells.length; i++) if (_isAdCell(cells[i])) return { headRow: cells[i].parentElement, strategy: depth === 0 ? "same_table" : "parent_table_" + depth };
      t = t.parentElement ? t.parentElement.closest("table") : null;
      depth++;
    }
    // ③ 前の行を遡る（同じ tbody / table）
    var prev = row ? row.previousElementSibling : null;
    while (prev) {
      var pc = Array.from(prev.querySelectorAll("th,td"));
      for (var j = 0; j < pc.length; j++) if (_isAdCell(pc[j])) return { headRow: prev, strategy: "previous_row" };
      prev = prev.previousElementSibling;
    }
    // ④ 文書全体: row より前にある最後の「AD」セル
    if (row) {
      var all = Array.from(document.querySelectorAll("th,td")).filter(_isAdCell);
      var last = null;
      for (var k = 0; k < all.length; k++) {
        if (all[k].compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) last = all[k];
      }
      if (last) return { headRow: last.parentElement, strategy: "document_preceding" };
    }
    // 見出しに AD が無い: th が一番多い行
    if (table) {
      var best = null, bestN = 0;
      Array.from(table.querySelectorAll("tr")).forEach(function (tr) {
        var n = tr.querySelectorAll("th").length;
        if (n > bestN) { bestN = n; best = tr; }
      });
      if (best) return { headRow: best, strategy: "most_th" };
    }
    return null;
  }
  function findHeaderIndex(row) {
    try {
      var found = _findHeadRow(row);
      if (!found) { if (!_headerLogged) { _headerLogged = true; console.log("[AXLX bulk-dl] 列見出し: 見つからない → 今までの読み方"); } return null; }
      var headRow = found.headRow;
      var labels = Array.from(headRow.children).map(function (c) { return c.textContent.replace(/\s+/g, "").toUpperCase(); });
      var find = function (re) { for (var k = 0; k < labels.length; k++) if (re.test(labels[k])) return k; return -1; };
      var idx = {
        ad: find(/^AD$|^ＡＤ$|広告/),
        rent: find(/賃料|家賃/),
        adminFee: find(/管理費|共益費/),
        deposit: find(/^敷金?$|^敷/),
        keyMoney: find(/^礼金?$|^礼/),
        floorPlan: find(/間取/),
        walk: find(/徒歩|交通|最寄/),
        age: find(/築年|築/),
      };
      var any = Object.keys(idx).some(function (k) { return idx[k] >= 0; });
      // 2026-09-25: 見出しの文字も持つ（候補の記録に残し、サーバーが列の意味を読めるようにする）。数字の鍵ではないので cellByHeader には当たらない
      idx.labels = labels.slice(0, 40);
      if (!_headerLogged) {
        _headerLogged = true;
        console.log("[AXLX bulk-dl] 列見出し(" + found.strategy + "): " + (any ? JSON.stringify(idx) + " 見出し=" + JSON.stringify(labels) : "AD 等の見出しが無い → 今までの読み方"));
      }
      return any ? idx : null;
    } catch (_) { return null; }
  }
  /** 見出しの列のセル文字（無ければ null） */
  function cellByHeader(card, key) {
    var i = card && card.headerIdx ? card.headerIdx[key] : -1;
    if (i == null || i < 0 || !card.cells || card.cells.length <= i) return null;
    var t = String(card.cells[i] || "").trim();
    return t.length ? t : null;
  }
  /** 「2ヶ月」「0.5ヶ月」「100%」「なし」「－」→ ヶ月（なし=0・読めなければ null） */
  function parseMonthsText(t) {
    if (t == null) return null;
    t = String(t).replace(/[０-９．]/g, function (c) { return c === "．" ? "." : String.fromCharCode(c.charCodeAt(0) - 0xfee0); }).trim();
    var m = t.match(/(\d+(?:\.\d+)?)\s*(?:ヶ月|ヵ月|カ月|か月|ケ月|月)/);
    if (m) return parseFloat(m[1]);
    var p = t.match(/(\d+(?:\.\d+)?)\s*[%％]/);
    if (p) return parseFloat(p[1]) / 100;
    if (/^(なし|無し|無|－|-|0)$/.test(t)) return 0;
    return null;
  }
  /** 「58,000円」「5.8万円」「¥58,000」→ 円（読めなければ null） */
  function parseYenText(t) {
    if (t == null) return null;
    var s = String(t).replace(/[,，]/g, "").replace(/[０-９．]/g, function (c) { return c === "．" ? "." : String.fromCharCode(c.charCodeAt(0) - 0xfee0); });
    var rm = s.match(/(\d+(?:\.\d+)?)\s*万/);
    if (rm) return Math.round(parseFloat(rm[1]) * 10000);
    var ry = s.match(/¥\s*(\d+)|(\d+)\s*円/);
    if (ry) return parseInt(ry[1] || ry[2]);
    return null;
  }

  function findFloorPlanImage(row) {
    if (!row) return null;
    try {
      var imgs = Array.from(row.querySelectorAll("img"));
      for (var i = 0; i < imgs.length; i++) {
        var src = imgs[i].currentSrc || imgs[i].src || imgs[i].getAttribute("src") || "";
        if (!src) continue;
        var abs;
        try { abs = new URL(src, location.href).href; } catch (_) { continue; }
        if (!/^https?:\/\//.test(abs)) continue;
        if (/icon|btn|button|arrow|spacer|blank|logo|\.gif(\?|$)/i.test(abs)) continue;
        var w = imgs[i].naturalWidth || imgs[i].width || 0;
        var h = imgs[i].naturalHeight || imgs[i].height || 0;
        if (w && h && (w < 40 || h < 40)) continue;   // 小さい画像はアイコン
        return abs;
      }
    } catch (_) {}
    return null;
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

    // 敷金・礼金: 2026-09-24 まず見出しの列（敷金・礼金）から。無ければ間取りの直前2セルが Nヶ月 or なし/－ 形式なら採用
    // 列順: ...管理費 | 敷金 | 礼金 | 間取り...
    var _hDep = cellByHeader(card, "deposit"), _hKey = cellByHeader(card, "keyMoney");
    if (_hDep !== null && _hKey !== null && parseMonthsText(_hDep) !== null && parseMonthsText(_hKey) !== null) {
      var _fmt = function (t) { var m = parseMonthsText(t); return m === 0 ? "なし" : (String(m).replace(/\.0$/, "") + "ヶ月"); };
      lines.push("敷" + _fmt(_hDep) + " 礼" + _fmt(_hKey));
    } else if (madoriIdx >= 2) {
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

    // AD: 2026-09-24 まず見出しの列（AD）から。無ければ間取りより後のセルだけを検索して敷金礼金との混同を防ぐ
    var adLine = null;
    var _hAd = cellByHeader(card, "ad");
    if (_hAd !== null) {
      var _hAdM = parseMonthsText(_hAd);
      var _hAdY = /円|¥/.test(_hAd) ? parseYenText(_hAd) : null;
      if (_hAdM !== null && _hAdM > 0) adLine = "AD " + String(_hAdM).replace(/\.0$/, "") + "ヶ月";
      else if (_hAdY) adLine = "AD " + _hAdY.toLocaleString() + "円";
    }
    var _adStart = madoriIdx >= 0 ? madoriIdx + 1 : 0;
    if (adLine) _adStart = card.texts.length;   // 見出しから取れた時は下の探索をしない
    for (var _ai = _adStart; _ai < card.texts.length; _ai++) {
      var _at = card.texts[_ai].trim();
      var _am = _at.match(/^(\d+(?:\.\d+)?)[ヶか]月$/);
      if (_am) { adLine = "AD " + _at; break; }
      // 2026-09-24 竹内「250% は家賃の2.5ヶ月分」: リアプロの AD 列は「250%」「100% [備考有]」の形もある（家賃・敷礼のセルに % は無い）
      var _ap = _at.match(/^(\d+(?:\.\d+)?)\s*[%％]/);
      if (_ap) { adLine = "AD " + String(parseFloat(_ap[1]) / 100).replace(/\.0$/, "") + "ヶ月"; break; }
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
    // 2026-09-24: 見出しの列から読めた項目は header、無ければ今までの読み方（heuristic）。候補プールで率を数える
    data.read_mode = card.headerIdx ? "header" : "heuristic";
    var _hRent = cellByHeader(card, "rent");
    var _hAdmin = cellByHeader(card, "adminFee");
    // 2026-09-25: 見出しが「賃料/管理費」の1列だと賃料と管理費が同じ列になり、管理費に家賃が入っていた（候補の記録 861/861件が 管理費＝家賃）。
    //   同じ列の時は、そのセルの**2つ目の金額**を管理費にする（「65,000円 10,000円」→ 10,000）。2つ目が無ければ入れない
    var _sameCol = card.headerIdx && card.headerIdx.adminFee >= 0 && card.headerIdx.adminFee === card.headerIdx.rent;
    if (_hAdmin !== null && _sameCol) {
      var _amts = (String(_hAdmin).replace(/[,，]/g, "").match(/\d+(?:\.\d+)?\s*万|\d+\s*円|¥\s*\d+/g) || []).map(parseYenText).filter(function (v) { return v !== null; });
      if (_amts.length >= 2 && _amts[1] >= 0 && _amts[1] <= 100000 && _amts[1] < _amts[0]) data.admin_fee_yen = _amts[1];
      else if (_amts.length === 1 && /(?:なし|－|-)\s*$/.test(String(_hAdmin))) data.admin_fee_yen = 0;
    } else if (_hAdmin !== null) { var _av = parseYenText(_hAdmin); if (_av !== null && _av >= 0 && _av <= 100000) data.admin_fee_yen = _av; }
    var rentText = _hRent !== null ? _hRent : card.texts.find(function(t) { return /[0-9,，]+[\s]*[万円]/.test(t) || /¥/.test(t); });
    if (rentText) {
      // 2026-09-23: 旧 `/(\d+)万/` はリアプロの「58,000円」「¥58,000」に当たらず、30,681件中 2件しか rent が入っていなかった
      //   （実測 2026-09-21・設計知見「表示は正しく、記録だけが空」）。万・円・¥ の3形式を円で保存する。
      var _rt = rentText.replace(/[,，]/g, "").replace(/[０-９．]/g, function(c) { return c === "．" ? "." : String.fromCharCode(c.charCodeAt(0) - 0xfee0); });
      var rm = _rt.match(/(\d+(?:\.\d+)?)\s*万/);
      var ry = _rt.match(/¥\s*(\d+)|(\d+)\s*円/);
      var rv = rm ? Math.round(parseFloat(rm[1]) * 10000) : (ry ? parseInt(ry[1] || ry[2]) : null);
      data.rent = (rv && rv >= 20000 && rv <= 500000) ? rv : null;
    }
    var _hPlan = cellByHeader(card, "floorPlan");
    var madoriText = (_hPlan !== null && /[1-9](R|K|DK|LDK|SLDK|SDK)/.test(_hPlan)) ? _hPlan : card.texts.find(function(t) { return /[1-9](R\b|K\b|DK\b|LDK|SLDK|SDK)/.test(t); });
    if (madoriText) {
      var mm = madoriText.trim().match(/[1-9][A-Z]+/i);
      data.floor_plan = mm ? mm[0] : null;
      // 2026-09-25: 広さ（間取りのセルが「1K 22.62㎡」）。説明文には出ていたが候補の記録に無かった
      var _sq = madoriText.replace(/[０-９．]/g, function (c) { return c === "．" ? "." : String.fromCharCode(c.charCodeAt(0) - 0xfee0); }).match(/(\d{1,3}(?:\.\d{1,2})?)\s*(?:㎡|m2|m²|平米)/);
      if (_sq) { var _sv = parseFloat(_sq[1]); if (_sv >= 5 && _sv <= 500) data.area_sqm = _sv; }
    }
    var madoriIdx = madoriText ? card.texts.indexOf(madoriText) : -1;
    // 徒歩: 見出しの列（徒歩・交通）→「徒歩」を含むセル →「駅」を含むセル（説明文と同じ探し方）
    var _hWalk = cellByHeader(card, "walk");
    var accessText = _hWalk || card.texts.find(function(t) { return /徒歩/.test(t); }) || card.texts.find(function(t) { return /駅/.test(t); });
    if (accessText) {
      var wm = accessText.replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); }).match(/徒歩\s*(\d+)\s*分|(\d+)\s*分/);
      if (wm) data.walk_minutes = parseInt(wm[1] || wm[2]);
    }
    var _hAge = cellByHeader(card, "age");
    if (_hAge !== null) {
      var _ag = _hAge.replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); }).match(/(\d+)\s*年/);
      if (_ag) data.building_age = parseInt(_ag[1]); else if (/新築/.test(_hAge)) data.building_age = 0;
    }
    // 敷金・礼金: 2026-09-24 まず見出しの列（敷金・礼金）。円で書かれていれば deposit_yen / key_money_yen にも残す
    var _hDep2 = cellByHeader(card, "deposit"), _hKey2 = cellByHeader(card, "keyMoney");
    var _dmH = parseMonthsText(_hDep2), _kmH = parseMonthsText(_hKey2);
    if (_dmH !== null && _kmH !== null) {
      data.deposit_months = _dmH; data.key_money_months = _kmH;
      if (/円|¥/.test(_hDep2)) data.deposit_yen = parseYenText(_hDep2);
      if (/円|¥/.test(_hKey2)) data.key_money_yen = parseYenText(_hKey2);
    } else if (madoriIdx >= 2) {
      // 無ければ今まで通り（説明文と同じ: 間取りの直前2セル。なし/－ = 0）。2026-09-23 追加（それまで data には入れていなかった）
      var _toM = function(t) {
        if (!t) return null;
        t = t.trim();
        var m = t.match(/^(\d+(?:\.\d+)?)[ヶか]月$/);
        if (m) return parseFloat(m[1]);
        if (t === "なし" || t === "－" || t === "-") return 0;
        return null;
      };
      var _dm = _toM(card.texts[madoriIdx - 2]);
      var _km = _toM(card.texts[madoriIdx - 1]);
      if (_dm !== null && _km !== null) { data.deposit_months = _dm; data.key_money_months = _km; }
    }
    // AD: 2026-09-24 まず見出しの列（AD）。「2ヶ月」「0.5ヶ月」「100%」は ad_months、「30,000円」は ad_yen
    var _hAd2 = cellByHeader(card, "ad");
    var _gotAd = false;
    if (_hAd2 !== null) {
      var _hm = parseMonthsText(_hAd2);
      if (_hm !== null && _hm > 0 && _hm <= 12) { data.ad_months = _hm; _gotAd = true; }
      else if (/円|¥/.test(_hAd2)) { var _hy = parseYenText(_hAd2); if (_hy) { data.ad_yen = _hy; _gotAd = true; } }
    }
    if (!_gotAd && madoriIdx >= 0) {
      for (var _ai2 = madoriIdx + 1; _ai2 < card.texts.length; _ai2++) {
        var _at2 = card.texts[_ai2].trim();
        // 2026-09-23: 小数（0.5ヶ月・1.5ヶ月）も取る。円形式は ad_yen に分ける（itandi 側の「AD 30,000円→30ヶ月」の変換ミスを繰り返さない）
        var _am2 = _at2.match(/^(\d+(?:\.\d+)?)[ヶか]月$/);
        if (_am2) { data.ad_months = parseFloat(_am2[1]); break; }
        // 2026-09-24 竹内「250% は家賃の2.5ヶ月分・20,000円は AD の報酬額」: % は月数に
        var _ap2 = _at2.match(/^(\d+(?:\.\d+)?)\s*[%％]/);
        if (_ap2) { data.ad_months = parseFloat(_ap2[1]) / 100; break; }
        var _ay2 = /^(AD|広告料)/.test(_at2) ? _at2.replace(/[,，]/g, "").match(/(\d+)\s*円/) : null;
        if (_ay2) { data.ad_yen = parseInt(_ay2[1]); break; }
      }
    }
    // 2026-09-25 竹内「候補の記憶を太くする」: 行のセル（全部）・見出し・建物の段の文字をそのまま候補の記録に残す。
    //   駅・徒歩・所在地・築年・敷礼・号室・階は、ここで推測せずサーバー（/api/log-property-candidates → candidate-facts.ts）が読む
    //   （リアプロの見出しの並びは実機で確かめていないため。生の文字があれば読み方を直した後に読み直せる）。
    //   ⚠ data はブレインの判定（/api/property-brain/judge）にも渡るが、足した鍵は判定では読まない
    if (card.cells && card.cells.length) data.cells = card.cells.slice(0, 40).map(function (t) { return String(t).slice(0, 120); });
    if (card.headerIdx && card.headerIdx.labels) data.head = card.headerIdx.labels;
    if (card.bldText) data.bld_text = card.bldText;
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
    // v2.5.80 竹内「違うお客さんの物件がまぎれている」: この一覧を検索したお客様と今のお客様・場所を照らす（search-stamp.js）
    if (sendToLine && !_sendGuardOk(customerName, customerId)) return;

    var today = new Date().toLocaleDateString("ja-JP").replace(/\//g, "-");

    if (sendToLine) {
      // ── 売上番長に送る: 1件ずつ順番にLINE送信 ─────────────────────────────
      var lineBtn = document.getElementById("axlx-line-btn");
      var lineOrig = lineBtn.textContent;
      lineBtn.disabled = true;
      lineBtn.textContent = "送信中... (0/" + urls.length + ")";

      // 2026-09-18: urls / 説明文 / 学習用データは必ず同じ組から作る（位置で対応づけない）
      // 2026-09-23: ブレインモードなら送信前に判定（外す物を外す・失敗なら全件）
      buildSendItemsBrain(customerId, function (sendItems, brain) {
      if (!sendItems.length) {
        lineBtn.disabled = false;
        lineBtn.textContent = lineOrig;
        alert("ブレインが全件を見送りました（送信なし）。コンソールに理由を出しています。");
        return;
      }
      if (brain && sendItems.length !== urls.length) lineBtn.textContent = "送信中... (0/" + sendItems.length + "・ブレインが" + (urls.length - sendItems.length) + "件見送り)";

      chrome.runtime.sendMessage({
        type: "axlx-send-to-line",
        urls: AxlxSendPairing.pluck(sendItems, "url"),
        customer_name: customerName || null,
        property_summaries: AxlxSendPairing.pluck(sendItems, "summary"),
        property_pool: poolWithUrl(sendItems),   // 2026-09-25: 資料の URL も候補の記録に
        customer_id: customerId || null,
        customer_conditions: customerConditions || null,
        site: "realpro",
        // v2.5.81 この一覧を検索した時の条件（今のお客様の印の時だけ）→ 売上サポの回（property_pickups.search_conditions）
        search_stamp: (function () { var SS = (typeof self !== "undefined" ? self : window).AxlxSearchStamp; return SS ? SS.forSend(SS.read(), customerId, Date.now()) : null; })(),
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
        // 2026-10-01 竹内「送信した際に分かれば大丈夫」: サーバーが送付済みで外した数を引いて出す（旧は外す前の数を出していた）
        var _exc = resp.excluded_count || 0;
        if (resp.all_already_sent) {
          lineBtn.textContent = "⚠ すべて送付済みでした（送信なし）";
        } else {
          lineBtn.textContent = "✅ " + Math.max(0, sendItems.length - _exc) + "件 送信完了" + (_exc ? "（送付済み " + _exc + "件は除外）" : "") + (resp.from_cache ? "・押した資料 " + resp.from_cache + "件は手元から" : "");
        }
        if (_exc && resp.excluded) lineBtn.title = resp.excluded;
        setTimeout(function () { lineBtn.textContent = lineOrig; }, 5000);
      });
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
    win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>物件まとめ印刷</title><style>body{margin:0;background:#eee;font-family:sans-serif}.ctrl{position:fixed;top:12px;right:12px;z-index:9999;display:flex;gap:8px;background:rgba(0,0,0,0.7);padding:8px 12px;border-radius:10px}.ctrl button{padding:8px 14px;border:none;border-radius:6px;font-weight:bold;cursor:pointer;font-size:13px}.print-btn{background:#1565C0;color:#fff}.close-btn{background:#fff;color:#333}.page{background:#fff;margin:12px auto;max-width:900px;box-shadow:0 2px 8px rgba(0,0,0,0.2)}.label{background:#1565C0;color:#fff;font-size:11px;font-weight:bold;padding:4px 10px}iframe{width:100%;height:1050px;border:none;display:block}@media print{.ctrl{display:none!important}.page{box-shadow:none;margin:0;page-break-after:always}iframe{height:100vh}}</style></head><body><div class="ctrl"><button class="print-btn" id="axlx-print-btn">🖨️ PDF保存（' + urls.length + '枚）</button><button class="close-btn" id="axlx-close-btn">✕ 閉じる</button></div>' + iframes + '<script>document.getElementById("axlx-print-btn").onclick=function(){window.print()};document.getElementById("axlx-close-btn").onclick=function(){window.close()};</scr' + 'ipt></body></html>');
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

  /**
   * ★ 2.8.234 竹内さん「1ページだけの場合止まってしまう／1ページのみと把握して次へ」:
   *   リアプロは 1ページでも「次」セルが出ることがある。数字が1つだけ＝1ページのみ。
   *   次に onclick が無い／pager(現在以下)＝押せない次。把握印 list_page_one_only。
   */
  function _readPagerState() {
    var nums = [];
    var current = null;
    var nextEl = null;
    var nextOnclick = "";
    var texts = [];
    try {
      var tds = document.querySelectorAll("td.pager");
      for (var i = 0; i < tds.length; i++) {
        var td = tds[i];
        if (!_isElVisible(td)) continue;
        var t = String(td.textContent || "").replace(/\s+/g, "").trim();
        if (!t) continue;
        texts.push(t);
        if (/^\d+$/.test(t)) {
          var n = parseInt(t, 10);
          if (nums.indexOf(n) < 0) nums.push(n);
          var oc = String(td.getAttribute("onclick") || "");
          // 番号セルに onclick が無い＝いまのページ
          if (!oc) current = n;
        }
        if (/^(次|次へ|次のページ)$/.test(t)) {
          nextEl = td;
          nextOnclick = String(td.getAttribute("onclick") || "");
        }
      }
    } catch (_) {}
    if (current == null && nums.length) current = nums[0];
    var onlyOne = nums.length <= 1;
    var usable = false;
    if (nextEl && !_isDisabledEl(nextEl) && _isElVisible(nextEl) && !onlyOne) {
      if (nextOnclick) {
        var m = nextOnclick.match(/pager\s*\(\s*(\d+)/i);
        if (m) usable = Number(m[1]) > (current || 1);
        else usable = true;
      }
    }
    if (onlyOne) usable = false;
    return {
      nums: nums,
      current: current || 1,
      onlyOnePage: onlyOne,
      hasNextUsable: usable,
      texts: texts.slice(0, 12),
      nextOnclick: nextOnclick.slice(0, 40),
    };
  }
  try { window.__axlxReadPagerState = _readPagerState; } catch (_) {}

  // 「次」テキストを持つ clickable な要素を返す（1ページのみ／押せない次は null）
  function _findNextPageEl() {
    var NEXT_TEXTS = ["次", "次へ", "次のページ", ">", ">>"];

    /** ★ 2.8.234: 1ページのみなら次は無い（見た目の「次」に騙されない・印は把握側で残す） */
    try {
      var pst0 = _readPagerState();
      if (pst0.onlyOnePage) return null;
    } catch (_) {}

    /**
     * 2026-11-14 竹内さん「実際のところから学習する」:
     *   **前に押せた「次」の印**があれば、それを**最初に**探す（サイトの構造が変わっても当たる）。
     *   ⚠ 見つからなければ今までの候補へ戻る（安全側）。
     */
    try {
      if (Array.isArray(_pagerMarksCache) && _pagerMarksCache.length) {
        var lh = null;
        _findNextByLearned(_pagerMarksCache, function (h) { lh = h; });
        if (lh && _isElVisible(lh) && !_isDisabledEl(lh)) {
          console.log("[AXLX bulk-dl] _findNextPageEl: 前に押せた「次」の印で発見 tag=" + lh.tagName);
          return lh;
        }
      }
    } catch (_) {}

    // フェーズ0: リアプロ専用 td.pager（最も確実）
    // リアプロのページネーションは <TD class="pager" onclick="pager(...)">次</TD> の構造
    var pagerTds = document.querySelectorAll("td.pager");
    for (var pi = 0; pi < pagerTds.length; pi++) {
      var pt = pagerTds[pi];
      if (NEXT_TEXTS.indexOf(pt.textContent.trim()) !== -1 && _isElVisible(pt) && !_isDisabledEl(pt)) {
        var poc = String(pt.getAttribute("onclick") || "");
        /** ★ 2.8.234: onclick 無しの「次」は装飾＝最終ページ */
        if (!poc) {
          console.log("[AXLX bulk-dl] _findNextPageEl: 次にonclick無し → 最終ページ扱い");
          continue;
        }
        var pm = poc.match(/pager\s*\(\s*(\d+)/i);
        if (pm) {
          var pst1 = null;
          try { pst1 = _readPagerState(); } catch (_) { pst1 = null; }
          if (pst1 && Number(pm[1]) <= (pst1.current || 1)) continue;
        }
        console.log("[AXLX bulk-dl] _findNextPageEl: td.pager で次ボタン発見 onclick=" + poc);
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

  /**
   * 2026-11-14 竹内さん「次のページにいく次のボタンも押していない。実際のところから学習する」:
   *
   *   ⚠ 旧の `_findNextPageEl` は **決め打ちの候補**（`td.pager` → 文字ウォーカー → CSSクラス）で
   *     探していた。リアプロのページャーは `最初 前 1 2 3 4 次 最後` のように並ぶ**リンク/セル**で、
   *     構造や class が変わると**見つからず、そのまま「次ページなし＝完了」と判断**していた
   *     （実測: `search_audits.result` が空＝完了まで届いていない）。
   *
   *   → ① **実際のページャーの中身を記録する**（何が並んでいるか・どれが「次」か）
   *     ② **押せたかどうかを確かめる**（URL か一覧が変わったか）
   *     ③ 押せなければ**記録に残す**（次に直せるように）
   */
  function _pagerDiagnostics() {
    var out = { at: Date.now(), found: null, candidates: [], pagerTexts: [] };
    try {
      // ページャーらしい入れ物を集める（td.pager・pagination・class に pager/page を含む物）
      var boxes = [];
      var sel = 'td.pager, .pager, .pagination, [class*="pager"], [class*="pagination"], [class*="pageNavi"], [class*="page_navi"]';
      var found = document.querySelectorAll(sel);
      for (var i = 0; i < found.length && i < 6; i++) boxes.push(found[i]);
      // 画面の下の方にある「最初・前・次・最後」を含む入れ物も足す
      var all = document.querySelectorAll('td, div, ul, table, nav, span');
      for (var j = 0; j < all.length && boxes.length < 8; j++) {
        var t = String(all[j].textContent || "").replace(/\s+/g, "");
        if (t.length < 30 && /最初/.test(t) && /(次|最後)/.test(t)) boxes.push(all[j]);
      }
      for (var bi = 0; bi < boxes.length; bi++) {
        var b = boxes[bi];
        if (!_isElVisible(b)) continue;
        var items = [];
        var kids = b.querySelectorAll('a, button, td, li, span, input[type=button]');
        for (var ki = 0; ki < kids.length && ki < 30; ki++) {
          var k = kids[ki];
          var kt = String(k.textContent || (k.value || "")).replace(/\s+/g, "").slice(0, 12);
          if (!kt) continue;
          items.push({
            t: kt,
            tag: k.tagName,
            cls: String(k.className || "").slice(0, 30),
            onclick: String(k.getAttribute && k.getAttribute("onclick") || "").slice(0, 40),
            href: String(k.getAttribute && k.getAttribute("href") || "").slice(0, 60),
            vis: _isElVisible(k),
            dis: _isDisabledEl(k),
          });
        }
        if (items.length) out.pagerTexts.push({ tag: b.tagName, cls: String(b.className || "").slice(0, 30), items: items.slice(0, 20) });
      }
      var el = _findNextPageEl();
      if (el) out.found = { tag: el.tagName, cls: String(el.className || "").slice(0, 30), t: String(el.textContent || "").replace(/\s+/g, "").slice(0, 12) };
      // 「次」らしき物を全部ひろう（押せなかった時に「なぜ」を見るため）
      var nextLike = [];
      var cands = document.querySelectorAll('a, button, td, li, span, input[type=button]');
      for (var ci = 0; ci < cands.length && nextLike.length < 12; ci++) {
        var c = cands[ci];
        var ct = String(c.textContent || (c.value || "")).replace(/\s+/g, "");
        if (!/^(次|次へ|次のページ|>|>>)$/.test(ct)) continue;
        if (!_isElVisible(c)) continue;
        nextLike.push({ t: ct, tag: c.tagName, cls: String(c.className || "").slice(0, 30), dis: _isDisabledEl(c), onclick: String(c.getAttribute("onclick") || "").slice(0, 40) });
      }
      out.candidates = nextLike;
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    return out;
  }
  try { self.__axPagerDiag = _pagerDiagnostics; } catch (_) {}

  /**
   * 2026-11-14 竹内さん「次のページにいく次のボタンも押していない。実際のところから学習する」:
   *   **実際の画面で「次」がどこにあったか**を覚えて、次からそれを先に使う。
   *
   *   ⚠ 決め打ちの候補（`td.pager` 等）だけで探すと、構造が変わった時に見つからない。
   *   → 押せた時の要素の**印**（タグ・class・文字・親の class）を storage に残し、
   *     次回は**その印で先に探す**（見つからなければ今までの候補に戻る＝安全側）。
   *   保存する物: `axlx_pager_learned` = { at, marks: [{tag,cls,txt,parentCls}], okCount }
   */
  var PAGER_KEY = "axlx_pager_learned";
  /** 覚えた印の控え（storage を毎回読まない・起動時と保存時に更新） */
  var _pagerMarksCache = null;
  try {
    chrome.storage.local.get([PAGER_KEY], function (r) {
      try { _pagerMarksCache = (r && r[PAGER_KEY] && Array.isArray(r[PAGER_KEY].marks)) ? r[PAGER_KEY].marks : []; }
      catch (_) { _pagerMarksCache = []; }
      if (_pagerMarksCache.length) console.log("[AXLX bulk-dl] 覚えている「次」の印:", JSON.stringify(_pagerMarksCache).slice(0, 200));
    });
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== "local" || !ch || !ch[PAGER_KEY]) return;
      try { _pagerMarksCache = (ch[PAGER_KEY].newValue && Array.isArray(ch[PAGER_KEY].newValue.marks)) ? ch[PAGER_KEY].newValue.marks : []; } catch (_) {}
    });
  } catch (_) { _pagerMarksCache = []; }
  function _pagerMarkOf(el) {
    try {
      if (!el) return null;
      var p = el.parentElement;
      return {
        tag: String(el.tagName || "").toUpperCase(),
        cls: String(el.className || "").split(/\s+/).filter(Boolean).slice(0, 2).join(" ").slice(0, 40),
        txt: String(el.textContent || "").replace(/\s+/g, "").slice(0, 10),
        parentCls: String((p && p.className) || "").split(/\s+/).filter(Boolean).slice(0, 2).join(" ").slice(0, 40),
      };
    } catch (_) { return null; }
  }
  /** 押せた「次」を覚える（同じ印は1つに） */
  function _rememberPager(el) {
    try {
      var m = _pagerMarkOf(el);
      if (!m || !m.txt) return;
      chrome.storage.local.get([PAGER_KEY], function (r) {
        var cur = (r && r[PAGER_KEY]) || { marks: [], okCount: 0 };
        var marks = Array.isArray(cur.marks) ? cur.marks.slice(0, 6) : [];
        var key = m.tag + "|" + m.cls + "|" + m.txt + "|" + m.parentCls;
        var exists = marks.some(function (x) { return (x.tag + "|" + x.cls + "|" + x.txt + "|" + x.parentCls) === key; });
        if (!exists) marks.unshift(m);
        var o = {}; o[PAGER_KEY] = { at: Date.now(), marks: marks.slice(0, 6), okCount: (Number(cur.okCount) || 0) + 1 };
        try { chrome.storage.local.set(o); } catch (_) {}
        console.log("[AXLX bulk-dl] 「次」の場所を覚えました:", JSON.stringify(m));
      });
    } catch (_) {}
  }
  /** 覚えた印で「次」を探す（見つからなければ null＝今までの候補へ） */
  function _findNextByLearned(marks, cb) {
    try {
      if (!Array.isArray(marks) || !marks.length) { cb(null); return; }
      var hit = null;
      for (var i = 0; i < marks.length && !hit; i++) {
        var m = marks[i];
        if (!m || !m.txt) continue;
        var sel = m.tag ? m.tag.toLowerCase() : "*";
        var cands = document.querySelectorAll(sel);
        for (var j = 0; j < cands.length; j++) {
          var c = cands[j];
          var txt = String(c.textContent || "").replace(/\s+/g, "");
          if (txt !== m.txt) continue;
          if (m.cls) {
            var clsOk = false;
            var parts = String(m.cls).split(/\s+/);
            for (var k = 0; k < parts.length; k++) if (parts[k] && c.classList && c.classList.contains(parts[k])) { clsOk = true; break; }
            if (!clsOk) continue;
          }
          if (!_isElVisible(c) || _isDisabledEl(c)) continue;
          hit = c; break;
        }
      }
      cb(hit);
    } catch (_) { cb(null); }
  }

  // ── ページネーション: 「次」ボタンをクリックして true を返す ───────────────
  function clickNextPageBtn() {
    var el = _findNextPageEl();
    if (!el) {      /**
       * 2026-11-14 竹内さん「次のページにいく次のボタンも押していない。実際のところから学習する」:
       *   見つからなかった時に**何が並んでいたか**を残す（推測で直さない）。
       */
      try {
        var d = _pagerDiagnostics();
        _tmark("next_not_found", JSON.stringify({ cand: d.candidates.length, pagers: d.pagerTexts.length, first: (d.pagerTexts[0] && d.pagerTexts[0].items || []).map(function (x) { return x.t; }).join("/").slice(0, 80) }));
        console.warn("[AXLX bulk-dl] 次のページのボタンが見つかりません。ページャーの中身:", JSON.stringify(d.pagerTexts.slice(0, 2)).slice(0, 500));
      } catch (_) {}
      return false;
    }
    // 2026-11-10 人間的な動き: 押す前に、ボタンが画面に入るまで少しずつ動かす（人が一覧の下まで目で追う形）
    _humanScrollToEl(el);
    /**
     * ⚠ 旧は `el.click()` だけだった。リアプロのページャーは `td.pager` に `onclick="pager(..)"` が
     *   付いている事があり、素の `click()` では**ハンドラが動かない**事がある。
     *   → ① 素の click → ② 動かなければ onclick を直接呼ぶ → ③ それでもだめなら中の a を押す。
     */
    /**
     * ★ 2026-11-20 竹内さん「次への部分も直接入力になっていないか・人間が押すような形か」:
     *   旧は カーソル無しで click → onclick の直接実行 → 中の a の click を**同時に3回**出していた（機械的・2頁送りの恐れ）。
     *   → カーソルを「次」へ動かしてから1回だけ押す。頁が変わらない時だけ、間を置いて onclick → 中の a の順に1つずつ足す。
     */
    var urlBefore = String(location.href);
    var _moved = function () { return String(location.href) !== urlBefore || !el.isConnected; };
    var _fallbacks = [
      function () { var oc = el.getAttribute && el.getAttribute("onclick"); if (oc) (new Function(oc)).call(el); },
      function () { var innerA = el.querySelector && el.querySelector("a[href]"); if (innerA) innerA.click(); },
    ];
    var _tryFallback = function (i) {
      if (i >= _fallbacks.length) return;
      setTimeout(function () {
        if (_moved()) return;
        try { _fallbacks[i](); _tmark("next_fallback", "#" + (i + 1)); } catch (_) {}
        _tryFallback(i + 1);
      }, 2200 + Math.floor(Math.random() * 900));
    };
    var _pressOnce = function () {
      try {
        if (typeof window.__axlxRecNoteOp === "function") window.__axlxRecNoteOp("click", el);
        el.click();
      } catch (_) {}
      _tryFallback(0);
    };
    setTimeout(function () {
      try {
        var P = window.AxlxPointerUi;
        if (P && P.moveToEl) {
          try { if (P.ensure) P.ensure(); } catch (_) {}
          P.moveToEl(el).then(function () {
            try { if (P.tap) P.tap(); } catch (_) {}
            _pressOnce();
          }, _pressOnce);
        } else {
          _pressOnce();
        }
      } catch (_) { _pressOnce(); }
    }, 600 + Math.floor(Math.random() * 900));
    console.log("[AXLX bulk-dl] clickNextPageBtn: カーソルで押す tag=" + el.tagName);
    /** 2026-11-14 竹内さん「実際のところから学習する」: 押せた「次」の場所を覚える */
    _rememberPager(el);
    return true;
  }

  /**
   * 2026-11-14: 押した**後**に本当にページが変わったかを確かめる（変わっていなければ記録に残す）。
   *   ⚠ 「押した」と「進んだ」は別。旧は押したら進んだ前提で state を進めていたので、
   *     押せていない時は**同じページを何度も読んで終わる**（＝次のページが取れない）。
   * @returns {Promise<boolean>} 進んだか
   */
  function _verifyNextPage(urlBefore, maxMs) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      var limit = maxMs || 6000;
      var tick = function () {
        if (String(location.href) !== urlBefore) { resolve(true); return; }
        if (Date.now() - t0 > limit) { resolve(false); return; }
        setTimeout(tick, 350);
      };
      setTimeout(tick, 400);
    });
  }

  // ── 検索の点検（2026-09-25 竹内「0件だった場合ちゃんと検索されていない可能性がある」）──
  // axlx-batch-customer-done に「ページ数・読んだ行数・送れる行数・送った数・0件と決めた理由・件数表示の生の文字・URL」を載せる。
  // background は、ブレインの時だけその回の記録に足す（search-audit.js の tracker）。件数表示の場所は確かめていないので、画面の文字から
  // 「N件」の形を探して生の文字のまま残す（self.AxlxSearchAudit.readCountText）
  function _auditResult(state, extra) {
    var r = {
      site: "realpro",
      pages: state ? (state.currentPage || null) : 0,
      read_rows: state && state.readCount != null ? state.readCount : (state ? null : 0),
      sendable_rows: state && state.sendableCount != null ? state.sendableCount : (state ? null : 0),
      sent_count: state ? (state.sentCount || 0) : 0,
      zero_reason: null,
      url: String(location.href || "").slice(0, 300),
    };
    try {
      var A = self.AxlxSearchAudit;
      if (A && document.body) {
        var ct = A.readCountText(String(document.body.innerText || "").slice(0, 30000));
        r.count_text = ct.text; r.count_number = ct.number;
      }
    } catch (_) {}
    if (r.read_rows === 0) r.zero_reason = "no_rows";
    // 2026-09-29 v2.5.41 送付済みで選ばなかった数・一覧の更新日の経過（点検の C2）
    if (state && state.sentSkipped) r.sent_skipped = state.sentSkipped;
    if (state && state.updateAges && state.updateAges.n > 0) r.update_ages = state.updateAges;
    // 2026-09-30 v2.5.42 一覧で実際にチェックが入っていた部屋（見張りが送付済みの部屋を選んでいないか確かめる・150件まで）
    if (state && state.pickedRooms && state.pickedRooms.length) r.picked_rooms = state.pickedRooms.slice(0, 150);
    // 2026-09-30 v2.5.43 更新順で前回の検索より古い行で止めた（止めた行の更新日・前回の時刻・ページ）→ 点検の result・見張りの C3
    if (state && state.updateStop) r.stopped_at_last_search = state.updateStop;
    var _tl = _ttake();
    if (_tl) r.timings = _tl;
    return Object.assign(r, extra || {});
  }

  // ── 全ページ自動送信: 共通の次ページ遷移 or 完了処理 ─────────────────────
  // autoSendOnePage の onDone コールバックと start() 内の再開処理で共通利用する。
  function tryNext(state) {
    if (_guideBlocksAuto("tryNext")) return;
    if (_supBlocksAuto("tryNext")) return; // 統括が「渡してよい」と言っていない間はページをめくらない
    // ヒット多すぎ上限: 既定3ページまで送ったら4ページ目には進まず完了扱い（一括検索では次顧客へ）
    // 2026-09-19 竹内「17:00の便は項目は１ページだけで本来のように３ページ迄いかなくて大丈夫」:
    //   自動便は conditions.max_pages（サーバーの payload → background → conditions）で上限を変える
    //   2026-09-27: conditions は popup の経路では文字列（max_pages が読めない）→ background が置いた自動便の指定からも読む（auto-run.js）
    var _arOpts = _autoRunFor(state.customerId);
    // 2026-11-16 竹内「最大3で大丈夫／新着は最大5」: auto-run resolveMaxPages（指定→新着5→既定3）
    var _maxPages = (state.customerConditions && Number(state.customerConditions.max_pages))
      || (_AR() && _AR().resolveMaxPages ? _AR().resolveMaxPages(_arOpts, null) : null)
      || (_AR() ? _AR().pageLimit(_arOpts, null) : null)
      || (_AR() && _AR().DEFAULT_MAX_PAGES) || 3;
    // 2026-09-30 v2.5.43 更新順で前回の検索より古い行まで来た → 次のページは開かない（ページの上限より前に終える＝サイトへのアクセスが減る）
    if (state.updateStop && hasNextPageBtn()) {
      clearAutoSendState();
      var countElStop = document.getElementById("axlx-count");
      if (countElStop) countElStop.textContent = "前回の検索まで見た → 次へ";
      console.log("[AXLX bulk-dl] 前回の検索より古い行まで来た（P" + state.currentPage + "）→ " + (state.sentCount || 0) + "件送信。次のページは開かない。");
      try { chrome.runtime.sendMessage({ type: "axlx-batch-customer-done", customerId: state.customerId || null, propertyCount: state.sentCount || 0, audit: _auditResult(state) }, function() { void chrome.runtime.lastError; }); } catch (_) {}
      return;
    }
    if (state.currentPage >= _maxPages && hasNextPageBtn()) {
      clearAutoSendState();
      var countElLimit = document.getElementById("axlx-count");
      if (countElLimit) countElLimit.textContent = _maxPages + "P上限 → 次へ";
      console.log("[AXLX bulk-dl] " + _maxPages + "ページ上限到達 → " + (state.sentCount || 0) + "件送信。次顧客へ切替。");
      try { chrome.runtime.sendMessage({ type: "axlx-batch-customer-done", customerId: state.customerId || null, propertyCount: state.sentCount || 0, audit: _auditResult(state, { page_limit: _maxPages }) }, function() { void chrome.runtime.lastError; }); } catch (_) {}
      return;
    }
    if (hasNextPageBtn()) {
      _tmark("next", "P" + (state.currentPage + 1));
      var _urlBefore = String(location.href);
      var clicked = clickNextPageBtn();
      if (!clicked) {
        clearAutoSendState();
        // propertyCount を付けない（すでに送信済みの物件があるため0件アナウンスを出さない）
        try { chrome.runtime.sendMessage({ type: "axlx-batch-customer-done", customerId: state.customerId || null, audit: _auditResult(state, { next_page_failed: true }) }, function() { void chrome.runtime.lastError; }); } catch (_) {}
        console.error("[AXLX bulk-dl] 次ページへの遷移に失敗しました（次ページボタンが見つからない）");
        var countEl2 = document.getElementById("axlx-count");
        if (countEl2) countEl2.textContent = "次ページ遷移エラー";
      } else {
        /**
         * 2026-11-14 竹内さん「次のページにいく次のボタンも押していない。実際のところから学習する」:
         *   ⚠ 旧は押したら**進んだ前提**で state を進めていた。押せていないと
         *     同じページを何度も読んで終わる（＝次のページが取れない）。
         *   → **本当に URL が変わったかを確かめる**。変わらなければ記録に残して止める
         *     （同じページを繰り返さない＝サイトへのアクセスも増やさない）。
         */
        var countElW = document.getElementById("axlx-count");
        if (countElW) countElW.textContent = "次ページを開いています…";
        _verifyNextPage(_urlBefore, 14000).then(function (moved) {
          if (!moved) {
            clearAutoSendState();
            var d = {};
            try { d = _pagerDiagnostics(); } catch (_) {}
            _tmark("next_not_moved", JSON.stringify({ at: state.currentPage, cand: (d.candidates || []).length, pagers: (d.pagerTexts || []).length }));
            try {
              chrome.runtime.sendMessage({
                type: "axlx-batch-customer-done",
                customerId: state.customerId || null,
                audit: _auditResult(state, { next_page_not_moved: true, pager: { candidates: d.candidates || [], pagers: (d.pagerTexts || []).slice(0, 2) } }),
              }, function () { void chrome.runtime.lastError; });
            } catch (_) {}
            console.warn("[AXLX bulk-dl] 次ページのボタンを押しましたが、ページが変わりませんでした（ここで止めます）");
            var ce = document.getElementById("axlx-count");
            if (ce) ce.textContent = "次ページが変わりません";
            return;
          }
          // クリック成功後にstateを更新（失敗時にdirty stateが残らないようにする）
          setAutoSendState({ active: true, currentPage: state.currentPage + 1, customerName: state.customerName, customerConditions: state.customerConditions || null, customerId: state.customerId || null, sentCount: state.sentCount || 0, readCount: state.readCount || 0, sendableCount: state.sendableCount || 0, sentSkipped: state.sentSkipped || 0, updateAges: state.updateAges || null, pickedRooms: state.pickedRooms || null, updateCarry: state.updateCarry || null });
          // 進捗ハートビート: ページ遷移も「進行中」として background のタイムアウトをリセット
          try { chrome.runtime.sendMessage({ type: "axlx-batch-progress", customerId: state.customerId || null, sentCount: state.sentCount || 0 }, function () { void chrome.runtime.lastError; }); } catch (_) {}
          // AJAX: 次のinject()でCase Bが拾えるようにリセット
          // ページリロード: _pendingAutoSendDispatched は再初期化されるので問題なし
          _pendingAutoSendDispatched = false;
          console.log("[AXLX bulk-dl] 次ページへ遷移 P" + (state.currentPage + 1));
        });
      }
    } else {
      clearAutoSendState();
      // sentCount を必ず付ける: 0件なら background が「🔍【物件0件】」アナウンスを送る
      try { chrome.runtime.sendMessage({ type: "axlx-batch-customer-done", customerId: state.customerId || null, propertyCount: state.sentCount || 0, audit: _auditResult(state) }, function() { void chrome.runtime.lastError; }); } catch (_) {}
      var countEl = document.getElementById("axlx-count");
      if (countEl) countEl.textContent = "全ページ送信完了！";
      console.log("[AXLX bulk-dl] 全ページ自動送信が完了しました。（" + state.currentPage + "ページ / " + (state.sentCount || 0) + "件送信）");
    }
  }

  /** ★ 2026-11-18 平田: 送付中も無進捗5分で batch_timeout しないよう心拍（background がリセット） */
  function _batchProgressPing(customerId, sentCount) {
    try { chrome.runtime.sendMessage({ type: "axlx-batch-progress", customerId: customerId || null, sentCount: sentCount || 0 }, function () { void chrome.runtime.lastError; }); } catch (_) {}
  }

  // ── 全ページ自動送信: 現ページを自動送信する ──────────────────────────────
  // mergePdfs を再利用せず chrome.runtime.sendMessage を直接呼ぶ
  // （コールバック内で onDone を呼ぶため）。
  function autoSendOnePage(state, onDone) {
    if (_guideBlocksAuto("autoSendOnePage")) return;
    if (_supBlocksAuto("autoSendOnePage")) return; // 統括が止めている間は1ページも送らない
    // 2026-11-10 v2.5.95 竹内さん「1件ずつのダウンロードとなりそして時間差も人間が確認するように」＋「まずリアプロから徹底的に」:
  //   旧は 10件ずつまとめて資料を取りに行っていた（人が1件ずつPDFを開いて見る速さではない）。
  //   既定を **1件ずつ** にする。人が1件のPDFを開いて中身を見て、次の行へ移る間（2〜6秒・対数正規）を置く。
  //   束の大きさは storage.local `axlxSendBatchSize` で変えられる（速さ優先の時は 2〜3）。サイトへの負荷は
  //   「押す回数」ではなく「取りに行く回数」で決まるので、1件ずつでもリクエスト数は同じ（間隔が広がるだけ）。
  var SEND_BATCH_SIZE_DEFAULT = 1;
  function _sendBatchSize() {
    try {
      var v = Number(sessionStorage.getItem("axlxSendBatchSize"));
      if (v >= 1 && v <= 20) return Math.floor(v);
    } catch (_) {}
    return SEND_BATCH_SIZE_DEFAULT;
  }
    var countEl = document.getElementById("axlx-count");
    _tmark("page", "P" + state.currentPage, state.customerId || null);
    if (countEl) countEl.textContent = "全ページ送信中 P" + state.currentPage + "...";
    try { _batchProgressPing(state.customerId || null, state.sentCount || 0); } catch (_) {}

    // 2026-11-10 竹内さん「リアプロの一気に選択されてしまうのでなくて1つ1つ行っていく形で。チェックボックスはこの印刷用PDFのところの部分のこと」:
    //   旧は**先に全行へチェックを入れて**から選別して外していた（画面で一斉にチェックが付く＝機械らしい・人が1件ずつ選ぶ形と違う）。
    //   新は **チェックを一切触らずに候補を作り**（送付済み・更新日で止める行はここで外す）、1件ずつ「選ぶ → 送る → 次を選ぶ」を繰り返す。
    //   画面は常に1件だけチェックが入る（人が1軒ずつ選んで送るのと同じ形）。
    var _skCounted = tracked.length > 0;
    _beginSelect();
    return;

    function _beginSelect() {
      var cand = tracked.filter(function (t) { return t.cb && t.btn && AxlxSendPairing.isHttpUrl(t.btn.href); });
      if (cand.length) { _selectAllowed(cand); return; }
      // DOM がまだレンダリング中の可能性があるため最大4秒待つ（チェックは触らない）
      var _pollWait = 0;
      var _pollTimer = setInterval(function () {
        inject();
        var c2 = tracked.filter(function (t) { return t.cb && t.btn && AxlxSendPairing.isHttpUrl(t.btn.href); });
        _pollWait += 200;
        if (c2.length || _pollWait >= 4000) {
          clearInterval(_pollTimer);
          if (!c2.length) {
            console.warn("[AXLX bulk-dl] autoSendOnePage: " + _pollWait + "ms待機後も物件なし → スキップ");
            onDone(true, 0);
            return;
          }
          _selectAllowed(c2);
        }
      }, 200);
    }

    /** 候補から送らない行（送付済み・前回の検索より古い）を外す。チェックは触らない */
    function _selectAllowed(cand) {
      // 更新順で止める線（前回の検索より古い行）を決める＝今までの決まりをそのまま使う
      _applyUpdateOrderStop(state);
      _countRowAges(state);
      var allowed = [], sent = 0, old = 0;
      cand.forEach(function (t) {
        var why = _rowSkipReason(state, t);
        if (why === "sent") { sent++; t.__axSkip = true; return; }
        if (why === "old") { old++; return; }
        allowed.push(t);
      });
      if (sent) console.log("[AXLX bulk-dl] 送付済みの部屋 " + sent + "件は送らない（資料を取りに行かない）");
      if (old) console.log("[AXLX bulk-dl] 前回の検索より古い行 " + old + "件は送らない");
      /**
       * 2026-11-14 竹内さん「同じ建物の場合平米数が同じなら一番低い家賃の物件1件だけにする。
       *   同じマンションでも同じ間取りで大量に募集されている場合。ここもともとは設定していたのに
       *   今すべてダウンロードしているので改善する」
       *
       *   → この一覧の中から **同じ建物・同じ間取り・同じ平米数** の組を作り、**最安1件だけ**残す。
       *     ⚠ 送付済み・古い行を外した**後**に行う（残った物だけで比べる）。
       *     ⚠ スタッフモード・読めない項目は絞らない（`_applyCheapestPerLayout` の中で判断）。
       */
      try {
        var _cheap = _applyCheapestPerLayout(state, cand);
        if (_cheap && _cheap.dropped) {
          // ⚠ ここも「チェックされている物で絞る」のではなく、**送らない印**で外す
          //    （この時点ではまだ誰もチェックされていない＝`cb.checked` で絞ると全部消える）
          allowed = allowed.filter(function (t) { return !(t && t.__axCheapestSkip); });
          _tmark("cheapest_skip", _cheap.dropped + "件を最安1件に絞った");
        }
      } catch (e) { console.warn("[AXLX bulk-dl] 最安1件の絞り込みで失敗（絞らずに続けます）:", (e && e.message) || e); }
      if (!_skCounted) _skCounted = true;
      state.pageSkipped = sent;
      if (!allowed.length) {
        console.log("[AXLX bulk-dl] P" + state.currentPage + " は送る部屋が無い → 資料を取らずに次へ");
        onDone(true, 0);
        return;
      }
      _doSend(allowed.map(function (t) { return t.btn.href; }));
    }

    // 2026-11-10: 旧の _afterSelect（先に全行チェック→選別）は _selectAllowed に置き換えた（全行チェックをしない）

    function _doSend(sendUrls) {
      state.readCount = (state.readCount || 0) + sendUrls.length; // 検索の点検: 読んだ行数
      // 2026-11-10: 1件ずつ選ぶ形になったので、ここでは「どの部屋を送るか」をまだチェックしていない。
      //   送る物の記録（pickedRooms）は1件ずつ送る直前に _rememberPickedOne で足す。
      // 2026-11-10 v2.5.95 竹内さん「人間が確認するように」: 選び終わってから資料を取りに行くまでに
      //   「一覧を上から目で追って、どの部屋を送るか決める間」を置く（1.2〜4秒・対数正規）。
      //   押した直後に一斉に資料を取りに行くと機械らしい。サイトへのアクセスは増えない（待つだけ）
      var _Hp = self.AxlxHumanWait;
      var _lookGap = _Hp && _Hp.logNormalDelay ? _Hp.logNormalDelay(2200, 0.4) : (1200 + Math.floor(Math.random() * 2800));
      if (_lookGap > 8000) _lookGap = 8000;
      _tmark("look_wait", "P" + state.currentPage + " " + Math.round(_lookGap) + "ms");
      if (countEl) countEl.textContent = "P" + state.currentPage + " 送る部屋を確認中…";
      setTimeout(function () {
        // 2026-11-10 v2.6.13 竹内さん「一軒ずつ選択しておくるように」:
        //   ここから **1件選ぶ → 送る → 次を選ぶ** の繰り返しへ（旧は全行にチェックを入れてから1件ずつ送っていた）
        // 2026-11-10 v2.6.17 重大な不具合を修正:
        //   旧は tracked（＝画面の全行）からリストを作っていたため、**送付済み・更新日で止めた行・上限で外した行まで
        //   選び直して送ってしまう**恐れがあった（選別でチェックを外した意味が消える）。
        //   いまは「選別を通った行（sendUrls）」だけを対象にする＝送る物が正しく絞られる。
        var _allowed = {};
        (sendUrls || []).forEach(function (u) { _allowed[String(u)] = true; });
        var _list = tracked.filter(function (t) { return t.cb && t.btn && _allowed[String(t.btn.href)]; });
        if (!_list.length) { onDone(true, 0); return; }
        _oneByOneStart(state, _list, 0, function () {
          onDone(true, state.sentCount || 0);
        });
      }, _lookGap);
    }

    /**
     * 2026-11-10 v2.6.13 竹内さん「一軒ずつ選択しておくるように」:
     *   旧は先に全行へチェックを入れ、その後に1件ずつ送っていた（画面では全部にチェックが付いてから送信が始まる）。
     *   新は **1件選ぶ → その1件を送る → 次を選ぶ** の繰り返し（人が1軒ずつ選んで送る形）。
     *   ・選ぶのは1行だけ（前の行のチェックは外す）
     *   ・送り終わってから次の行を選ぶ（送信中に次のチェックを付けない）
     *   ・行の間は人の間（1.5〜4秒・たまに一息）
     *   ブレインの判定は1件ずつ呼ぶ（材料は同じ）。判定で外す物は選ばずに次へ。
     *   ⚠ 送付済み・更新日で止める・物件数の上限の選別は今まで通り（選ぶ前に必ず通す）
     */
    function _oneByOneStart(state, list, index, doneCb) {
      if (index >= list.length) { doneCb(); return; }
      var item = list[index];
      // ★ 2026-11-18 竹内さん「進捗ありは切らない」: 1件選ぶたびにも進みの合図（background の無進捗待ちを延ばす）
      try { _batchProgressPing(state.customerId || null, state.sentCount || 0); } catch (_) {}
      if (!item || !item.cb || !item.btn) { _oneByOneStart(state, list, index + 1, doneCb); return; }
      // 前の行のチェックを外す（1件だけ選ばれている状態を作る）
      tracked.forEach(function (t) { if (t.cb && t.cb !== item.cb && t.cb.checked) t.cb.checked = false; });
      updateBar();
      var H = self.AxlxHumanWait;
      var start = function () {
        // 2026-11-10 v2.6.17 重大な不具合を修正:
        //   旧は「チェックを積んで 1.6秒待って送る」だけだったので、カーソル移動＋迷いで押すのが遅いと
        //   **チェックが入る前に送信**していた（送る物が0件になったり、前の行を送ったりする）。
        //   いまは「実際にチェックが入るまで待つ」（最大8秒）→ 選んでから人が見る間 → 送る。
        var waitChecked = function (n) {
          if (item.cb.checked || n >= 16) {
            var gap = H && H.logNormalDelay ? H.logNormalDelay(1600, 0.45) : (1200 + Math.floor(Math.random() * 2000));
            if (gap > 6000) gap = 6000;
            if (countEl) countEl.textContent = "P" + state.currentPage + " " + (index + 1) + "/" + list.length + " 確認中…";
            setTimeout(function () {
              _doSendOne(item, state, function () {
                var nextGap = H && H.logNormalDelay ? H.logNormalDelay(1500, 0.45) : (900 + Math.floor(Math.random() * 1800));
                if (Math.random() < 0.12) nextGap += 800 + Math.floor(Math.random() * 1500);
                setTimeout(function () { _oneByOneStart(state, list, index + 1, doneCb); }, nextGap);
              });
            }, gap);
            return;
          }
          setTimeout(function () { waitChecked(n + 1); }, (H && H.pollDelay ? H.pollDelay(500) : 500));
        };
        waitChecked(0);
      };
      if (!item.cb.checked) {
        // 人が1件だけ押す（見えるカーソルでその行まで動いてから押す）
        // 2026-11-10 重大な不具合を修正: 旧は page-script.js 側の `enqueueHumanClick(item.cb, _clickEl, ...)` を呼んでいたが、
        //   この2つは bulk-dl.js の中には無い（ReferenceError になり、1件ずつの送信が丸ごと止まっていた）。
        _humanClickCb(item.cb);
        start();
      } else {
        start();
      }
    }

    /** 1件のチェックを人が押す形で入れる（見えるカーソル → たまに迷う → 押す → 反応を見る） */
    function _humanClickCb(cb) {
      if (!cb) return;
      var P = (typeof self !== "undefined" ? self : window).AxlxPointerUi;
      _humanScrollToEl(cb);
      var fire = function () { try { if (cb.isConnected && !cb.checked) cb.click(); } catch (_) {} };
      // 2026-11-10 竹内さん「ボタン選択する際人間ならたまにまよう」: 1件ずつ選ぶ所は人が一番迷う。
      //   15%ほどで迷い（3段: 一瞬250〜600／考え込む700〜1600／かなり1800〜4500）を足してから押す
      var hesitate = 0;
      if (Math.random() < 0.15 * (0.75 + Math.random() * 0.5)) {
        var _hr = Math.random();
        hesitate = _hr < 0.65 ? 250 + Math.floor(Math.random() * 350)
                 : _hr < 0.95 ? 700 + Math.floor(Math.random() * 900)
                 : 1800 + Math.floor(Math.random() * 2700);
      } else if (Math.random() < 0.08) {
        hesitate = 400 + Math.floor(Math.random() * 700);
      }
      var tap = function () {
        if (P && P.tap) P.tap();
        setTimeout(fire, 90 + Math.floor(Math.random() * 160));
      };
      var withHesitate = function (fn) { if (hesitate > 0) setTimeout(fn, hesitate); else fn(); };
      if (P && P.moveToEl) {
        P.ensure();
        P.moveToEl(cb).then(function () { withHesitate(tap); }, function () { withHesitate(fire); });
      } else withHesitate(fire);
    }

    /** 1件だけを組にして送る（判定は1件ずつ・材料は今まで通り） */
    function _doSendOne(item, state, next) {
      var sendItems = [];
      try {
        // 2026-11-10 v2.6.17: この行だけを組にする。チェックが外れていても対象の行は必ず入れる
        //   （選別を通った行だけが list に来ているので、ここでの対象は安全）
        var all = buildSendItems();
        sendItems = all.filter(function (it) { return it && it.url && it.url === item.btn.href; });
        if (!sendItems.length) {
          // 組が作れない（印刷用PDFのリンクが取れない）→ この行は飛ばす
          console.warn("[AXLX bulk-dl] 1件送信: 組が作れない行 → 飛ばす: " + String(item.btn.href || '').slice(0, 80));
          next();
          return;
        }
      } catch (_) { next(); return; }
      // 送る前に「本当にチェックが入っているか」を確かめる（入っていなければ一度だけ入れる）
      if (item.cb && !item.cb.checked && !item.__axForced) {
        item.__axForced = true;
        try { item.cb.checked = true; updateBar(); } catch (_) {}
        setTimeout(function () { _doSendOne(item, state, next); }, 400);
        return;
      }
      _rememberPickedOne(state, item); // 2026-11-10: 送る1件を記録（点検の C2・C3 が読む）
      // ブレインの判定（1件）
      var judge = function (kept, brain) {
        if (!kept || !kept.length) { next(); return; }
        state.sendableCount = (state.sendableCount || 0) + kept.length;
        _tmark("send", "P" + state.currentPage + " 1件");
        if (countEl) countEl.textContent = "P" + state.currentPage + " 送信中…";
        chrome.runtime.sendMessage({
          type: "axlx-send-to-line",
          urls: AxlxSendPairing.pluck(kept, "url"),
          customer_name: state.customerName || null,
          property_summaries: AxlxSendPairing.pluck(kept, "summary"),
          property_pool: poolWithUrl(kept),
          customer_id: state.customerId || null,
          customer_conditions: state.customerConditions || null,
          site: "realpro",
          sent_skipped: 0,
        }, function (resp) {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            var msg = chrome.runtime.lastError ? chrome.runtime.lastError.message : (resp && resp.error) || "応答なし";
            console.error("[AXLX bulk-dl] 1件送信のエラー:", msg);
            _tmark("send_err", "1件: " + String(msg).slice(0, 80));
            // 2026-11-10 v2.6.17: 送信エラーの時は件数を付けない（「分からない」）。0 と書くと「0件」と誤解される
            try {
              chrome.runtime.sendMessage({
                type: "axlx-batch-customer-done",
                customerId: state.customerId || null,
                audit: _auditResult(state, { send_error: String(msg).slice(0, 200) }),
              }, function () { void chrome.runtime.lastError; });
            } catch (_) {}
            return; // 次の行へは進まない（エラーの時は止める＝今まで通り）
          } else {
            _tmark("sent", "P" + state.currentPage + " 1件");
            state.sentCount = (state.sentCount || 0) + kept.length;
          }
          try { chrome.runtime.sendMessage({ type: "axlx-batch-progress", customerId: state.customerId || null, sentCount: state.sentCount || 0 }, function () { void chrome.runtime.lastError; }); } catch (_) {}
          next();
        });
      };
      // ブレインの時だけ判定（1件）。失敗しても送る（fail-open＝今まで通り）
      if (_brainModeOn && state.customerId) {
        buildSendItemsBrain(state.customerId, function (keptAll, brain) {
          var kept = (keptAll || sendItems).filter(function (it) { return it && it.url === item.btn.href; });
          judge(kept, brain);
        });
      } else {
        judge(sendItems, null);
      }
    }


  }

  // ── 全ページ自動送信: エントリポイント ────────────────────────────────────
  // _manual=true で呼ぶとスタッフモードチェックをスキップ（手動ボタン押下用）
  // _flagSnap: Case C（リロード後の再開）で渡される「誰の検索か」。
  //   popup.js が axlx_pending_auto_send に載せた顧客をそのまま使う。
  //   これが無い時だけ、従来どおり popup / storage の「今の顧客」に頼る。
  function autoSendAllPages(_manual, _flagSnap) {
    /**
     * 2026-11-10 竹内さん「古い一括のなくした方がよいかも。紛らわしくなる可能性あれば」:
     *   旧の「全ページ送る」（全行にチェックを入れて1ページずつ送る）は **使わない**。
     *   入口は新しい「印刷用PDFを1件ずつ押して送る」（autoPressPdfs）に1本化した。
     *   この関数は古い経路（拡張の古いタブ・残った合図）から呼ばれても何もしない（勝手に全件送らないための安全弁）。
     *   ⚠ 消さずに残している理由: background.js の一括検索が「全ページ送信完了（axlx-batch-customer-done）」を待つため、
     *     完了の合図は新しい流れ（_autoFinish）から送っている。ここは「呼ばれても動かない」だけの置き場。
     */
    console.log("[AXLX bulk-dl] 旧の全ページ送る（autoSendAllPages）は使いません（新しい1件ずつの押下に1本化）");
    try { chrome.storage.session.remove("axlx_pending_auto_send"); } catch (_) {}
    void _manual; void _flagSnap;
    _maybeAutoPressOnLoad();
    return;
  }

  // ── underbar.js からの全ページ自動送信シグナル受信 ───────────────────────
  // Step1: autofill ボタン押下時 → 現在の結果ボタンをスナップショット
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.from !== "axlx-autofill-initiated") return;
    _autofillInitiated = true;
    /**
     * 2026-11-12 竹内さん「自動で検索したら検索も条件入れる前にいま出ている物件のダウンロードを始めてしまう」:
     *   ここから**条件の入力が始まる**（検索を押すのはまだ先）。この間は画面の一覧（＝前のお客様の結果）を押さない。
     *   解除するのは `aixlinx-fill-done`（検索を押した合図）が来た時。
     */
    _autofillInProgress = true;
    _autofillStartedAt = Date.now();
    _setFillInProgress(true);
    console.log("[AXLX bulk-dl] 自動入力の開始 → 検索を押すまでは画面の一覧を押しません");
    /**
     * 2026-11-12: 前の一覧で自動押下が**まだ回っている**時は止める。
     *   止めないと、条件を入れ始めた横で前の一覧を押し続けてしまう。
     * ★ 2026-11-22: 並べ替えホバー中（`_autoPdfRun` がまだ null）も `_abortAdSort` で止める。
     *   旧は PDF 押しだけ止めて並べ替えカーソルが駅選択中に飛び続けた。
     * ★ 2026-11-22 根本: 前客の `_autoSendArmed` が残ったままだと、駅モーダル検知漏れ時に並べ替えが再発火する。
     *   条件入力の開始＝前の「検索完了→送付」武装を必ず外す。
     */
    try { _abortAdSort("autofill_initiated"); } catch (_) {}
    _autoSendArmed = false;
    _searchGraspedMem = null;
    try { chrome.storage.session.remove("axlx_pending_auto_send"); } catch (_) {}
    try { chrome.storage.session.remove("axlx_search_grasped"); } catch (_) {}
    try { sessionStorage.removeItem("axlx_pending_auto_send_sync"); } catch (_) {}
    try { sessionStorage.removeItem("axlx_search_grasped_sync"); } catch (_) {}
    try { chrome.storage.session.remove("axlx_search_grasped"); } catch (_) {}
    if (_autoPdfRun) {
      _autoPdfRun.stopped = true;
      console.warn("[AXLX bulk-dl][auto] 条件の入力が始まった → 前の一覧の自動押下を止めます");
      _tmark("auto_pdf_end", "stopped_by_autofill");
      _autoPdfRun = null;
      var _sb = document.getElementById("axlx-autopdf-stop-btn");
      if (_sb) _sb.style.display = "none";
    }
    _pendingAutoSendDispatched = false; // 新しい検索なので、押し始めの印を戻す
    // 前バッチ中断で残留したsessionStorage状態をクリア（Case Aの!getAutoSendState()チェックがブロックされるバグ対策）
    try { sessionStorage.removeItem(AUTO_SEND_KEY); } catch (_) {}
    // 前顧客の0件ポーリングが残っていれば即座に停止（次顧客の窓で誤発火を防ぐ）
    if (_zeroDetectTimer) { clearInterval(_zeroDetectTimer); _zeroDetectTimer = null; }
    // href URL をキーにしたスナップショット（DOM参照ではなくURL比較でAJAX再利用を正しく検出）
    _preAutofillBtns = new Set(findPrintBtns().map(function(b) { return b.href || b.getAttribute('href') || ''; }));
    _pendingAutoSendDispatched = false;
    console.log("[AXLX bulk-dl] autofill initiated, snapshot=" + _preAutofillBtns.size + "btn");
    /**
     * ★ 2026-11-16 勇気さん実測（owner_mismatch: 送る相手=勇気 / 検索の回=り）:
     *   旧は getCustomerFromPopup → storage の「今選んでいる客」をスナップした。
     *   一連中に次客を選ぶと、送る相手だけ次客になり止まる。
     *   → fill が載せた customerId を最優先。無ければ popup（従来）。
     */
    _pendingCustomerForAutoSend = null;
    var _initCid = e.data.customerId ? String(e.data.customerId) : null;
    var _initName = e.data.customerName ? String(e.data.customerName) : null;
    function _armSnap(name, conditions, customerId) {
      _pendingCustomerForAutoSend = { name: name, conditions: conditions, customerId: customerId };
      console.log("[AXLX bulk-dl] autofill initiated: customer snapshot =", name, customerId ? String(customerId).slice(0, 8) : "");
      if (_autoSendArmed && !_pendingAutoSendDispatched && !getAutoSendState()) {
        var _hasNBsnap = tracked.some(function(item) { var k = item.btn.href || item.btn.getAttribute('href') || ''; return k && !_preAutofillBtns.has(k); });
        if (_hasNBsnap) {
          _autoSendArmed = false;
          _pendingAutoSendDispatched = true;
          _maybeAutoPressOnLoad();
        }
      }
    }
    if (_initCid) {
      _armSnap(_initName || null, null, _initCid);
      // 名前・条件は後から補完（IDは fill のものを守る）
      getCustomerFromPopup(function(name, conditions, customerId) {
        if (!_pendingCustomerForAutoSend) return;
        if (String(_pendingCustomerForAutoSend.customerId) !== String(_initCid)) return; // 別客に上書きしない
        if (name) _pendingCustomerForAutoSend.name = name;
        if (conditions) _pendingCustomerForAutoSend.conditions = conditions;
        // popup が別客を返しても customerId は _initCid のまま
        void customerId;
      });
    } else {
      getCustomerFromPopup(function(name, conditions, customerId) {
        _armSnap(name, conditions, customerId);
      });
    }
  });

  /**
   * ★ 2026-11-18 HONOKA根本（物件未取得）:
   *   自動の検索 click 直前に page-script が `axlx-search-armed` を同期 postMessage。
   *   → ここで session の axlx_pending_auto_send を書く（リロード後 Case C の唯一の生存経路）。
   *   旧は popup の go_search 監視だけが書いていた → 自動 clickSearch では印ゼロ → 物件取得ゼロ。
   *   AJAX（リロード無し）でも _autoSendArmed を立て、fill-done が消えても新行を押せる。
   */
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.from !== "axlx-search-armed") return;
    try {
      var _armCid = e.data.customerId
        || (_pendingCustomerForAutoSend && _pendingCustomerForAutoSend.customerId)
        || null;
      var _armName = (_pendingCustomerForAutoSend && _pendingCustomerForAutoSend.customerName) || null;
      var _armCond = (_pendingCustomerForAutoSend && _pendingCustomerForAutoSend.conditions) || null;
      var _armFlag = {
        customerId: _armCid,
        customerName: _armName,
        conditions: _armCond,
        ts: Date.now(),
        armed_why: String(e.data.why || "search_armed").slice(0, 48),
        pageVer: e.data.pageVer || null,
      };
      /**
       * ★ 2026-11-22 audit#1585: chrome.storage.session.set は非同期。
       *   click 直後のリロードで書き込みが消える → Case C 不発。sessionStorage は同期で残す。
       */
      try { sessionStorage.setItem("axlx_pending_auto_send_sync", JSON.stringify(_armFlag)); } catch (_) {}
      chrome.storage.session.set({ axlx_pending_auto_send: _armFlag });
      // 検索を押した＝入力中ではない。busy 印を外し、Case A/C が動けるようにする
      _setFillInProgress(false);
      _fillBusyFromSession = false;
      try { chrome.storage.session.remove("axlx_fill_busy"); } catch (_) {}
      /**
       * ★ 2026-11-22 2.8.190: 検索を押した＝必ず armed。
       *   旧は _autofillInitiated の時だけ → AJAX結果更新で Case C 不発＋armed無し＝一覧で止まる。
       */
      _autoSendArmed = true;
      _autofillInProgress = false;
      _autofillInitiated = false;
      /**
       * ★ 2.8.263: 新しい検索を押したら旧 screenOk を捨てる。
       *   残ったままだと旧一覧で「検索完了→並べ替え」が先に走り、実検索を邪魔する。
       */
      try {
        _searchGraspedMem = {
          at: Date.now(),
          why: "search_armed_wait_page",
          screenOk: false,
          confirmed: false,
          pressed: true,
          intent: false,
          customerId: _armCid || null,
        };
        try { sessionStorage.setItem("axlx_search_grasped_sync", JSON.stringify(_searchGraspedMem)); } catch (_) {}
        try { chrome.storage.session.set({ axlx_search_grasped: _searchGraspedMem }); } catch (_) {}
        _sortCursorScheduled = false;
        if (_sortCursorTimer) { try { clearTimeout(_sortCursorTimer); } catch (_) {} _sortCursorTimer = null; }
        try { _abortAdSort("search_armed_new"); } catch (_) {}
        /**
         * ★ 2.8.264: 押した時のページの印（同じページか／移った先か）と軽い目印を残す。
         *   beforeunload がこの印より先に来ていれば移動中のまま（postMessage は click より後に届く事がある）。
         */
        _pageWaitN = 0;
        try {
          var _pb264 = _readSearchPressBaseline();
          var _pAt264 = Number(_pb264 && _pb264.at) || Date.now();
          if (_navPendingAt && _navPendingAt < _pAt264) _navPendingAt = 0;
          if (!_isNavPending()) {
            sessionStorage.setItem("axlx_search_press_doc", _AXLX_DOC_ID);
            sessionStorage.setItem("axlx_search_press_sig", _localScreenEvidenceBrief().brief);
          }
        } catch (_) {}
        try { _liveDlStep("search_press_wait_results", "armed→旧screenOk破棄・結果ページ待ち"); } catch (_) {}
        _nudge("⏳ 検索結果のページ表示を待っています");
      } catch (_) {}
      console.log("[AXLX bulk-dl] search-armed → pending保存＋armed（必ず／AJAX・リロード両対応）");
      try { _graspAcquire("armed", true, "search_armed→取得タイミングOK"); } catch (_) {}
      try { _liveDlStep("search_armed", String(e.data.why || "search").slice(0, 40)); } catch (_) {}
      // ★ 2.8.255: armed直後から沈黙見張り（screenOk待ちで送付中固着を解く）
      try { _touchPipelineProgress("search_armed"); _armPipelineSilence("search_armed"); } catch (_) {}
      try { _armScreenOkWatchdog("search_armed"); } catch (_) {}
      setTimeout(inject, 80);
      /**
       * ★ 2.8.207: armed 直後の 400ms kick は旧一覧で並べ替えが走る根。
       * ★ 2.8.263: さらに早くても結果ページ未表示。最初の poll を 2.2秒以降に（表示待ち）。
       */
      setTimeout(function () { try { _kickSortAfterSearch("armed_poll_page"); } catch (_) {} }, 2200);
      setTimeout(function () { try { _kickSortAfterSearch("armed_poll2"); } catch (_) {} }, 3800);
      setTimeout(function () { try { _kickSortAfterSearch("armed_poll3"); } catch (_) {} }, 5500);
    } catch (err) {
      console.warn("[AXLX bulk-dl] search-armed 失敗", err && err.message);
    }
  });

  /**
   * ★ 2026-11-22 竹内さん「検索押したって把握してからAD」:
   *   page-script の `_guideLikeAfterSearchGrasp` が送る。AD並び替えの前段の印。
   * ★ 2.8.195: お客さん番号＋画面照会OKなら本線で並べ替えへ kick（質の高い把握）。
   */
  /** ★ 2.8.241: page が古い把握印を捨てた → mem も捨てる */
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.from !== "axlx-search-grasped-clear") return;
    try {
      _searchGraspedMem = null;
      try { sessionStorage.removeItem("axlx_search_grasped_sync"); } catch (_) {}
      try { chrome.storage.session.remove("axlx_search_grasped"); } catch (_) {}
      try { _liveDlStep("stale_grasp_drop", String(e.data.why || "clear").slice(0, 40)); } catch (_) {}
    } catch (_) {}
  });
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.from !== "axlx-search-grasped") return;
    try {
      var _screenOk = !!e.data.screenOk || /^screen:/i.test(String(e.data.why || ""));
      var _pressedOnly = (e.data.pressed === true || /search_press_ok|press_ok/i.test(String(e.data.why || "")))
        && !_screenOk;
      var _intentOnly = e.data.intent === true && !_screenOk;
      _searchGraspedMem = {
        at: Number(e.data.ts) || Date.now(),
        why: String(e.data.why || "search").slice(0, 48),
        pageVer: e.data.pageVer || null,
        customerId: e.data.customerId || null,
        screenOk: _screenOk,
        confirmed: _screenOk,
        pressed: !!(e.data.pressed || _pressedOnly || _screenOk),
        intent: !!e.data.intent || _intentOnly,
      };
      try { sessionStorage.setItem("axlx_search_grasped_sync", JSON.stringify(_searchGraspedMem)); } catch (_) {}
      chrome.storage.session.set({ axlx_search_grasped: _searchGraspedMem });
      try {
        _tmark(
          "search_grasped",
          _searchGraspedMem.why
            + (_intentOnly ? ":intent" : (_screenOk ? ":screen" : (_pressedOnly ? ":pressed" : ":other"))),
        );
      } catch (_) {}
      if (e.data.customerId) {
        try { _autoRunCid = e.data.customerId; } catch (_) {}
        try { _liveDlStep("search_customer_bound", String(e.data.customerId).slice(0, 12)); } catch (_) {}
      }
      if (_intentOnly) {
        try { _liveDlStep("search_grasp_intent_only", String(e.data.why || "intent").slice(0, 40)); } catch (_) {}
        console.log("[AXLX bulk-dl] search-grasped 意図のみ → 並べ替えは結果確認後 (" + _searchGraspedMem.why + ")");
        return;
      }
      /**
       * ★ 2.8.240: 押下だけでは AD しない。結果画面 OK のときだけ kick。
       */
      if (_pressedOnly) {
        try { _liveDlStep("search_press_wait_results", String(e.data.why || "press").slice(0, 40)); } catch (_) {}
        _stampSortFlowAtom("search_press_wait", true, String(e.data.why || "press").slice(0, 40));
        console.log("[AXLX bulk-dl] search-grasped 押下済・結果待ち → ADしない (" + _searchGraspedMem.why + ")");
        // ★ 2.8.255: 押下後も screenOk が来ない時用の見張り
        try { _armScreenOkWatchdog("press_wait"); } catch (_) {}
        try { _armPipelineSilence("press_wait"); } catch (_) {}
        return;
      }
      if (_screenOk) {
        try { _liveDlStep("search_customer_screen_ok", String(e.data.screenBrief || e.data.why || "").slice(0, 48)); } catch (_) {}
        _stampSortFlowAtom("search_customer_grasp", true, String(e.data.screenBrief || "ok").slice(0, 40));
        _autoSendArmed = true;
        try { _forceAutoForPending("search_results_ready"); } catch (_) {}
        setTimeout(function () {
          try { _kickSortAfterSearch("customer_screen_grasp"); } catch (_) {}
        }, 50);
        console.log("[AXLX bulk-dl] search-grasped → 結果OK → AD並び替え可 " + _searchGraspedMem.why
          + (e.data.customerId ? (" 客=" + String(e.data.customerId).slice(0, 8)) : ""));
      }
    } catch (err) {
      console.warn("[AXLX bulk-dl] search-grasped 失敗", err && err.message);
    }
  });

  // Step2: fill-done 受信 → arm（スナップショット外の新結果が出たら Case A で発動）
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.from !== "aixlinx-fill-done") return;
    // ★ 2026-11-18: 入力中に来た別のお客さんを断った合図は、今のお客さんの入力・送付の構えに触らない
    if (e.data.gateKind === "busy_other_customer") return;
    /**
     * 2026-11-12 竹内さん「自動で検索したら検索も条件入れる前にいま出ている物件のダウンロードを始めてしまう」:
     *   検索を押した合図が来た＝**ここから先の一覧は今のお客様の検索結果**。押してよい。
     */
    _autofillInProgress = false;
    _setFillInProgress(false);
    if (e.data.gate) { _autofillInitiated = false; console.warn("[AXLX bulk-dl] fill-done（関所で止めた）→ 自動送信は構えない: " + (e.data.error || "")); return; }
    if (!_autofillInitiated) return;
    _autoSendArmed = true;
    _autofillInitiated = false;
    try { _touchPipelineProgress("fill_done"); _armPipelineSilence("fill_done"); } catch (_) {}
    console.log("[AXLX bulk-dl] fill-done 受信 → 全ページ自動送信 armed");
    _treset(null); _tmark("armed", null);
    try { _graspAcquire("armed", true, "fill-done→物件取得のタイミング（送付済把握→PDF押し）"); } catch (_) {}
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
        console.log("[AXLX bulk-dl] 2秒フォールバック: hasNewBtn=true → 1件ずつ押す形へ");
        // 2026-11-10: 旧の一括ではなく、1件ずつ押す形（自動モードなら自動で押す）
        _maybeAutoPressOnLoad();
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
          { type: "axlx-batch-customer-done", customerId: _armed0ItemCid, propertyCount: 0, audit: _auditResult(null, { zero_reason: "no_rows_25s" }) },
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
  var _OM = (typeof self !== "undefined" ? self : window).AxlxOwnMut;
  // ★ 2.8.279: 変化のたびにその場で数えず、0.3秒にまとめて1回（ページが続けて書き換わる間に何十回も数えない）
  var _obsCheckTimer = null;
  var obs = new MutationObserver(function (muts) {
    if (injectTimer || _obsCheckTimer) return;
    // 2026-10-06 v2.5.72: 拡張が書いた札・光・枠だけの変化では印刷用PDF を数え直さない（own-mutation.js・見張りどうしの反応し合いを止める）
    if (_OM && _OM.onlyOwn(muts)) return;
    _obsCheckTimer = setTimeout(function () {
      _obsCheckTimer = null;
      if (injectTimer) return;
      var btns = findPrintBtns();
      var uninjected = btns.filter(function (b) {
        return !b.previousSibling || !b.previousSibling.classList || !b.previousSibling.classList.contains("axlx-cb");
      });
      if (uninjected.length > 0) {
        injectTimer = setTimeout(function () { inject(); injectTimer = null; }, 400);
      }
    }, 300);
  });

  function start() {
    ensureBar();
    // ★ 2.8.254: 並べ替え tuck 残骸で消えたパネルを起動時に戻す
    try { _restoreGuidesAfterSort(); } catch (_) {}
    try { updateBar(); } catch (_) {}
    setTimeout(inject, 1200);
    obs.observe(document.body, { childList: true, subtree: true });
    // 定期: float-wrap / 物件送る枠が消えたままなら戻す（tuck 漏れ・右ドック被り対策）
    try {
      setInterval(function () {
        try {
          if (document.querySelector("[data-axlx-sort-prev-display]")) _restoreGuidesAfterSort();
        } catch (_) {}
        try {
          var w = document.getElementById("aixlinx-float-wrap");
          var mini = document.getElementById("aixlinx-mini-btn");
          var userMini = w && w.getAttribute("data-axlx-user-mini") === "1";
          var miniOn = mini && mini.style && mini.style.display === "flex";
          if (w && w.style && w.style.display === "none" && !userMini && !miniOn) {
            w.style.setProperty("display", "flex", "important");
          }
        } catch (_) {}
        try {
          var onEst = /[?&]method=estate\b/.test(String(location.search || ""))
            || /[?&]display=building\b/.test(String(location.search || ""));
          if (onEst) {
            try { _snapCustomerPanelRight(); } catch (_) {}
            ensureBar();
            updateBar();
            try { _placeSendBarVisible(); } catch (_) {}
            // 枠が DOM にあるか・見えているかを印に残す（steps=0 / 「出ていない」の切り分け）
            try {
              var _bChk = document.getElementById("axlx-bar");
              if (!_bChk) {
                try { _liveDlStep("send_bar_missing", "no_dom"); } catch (_) {}
              } else {
                var _br = _bChk.getBoundingClientRect();
                var _csb = window.getComputedStyle ? window.getComputedStyle(_bChk) : null;
                var _hid = (_csb && _csb.display === "none") || _bChk.style.display === "none"
                  || _br.width < 20 || _br.height < 20
                  || _br.right < 0 || _br.left > (window.innerWidth || 0);
                if (_hid) {
                  _bChk.style.setProperty("display", "flex", "important");
                  _bChk.style.setProperty("z-index", "2147483647", "important");
                  _bChk.style.setProperty("left", "12px", "important");
                  _bChk.style.setProperty("right", "auto", "important");
                  _bChk.style.setProperty("top", "auto", "important");
                  _bChk.style.setProperty("bottom", "16px", "important");
                  _bChk.style.setProperty("transform", "none", "important");
                  _bChk.setAttribute("data-axlx-docked", "bottom-left");
                  _bChk.removeAttribute("data-axlx-user-drag");
                  try { _liveDlStep("send_bar_force", "was_hidden"); } catch (_) {}
                }
              }
            } catch (_) {}
            /**
             * ★ 2.8.261 竹内さん「検索したところで止まる／改善が反映されない」:
             *   estate に行があるのに並べ替えも送付も動いていない＝固着。
             *   版印＋物件送る枠再表示＋並べ替え kick＋steps flush（steps=0 を止める）。
             */
            try {
              var _nR = 0;
              try { _nR = tracked.filter(function (t) { return t && t.btn && t.btn.isConnected; }).length; } catch (_) { _nR = 0; }
              var _busy = false;
              try { _busy = !!(_isFillBusy() || _isCondModalOpen() || _adSortInFlight || _autoPdfRun); } catch (_) { _busy = false; }
              /**
               * ★ 2.8.279 竹内さん「拡張ツールひらいているとき重すぎる」:
               *   旧は「行がある・動いていない」だけで4.5秒ごとに立て直していた＝**人が一覧を見ているだけでも**
               *   並べ替えの起動・行の読み直し・点検の送信が止まらなかった（DB: estate_stuck_recover・page_display_need_press）。
               *   → 待っている自動の仕事（検索の後の送付待ち・検索後の印）がある時だけ。
               *     続けて効かない時は間を広げる（4.5秒×6回の後は30秒ごと）。
               */
              var _pendWork = false;
              try { _pendWork = !!(_autoSendArmed || _hasSearchPendingSync()); } catch (_) { _pendWork = false; }
              // ★ 2.8.280: 通常モード（読み込み済みで自動でない）は自動の見回りをしない（並べ替えも押さない）
              if (_modeLoaded && !_autoModeOn) _pendWork = false;
              if (_nR > 0 && !_busy && _pendWork) {
                if (!window.__axlxEstateStuckAt) window.__axlxEstateStuckAt = Date.now();
                var _stuckN = Number(window.__axlxEstateStuckN) || 0;
                var _stuckGap = _stuckN < 6 ? 4500 : 30000;
                if (Date.now() - Number(window.__axlxEstateStuckAt || 0) >= _stuckGap) {
                  window.__axlxEstateStuckAt = Date.now();
                  window.__axlxEstateStuckN = _stuckN + 1;
                  var _mv2 = "";
                  try { _mv2 = (chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest().version : ""; } catch (_) {}
                  try { _liveDlStep("estate_stuck_recover", "v" + _mv2 + " rows=" + _nR); } catch (_) {}
                  try { _forceAutoForPending("estate_stuck"); } catch (_) {}
                  try { _kickSortAfterSearch("estate_stuck_recover"); } catch (_) {}
                  try {
                    if (typeof window.__axlxForceAuditStepsFlush === "function") {
                      window.__axlxForceAuditStepsFlush("estate_stuck");
                    }
                  } catch (_) {}
                }
              } else {
                window.__axlxEstateStuckAt = 0;
                window.__axlxEstateStuckN = 0;
              }
            } catch (_) {}
          }
        } catch (_) {}
      }, 2000);
    } catch (_) {}

    // Case D: ページリロード後の再開（ページ2以降）
    // 2026-11-10 竹内さん「古い一括のなくした方がよいかも。紛らわしくなる可能性あれば」:
    //   旧の「全ページ送る」（autoSendAllPages・autoSendOnePage・tryNext）は使わない。ページをめくるのも拡張の自動押下と同じ考えで
    //   1件ずつ押して送る形にまとめた（ページ送りの続きが残っていても、この画面の行を1件ずつ押すだけ＝二重に送らない）。
    var autoState = getAutoSendState();
    if (autoState && autoState.active) {
      clearAutoSendState(); // 旧のページ送りの続きは捨てる（同じ物件を二重に送らない）
      console.log("[AXLX bulk-dl][auto] 旧のページ送りの続きがあった → 捨てて、この画面の行を1件ずつ押します");
    }

    // Case C: ページリロード後の初回起動（sessionStorage 同期印を先・chrome.storage は控え）
    var _runCaseC = function (_flag, _fromSync) {
      if (!_flag || _pendingAutoSendDispatched) return;
      try { chrome.storage.session.remove("axlx_pending_auto_send"); } catch (_) {}
      try { sessionStorage.removeItem("axlx_pending_auto_send_sync"); } catch (_) {}
      var _age = (_flag && typeof _flag === "object" && _flag.ts) ? (Date.now() - _flag.ts) : 0;
      if (_age > 600000) {
        console.warn("[AXLX bulk-dl] Case C: 再開フラグが古い（" + Math.round(_age / 1000) + "秒前・" + (_flag.customerName || "不明") + "）→ 送信しない");
        return;
      }
      chrome.storage.session.get(["axlx_fill_busy"], function (r2) {
        var _H = (typeof self !== "undefined" ? self : window).AxlxCustomerHandoff;
        var _why = _H ? _H.pendingFlagBlockReason(_flag, r2 && r2.axlx_fill_busy, _pickCustomerIdForAuto(), Date.now()) : null;
        if (_why) {
          console.warn("[AXLX bulk-dl] Case C: 検索した印が今のお客さんの物ではない（" + _why + "）→ 押しません");
          _tmark("auto_pdf_load", "caseC_block_" + _why);
          return;
        }
        console.log("[AXLX bulk-dl][auto] Case C: 検索後のページ読み直し → この画面の行を1件ずつ押します" + (_fromSync ? "（sync印）" : ""));
        if (_flag && _flag.customerId) _autoRunCid = _flag.customerId;
        _autoSendArmed = true;
        try { _forceAutoForPending(_fromSync ? "case_c_sync" : "case_c"); } catch (_) {}
        try {
          var _gSync = null;
          try {
            var _gs = sessionStorage.getItem("axlx_search_grasped_sync");
            if (_gs) _gSync = JSON.parse(_gs);
          } catch (_) { _gSync = null; }
          _searchGraspedMem = (_gSync && _gSync.at)
            ? _gSync
            : { at: Date.now(), why: "case_c_pending", pageVer: (_flag && _flag.pageVer) || null };
          chrome.storage.session.set({ axlx_search_grasped: _searchGraspedMem });
          try { sessionStorage.setItem("axlx_search_grasped_sync", JSON.stringify(_searchGraspedMem)); } catch (_) {}
          _tmark("search_grasp_gate", _fromSync ? "case_c_sync" : "case_c");
          _tmark("search_grasped", _searchGraspedMem.why || "case_c_pending");
          try { _liveDlStep("after_search", _fromSync ? "case_c_sync" : "case_c"); } catch (_) {}
          try { _liveDlStep("search_to_sort", _fromSync ? "case_c_sync" : "case_c"); } catch (_) {}
          /**
           * ★ 2.8.196: リロード後は page-script の画面照合タイマーが死んでいる。
           *   一覧証拠があればここで客検索把握を screenOk に昇格（抜けを塞ぐ）。
           */
          try {
            var _nC = 0, _headC = false, _pdfC = 0;
            try { if (typeof _rescanRows === "function") _rescanRows(); } catch (_) {}
            try { _nC = tracked.filter(function (t) { return t && t.btn && t.btn.isConnected; }).length; } catch (_) {}
            try { _headC = !!_hasSortHeadVisible(); } catch (_) {}
            try { _pdfC = document.querySelectorAll("a.print, a[href*='print'], a[href*='Print']").length; } catch (_) {}
            if (_nC > 0 || _headC || _pdfC > 0) {
              _searchGraspedMem = Object.assign({}, _searchGraspedMem || {}, {
                at: Date.now(),
                why: "case_c_screen",
                customerId: (_flag && _flag.customerId) || (_searchGraspedMem && _searchGraspedMem.customerId) || null,
                screenOk: true,
                screen: { sortHead: _headC, rowsHint: _nC > 0, pdf: _pdfC },
              });
              try { sessionStorage.setItem("axlx_search_grasped_sync", JSON.stringify(_searchGraspedMem)); } catch (_) {}
              try { chrome.storage.session.set({ axlx_search_grasped: _searchGraspedMem }); } catch (_) {}
              try { _liveDlStep("search_customer_screen_ok", "case_c rows=" + _nC + " head=" + (_headC ? "Y" : "N")); } catch (_) {}
              _stampSortFlowAtom("search_customer_grasp", true, "case_c");
            }
          } catch (_) {}
        } catch (_) {}
        // ★ 2.8.191: 検索後は「1秒以降の人間待ち→並べ替えへカーソル」専用道（見る間固着を回避）
        _scheduleSortCursorAfterSearch(_fromSync ? "case_c_sync" : "case_c");
        var _zeroTries = 0;
        var _zeroCheck = function () {
          _zeroTries++;
          if (_autoPdfRun || _sortCursorScheduled) return;
          var _n = 0;
          try { if (typeof _rescanRows === "function") _rescanRows(); } catch (_) {}
          try { _n = tracked.filter(function (t) { return t && t.btn && t.btn.isConnected; }).length; } catch (_) { _n = 0; }
          if (_n > 0) {
            if (_zeroTries < 3) {
              try { _autoPdfSig = ""; } catch (_) {}
              _scheduleSortCursorAfterSearch("case_c_zero_retry");
              setTimeout(_zeroCheck, 1500);
            }
            return;
          }
          if (_zeroTries < 10) { setTimeout(_zeroCheck, 1200); return; }
          if (!_autoModeOn) return;
          var _isResult = true;
          try { if (typeof _looksLikeSearchResult === "function") _isResult = !!_looksLikeSearchResult(); } catch (_) { _isResult = true; }
          console.log("[AXLX bulk-dl][auto] Case C: 検索後の一覧が0件 → 終わりの合図を送ります（" + (_isResult ? "0件" : "検索結果の画面と読めない＝件数不明") + "）");
          _pendingAutoSendDispatched = true;
          _sendSkipDoneFor(_flag && _flag.customerId, _isResult ? "zero_rows_after_search" : "no_rows_not_result_page", _isResult ? 0 : null);
        };
        setTimeout(_zeroCheck, 1500);
      });
    };
    /**
     * ★ 2026-11-22 audit#1585: sync印は 0.7秒で起動（旧2.5秒待ちのあいだ一覧で止まって見えた）。
     *   chrome.storage だけの控えは従来どおり 2.5秒。
     */
    setTimeout(function () {
      if (_pendingAutoSendDispatched) return;
      try {
        var _syncFlag = null;
        try {
          var _sr = sessionStorage.getItem("axlx_pending_auto_send_sync");
          if (_sr) _syncFlag = JSON.parse(_sr);
        } catch (_) { _syncFlag = null; }
        if (_syncFlag && typeof _syncFlag === "object" && _syncFlag.ts) {
          _runCaseC(_syncFlag, true);
        }
      } catch (_) {}
    }, 700);
    setTimeout(function () {
      if (_pendingAutoSendDispatched) return;
      try {
        chrome.storage.session.get(["axlx_pending_auto_send"], function (data) {
          if (data && data.axlx_pending_auto_send && !_pendingAutoSendDispatched) {
            _runCaseC(data.axlx_pending_auto_send, false);
          }
        });
      } catch (_) {}
    }, 2500);

    // Case E: 自動が「次」を押した後の読み直し（td.pager はページ全体を読み直す）→ 次の頁を続きから押す
    setTimeout(function () {
      try {
        chrome.storage.session.get(["axlx_auto_next_page"], function (data) {
          var s = data && data.axlx_auto_next_page;
          if (!s || typeof s !== "object") return;
          chrome.storage.session.remove("axlx_auto_next_page");
          var age = Date.now() - (Number(s.at) || 0);
          // 印は押す直前に付け直す（2.8.131）。読み込みの遅れ・裏のタブで遅くなっても切らないよう 5分まで
          // 続けない時も黙らない: そのお客さんに「ここまで」の終わりの合図を送る（background が 20〜45分待たない・2026-11-20）
          if (age > 300000) {
            console.warn("[AXLX bulk-dl][auto] Case E: 次ページの続きの印が古い（" + Math.round(age / 1000) + "秒前）→ 続けない");
            _tmark("auto_next_page_resume", "stale_" + Math.round(age / 1000) + "s");
            _sendSkipDoneFor(s.customerId, "next_page_stale", s.total);
            return;
          }
          if (_autoPdfRun || _pendingAutoSendDispatched) return;
          var nowCid = _pickCustomerIdForAuto();
          if (s.customerId && nowCid && String(s.customerId) !== String(nowCid)) {
            console.warn("[AXLX bulk-dl][auto] Case E: お客さんが変わっている → 続けない");
            _tmark("auto_next_page_resume", "customer_changed");
            _sendSkipDoneFor(s.customerId, "next_page_customer_changed", s.total);
            return;
          }
          // 読み直しをまたいでも、押し始めたお客さんの番号を引き継ぐ（終わりの合図の番号ずれ防止・2.8.127）
          if (s.customerId) _autoRunCid = s.customerId;
          var resumeTries = 0;
          var go = function () {
            resumeTries++;
            if (_autoPdfRun || _pendingAutoSendDispatched) return;
            var n = 0;
            try { if (typeof _rescanRows === "function") _rescanRows(); } catch (_) {}
            try { n = tracked.filter(function (t) { return t && t.btn && t.btn.isConnected; }).length; } catch (_) { n = 0; }
            // 自動モードの読み込み（storage.local）と行の描画を待つ。待っても来なければ印を落として止まる（黙らない）
            if ((!_autoModeOn || n === 0) && resumeTries < 8) { setTimeout(go, 800); return; }
            if (!_autoModeOn) {
              _tmark("auto_next_page_resume", "not_auto");
              _sendSkipDoneFor(s.customerId, "next_page_not_auto", s.total);
              return;
            }
            if (n === 0) {
              // 次の頁が出たのに行が無い＝ここまで。送った数のまま終わりの合図
              _tmark("auto_next_page_resume", "no_rows");
              _sendSkipDoneFor(s.customerId, "next_page_no_rows", s.total);
              return;
            }
            _autoPdfPage = Number(s.page) || 2;
            _autoNextPageTries = Number(s.tries) || 1;
            _autoPdfTotalSent = Number(s.total) || 0;
            // 並べ替え直すと1頁目に戻る → この検索では並べ替え済みとして扱う
            _adSortDone = true;
            _pendingAutoSendDispatched = true;
            console.log("[AXLX bulk-dl][auto] Case E: 次ページの読み直し後 → P" + _autoPdfPage + " を続きから押します（行=" + n + "・累計 " + _autoPdfTotalSent + "件）");
            _tmark("auto_next_page_resume", "P" + _autoPdfPage + " rows=" + n);
            _guideLikeListFlowGrasp("after_next", function () {
              _startAutoPressAfterLook(n || 10, { continuePages: true });
            });
          };
          go();
        });
      } catch (_) {}
    }, 2700);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
  window.addEventListener("load", function () { setTimeout(inject, 2000); });

  // 2026-10-01 案内モード（realpro-guide.js）が一覧の行（建物名・号室・行の要素）を読むための口。読むだけ・行には触らない。
  //   見出しの読み方は _applySentSkip と同じ（先頭のセルが「部屋名／号室」の時だけ号室を読む）
  try {
    (typeof self !== "undefined" ? self : window).AxlxRealproRows = {
      list: function () {
        var SK = _SK();
        return tracked.map(function (t) {
          var card;
          try { card = extractCard(t.btn); } catch (_) { return null; }
          var labels = card && card.headerIdx && card.headerIdx.labels;
          var roomCol = !(labels && labels.length && !/部屋|号室/.test(String(labels[0] || "")));
          var c0 = card && card.cells ? card.cells[0] : null;
          return { name: card ? card.name : null, room: roomCol && SK ? SK.roomFromRealproCell(c0) : null, row: t.btn && t.btn.closest ? t.btn.closest("tr") : null, cb: t.cb, url: (t.btn && t.btn.href) || null, btn: t.btn || null };
        }).filter(Boolean);
      },
      /**
       * 2026-10-01 竹内「建物ごとはずす…みたら分かる状態に」: 送るとサーバーが送付済みとして外す行（list() の番号）に印を付ける。
       *   スタッフモードではサーバーが外さない（merge-pdfs の staff_mode）ので、印だけでチェックは外さない
       */
      markSentForServer: function (marks) {
        var rows = this.list();
        var n = 0;
        document.querySelectorAll(".axlx-sent-bld-badge").forEach(function (el) { el.remove(); });
        (Array.isArray(marks) ? marks : []).forEach(function (m) {
          var r = rows[m.index];
          if (!r || !r.cb) return;
          var btn = r.cb.nextSibling;
          var b = document.createElement("span");
          b.className = "axlx-sent-bld-badge";
          b.style.cssText = "margin-left:4px;font-size:10px;font-weight:700;padding:1px 5px;border-radius:6px;vertical-align:middle;background:#eceff1;color:#455a64;";
          b.textContent = m.reason === "building" ? "送付済みの建物" : "送付済み";
          b.title = _staffModeOn ? "このお客様に送ったことがあります（スタッフモードなので、チェックすれば送られます）" : "このお客様に送ったことがあります。送ってもサーバーが外すのでチェックを外しました";
          if (!_staffModeOn && r.cb.checked) { r.cb.checked = false; n++; }
          if (btn && btn.parentNode) btn.parentNode.insertBefore(b, btn.nextSibling); else r.cb.parentNode.appendChild(b);
        });
        if (n) updateBar();
        return n;
      },
    };
  } catch (_) {}
})();
