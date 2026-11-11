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
     * 2026-11-11 竹内さん「でていない。ブレインの左側にわかりやすいようにだす」:
     *   未許可の時だけ **ブレインのすぐ左**にオレンジのボタン（#perm-rec-btn）を出す。
     *   帯（#snap-perm-banner）は補助（下に説明を出す）として残す。
     */
    if (recBtn) recBtn.style.display = granted ? "none" : "inline-block";
    if (banner) banner.style.display = granted ? "none" : "flex";
    var hint = el("snap-perm-hint");
    if (hint && granted) { hint.style.display = "none"; hint.textContent = ""; }
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
  }

  /** 許可を頼む（人のクリックの中で呼ぶ）。だめなら手順を出す */
  function ask() {
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
  }

  document.addEventListener("DOMContentLoaded", init);
  try {
    if (chrome.permissions && chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(refresh);
    if (chrome.permissions && chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(refresh);
  } catch (_) {}
  // popup.html の最後で読むので DOMContentLoaded の後の時もある
  if (document.readyState !== "loading") init();
})();
