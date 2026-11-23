"use strict";

// 2026-09-27 竹内「拡張ツールは人間らしい動きをするために全て時間ランダムにする」: 人の操作の間（human-wait.js・manifest で先に読む）。
//   読めない時は元の値。_axContentHd＝人の操作の間（0.8〜1.5倍）／_axContentSd＝画面が落ち着くのを待つ固定の秒数（元より短くしない）
function _axContentHd(ms) { var H = (typeof self !== "undefined" ? self : window).AxlxHumanWait; return H ? H.humanDelay(ms) : ms; }
function _axContentSd(ms) { var H = (typeof self !== "undefined" ? self : window).AxlxHumanWait; return H ? H.settleDelay(ms) : ms; }

// リアプロ 左サイドバー強制表示スクリプト v8 - 包括対策版
(function () {
  const SIDEBAR_MARKERS = ["リスト検索", "所在地絞り込み", "沿線・駅絞り込み", "管理会社絞り込み"];

  // ══════════════════════════════════════════════════
  // STEP 1: ページのJSコンテキストに直接注入
  // content scriptのisolated worldではリアプロのJSに効かないため
  // scriptタグを使ってページ本体のJSとして実行させる
  // ══════════════════════════════════════════════════
  (function injectPageScript() {
    // 2026-09-27 待ち時間のばらつき（self.AxlxHumanWait）を page-script.js より先にページへ入れる。
    //   動的に足した <script> は既定で async（読み終わった順に動く）ので、async=false で入れた順に動かす。
    //   読めなくても page-script.js は元の値で動く（予備あり）。
    try {
      const hw = document.createElement("script");
      hw.src = chrome.runtime.getURL("human-wait.js");
      hw.async = false;
      hw.onload = function() { this.remove(); };
      (document.head || document.documentElement).appendChild(hw);
      // 2026-11-11 竹内さん「通常モードの動きから学ぶのか」: 覚えた動きの癖を読む純関数（human-wait の後・pointer-ui の前）
      const hl = document.createElement("script");
      hl.src = chrome.runtime.getURL("human-learn.js");
      hl.async = false;
      hl.onload = function() { this.remove(); };
      (document.head || document.documentElement).appendChild(hl);
      // 2026-11-10 v2.6.0 見えるカーソル（pointer-ui.js）も page-script.js より先にページへ
      const pu = document.createElement("script");
      pu.src = chrome.runtime.getURL("pointer-ui.js");
      pu.async = false;
      pu.onload = function() { this.remove(); };
      (document.head || document.documentElement).appendChild(pu);
    } catch (_) { /* 予備で動く */ }
    // 2026-10-06 v2.5.82 間取りの「〇〇以上」の広げ方（floor-ijou.js）も page-script.js より先にページへ
    try {
      const fi = document.createElement("script");
      fi.src = chrome.runtime.getURL("floor-ijou.js");
      fi.async = false;
      fi.onload = function() { this.remove(); };
      (document.head || document.documentElement).appendChild(fi);
    } catch (_) { /* 旧の広げ方で動く */ }
    /**
     * 2026-11-13 竹内さん「site_flow を実際に使う」:
     *   ⚠ **`learn-order.js` をページに入れていなかった**（v2.7.12 で作ったのに繋ぎ忘れ）。
     *     そのため page-script の `window.AxlxLearnOrder` が**常に undefined** で、
     *     `_orderByLearned` は毎回そのまま返していた＝**学んだ押す順番が一度も効いていなかった**。
     *   → page-script.js より先に入れる（web_accessible_resources には入っていた）。
     */
    try {
      const lo = document.createElement("script");
      lo.src = chrome.runtime.getURL("learn-order.js");
      lo.async = false;
      lo.onload = function() { this.remove(); };
      (document.head || document.documentElement).appendChild(lo);
    } catch (_) { /* 学んだ順は使わず元の順で動く */ }
    /**
     * ★ 2026-11-17 統括Pro「沿線↔駅の地図は既にある（STATION_LINE_MAP）→ page-script の自動把握に載せる」:
     *   地図を作るより先に、popup-maps を page へ注入して自動が読めるようにする。
     */
    try {
      const pm = document.createElement("script");
      pm.src = chrome.runtime.getURL("popup-maps.js");
      pm.async = false;
      pm.onload = function() { this.remove(); };
      (document.head || document.documentElement).appendChild(pm);
    } catch (_) { /* 地図無しでも DOM 同名全押しで動く */ }
    /**
     * ★ 2026-11-22 竹内さん「通常は把握が強い／自動はまばら。通常のように連携」:
     *   通常の光る把握は realpro-guide-plan（手順表）＋画面の今を毎ティック読む土台。
     *   旧は案内だけが手順表を持ち、自動（page-script）は別経路 → 把握がまばら。
     *   → 同じ手順表を page に注入し、自動も同じ stationStepAction／primary 判断を使う。
     */
    try {
      const gp = document.createElement("script");
      gp.src = chrome.runtime.getURL("realpro-guide-plan.js");
      gp.async = false;
      gp.onload = function() { this.remove(); };
      (document.head || document.documentElement).appendChild(gp);
    } catch (_) { /* 手順表無しでも primary 補完で動く */ }
    const s = document.createElement("script");
    s.async = false;
    s.src = chrome.runtime.getURL("page-script.js");
    s.onload = function() { this.remove(); };
    (document.head || document.documentElement).appendChild(s);
  })();

  // ══════════════════════════════════════════════════
  // STEP 2: CSSメディアクエリをスキャンして隠し規則を上書き
  // リアプロが @media (max-width: Npx) で隠している要素を !important で復元
  // ══════════════════════════════════════════════════
  function overrideHidingMQRules() {
    if (!document.head) return;
    if (document.getElementById("aixlinx-mq-fix")) return;

    const overrides = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSMediaRule)) continue;
        const m = rule.media.mediaText.match(/max-width:\s*(\d+(?:\.\d+)?)px/i);
        if (!m || +m[1] < 900 || +m[1] > 1400) continue;
        for (const inner of Array.from(rule.cssRules)) {
          if (!(inner instanceof CSSStyleRule)) continue;
          if (inner.style.display === "none" || inner.style.visibility === "hidden") {
            overrides.push(
              `${inner.selectorText} { display: revert !important; visibility: visible !important; }`
            );
          }
        }
      }
    }

    if (overrides.length) {
      const el = document.createElement("style");
      el.id = "aixlinx-mq-fix";
      el.textContent = overrides.join("\n");
      document.head.appendChild(el);
    }
  }

  // ══════════════════════════════════════════════════
  // STEP 3: content scriptからもサイドバー監視＋クリック（二重対策）
  // ══════════════════════════════════════════════════
  function isSidebarVisible() {
    if (!document.body) return false;
    for (const marker of SIDEBAR_MARKERS) {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      let n;
      while ((n = w.nextNode())) {
        if (!n.textContent.includes(marker)) continue;
        let el = n.parentElement;
        while (el && el !== document.body) {
          const cs = window.getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") return false;
          el = el.parentElement;
        }
        return true;
      }
    }
    return false;
  }

  function clickShowBtn() {
    if (!document.body) return false;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let n;
    while ((n = w.nextNode())) {
      if (!n.textContent.trim().includes("検索条件を表示")) continue;
      let el = n.parentElement;
      if (window.getComputedStyle(el).display === "none") continue;
      let t = el;
      for (let i = 0; i < 6 && t && t !== document.body; t = t.parentElement, i++) {
        if (["A", "BUTTON"].includes(t.tagName) || t.onclick || t.getAttribute("onclick") ||
            window.getComputedStyle(t).cursor === "pointer") {
          t.click();
          return true;
        }
      }
      el.click();
      return true;
    }
    return false;
  }

  function fix() {
    if (!document.body) return;
    if (isSidebarVisible()) return;
    // ページ側（page-script.js）が居れば、カーソル経由・4秒に1回の押しを頼む（2026-11-20 カーソル無しの押しをなくす）
    if (document.documentElement.getAttribute("data-axlx-ps") === "1") {
      window.postMessage({ from: "axlx-press-show-sidebar" }, "*");
      return;
    }
    clickShowBtn();
  }

  // resizeイベント（content scriptからも二重対策）
  window.addEventListener("resize", function () {
    [200, 600, 1500].forEach(function (d) { setTimeout(fix, _axContentHd(d)); });
  });

  // MutationObserver（ループ防止ロック付き）
  let lock = false;
  // 2026-10-06 v2.5.72: 拡張が書いた物（札・光・枠・class の axlx-）だけの変化では左の欄を確かめ直さない
  //   （旧は class/style の変化まで見るので、光や札の書き直しのたびに画面の全文字をたどっていた）
  const _OM = (typeof self !== "undefined" ? self : window).AxlxOwnMut;
  const obs = new MutationObserver(function (muts) {
    if (lock) return;
    if (_OM && _OM.onlyOwn(muts)) return;
    if (document.hidden) return;
    lock = true;
    setTimeout(function () { fix(); lock = false; }, 400);
  });

  function start() {
    fix();
    overrideHidingMQRules();
    obs.observe(document.documentElement, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ["style", "class"], attributeOldValue: true,
    });
    // 見えていないタブでは確かめない（v2.5.72）
    setInterval(function () { if (!document.hidden) fix(); }, 3000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  window.addEventListener("load", function () {
    overrideHidingMQRules();
    [500, 1500, 3000].forEach(function (d) { setTimeout(fix, d); });
  });
})();

// URLパラメータ検知：?sumora_cid=<ID> でページを開いたとき自動入力をトリガー
// page-script.js はこのファイルの冒頭ですでに注入済みのため直接 postMessage する
(function () {
  "use strict";
  var _cid = new URLSearchParams(window.location.search).get("sumora_cid");
  if (!_cid) return;

  function _detectShikireiFlag(c) {
    try {
      if (!c) return false;
      if (c.shikirei_free === true || c.shikirei_free === "true" || c.shikirei_free === 1) return true;
      var text = [c.preferences, c.ng_points, c.other_requests, c.property_memo, c.notes, c.additional_conditions, c.raw_format_text]
        .filter(Boolean).join(" ");
      return /敷礼なし|敷金[・･]?礼金なし|敷金礼金0|敷金0礼金0|敷0礼0|敷礼0|初期費用.*抑/.test(text);
    } catch (_) { return false; }
  }
  function _buildConditions(c) {
    var _shiki = _detectShikireiFlag(c);
    return {
      rent_max:     c.rent_max || c.max_rent || null,
      rent_min:     c.rent_min_search || c.rent_min || null, // 2026-10-02 ⑫ おおよその下限（サーバーの rent_min_search）
      walk_minutes: c.walk_minutes || null,
      building_age: c.building_age || null,
      floor_plan:   c.floor_plan || c.layout || null,
      is_wide:      false,
      area_min:     c.floor_area_min || c.area_min || c.min_area || null,
      area_max:     c.floor_area_max || c.area_max || c.max_area || null,
      pet_ok:       !!(c.pet),
      // ★ 2026-11-16: sumora_cid 経路でも敷礼なしを落とさない
      shikirei_free: _shiki,
      prefer_no_shikirei: _shiki,
      rp_update_days: c.rp_update_days != null ? Number(c.rp_update_days) || null : null,
    };
  }

  function _run() {
    // CSP対策: content scriptから直接fetchするとリアプロのCSPでブロックされるため
    // background.js (Service Worker) 経由でfetchしてもらう
    chrome.runtime.sendMessage(
      { type: "axlx-fetch-customer", customerId: _cid },
      function (resp) {
        if (chrome.runtime.lastError) {
          console.warn("[content] sendMessage error:", chrome.runtime.lastError.message);
          return;
        }
        var c = resp && resp.customer;
        if (!c) {
          console.warn("[content] sumora_cid not found:", _cid);
          return;
        }
        // page-script.js がリスナーを登録し終わるまで余裕を持たせてから送信
        setTimeout(function () {
          window.postMessage({ from: "aixlinx-fill", conditions: _buildConditions(c) }, "*");
        }, _axContentSd(1000));
      }
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _run);
  } else {
    setTimeout(_run, 300);
  }
})();

// 2026-09-27 v2.5.32 page-script.js が生きているか（ページの中へ postMessage で聞き、答えを待つ）。
// ★ 2026-11-17: 答えに fillRunning／客ID を載せる（次客乗り換え時の誤 tab_reload 防止）。
function _axPingPage(timeoutMs) {
  return new Promise(function (resolve) {
    var id = "p" + Date.now() + Math.random().toString(36).slice(2, 8);
    var done = false;
    var onMsg = function (e) {
      if (e.source !== window || !e.data || e.data.from !== "axlx-page-pong" || e.data.id !== id) return;
      finish({
        page: true,
        fillRunning: !!e.data.fillRunning,
        fillCustomerId: e.data.fillCustomerId || null,
        fillGen: Number(e.data.fillGen) || 0,
        pageVer: e.data.pageVer || null,
      });
    };
    var finish = function (v) { if (done) return; done = true; window.removeEventListener("message", onMsg); resolve(v); };
    window.addEventListener("message", onMsg);
    setTimeout(function () { finish({ page: false, fillRunning: false, fillCustomerId: null, fillGen: 0, pageVer: null }); }, timeoutMs || 700);
    try { window.postMessage({ from: "axlx-page-ping", id: id }, "*"); } catch (_) { finish({ page: false, fillRunning: false, fillCustomerId: null, fillGen: 0, pageVer: null }); }
  });
}

// 2026-09-27 v2.5.32 page-script.js が条件の入力を始めた合図（aixlinx-fill-started）を background へ中継する。
//   一括検索は合図が来なければタブを読み直して1回だけやり直す（90秒の時間切れを待たない）
window.addEventListener("message", function (e) {
  if (e.source !== window || !e.data || e.data.from !== "aixlinx-fill-started") return;
  try {
    chrome.runtime.sendMessage({
      type: "axlx-fill-started",
      site: "realnetpro",
      customerId: e.data.customerId || _pendingFillCustomerId || null,
      runId: e.data.runId || null,
    }, function () { void chrome.runtime.lastError; });
  } catch (_) { /* 拡張の読み直し等で切れている時は何もしない */ }
});

// background.js からの自動入力トリガー（executeScript を使わずに sendMessage 経由で呼ぶ）
var _pendingFillCustomerId = null; // axlx-set-fill-customer で設定される現在処理中の顧客ID
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.type === "axlx-ping") {
      // 2026-09-27 v2.5.32: background の _pingTab は pong を見ていたのに、ここは ok しか返さず「いつも応答なし」になっていた。
      //   pong と、page-script.js が答えるか（page）も返す（一括検索の前のタブの確かめ・batch-guard.js realproTabPlan）
      //   vis: このタブが見えているか（hidden の背面のタブはタイマーが間引かれ、入力が遅れる＝点検 26）
      // ★ 2026-11-17: fillRunning／fillCustomerId も返す（次客溜まり→誤更新の防止）
      _axPingPage(700).then(function (p) {
        var pageOk = !!(p && p.page);
        sendResponse({
          ok: true,
          pong: true,
          page: pageOk,
          vis: document.visibilityState,
          fillRunning: !!(p && p.fillRunning),
          fillCustomerId: (p && p.fillCustomerId) || null,
          fillGen: (p && p.fillGen) || 0,
          pageVer: (p && p.pageVer) || null,
        });
      });
      return true;
    }
    // fill-done relay に customerId を付与するため、autofill 前に顧客IDをセットしておく
    if (msg.type === "axlx-set-fill-customer") {
      _pendingFillCustomerId = msg.customerId || null;
      sendResponse({ ok: true });
      return true;
    }
    /**
     * ★ 2026-11-16 連続客: fill_timeout 時に MAIN の page-script へ fillRunning 解除を中継。
     */
    if (msg.type === "axlx-force-fill-clear") {
      try {
        window.postMessage({
          from: "axlx-force-fill-clear",
          reason: msg.reason || "fill_timeout",
          customerId: msg.customerId || null,
        }, "*");
      } catch (_) {}
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type !== "axlx-realnetpro-autofill") return;
    // 2026-09-18 竹内（一括検索で違うお客さんの条件が送られるバグ）:
    //   「誰の自動入力か」を依頼と一緒に page-script へ渡す。page-script はこの ID をそのまま
    //   fill-done に載せて返すので、遅れて届いたシグナルに**次の顧客の ID が付く**ことがなくなる。
    //   （旧: fill-done を中継する時に「その時点の _pendingFillCustomerId」を付けていた）
    var _fillCid = msg.customerId || _pendingFillCustomerId || null;
    setTimeout(function () {
      /**
       * ★ 2026-11-18 竹内さん「お客さん検索中や選択中上書きしないように」:
       *   別のお客さんの入力が進んでいる時は「入力の開始」を bulk-dl に知らせない（送る相手・一覧の控えを次のお客さんで上書きしない）。
       *   依頼はページへ渡し、page-script が busy_other_customer で断る。
       */
      _axPingPage(700).then(function (p) {
        var _busyOther = !!(p && p.fillRunning && p.fillCustomerId && _fillCid && String(p.fillCustomerId) !== String(_fillCid));
        if (!_busyOther) window.postMessage({ from: "axlx-autofill-initiated" }, "*");
        window.postMessage({ from: "aixlinx-fill", conditions: msg.conditions, customerId: _fillCid }, "*");
      });
    }, _axContentHd(500)); // 自動入力を始めるまでの間（毎回ばらつかせる）
    sendResponse({ ok: true });
  });
}

/**
 * ★ 2026-11-22: page-script が検索把握印を即監査へ載せる（リロードで消える穴）。
 */
window.addEventListener("message", function (e) {
  if (e.source !== window || !e.data || e.data.from !== "axlx-guide-live-flush") return;
  try {
    var steps = Array.isArray(e.data.steps) ? e.data.steps : [];
    for (var i = 0; i < steps.length; i++) {
      var st = steps[i] || {};
      chrome.runtime.sendMessage({
        type: "axlx-audit-live-step",
        k: "page:" + String(st.k || "").slice(0, 40),
        d: st.d == null ? null : String(st.d).slice(0, 80),
        customerId: e.data.customerId != null ? String(e.data.customerId) : (_pendingFillCustomerId || null),
        site: "realpro",
      }, function () { void chrome.runtime.lastError; });
    }
    try {
      sessionStorage.setItem("axlx_search_grasped_sync", JSON.stringify({
        at: Date.now(), why: String(e.data.why || "search").slice(0, 48),
      }));
    } catch (_) {}
  } catch (_) {}
});

/**
 * ★ 2026-11-18: 検索 click 直前のリロード生存印（page-script → content）。
 *   bulk-dl も同メッセージを聞くが、content 側でも必ず session に書く（二重でも上書きで安全）。
 * ★ 2026-11-22: sessionStorage 同期印も書く（chrome.storage 非同期負け対策）。
 */
window.addEventListener("message", function (e) {
  if (e.source !== window || !e.data || e.data.from !== "axlx-search-armed") return;
  try {
    var _cid = e.data.customerId || _pendingFillCustomerId || null;
    var _flag = {
      customerId: _cid,
      customerName: null,
      conditions: null,
      ts: Date.now(),
      armed_why: String(e.data.why || "search_armed").slice(0, 48),
      pageVer: e.data.pageVer || null,
    };
    try { sessionStorage.setItem("axlx_pending_auto_send_sync", JSON.stringify(_flag)); } catch (_) {}
    chrome.storage.session.set({ axlx_pending_auto_send: _flag });
    try { chrome.storage.session.remove("axlx_fill_busy"); } catch (_) {}
    try {
      chrome.runtime.sendMessage({
        type: "axlx-audit-live-step",
        k: "page:search_armed",
        d: String(e.data.why || "search_armed").slice(0, 48),
        customerId: _cid != null ? String(_cid) : null,
        site: "realpro",
      }, function () { void chrome.runtime.lastError; });
    } catch (_) {}
  } catch (_) {}
});

/**
 * ★ 2026-11-18 竹内さん「送付済みは送ったと把握／取得タイミングと連携」:
 *   bulk-dl の把握台帳を content でも session に残す（リロード・分離worldでも読める）。
 */
window.addEventListener("message", function (e) {
  if (e.source !== window || !e.data || e.data.from !== "axlx-acquire-grasp") return;
  try {
    var led = e.data.ledger && typeof e.data.ledger === "object" ? e.data.ledger : {};
    chrome.storage.session.set({
      axlx_acquire_grasp: {
        phase: String(e.data.phase || "").slice(0, 24),
        ok: e.data.ok !== false,
        detail: String(e.data.detail || "").slice(0, 80),
        sentMarked: Number(led.sentMarked) || 0,
        sentSkipped: Number(led.sentSkipped) || 0,
        pressed: Number(led.pressed) || 0,
        allowed: Number(led.allowed) || 0,
        last: led.last || e.data.phase || null,
        at: Date.now(),
      },
    });
  } catch (_) {}
});

// 修正4+CRITICAL1: page-script.js の検索実行完了シグナル（aixlinx-fill-done）を background.js へ中継する
// customerId を含めることで、別顧客のウェイターを誤解決するバグを防止する
// 2026-11-10 竹内さん「自動モードの場合押したらちゃんとそのまま売り上げ番長に送られるようにする」:
//   「この一覧は誰の検索か」の印（axlx_search_for）は page-script.js（ページ側）が書く。
//   ここは content script（分離した world）なので AxlxSearchStamp を直接は持たない（読める時だけ書く）。
window.addEventListener("message", function (e) {
  if (e.source !== window || !e.data || e.data.from !== "aixlinx-fill-done") return;
  try {
    // fill-done でも pending を補強（notifyDone が届いた経路／リロード直前の保険）
    /**
     * ★ 2026-11-20 竹内さん「連続でお客さんちゃんと検索できるように」:
     *   ページ側の失敗（検索画面へ移れない・30分の見張り切れ・3分止まって次へ移った・入力中の例外）は
     *   検索を押していないのに「成功」として届き、background が結果を20分待ち、「検索した印」まで書いていた。
     *   → この種類の失敗は関所と同じ扱い（error で渡す・検索した印は書かず消す）。
     *   案内モード（guide-mode）はスタッフが検索する番なので今まで通り（「検索できなかった」の知らせを出さない）。
     */
    var _pgErr = String(e.data.error || "");
    var _notSearched = !e.data.gate && /^(no_search_form|watchdog-timeout|stuck_superseded|fill_exception)/.test(_pgErr);
    if (_notSearched) { e.data.gate = true; e.data.gateKind = e.data.gateKind || _pgErr.split(":")[0]; }
    try {
      var _doneCid = e.data.customerId || _pendingFillCustomerId || null;
      if (!e.data.gate) {
        chrome.storage.session.set({
          axlx_pending_auto_send: {
            customerId: _doneCid,
            customerName: null,
            conditions: null,
            ts: Date.now(),
            armed_why: "fill-done",
          },
        });
        try { chrome.storage.session.remove("axlx_fill_busy"); } catch (_) {}
      } else if (e.data.gateKind !== "busy_other_customer") {
        // ★ 2026-11-18: 検索していない（関所で止めた）→ 前に残った「検索した印」で今の一覧を送らせない
        //   （busy_other_customer は断った側の合図。進行中のお客さんの印は消さない）
        try { chrome.storage.session.remove(["axlx_pending_auto_send", "axlx_auto_next_page"]); } catch (_) {}
      }
    } catch (_) {}
    chrome.runtime.sendMessage({
      type: "axlx-fill-done",
      site: "realnetpro",
      // 2026-09-18: シグナルに載っている ID（＝その入力を始めた時の顧客）を最優先。
      //   「今の _pendingFillCustomerId」は、遅れて届いた時に次の顧客を指してしまう
      customerId: e.data.customerId || _pendingFillCustomerId || null,
      // 2026-09-25 検索の点検（ブレインの時だけ page-script が載せる）: その回の run_id と audit をそのまま中継
      runId: e.data.runId || null,
      audit: e.data.audit || null,
      // ⚠ error ではなく pageError（点検の記録だけに使う）。error で渡すと _notifyFillDone が検索を止める動きに変わる（今まで中継していなかった＝動きは変えない）
      pageError: e.data.error || null,
      // v2.5.50 検索を押す前の関所で止めた時（gate）だけ error で渡す＝background はこのお客様のリアプロを飛ばす（検索していないので取りに行かない）
      error: e.data.gate ? (e.data.error || "AXLX_FILL_INCOMPLETE") : null,
      gateKind: e.data.gateKind || null,
    }, function () {
      void chrome.runtime.lastError;
    });
  } catch (err) {
    // 拡張リロード等で context が失われた場合は無視
  }
});

/** ★ 2026-11-16: fill 途中の段を background の点検へ（steps到達） */
window.addEventListener("message", function (e) {
  if (e.source !== window || !e.data || e.data.from !== "aixlinx-fill-progress") return;
  try {
    chrome.runtime.sendMessage({
      type: "axlx-fill-progress",
      site: "realnetpro",
      customerId: e.data.customerId || _pendingFillCustomerId || null,
      runId: e.data.runId || null,
      steps: Array.isArray(e.data.steps) ? e.data.steps : [],
    }, function () { void chrome.runtime.lastError; });
  } catch (_) {}
});

/**
 * ★ 2026-11-18 学習→自動反映の根因修正:
 *   MAIN world（page-script.js）は chrome.storage / chrome.runtime に直接アクセスできない。
 *   content.js が isolated world 側で学習束を読み・更新監視して MAIN world へ中継する。
 */
(function () {
  var PUSH_KEYS = [
    "axlx_learn_points", "axlx_learn_screen", "axlx_learn_scene", "axlx_learn_needs_auto",
    "axlx_learn_next", "axlx_learn_site_flow", "axlx_learn_seq", "axlx_learn_next_mode",
    "axlx_learn_screen_flow", "axlx_learn_scene_flows", "axlx_learn_stopped_scene", "axlx_learn_scene_missing",
    "axlx_learn_opens", "axlx_learn_plan", "axlx_learn_cursor_hand",
    "axlx_human_profile", "axlx_human_learn", "axlx_human_points",
    // ★ 2026-11-19 v2.8.25: サーバーで学んだ動き（速さ・曲がり）と、ラン単位の動き計画を MAIN world（pointer-ui.js）へ。
    //   → window.__axlxServerMotion / window.__axlxMotionPlan（pointer-ui.js が axlx-page-learn-push で受ける）
    //   ⚠ "axlx_learn_gaps" は配列の最後に置く（pick-lane-v2821 のテストが末尾を見る）
    "axlx_learn_motion", "axlx_motion_plan",
    // ★ 2026-11-20 v2.8.137: 手順書（場面の手順・1手ずつの細部・自動の決まり）もページへ（自動が読んだ印を点検記録に残す）
    "axlx_learn_playbook",
    // ★ 2.8.202: 客ごとの思考（決定論）を MAIN へ
    "axlx_customer_think",
    "axlx_learn_gaps",
  ];
  function pushAll() {
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get(PUSH_KEYS, function (r) {
        try {
          if (chrome.runtime && chrome.runtime.lastError) return;
          if (r && typeof r === "object" && Object.keys(r).length) {
            window.postMessage({ from: "axlx-page-learn-push", data: r }, "*");
          }
        } catch (_) {}
      });
    } catch (_) {}
  }
  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data || typeof e.data !== "object") return;
    if (e.data.from === "axlx-page-storage-get") {
      var id = e.data.id;
      var keys = Array.isArray(e.data.keys) ? e.data.keys : PUSH_KEYS;
      try {
        chrome.storage.local.get(keys, function (r) {
          var payload = (chrome.runtime && chrome.runtime.lastError) ? {} : (r || {});
          try { window.postMessage({ from: "axlx-page-storage-result", id: id, data: payload }, "*"); } catch (_) {}
        });
      } catch (_) {
        try { window.postMessage({ from: "axlx-page-storage-result", id: id, data: {} }, "*"); } catch (__) {}
      }
    } else if (e.data.from === "axlx-page-learn-refresh") {
      var rid = e.data.id;
      try {
        chrome.runtime.sendMessage({ type: "axlx-learn-refresh", force: !!e.data.force }, function (res) {
          void chrome.runtime.lastError;
          pushAll();
          var slim = null;
          try {
            if (res && typeof res === "object") {
              slim = {
                ok: res.ok !== false, skipped: res.skipped || null, empty: !!res.empty,
                error: res.error ? String(res.error).slice(0, 80) : null,
                screen_solid: typeof res.screen_solid === "number" ? res.screen_solid : null,
                screen_all: typeof res.screen_all === "number" ? res.screen_all : null,
                retry_in_ms: typeof res.retry_in_ms === "number" ? res.retry_in_ms : null,
                ver: res.ver ? String(res.ver).slice(0, 19) : null,
              };
            }
          } catch (_) { slim = null; }
          try { window.postMessage({ from: "axlx-page-learn-refresh-done", id: rid, res: slim }, "*"); } catch (_) {}
        });
      } catch (_) {
        try { window.postMessage({ from: "axlx-page-learn-refresh-done", id: rid }, "*"); } catch (__) {}
      }
    } else if (e.data.from === "axlx-page-learn-auto-linked") {
      try {
        chrome.runtime.sendMessage({
          type: "axlx-learn-auto-linked",
          ok: !!e.data.ok,
          screen: Number(e.data.screen) || 0,
          scenes: Number(e.data.scenes) || 0,
          flow: !!e.data.flow,
        }, function () { void chrome.runtime.lastError; });
      } catch (_) {}
    } else if (e.data.from === "axlx-set-last-customer") {
      /** ★ 2.8.202: 前客番号・場所モードを background の客ごと思考へ渡す */
      try {
        var _lc = {};
        if (e.data.cid) _lc.axlx_last_filled_cid_mirror = String(e.data.cid);
        if (e.data.want != null) _lc.axlx_last_want_mode = String(e.data.want);
        chrome.storage.local.set(_lc, function () { void chrome.runtime.lastError; });
      } catch (_) {}
    }
  });
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== "local" || !changes) return;
        var out = {};
        var has = false;
        for (var i = 0; i < PUSH_KEYS.length; i++) {
          var k = PUSH_KEYS[i];
          if (changes[k]) { out[k] = changes[k].newValue; has = true; }
        }
        if (has) {
          try { window.postMessage({ from: "axlx-page-learn-push", data: out }, "*"); } catch (_) {}
        }
      });
    }
  } catch (_) {}
  setTimeout(pushAll, 300);
  setTimeout(pushAll, 1500);
  /**
   * ★ 2026-11-22 2.8.183: リアプロページを開いただけで、未取込／手順書欠なら裏で束を取る。
   *   ポップアップを開かなくても新束へ寄せる（3分に1回まで）。
   */
  (function bootLearnIfNeeded() {
    var BOOT_KEY = "axlx_learn_boot_refresh_at";
    var BOOT_GAP_MS = 3 * 60 * 1000;
    function maybe() {
      try {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
        chrome.storage.local.get([
          "axlx_learn_needs_auto", "axlx_learn_ver", "axlx_learn_screen", "axlx_learn_link",
          "axlx_learn_next", "axlx_learn_points", "axlx_learn_playbook", "axlx_learn_after_update",
          BOOT_KEY,
        ], function (st) {
          try {
            if (chrome.runtime && chrome.runtime.lastError) return;
            st = st || {};
            var last = Number(st[BOOT_KEY]) || 0;
            if (Date.now() - last < BOOT_GAP_MS) return;
            var need = !!(st.axlx_learn_after_update || st.axlx_learn_needs_auto || !st.axlx_learn_playbook);
            if (!need) {
              var pb = st.axlx_learn_playbook;
              if (pb && typeof pb === "object") {
                var bv = Number(pb.build_v) || 0;
                var fs = pb.flow_series;
                if (bv >= 7 && (!Array.isArray(fs) || fs.length < 5)) need = true;
                if (bv > 0 && bv < 7) need = true;
              }
            }
            if (!need) return;
            var patch = {};
            patch[BOOT_KEY] = Date.now();
            chrome.storage.local.set(patch, function () {
              try {
                chrome.runtime.sendMessage({ type: "axlx-learn-refresh", force: true }, function (res) {
                  void chrome.runtime.lastError;
                  pushAll();
                  try {
                    if (res && res.ok) {
                      console.log(
                        "[AX] ページ起動で学習束を取込:",
                        res.skipped || "ok",
                        "read=" + (res.server_read_count != null ? res.server_read_count : "?"),
                        "needs_auto=" + !!res.needs_auto,
                      );
                    }
                  } catch (_) {}
                });
              } catch (_) {}
            });
          } catch (_) {}
        });
      } catch (_) {}
    }
    setTimeout(maybe, 1200);
  })();
})();

