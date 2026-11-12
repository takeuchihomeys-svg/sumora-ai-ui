// chrome-extension/snapshot-popup.js
// 2026-09-29 v2.5.40 小窓の「拡張の版」と「画面の写真」の許可ボタン（popup.html の #snap-perm）。
//   竹内「拡張ツールでひらいているページの画面をみて判断できる事もできるのか？ …画面開いているのも目で見ることができるのが理想」
//   画面の写真（chrome.tabs.captureVisibleTab）には <all_urls> の許可が要る。最初から持たせず（optional_host_permissions）、
//   PC ごとに1回このボタンで許可してもらう。許可が無くても、ページの文字・拡張の状態・ログは送る（background.js _takeSnapshot）。
//   版は 9/29 の件（v2.5.38 で直したのに PC が古い版のまま動いていた）を小窓で見分けるために出す。
//
// 2026-11-11 竹内さん「録画の許可のボタン表示されていないので表示されるようにする」:
//   ① 旧は「画面の共有を許可」が**10px の小さな文字の並び**で、気づけなかった → **黄色の目立つ帯**（#snap-perm-banner）を出す
//   ② 小窓（underbar の iframe）の中で `chrome.permissions.request` を呼ぶと、
//      Chrome が「ユーザーの操作が要る」と判断して**ダイアログが出ない**ことがある
//      → その時は**手順**を出して、拡張の管理画面（chrome://extensions）から許可できるようにする
(function () {
  "use strict";
  var ORIGINS = { origins: ["<all_urls>"] };

  function el(id) { return document.getElementById(id); }

  /** 拡張の id（手順に出す） */
  function extId() {
    try { return chrome.runtime.id; } catch (_) { return ""; }
  }

  function render(granted) {
    var box = el("snap-perm");
    var banner = el("snap-perm-banner");
    var recBtn = el("perm-rec-btn");
    var ver = "";
    try { ver = chrome.runtime.getManifest().version; } catch (_) {}
    // 版は小さく「v2.6.72」だけ（問い合わせの時に見る）。許可済みなら許可の表示は出さない
    if (el("snap-ver")) {
      el("snap-ver").textContent = "v" + (ver || "?");
      el("snap-ver").title = "拡張 v" + (ver || "?") + (granted ? "／画面の写真: 許可済み" : "");
    }
    if (el("snap-perm-state")) el("snap-perm-state").textContent = granted ? "" : "画面の写真: 未許可";
    if (el("snap-perm-btn")) el("snap-perm-btn").style.display = granted ? "none" : "inline-block";
    if (box) box.style.display = "flex";
    /**
     * 2026-11-11 竹内さん「まだでていない。ちゃんとでるようにする」:
     *   ⚠ 旧は「未許可の時だけ出す」作りだったので、**すでに許可済みだと何も出なかった**
     *     （＝「でていない」に見える）。しかも小窓が狭いと右に切れて見えない事もあった。
     *   → **いつも出す**。状態で見た目だけ変える:
     *     未許可 … 🎬 録画を許可（オレンジ・脈打つ・押すと許可を頼む）
     *     許可済み … 🎬 録画OK（緑・小さい・押すと「許可済み」と出る）
     *   これで「出ない」が無くなる（押せば今どちらの状態かも分かる）。
     */
    if (recBtn) {
      recBtn.style.display = "inline-block";
      if (granted) {
        recBtn.textContent = "🎬 OK";
        recBtn.style.background = "#16a34a";
        recBtn.style.boxShadow = "0 2px 6px rgba(22,163,74,.45)";
        recBtn.style.animation = "none";
        recBtn.title = "画面の録画は許可済みです（操作のたびに画面の写真が残ります）";
      } else {
        recBtn.textContent = "🎬 許可する";
        recBtn.style.background = "#f59e0b";
        recBtn.style.boxShadow = "0 2px 8px rgba(245,158,11,.55)";
        recBtn.style.animation = "axlxPermPulse 1.6s ease-in-out infinite";
        recBtn.title = "押すと画面の録画を許可できます（操作のたびに画面の写真を残す・PCごとに1回）";
      }
    }
    /**
     * 2026-11-11 竹内さん「でないときの右側に許可するぼたんつける」:
     *   帯は**許可済みでも出す**（出ていれば「許可済み」と分かる・押せば再確認できる）。
     *   許可済みの時は「✅ 許可済み」の1行にして、ボタンは「もう一度確認」にする。
     */
    if (banner) {
      banner.style.display = "flex";
      var title = el("snap-perm-title");
      var desc = el("snap-perm-desc");
      var bBtn = el("snap-perm-banner-btn");
      if (granted) {
        if (title) title.textContent = "✅ 画面の録画は許可済みです";
        if (desc) desc.textContent = "操作のたびに画面の写真が残ります（PCごとに1回の設定は済んでいます）。";
        if (bBtn) { bBtn.textContent = "もう一度確認"; bBtn.style.background = "#16a34a"; bBtn.style.boxShadow = "0 2px 6px rgba(22,163,74,.4)"; }
        if (hint) { hint.style.display = "none"; hint.textContent = ""; }
        /**
         * 2026-11-12 竹内さん「くれさん通常モードで検索したけどちゃんと画面録画はできるようになっているかな」:
         *   ⚠「許可済み」と「写真が撮れている」は**別**。許可済みでも撮れていない事がある（今日は0枚だった）。
         *   → 許可済みの時は、**実際に撮れた枚数**を帯に出す（撮れていなければ黄色で理由も出す）。
         */
        try {
          chrome.storage.local.get(["axlx_human_shot_diag", "axlx_human_shot_bg", "axlx_human_shot_upload"], function (rr) {
            var d = (rr && rr.axlx_human_shot_diag) || null;
            var bg = (rr && rr.axlx_human_shot_bg) || null;
            var up = (rr && rr.axlx_human_shot_upload) || null;
            var ok = d ? Number(d.ok) || 0 : 0;
            var tried = d ? Number(d.tried) || 0 : 0;
            if (!desc) return;
            if (tried === 0 && !(bg && bg.called)) {
              desc.textContent = "許可は済んでいます。まだ写真は撮れていません（操作すると撮ります・「写真テスト」で今すぐ試せます）。";
              return;
            }
            var bad = [];
            if (d && d.last_error) bad.push("撮影: " + d.last_error);
            if (up && up.ok === false && up.error) bad.push("送信: " + up.error);
            if (ok > 0 && !bad.length) {
              desc.textContent = "許可済み・写真 " + ok + "枚（試した " + tried + "回）。操作のたびに残ります。";
            } else if (ok > 0) {
              desc.textContent = "写真 " + ok + "枚（試した " + tried + "回）。⚠ " + bad.join(" / ");
            } else {
              desc.textContent = "⚠ 許可は済んでいますが、写真が撮れていません（試した " + tried + "回）: " + (bad.join(" / ") || "理由不明") + "。「写真テスト」で確かめてください。";
            }
          });
        } catch (_) {}
      } else {
        if (title) title.textContent = "🎬 画面の録画を許可してください";
        if (desc) desc.textContent = "許可すると、操作のたびに画面の写真が残り「検索を押せたか」を後から確かめられます。PCごとに1回だけです。";
        if (bBtn) { bBtn.textContent = "許可する"; bBtn.style.background = "#f59e0b"; bBtn.style.boxShadow = "0 2px 6px rgba(245,158,11,.4)"; }
      }
    }
  }

  function refresh() {
    try {
      if (!chrome.permissions || !chrome.permissions.contains) { render(false); return; }
      chrome.permissions.contains(ORIGINS, function (ok) {
        // 2026-11-11: 小窓（iframe）では chrome.permissions が使えない事がある
        //   → エラーでも「未許可」として**ボタンを出す**（押した時に手順を出す）
        if (chrome.runtime.lastError) { render(false); return; }
        render(!!ok);
      });
    } catch (_) { render(false); }
    // 2026-11-11 竹内さん「許可済みになっているはず」: 許可済みなのに写真が撮れない時の理由を出す
    try {
      chrome.storage.local.get(["axlx_human_shot_error", "axlx_human_shot_diag", "axlx_search_why", "axlx_fill_entry"], function (r) {
        var e = r && r.axlx_human_shot_error;
        var d = r && r.axlx_human_shot_diag;
        var sw = r && r.axlx_search_why;
        var fe = r && r.axlx_fill_entry;
        var hint = el("snap-perm-hint");
        if (!hint) return;
        var lines = [];
        // 写真
        if (d && typeof d.tried === "number") {
          lines.push("写真: 試した " + d.tried + "回・成功 " + (Number(d.ok) || 0) + "回"
            + (d.last_error ? "・理由: " + d.last_error : "")
            + (d.last_why ? "（" + d.last_why + "）" : ""));
        }
        // 2026-11-11 竹内さん「まだ自動モード検索されない」: 検索を押した/押さなかった理由を出す
        if (sw && Date.now() - (Number(sw.at) || 0) < 10 * 60 * 1000) {
          lines.push("検索: " + sw.why + "（guide=" + String(sw.guide) + "・検索ボタン " + sw.goSearch + "個）");
        }
        if (fe && Date.now() - (Number(fe.at) || 0) < 10 * 60 * 1000) {
          lines.push("入力を始めた: 区" + fe.city_codes + "・駅" + fe.station_names + "・沿線" + fe.route_ids
            + "・area_mode=" + String(fe.area_mode) + "・guide=" + String(fe.guide));
        }
        if (e && Date.now() - (Number(e.at) || 0) < 10 * 60 * 1000) {
          lines.push("⚠ " + String(e.error || ""));
        }
        if (lines.length) {
          hint.style.display = "block";
          hint.textContent = lines.join("\n");
        }
      });
    } catch (_) {}
  }

  /** 許可を頼む（人のクリックの中で呼ぶ）。だめなら手順を出す */
  function ask() {
    var hint = el("snap-perm-hint");
    var showHint = function (msg) {
      if (!hint) return;
      hint.style.display = "block";
      hint.textContent = msg;
    };
    // 2026-11-11: すでに許可済みなら、押した時に「もう許可済み」と出す（状態が分かるように）
    try {
      if (chrome.permissions && chrome.permissions.contains) {
        chrome.permissions.contains(ORIGINS, function (already) {
          if (!chrome.runtime.lastError && already) {
            var b = el("snap-perm-banner");
            if (b) b.style.display = "flex";
            showHint("✅ 画面の録画は許可済みです。操作すると自動で写真が残ります。");
            // 2026-11-11 竹内さん「でないときの右側に許可するぼたんつける」: ボタンは消さない（右に置いたまま残す）
            return;
          }
          doAsk();
        });
        return;
      }
    } catch (_) {}
    doAsk();
  }

  function doAsk() {
    var hint = el("snap-perm-hint");
    var showHint = function (msg) {
      if (!hint) return;
      hint.style.display = "block";
      hint.textContent = msg;
    };
    try {
      chrome.permissions.request(ORIGINS, function (ok) {
        if (chrome.runtime.lastError) {
          console.warn("[snap] 許可の確認に失敗:", chrome.runtime.lastError.message);
          showHint("うまく出せませんでした。下の手順（chrome://extensions）で許可してください。");
          render(false);
          return;
        }
        if (ok) { render(true); return; }
        // ダイアログが出なかった／断られた
        showHint(PERM_STEPS());
        render(false);
      });
    } catch (e) {
      console.warn("[snap] 許可の確認に失敗:", e && e.message);
      showHint(PERM_STEPS());
      render(false);
    }
  }

  /**
   * 2026-11-11 竹内さん「録画の許可のボタン表示されていないので表示されるようにする」:
   *   小窓（iframe）の中では Chrome が許可のダイアログを出さないことがある。
   *   その時は**拡張の管理画面から許可する手順**を出す（確実・1回だけ）。
   */
  function PERM_STEPS() {
    var id = extId();
    return "許可の画面が出ない時は、次のどちらか:\n"
      + "① アドレスバーに chrome://extensions と入れる → 「AIXLINX 物件検索」の「詳細」→「サイトへのアクセス」を「すべてのサイト」にする"
      + (id ? "（拡張ID: " + id + "）" : "")
      + "\n② それでも出ない時は、拡張のアイコンを右クリック→「オプション」ではなく、この小窓を「サイドパネルで開く」から開き直してから押す";
  }

  /** 拡張の管理画面を開く（押せば確実に許可できる） */
  function openExtensionsPage() {
    try {
      chrome.tabs.create({ url: "chrome://extensions/?id=" + extId() });
    } catch (_) {
      try { chrome.tabs.create({ url: "chrome://extensions/" }); } catch (__) {}
    }
  }

  function init() {
    /**
     * 2026-11-11 竹内さん「でていない。ブレインの左側にわかりやすいようにだす」:
     *   許可の確認（contains）が返るまで**何も出ない**時間があり、iframe ではそもそも返らない事もある。
     *   → まず**ボタンを出しておく**（未許可の見た目）→ 確認できたら許可済みなら消す。
     *     これで「出ない」が無くなる（許可済みなら一瞬光るだけで消える）。
     */
    var recBtn0 = el("perm-rec-btn");
    if (recBtn0) recBtn0.style.display = "inline-block";
    var banner0 = el("snap-perm-banner");
    if (banner0) banner0.style.display = "flex";
    refresh();
    var btn = el("snap-perm-btn");
    if (btn) btn.addEventListener("click", ask);
    var bannerBtn = el("snap-perm-banner-btn");
    if (bannerBtn) bannerBtn.addEventListener("click", ask);
    // 2026-11-11 竹内さん「ブレインの左側にわかりやすいようにだす」: ヘッダーのオレンジのボタン
    var recBtn = el("perm-rec-btn");
    if (recBtn) recBtn.addEventListener("click", ask);
    // 2026-11-11: ダイアログが出ない時の逃げ道（拡張の管理画面を開く）
    var openBtn = el("snap-perm-open-ext");
    if (openBtn) openBtn.addEventListener("click", openExtensionsPage);
    /**
     * 2026-11-11 竹内さん「写真撮ってるかな？」:
     *   検索を待たずに**その場で1枚撮って**確かめられるボタン。
     *   結果（撮れた・撮れない＋理由）を黄色の帯に出す。
     */
    var testBtn = el("snap-perm-test");
    if (testBtn) testBtn.addEventListener("click", function () {
      var hint = el("snap-perm-hint");
      var show = function (msg) { if (hint) { hint.style.display = "block"; hint.textContent = msg; } };
      show("📷 撮っています…");
      /**
       * 2026-11-11 竹内さん「写真ちゃんと取れているか」:
       *   旧は「撮れた」だけで判定していた（クラウドに上がったかは見ていなかった）。
       *   → 撮影 → **アップロードの結果まで**見て出す。
       */
      try {
        chrome.runtime.sendMessage({ type: "axlx-human-shot", site: "manual_test" }, function (res) {
          if (chrome.runtime.lastError) { show("✖ 撮れません: " + chrome.runtime.lastError.message); return; }
          if (!res || !res.ok) { show("✖ 撮れません: " + ((res && res.error) || "理由なし")); return; }
          show("✅ 撮れました（" + res.shot_key + "）。クラウドへ送っています…");
          // 2.5秒後にアップロードの結果を見る
          setTimeout(function () {
            try {
              chrome.storage.local.get(["axlx_human_shot_upload"], function (r) {
                var u = r && r.axlx_human_shot_upload;
                if (!u) { show("✅ 撮れました。" + res.shot_key + "\n（アップロードの結果はまだ）"); return; }
                if (u.ok) show("✅ 撮って、クラウドに上がりました\nkey: " + res.shot_key);
                else show("⚠ 撮れましたが、クラウドに上がりませんでした\n理由: " + (u.error || ("status " + u.status)));
              });
            } catch (_) {}
          }, 2500);
        });
      } catch (e) { show("✖ 撮れません: " + ((e && e.message) || e)); }
    });

    /**
     * 2026-11-12 竹内さん「画面録画モード等のボタンをつけることができればさらに簡単にできるようになる。
     *   画面録画モード押しているときは連続でさつえいされていればちゃんと記録されるので」:
     *   押すたびに「録画中 ⇄ 停止」。録画中はボタンが赤く脈打ち、撮れた枚数が帯に出る。
     */
    var recModeBtn = el("snap-rec-mode");
    var paintRecMode = function (on, count) {
      if (!recModeBtn) return;
      if (on) {
        recModeBtn.textContent = "⏹ 録画中" + (count ? " " + count : "");
        recModeBtn.style.background = "#be123c";
        recModeBtn.style.color = "#fff";
        recModeBtn.style.animation = "axlxPermPulse 1.6s ease-in-out infinite";
        recModeBtn.title = "押すと録画を止めます（2〜4秒ごとに画面を撮っています）";
      } else {
        recModeBtn.textContent = "⏺ 録画";
        recModeBtn.style.background = "#fff";
        recModeBtn.style.color = "#be123c";
        recModeBtn.style.animation = "none";
        recModeBtn.title = "押すと「画面録画モード」になります（このタブの画面を2〜4秒ごとに続けて撮ります）";
      }
    };
    var refreshRecMode = function () {
      try {
        chrome.runtime.sendMessage({ type: "axlx-rec-status" }, function (res) {
          void chrome.runtime.lastError;
          if (!res) return;
          paintRecMode(!!res.on, Number(res.count) || 0);
          if (res.on) {
            var hint2 = el("snap-perm-hint");
            if (hint2) {
              hint2.style.display = "block";
              hint2.style.color = "#be123c";
              hint2.textContent = "⏺ 画面録画モード: 録画中（" + (Number(res.count) || 0) + "枚）。もう一度押すと止まります。";
            }
          }
        });
      } catch (_) {}
    };
    if (recModeBtn) recModeBtn.addEventListener("click", function () {
      var hint = el("snap-perm-hint");
      var show = function (msg, color) { if (hint) { hint.style.display = "block"; hint.textContent = msg; hint.style.color = color || "#b91c1c"; } };
      try {
        chrome.runtime.sendMessage({ type: "axlx-rec-status" }, function (st) {
          void chrome.runtime.lastError;
          var on = !!(st && st.on);
          chrome.runtime.sendMessage({ type: on ? "axlx-rec-stop" : "axlx-rec-start" }, function (res) {
            void chrome.runtime.lastError;
            if (!res || res.ok === false) { show("✖ できませんでした: " + ((res && res.error) || "理由なし")); return; }
            if (on) {
              paintRecMode(false, 0);
              show("⏹ 録画を止めました（" + (Number(res.count) || 0) + "枚）", "#047857");
            } else {
              paintRecMode(true, 0);
              show("⏺ 録画を始めました。2〜4秒ごとに画面を撮ります（もう一度押すと止まります）。", "#be123c");
            }
          });
        });
      } catch (e) { show("✖ できませんでした: " + ((e && e.message) || e)); }
    });
    refreshRecMode();
    setInterval(refreshRecMode, 5000);
  }

  document.addEventListener("DOMContentLoaded", init);
  try {
    if (chrome.permissions && chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(refresh);
    if (chrome.permissions && chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(refresh);
  } catch (_) {}
  // popup.html の最後で読むので DOMContentLoaded の後の時もある
  if (document.readyState !== "loading") init();
})();
