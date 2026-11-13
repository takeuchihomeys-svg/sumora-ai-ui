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
    /**
     * 2026-11-13 竹内さん「許可済みなのでここの上の部分は録画ボタンのところ以外は出ないようにする」:
     *   ⚠ 旧は許可済みでも黄色の帯を大きく出していた（許可の説明・出ない時・もう一度確認・写真テスト・片付ける）。
     *   → **許可済みの時は「⏺ 録画」だけ**を出す（許可は済んでいるので説明は要らない・画面を広く使う）。
     *     未許可の時は今まで通り全部出す（許可のしかたが要る）。
     */
    if (banner) {
      if (granted) {
        // 許可済み: 帯は出さない。録画ボタンだけを細い1行で出す
        banner.style.display = "none";
        var slim = el("snap-rec-slim");
        if (slim) slim.style.display = "flex";
        else {
          // 初回だけ組み立てる（録画ボタンを持ち出して細い行に置く）
          var line = document.createElement("div");
          line.id = "snap-rec-slim";
          line.style.cssText = "display:flex;align-items:center;gap:6px;margin:0 8px 6px;flex:0 0 auto";
          var keep = el("snap-rec-mode");
          if (keep) { keep.style.flex = "0 0 auto"; line.appendChild(keep); }
          // 録画の状態（枚数・あと何秒）だけを小さく添える
          var note = document.createElement("span");
          note.id = "snap-rec-slim-note";
          note.style.cssText = "font-size:10px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
          line.appendChild(note);
          /**
           * 2026-11-14 竹内さん「ほかちゃんと録画したの学習できてるかな」:
           *   操作を何件おぼえているか（写真と結びつくか）を出す。
           */
          if (!el("snap-ops-diag")) {
            var dia = document.createElement("div");
            dia.id = "snap-ops-diag";
            dia.style.cssText = "display:none;font-size:10px;margin:0 8px 6px;color:#64748b";
            line.appendChild(dia);
          }
          var host = document.getElementById("snap-perm-banner");
          if (host && host.parentNode) host.parentNode.insertBefore(line, host);
        }
        if (hint) { hint.style.display = "none"; hint.textContent = ""; }
        return;   // 許可済みは帯の組み立てをしない（説明も出さない）
      }
      banner.style.display = "flex";
      var slimNow = el("snap-rec-slim");
      if (slimNow) {
        /**
         * 2026-11-13: 許可が外れた時は**録画ボタンを帯の中へ戻す**（細い行は隠す）。
         *   許可済みの時に細い行へ移しているので、戻さないと帯からボタンが消える。
         */
        var recBack = el("snap-rec-mode");
        var host2 = document.getElementById("snap-perm-banner");
        var row2 = host2 && host2.querySelector("div[style*='display:flex']");
        if (recBack && row2 && recBack.parentNode !== row2) {
          var testBtn = el("snap-perm-test");
          if (testBtn && testBtn.parentNode === row2) row2.insertBefore(recBack, testBtn.nextSibling);
          else row2.appendChild(recBack);
        }
        slimNow.style.display = "none";
      }
      var title = el("snap-perm-title");
      var desc = el("snap-perm-desc");
      var bBtn = el("snap-perm-banner-btn");
      {
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
    var paintRecMode = function (on, count, remainMs, tried, failed) {
      if (!recModeBtn) return;
      if (on) {
        var left = Math.max(0, Math.ceil((Number(remainMs) || 0) / 1000));
        var mm = Math.floor(left / 60), ss = left % 60;
        var leftTxt = mm > 0 ? mm + ":" + String(ss).padStart(2, "0") : ss + "秒";
        var bad = Number(failed) || 0;
        recModeBtn.textContent = "⏹ 録画中 " + (Number(count) || 0) + "枚" + (bad ? "（失敗" + bad + "）" : "") + "（あと" + leftTxt + "）";
        recModeBtn.style.background = "#be123c";
        recModeBtn.style.color = "#fff";
        recModeBtn.style.animation = "axlxPermPulse 1.6s ease-in-out infinite";
        recModeBtn.title = "押すと録画を止めます（1.5〜3.5秒ごとに画面を撮っています・最長7分）";
      } else {
        recModeBtn.textContent = "⏺ 録画";
        recModeBtn.style.background = "#fff";
        recModeBtn.style.color = "#be123c";
        recModeBtn.style.animation = "none";
        recModeBtn.title = "押すと「画面録画モード」になります（1.5〜3.5秒ごとに続けて撮ります・最長7分）";
      }
    };
    var refreshRecMode = function () {
      try {
        chrome.runtime.sendMessage({ type: "axlx-rec-status" }, function (res) {
          void chrome.runtime.lastError;
          if (!res) return;
          paintRecMode(!!res.on, Number(res.saved) || 0, Number(res.remain_ms) || 0, Number(res.tried) || 0, Number(res.failed) || 0);
          var note = el("snap-rec-slim-note");
          if (note) {
            var nv = Number(res.saved) || 0;
            var nf = Number(res.failed) || 0;
            /**
             * 2026-11-13 竹内さん「まだ自動モードで地域などの部分おせていない、ここ録画しているので」:
             *   ⚠ 旧は**録画中に失敗の理由を出していなかった**（止めた時にしか出ない）。
             *     そのため「失敗5」とだけ出て、**何が原因か分からない**まま何度も録画していた。
             *   → 録画中も**理由を短く出す**（長すぎる時は先頭だけ）。
             */
            var why = res.last_error ? String(res.last_error).replace(/\s+/g, " ").slice(0, 40) : "";
            note.textContent = res.on
              ? "録画中 " + nv + "枚" + (nf ? "（失敗" + nf + (why ? "：" + why : "") + "）" : "")
              : (nv ? "前回 " + nv + "枚" : "");
            note.style.color = nf ? "#b91c1c" : "#64748b";
          }
          /**
           * 2026-11-14 竹内さん「ほかちゃんと録画したの学習できてるかな」:
           *   ⚠ 実測で版 2.7.22 の写真 **234枚すべて shot_ops が空**だった。
           *     「なぜ空か」を画面で分かるようにする（`axlx_ops_diag`）。
           *     輪（操作の記録）が 0 のまま録画していると、写真から何も学べない。
           */
          try {
            chrome.storage.local.get(["axlx_ops_diag"], function (r2) {
              try {
                var d = (r2 && r2.axlx_ops_diag) || null;
                var el2 = el("snap-ops-diag");
                if (!el2) return;
                if (!d) { el2.textContent = ""; el2.style.display = "none"; return; }
                el2.style.display = "block";
                el2.style.color = d.ring ? "#15803d" : "#b91c1c";
                /**
                 * 2026-11-14 竹内さん「地域押さなかったのでこっちでおした画面確認して録画した画面」:
                 *   写真に操作が付かない原因を**その場で**分かるようにする。
                 *   ・輪が0 → この画面で押していない
                 *   ・輪はあるのに写真に付かない → タブの取り違え（axlx_rec_ops で分かる）
                 */
                chrome.storage.local.get(["axlx_rec_ops"], function (r3) {
                  try {
                    var ro = (r3 && r3.axlx_rec_ops) || null;
                    var got = ro ? Number(ro.got) || 0 : null;
                    el2.textContent = d.ring
                      ? "学習: 操作を" + d.ring + "件おぼえています"
                        + (got != null ? (got ? "（写真に" + got + "件付いています）" : "（⚠ 写真に付いていません）") : "")
                      : "学習: まだ操作を1件もおぼえていません（この画面で押すとおぼえます）";
                    if (d.ring && got === 0) el2.style.color = "#b45309";
                  } catch (_) {}
                });
              } catch (_) {}
            });
          } catch (_) {}
          /**
           * 2026-11-13: 許可済みの時は**帯を出さない**ので、ここで黄色の帯に何か書かない
           *   （帯の中の hint は未許可の時だけ使う）。
           */
          if (res.on) {
            var hint2 = el("snap-perm-hint");
            var banner2 = el("snap-perm-banner");
            if (hint2 && banner2 && banner2.style.display !== "none") {
              hint2.style.display = "block";
              hint2.style.color = "#be123c";
              var left2 = Math.max(0, Math.ceil((Number(res.remain_ms) || 0) / 1000));
              hint2.textContent = "⏺ 画面録画モード: 録画中（保存 " + (Number(res.saved) || 0) + "枚）。もう一度押すと止まります。";
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
              paintRecMode(false, 0, 0, 0, 0);
              var sv = Number(res.saved) || 0, fl = Number(res.failed) || 0;
              show("⏹ 録画を止めました（保存 " + sv + "枚" + (fl ? "・失敗 " + fl + "回" + (res.last_error ? "（" + res.last_error + "）" : "") : "") + "）", fl ? "#b91c1c" : "#047857");
            } else {
              paintRecMode(true, 0, Number(res.max_ms) || 7 * 60 * 1000, 0, 0);
              show("⏺ 録画を始めました。1.5〜3.5秒ごとに画面を撮ります（最長7分・もう一度押すと止まります）。", "#be123c");
            }
          });
        });
      } catch (e) { show("✖ できませんでした: " + ((e && e.message) || e)); }
    });
    refreshRecMode();
    setInterval(refreshRecMode, 5000);

    /**
     * 2026-11-12: 「写真を片付ける」ボタン（容量がいっぱいで撮れない時の逃げ道）
     */
    var trimBtn = el("snap-shot-trim");
    if (trimBtn) trimBtn.addEventListener("click", function () {
      var hint = el("snap-perm-hint");
      var show = function (msg, color) { if (hint) { hint.style.display = "block"; hint.textContent = msg; hint.style.color = color || "#b91c1c"; } };
      show("🧹 片付けています…", "#475569");
      try {
        chrome.runtime.sendMessage({ type: "axlx-shot-trim" }, function (res) {
          void chrome.runtime.lastError;
          if (!res || !res.ok) { show("✖ 片付けられませんでした: " + ((res && res.error) || "理由なし")); return; }
          show("✅ 片付けました（" + (Number(res.removed) || 0) + "件）。クラウドの写真は消していません。もう一度「⏺ 録画」を押してください。", "#047857");
        });
      } catch (e) { show("✖ できませんでした: " + ((e && e.message) || e)); }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
  try {
    if (chrome.permissions && chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(refresh);
    if (chrome.permissions && chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(refresh);
  } catch (_) {}
  // popup.html の最後で読むので DOMContentLoaded の後の時もある
  if (document.readyState !== "loading") init();
})();
