"use strict";

// ── ローカル条件解決コア（popup.js と同一ロジック）─────────────────────────
// manifest の background.type が "module" のため importScripts() は使えない。
// 静的 import で読み込み、resolution-core.js が公開する globalThis.SUMORA_RESOLUTION
// 経由で resolveConditionsLocal 等を参照する（_resolveLocalFirst 参照）。
import "./area-token.js"; // v2.5.76 市・区の語は駅にしない（resolution-core の駅モードが読む）
import "./wide-rent.js"; // v2.5.79 家賃の上限が「必ず」なら広げても上げない（resolution-core が読む）
import "./resolution-core.js";
// 2026-09-18 竹内: 検索日の記録（サイト×モード）を popup.js と同じ1つの関数で行う（self.AxlxSearchHistory）
import "./search-history.js";
// 2026-09-18 竹内（一括検索の混線）: fill-done が誰の分かの判定（純関数・テストあり）
import "./fill-done-match.js";
// 2026-11-18 竹内「１人のお客さん完了してから次のお客さんに移るように」: 次客へ渡してよいか・一括を止める関所（self.AxlxCustomerHandoff）
import "./customer-handoff.js";
import "./customer-search-think.js";
// 2026-09-25 竹内「ブレインだけ別で、ほかはドロップダウン」: 動作モードの読み方・組み合わせの動き・バッジ（self.AxlxModeCore・popup.js と同じ1つ）
import "./mode-core.js";
// 2026-09-25 竹内「更新日も拡張ツールと連動」: 一括検索の更新日（手で決めた値 → 送った日と確認した日の新しい方）（self.AxlxRpUpdateDays・app/lib/rp-update-days.ts の写し）
import "./rp-update-days.js";
// 2026-09-25 竹内「ブレインモードで…検索がちゃんとされていなかったら原因を見つけられるようにする」: 検索の点検（self.AxlxSearchAudit）
import "./search-audit.js";
// 2026-09-27 竹内「メモ欄に条件を送ったら、それに連動して検索」: AIXツールのメモの検索の指示（web_brain の payload.search_override）をその回だけ重ねる（self.AxlxSearchOverride）
import "./search-override.js";
// 2026-09-27 竹内「拡張ツールは人間らしい動きをするために全て時間ランダムにする」: 待ち時間のばらつき（self.AxlxHumanWait・popup/content/ページの中と同じ1つ）
import "./human-wait.js";
// 2026-09-27 v2.5.32 竹内「重い順から治す」: 一括検索の前のタブの確かめ・地域が空なら検索しない・失敗の知らせ（self.AxlxBatchGuard・純関数）
import "./batch-guard.js";
// 2026-09-27 自動便（auto_schedule）の決まり: ITANDI も回す・タブが無ければ飛ばす・サイト／お客様の間・便の指定（self.AxlxAutoRun）
import "./auto-run.js";
// 2026-09-29 v2.5.39 通勤の到達時間で駅を選ぶ（直接入力の経路でも popup と同じ決め方）: self.AxlxOsakaTransit / self.AxlxCommuteReach
import "./osaka-transit.js";
import "./commute-reach.js";
// 2026-09-29 v2.5.40 竹内「なぜ固まっているのか」「画面開いているのも目で見ることができるのが理想」: 心拍・画面の写真・一括の見張り（self.AxlxSnapshotCore）
import "./snapshot-core.js";
// 2026-09-29 v2.5.41 竹内「一度送ったことがある物件はダウンロードもしないように」: 送付済みの部屋を一覧で選ばない（self.AxlxSentSkip）
import "./sent-skip.js";
// 2026-09-30 v2.5.42 竹内「ITANDI も一回での上限を作る。物件数で」「ITANDI で条件指定ちゃんとできていなければ…」: 条件が効いていない検索の見分け（self.AxlxItandiGuard）
import "./itandi-guard.js";
// 2026-09-30 v2.5.43 竹内「拡張ツールはリアプロと ITANDI を開いているので、同時に動かす形でも大丈夫ならそれで行う」: 同時に動かせるかの判定・2本の合流（self.AxlxParallelSites）
import "./parallel-sites.js";
// 2026-09-30 v2.5.43 竹内「更新順で検索していたら、その更新順以降は見なくて大丈夫」: 前回の検索の時刻の読み（self.AxlxUpdateOrderStop）
import "./update-order-stop.js";
import "./learn-refresh-gate.js"; // 2.8.183 束・手順書の強制取込判定（更新直後／欠落／needs_auto）
import "./bulk-panel-grasp.js"; // 2.8.217 一括パネル「誰・何件・次客・把握」

// ── 2026-09-29 v2.5.40 SW のログの末尾（画面の写真に添える・最大80行） ──
//   console.log / warn / error をそのまま出したうえで、メモリの輪に貯める（storage.session へは15秒に1回まで）。
//   SW が作り直されても前の末尾を読み戻す（「止まる前に何をしていたか」が写真で分かるように）
var _extLogRing = [];
var _extLogSavedAt = 0;
(function () {
  try {
    var SC = self.AxlxSnapshotCore;
    if (!SC || self.__axlxLogWrapped) return;
    self.__axlxLogWrapped = true;
    ["log", "warn", "error"].forEach(function (lv) {
      var orig = console[lv].bind(console);
      console[lv] = function () {
        orig.apply(null, arguments);
        try {
          _extLogRing.push(SC.logLine(lv, arguments, Date.now()));
          if (_extLogRing.length > SC.LOG_MAX * 2) _extLogRing = SC.trimLog(_extLogRing, SC.LOG_MAX);
          if (Date.now() - _extLogSavedAt > 15000) {
            _extLogSavedAt = Date.now();
            chrome.storage.session.set({ extLogTail: SC.trimLog(_extLogRing, SC.LOG_MAX) }).catch(function () {});
          }
        } catch (_) {}
      };
    });
    chrome.storage.session.get("extLogTail").then(function (st) {
      if (st && Array.isArray(st.extLogTail) && st.extLogTail.length) {
        _extLogRing = SC.trimLog(st.extLogTail.concat([{ t: Date.now(), l: "log", m: "── SW が起動（ここから新しい SW）──" }], _extLogRing), SC.LOG_MAX);
      }
    }).catch(function () {});
  } catch (_) { /* ログの輪が作れなくても拡張は止めない */ }
})();

// 待ち時間のばらつき（human-wait.js）。settle＝ページが落ち着くのを待つ固定の秒数（元より短くしない）／
//   poll＝条件を見る間隔（平均は元と同じ・回数で打ち切る待ちの長さは変えない）。読めない時は元の値。
function _settleMs(ms) { var H = self.AxlxHumanWait; return H ? H.settleDelay(ms) : ms; }
function _pollMs(ms) { var H = self.AxlxHumanWait; return H ? H.pollDelay(ms) : ms; }

const UNDERBAR_SITES = ["realnetpro.com", "system.reins.jp"];

// ── レインズ新タブ監視（window.openで開かれるタブからPDFを取得）────────────
// openerTabId → { senderTabId, timerId }
const reinsTabWatchers = new Map();

// ── itandi ダウンロード監視（JSフック失敗時のフォールバック）────────────────
// タブIDではなく時刻ベースで管理（window.openで開いた新タブのDLにも対応）
let itandiWatchExpiry     = 0; // epoch ms
let itandiWatchOriginalTab = 0; // 結果を返す元タブ

// ── レインズ一括PDFダウンロードをLINE送信に横取り ─────────────────────────────
// 図面一括取得 → 確認ダイアログOK → Chrome download bar
// JSフックでは捕捉できない場合（Content-Disposition: attachment の直DL）を chrome.downloads で補完
// ダウンロードはキャンセルしない（ユーザーのファイルはそのまま保存される）
chrome.downloads.onCreated.addListener((downloadItem) => {
  const url    = downloadItem.url || "";
  const dlTabId = downloadItem.tabId;

  // ── itandi PDF ダウンロードキャプチャ（時刻ベース・タブID不問）────────────
  // Bug fix: window.openで開いた新タブのdlTabIdは元タブと一致しないため時刻ベースで判定
  if (itandiWatchExpiry > 0 && Date.now() < itandiWatchExpiry) {
    const isMaybePdf =
      url.includes(".pdf") ||
      (downloadItem.mime || "").includes("pdf") ||
      (downloadItem.mime || "").includes("octet-stream");
    if (isMaybePdf) {
      const originalTabId = itandiWatchOriginalTab;
      itandiWatchExpiry     = 0;
      itandiWatchOriginalTab = 0;
      // LINEに送るだけなのでファイルを保存しない（Adobeが開くのを防ぐ）
      chrome.downloads.cancel(downloadItem.id).catch(() => {});
      console.log("[AXLX BG] itandi DL検知 url=" + url.slice(0, 80) + " → originalTab=" + originalTabId);

      // BGサービスワーカーからfetch（host_permissionsがあるitandibb.comはCORSなし）
      // S3/CDN URL はフォールバックで元タブのMAIN worldからfetch
      (async () => {
        let b64 = null;
        try {
          const r = await fetch(url, { credentials: "include" });
          const buf = await r.arrayBuffer();
          const bytes = new Uint8Array(buf);
          const chunks = [];
          for (let i = 0; i < bytes.length; i += 8192) {
            chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
          }
          b64 = btoa(chunks.join(""));
          console.log("[AXLX BG] itandi DL BG-fetch成功 " + Math.round(b64.length / 1024) + "KB");
        } catch (e1) {
          console.warn("[AXLX BG] itandi DL BG-fetch失敗:", e1.message, "→ MAIN world fallback");
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: originalTabId },
              world: "MAIN",
              func: (pdfUrl) => {
                return fetch(pdfUrl, { credentials: "include" })
                  .then((r) => r.arrayBuffer())
                  .then((buf) => {
                    const bytes = new Uint8Array(buf);
                    const chunks = [];
                    for (let i = 0; i < bytes.length; i += 8192) {
                      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
                    }
                    return btoa(chunks.join(""));
                  })
                  .catch(() => null);
              },
              args: [url],
            });
            b64 = results?.[0]?.result || null;
            if (b64) console.log("[AXLX BG] itandi DL MAIN-fetch成功 " + Math.round(b64.length / 1024) + "KB");
          } catch (e2) {
            console.error("[AXLX BG] itandi DL MAIN-fetch失敗:", e2.message);
          }
        }
        if (b64) {
          chrome.tabs.sendMessage(originalTabId, { type: "axlx-itandi-pdf-by-download", b64, ts: Date.now() })
            .catch((e) => console.error("[AXLX BG] itandi sendMessage error:", e.message));
        } else {
          console.warn("[AXLX BG] itandi DL capture null（全fetchパス失敗）");
        }
      })();
    }
  }

  // ── レインズ PDF ダウンロードキャプチャ ──────────────────────────────────────
  if (reinsTabWatchers.size === 0) return; // 監視中でない

  // blob:URL はJSフック側で捕捉済みのため除外、reins.jp ドメインのみ対象
  if (url.startsWith("blob:") || !url.includes("reins.jp")) return;

  // senderTabId（レインズを開いているタブ）を取得
  let senderTabId = null;
  for (const [, entry] of reinsTabWatchers) {
    senderTabId = entry.senderTabId;
    break;
  }
  if (!senderTabId) return;

  // ダウンロードをキャンセルしてAdobeが開くのを防ぐ（内容はMAIN world fetchで取得）
  chrome.downloads.cancel(downloadItem.id).catch(() => {});
  console.log("[AXLX BG] 一括DL検知 → キャンセル & MAINworld再fetch:", url.slice(0, 80));

  // レインズタブのMAIN worldでURLをfetch（ページのセッションCookieが自動的に使われる）
  chrome.scripting.executeScript({
    target: { tabId: senderTabId },
    world: "MAIN",
    func: (pdfUrl) => {
      return fetch(pdfUrl)
        .then((r) => {
          const ct = r.headers.get("content-type") || "";
          if (!ct.includes("pdf") && !ct.includes("octet")) return null;
          return r.arrayBuffer();
        })
        .then((buf) => {
          if (!buf) return null;
          const bytes = new Uint8Array(buf);
          const chunks = [];
          for (let i = 0; i < bytes.length; i += 8192) {
            chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
          }
          return btoa(chunks.join(""));
        })
        .catch(() => null);
    },
    args: [url],
  }).then((results) => {
    const b64 = results?.[0]?.result;
    if (b64) {
      console.log("[AXLX BG] 一括PDF取得成功 → senderTab送信");
      chrome.tabs.sendMessage(senderTabId, {
        type: "axlx-reins-pdf-captured",
        b64,
        ts: Date.now(),
      }).catch((e) => console.error("[AXLX BG] sendMessage error:", e.message));
      // M8修正: 即時 clear() を廃止。複数PDF一括DLでは2件目以降がここに来るため
      // 既存の35秒タイマーで自然消化させる（全件完了後に watcher が自動削除される）
    } else {
      console.warn("[AXLX BG] 一括PDF fetch null（URLが期限切れ or 非PDF）");
    }
  }).catch((e) => {
    console.error("[AXLX BG] 一括PDF executeScript error:", e.message);
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  const newTabId = tab.id;
  let senderTabId = null;
  let watcherKey  = null;

  if (tab.openerTabId && reinsTabWatchers.has(tab.openerTabId)) {
    // 正常パス: openerTabId が一致
    const entry = reinsTabWatchers.get(tab.openerTabId);
    senderTabId = entry.senderTabId;
    watcherKey  = tab.openerTabId;
  } else if (reinsTabWatchers.size > 0) {
    // フォールバック: 図面一括取得が window.open 以外の方法でタブを開く場合
    // ウォッチャーが有効なら最初のエントリを使う
    for (const [key, entry] of reinsTabWatchers) {
      senderTabId = entry.senderTabId;
      watcherKey  = key;
      break;
    }
  }

  if (!senderTabId) return;

  // タイマーをリセット（複数タブが連続で開く一括取得に対応）
  const existing = reinsTabWatchers.get(watcherKey);
  if (existing) clearTimeout(existing.timerId);
  const newTimer = setTimeout(() => reinsTabWatchers.delete(watcherKey), 35000);
  reinsTabWatchers.set(watcherKey, { senderTabId, timerId: newTimer });

  console.log("[AXLX BG] レインズ新タブ検知 id=" + newTabId + " openerTabId=" + tab.openerTabId + " senderTabId=" + senderTabId);

  // タブのロード完了後にPDFを取得して元のタブに送信する
  function captureFromTab(updatedTab) {
    const url = updatedTab.url || "";
    console.log("[AXLX BG] 新タブ完了:", url.slice(0, 80));

    // レインズ外のURLはスキップ（誤検知でユーザーのタブを閉じないため）
    if (url && !url.includes("system.reins.jp") && !url.startsWith("blob:") && url !== "about:blank") {
      console.log("[AXLX BG] レインズ外URL → スキップ（タブ維持）");
      return;
    }

    // MAIN worldにスクリプトを注入してfetch経由でPDFデータを取得
    chrome.scripting.executeScript({
      target: { tabId: newTabId },
      world: "MAIN",
      func: () => {
        return fetch(location.href)
          .then((r) => {
            const ct = r.headers.get("content-type") || "";
            if (!ct.includes("pdf") && !ct.includes("octet")) {
              return null; // PDFでない場合はスキップ
            }
            return r.arrayBuffer();
          })
          .then((buf) => {
            if (!buf) return null;
            const bytes = new Uint8Array(buf);
            const chunks = [];
            for (let i = 0; i < bytes.length; i += 8192) {
              chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
            }
            return btoa(chunks.join(""));
          })
          .catch(() => null);
      },
    }).then((results) => {
      const b64 = results?.[0]?.result;
      // 新タブを閉じる
      chrome.tabs.remove(newTabId).catch(() => {});
      if (b64) {
        console.log("[AXLX BG] 新タブPDF取得成功 → 元タブに送信");
        chrome.tabs.sendMessage(senderTabId, {
          type: "axlx-reins-pdf-captured",
          b64,
          ts: Date.now(),
        }).catch((e) => console.error("[AXLX BG] sendMessage error:", e.message));
      } else {
        console.warn("[AXLX BG] 新タブからPDF取得失敗（null）");
      }
    }).catch((e) => {
      console.error("[AXLX BG] 新タブ注入エラー:", e.message);
      chrome.tabs.remove(newTabId).catch(() => {});
    });
  }

  // タブ更新リスナー
  const onUpdated = (tabId, changeInfo, updatedTab) => {
    if (tabId !== newTabId || changeInfo.status !== "complete") return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    captureFromTab(updatedTab);
  };
  chrome.tabs.onUpdated.addListener(onUpdated);

  // タブが既にcomplete状態の場合のフォールバック
  setTimeout(() => {
    chrome.tabs.get(newTabId, (t) => {
      if (chrome.runtime.lastError) return;
      if (t?.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        captureFromTab(t);
      }
    });
  }, 500);
});

function isUnderbarSite(url) {
  return !!url && UNDERBAR_SITES.some((s) => url.includes(s));
}

function setupSidePanel() {
  try {
    if (chrome.sidePanel?.setPanelBehavior) {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    }
  } catch (e) {
    // サービスワーカー起動クラッシュを防ぐ（sidePanel API の同期エラーを吸収）
    console.warn("[AXLX BG] setupSidePanel error:", e.message);
  }
}

function configureSidePanelForTab(tabId, url) {
  if (!chrome.sidePanel?.setOptions) return;
  chrome.sidePanel.setOptions({ tabId, enabled: !isUnderbarSite(url) }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(setupSidePanel);
chrome.runtime.onStartup.addListener(setupSidePanel);
setupSidePanel();

/**
 * ★ 2026-11-22 2.8.183 竹内さん「すぐ反映／ポップアップ無しでも」:
 *   拡張の再読込・更新の直後に束を強制取込（read_count を付ける）。
 *   ポップアップを開かなくても、chrome://extensions 再読込だけで新手順書へ寄せる。
 */
function _learnRefreshOnInstalled(details) {
  try {
    var reason = String((details && details.reason) || "");
    if (reason !== "install" && reason !== "update") return;
    chrome.storage.local.set({
      axlx_learn_after_update: true,
      axlx_learn_after_update_at: Date.now(),
      axlx_learn_after_update_reason: reason,
    }, function () {
      try {
        console.log("[learn] 拡張" + reason + " → 束を強制取り込みます（ポップアップ不要）");
      } catch (_) {}
      try {
        _refreshLearnedBundleQueued(true).then(function (r) {
          try {
            console.log(
              "[learn] 更新直後の取込:",
              (r && (r.skipped || (r.ok ? "ok" : "ng"))) || "?",
              "read=" + ((r && r.server_read_count != null) ? r.server_read_count : "?"),
              "needs_auto=" + !!(r && r.needs_auto),
            );
          } catch (_) {}
        }).catch(function () {});
      } catch (_) {}
    });
  } catch (_) {}
}
try { chrome.runtime.onInstalled.addListener(_learnRefreshOnInstalled); } catch (_) {}

// 2026-10-06 v2.5.77 竹内「常に自動モードではなくて、光って選択するモードとする」: 更新・起動のたびに、古い版の値
//   （AIX連動 aixMode=true・案内モード OFF guideMode=false）を「光って選択するモード」に書き直す（mode-core.js guideOnlyMigration）
// 2026-11-10: 自動モードを選べるようにしたので、**選んだ印（autoModeAt）が無い古い aixMode=true だけ**を落とす（選んだ自動は消さない）
function _migrateGuideOnly() {
  try {
    var core = self.AxlxModeCore;
    if (!core || !core.guideOnlyMigration) return;
    chrome.storage.local.get(["aixMode", "autoModeAt"], function (st) {
      var upd = core.guideOnlyMigration(st || {});
      if (upd) chrome.storage.local.set(upd);
    });
  } catch (_) {}
}
chrome.runtime.onInstalled.addListener(_migrateGuideOnly);
chrome.runtime.onStartup.addListener(_migrateGuideOnly);
/**
 * 2026-11-11 竹内さん「デフォルトが普通モードにして。選択で自動モードやAIXにこちらでしてから自動検索されるように」:
 *   ブラウザを起動した時は必ず通常モードから始める（前日の「自動」「AIX」「スタッフ」を引きずらない）。
 *   拡張の更新（onInstalled）では消さない（作業の途中で勝手に戻ると困る）。
 */
function _resetModeOnStartup() {
  try {
    var core = self.AxlxModeCore;
    if (!core || !core.startupReset) return;
    chrome.storage.local.set(core.startupReset(), function () {
      console.log("[mode] ブラウザの起動 → モードを通常に戻しました（自動で検索しません）");
    });
  } catch (_) {}
}
chrome.runtime.onStartup.addListener(_resetModeOnStartup);
_migrateGuideOnly();
/** 自動の物を始めてよいか。
 *  2026-10-06 v2.5.77: 「光って選択するモード」の間は常に false（自動の道を閉じる）。
 *  2026-11-10: 自動モード（mode-core の AUTO_MODE）を選んでいる時だけ開く。通常・スタッフは今まで通り閉じたまま。
 *  呼ぶ側は同期で判断したい所（一括検索の入口・Realtime・コマンドの入口）なので、storage を読まずに覚えている値（_autoModeChosen）を見る。
 *  値は起動時と storage の変化のたびに _refreshAutoModeChosen が書く。 */
var _autoModeChosen = false;
/**
 * ★ 2.8.186: スタッフも検索後に AD並び替え→PDF押しがある（mode-core effectiveBehavior.autoSend）。
 *   旧は `_autoModeChosen`（自動/AIXのみ）で fill-done 早期クローズを止めていたため、
 *   brain_staff（#1584）では human_search_done で閉じ、並べ替え印が監査に残らなかった。
 */
var _staffModeChosen = false;
async function _refreshAutoModeChosen() {
  try {
    var core = self.AxlxModeCore;
    if (!core || !core.GUIDE_ONLY) { _autoModeChosen = true; _staffModeChosen = false; return; }
    // 2026-11-11 竹内さん「もともとのAIXのようにチェックしたお客さんをリアプロとitandiで一括検索」:
    //   AIX（ai）も自動の道を開くモードなので、ここで一緒に見る（画面の一括検索の帯も自動・AIXの時に出す）
    var st = await chrome.storage.local.get(["staffMode", "staffModeAt", "aixMode", "autoModeAt", "brainMode", "aiMode"]);
    var _m = core.effectiveState(st || {}, Date.now()).mode;
    _autoModeChosen = _m === core.AUTO_MODE || (!!core.AI_MODE && _m === core.AI_MODE);
    _staffModeChosen = _m === "staff";
  } catch (_) { _autoModeChosen = false; _staffModeChosen = false; }
}
/** 検索後も監査を開けたままにする（自動／AIX／スタッフ） */
function _keepAuditOpenAfterFill() {
  return !!(_autoModeChosen || _staffModeChosen);
}
try {
  _refreshAutoModeChosen();
  chrome.storage.onChanged.addListener(function (ch, area) {
    if (area !== "local" || !ch) return;
    if (ch.aixMode || ch.autoModeAt || ch.staffMode || ch.staffModeAt || ch.aiMode) _refreshAutoModeChosen();
    /**
     * ★ 2.8.183: 自動／AIX を選んだ瞬間に束を強制取込（心拍待ち・ポップアップ不要）。
     */
    try {
      var Gate = self.AxlxLearnRefreshGate;
      if (!Gate || !Gate.modeOpenedForLearn) return;
      var keys = ["autoModeAt", "aixMode", "aiMode"];
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (!ch[k]) continue;
        if (Gate.modeOpenedForLearn(k, ch[k].oldValue, ch[k].newValue)) {
          try { console.log("[learn] モード切替（" + k + "）→ 束を強制取り込みます"); } catch (_) {}
          _refreshLearnedBundleQueued(true).catch(function () {});
          break;
        }
      }
    } catch (_) {}
  });
} catch (_) {}
function _guideOnly() {
  var core = self.AxlxModeCore;
  if (!(core && core.GUIDE_ONLY)) return false;
  return !_autoModeChosen;
}

// content script から chrome.storage.session へのアクセスを許可
if (chrome.storage && chrome.storage.session && chrome.storage.session.setAccessLevel) {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(function() {});
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.url) return;
    configureSidePanelForTab(tabId, tab.url);
    _learnSwitchSite(tab.url);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || (changeInfo.status === "complete" ? tab.url : null);
  if (url) {
    configureSidePanelForTab(tabId, url);
    if (changeInfo.url) _learnSwitchSite(url);
  }
});

/**
 * 2026-11-14 竹内さん「リアプロ itandi それぞれちゃんと区別して学習。それぞれの性質を理解するためにも
 *   改善していくためにも必要」:
 *
 *   **タブを切り替えてサイトが変わったら、そのサイトの学びに入れ替える**。
 *   ⚠ 旧は全体（全部混ぜた束）を1回読むだけだったので、リアプロで学んだ順番が itandi でも使われていた。
 *   → サイトが変わった時だけ取り直す（同じサイトなら何もしない＝通信しない）。
 */
var _learnSiteNow = null;
async function _learnSwitchSite(url) {
  try {
    var u = String(url || "");
    var s = /itandibb\.com/.test(u) ? "itandi" : (/realnetpro\.com/.test(u) ? "realpro" : null);
    if (!s) return { ok: true, skipped: "not-target" };
    if (s === _learnSiteNow) return { ok: true, skipped: "same-site" };
    _learnSiteNow = s;
    /**
     * `axlx_learn_at` を 0 にして「取り直す」状態にする（5分の待ちを飛ばす）。
     * ⚠ 版が同じでも、**サイトが違えば入れ替える必要がある**（別の束だから）。
     */
    await chrome.storage.local.set({ axlx_learn_at: 0 });
    var r = await _refreshLearnedBundleQueued(true);
    console.log("[learn] " + s + " の学びに入れ替えました:", JSON.stringify(r));
    return r;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ── ヘルパー: リアプロの資料（印刷用PDF）を、そのリアプロのタブの中で取る ─────────────
// 2026-10-01 竹内「なんで今両方からログインされている形になっているのか」「それで改善行う」:
//   旧はリアプロのログイン情報（Cookie）を読んでサーバー（Vercel）に渡し、サーバーがデータセンターからリアプロに資料を取りに行っていた
//   （同じログインがオフィスの PC とサーバーの2か所から使われる・ログイン情報が PC の外に出る）。
//   今はスタッフが開いているリアプロのタブの中で取る（印刷用PDF を開くのと同じ場所・同じログイン）→ 一時置き場（Vercel Blob）に上げ、
//   サーバーには置き場の URL と元の資料の場所だけを渡す（ITANDI の axlx-send-pdf-data-to-line と同じ道）。ログイン情報はどこにも送らない。
//   並べて一度に取らず1件ずつ順に取る（サイトへのアクセスを一度に重ねない）。
async function _realproTabFor(sender) {
  if (sender && sender.tab && sender.tab.id != null && /realnetpro\.com/.test(sender.tab.url || "")) return sender.tab.id;
  const tabs = await chrome.tabs.query({ url: ["https://www.realnetpro.com/*", "https://realnetpro.com/*"] });
  if (!tabs.length) throw new Error("リアプロのタブが開いていません。リアプロにログインしたタブを開いてから送ってください。");
  return tabs[0].id;
}

/** urls の資料をタブの中で1件ずつ取る。戻り値は urls と同じ並び（取れなかった物は error）。
 *  pressed（スタッフが「印刷用PDF」を押して開いた資料の URL）は、まず手元（ブラウザのキャッシュ）から読む＝リアプロにもう一度取りに行かない。
 *  手元に無かった時だけ今まで通り取りに行く（from: "cache" | "network"） */
async function fetchRealproPdfsInTab(tabId, urls, pressed) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [urls, Array.isArray(pressed) ? pressed : []],
    func: async (list, pressedList) => {
      const toB64 = (buf) => {
        const bytes = new Uint8Array(buf);
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(s);
      };
      const out = [];
      for (const u of list) {
        if (pressedList.indexOf(u) !== -1) {
          try {
            const rc = await fetch(u, { cache: "only-if-cached", mode: "same-origin", credentials: "include" });
            const ctc = rc.headers.get("content-type") || "";
            if (rc.ok && !ctc.includes("text/html")) { out.push({ b64: toB64(await rc.arrayBuffer()), from: "cache" }); continue; }
          } catch (_) { /* 手元に無い → 下で取りに行く */ }
        }
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 30000);
          const r = await fetch(u, { credentials: "include", signal: ctl.signal });
          clearTimeout(timer);
          const ct = r.headers.get("content-type") || "";
          if (!r.ok) { out.push({ error: "HTTP " + r.status }); continue; }
          if (ct.includes("text/html")) { out.push({ error: "session", html: true }); continue; }
          out.push({ b64: toB64(await r.arrayBuffer()), from: "network" });
        } catch (e) {
          out.push({ error: (e && e.name === "AbortError") ? "timeout" : String((e && e.message) || e) });
        }
      }
      return out;
    },
  });
  return (res && res.result) || [];
}

/**
 * リアプロの資料を取り → 一時置き場に上げる。取れなかった物件は外し、外した番号を返す（説明文などを同じ組で落とすため）。
 * ログインが切れていた（HTML が返る）時は全体を止める（再ログインの案内）。全件取れない時も止める
 */
async function realproPdfsToBlobUrls(sender, urls, baseName, customerId) {
  const tabId = await _realproTabFor(sender);
  const pressed = await _getPressedPdfs();
  const got = await fetchRealproPdfsInTab(tabId, urls, pressed);
  const fromCache = got.filter((g) => g && g.b64 && g.from === "cache").length;
  console.log("[realpro-pdf] 押して開いた資料を手元から:", fromCache, "/", urls.length);
  if (got.some((g) => g && g.html)) throw new Error("リアプロのセッションが切れています（資料の代わりにログイン画面が返りました）。リアプロに再ログインしてください。");
  const blobUrls = [], keptIdx = [], dropped = [];
  for (let i = 0; i < urls.length; i++) {
    const g = got[i];
    if (!g || !g.b64) { dropped.push({ i, error: g ? g.error : "no_result" }); continue; }
    blobUrls.push(await uploadWithRetry(g.b64, `${baseName}_${i + 1}.pdf`));
    keptIdx.push(i);
    try { _notifyBatchProgress(customerId || null); } catch (_) {}
  }
  if (!blobUrls.length) throw new Error("リアプロの資料を1件も取れませんでした（" + dropped.map((d) => d.error).join("・") + "）");
  if (dropped.length) console.warn("[realpro-pdf] 取れなかった資料を外して送る:", dropped);
  return { blobUrls, keptIdx, dropped, fromCache };
}

// ── 押した「印刷用PDF」を送る物に入れる（v2.5.60）────────────────────────────
// 2026-10-01 竹内「印刷用PDF おしたら転送されれば理想」:
//   スタッフが一覧の「印刷用PDF」を押す → 資料のタブが開き終わる → 一覧のタブの中で「手元に残っている物だけ」で読めるか確かめる
//   （cache: "only-if-cached"＝リアプロには行かない）→ 読めたら「押した資料」に覚え、一覧のその行にチェックを入れる。
//   送る時（realproPdfsToBlobUrls）は押した資料を手元から読む＝リアプロに届くのはスタッフが押した1回だけ。
//   覚えておくのは3時間（資料の鮮度）。拡張は押さない・開かない（タブが開いたのを見ているだけ）
const _PRESSED_KEY = "axlx_pressed_pdfs";
const _PRESSED_TTL_MS = 3 * 60 * 60 * 1000;
const _FACTSHEET_RE = /^https:\/\/(www\.)?realnetpro\.com\/common\/factsheet\.php\?/;
async function _getPressedPdfs() {
  try {
    const r = await chrome.storage.session.get(_PRESSED_KEY);
    const m = (r && r[_PRESSED_KEY]) || {};
    const now = Date.now();
    return Object.keys(m).filter((u) => now - m[u] < _PRESSED_TTL_MS);
  } catch (_) { return []; }
}
async function _addPressedPdf(url) {
  try {
    const r = await chrome.storage.session.get(_PRESSED_KEY);
    const m = (r && r[_PRESSED_KEY]) || {};
    const now = Date.now();
    for (const u of Object.keys(m)) if (now - m[u] >= _PRESSED_TTL_MS) delete m[u];
    m[url] = now;
    await chrome.storage.session.set({ [_PRESSED_KEY]: m });
  } catch (_) {}
}
// v2.5.62 2026-10-01 竹内「印刷用PDF おしたらダウンロードされるので、そのまま AIX ツールに転送されるようにする」:
//   リアプロの「印刷用PDF」は開かずにダウンロードされる（実画面）→ ダウンロードの完了でも受け取る（タブで開いた時と同じ処理）。
//   ダウンロードは止めない・消さない（スタッフのファイルはそのまま）
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta || !delta.state || delta.state.current !== "complete") return;
  chrome.downloads.search({ id: delta.id }, (items) => {
    const it = items && items[0];
    const u = it && ([it.url, it.finalUrl].find((x) => _FACTSHEET_RE.test(x || "")));
    if (u) _capturePressedPdf(u, null, null);
  });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab || !_FACTSHEET_RE.test(tab.url || "")) return;
  _capturePressedPdf(tab.url, tabId, tab.openerTabId);
});
function _capturePressedPdf(url, tabId, openerTabId) {
  (async () => {
    // 一覧のタブ（開いた元のタブ → 無ければ資料でないリアプロのタブ）
    let listTabId = null;
    try {
      if (openerTabId != null) {
        const ot = await chrome.tabs.get(openerTabId);
        if (ot && /realnetpro\.com/.test(ot.url || "") && !_FACTSHEET_RE.test(ot.url || "")) listTabId = ot.id;
      }
      if (listTabId == null) {
        const tabs = await chrome.tabs.query({ url: ["https://www.realnetpro.com/*", "https://realnetpro.com/*"] });
        const t = tabs.find((x) => x.id !== tabId && !_FACTSHEET_RE.test(x.url || ""));
        if (t) listTabId = t.id;
      }
    } catch (_) {}
    if (listTabId == null) return;
    let ok = false, bytes = 0;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: listTabId },
        args: [url],
        func: async (u) => {
          try {
            if (new URL(u).origin !== location.origin) return { ok: false };
            const r = await fetch(u, { cache: "only-if-cached", mode: "same-origin", credentials: "include" });
            const ct = r.headers.get("content-type") || "";
            const buf = await r.arrayBuffer();
            return { ok: r.ok && !ct.includes("text/html"), bytes: buf.byteLength };
          } catch (_) { return { ok: false }; }
        },
      });
      ok = !!(res && res.result && res.result.ok);
      bytes = (res && res.result && res.result.bytes) || 0;
    } catch (_) {}
    if (ok) await _addPressedPdf(url);
    // 手元に残らなくても「押した」ことは知らせる（送る時は今まで通り取りに行く・竹内さんの判断でまとめて送るのは可）
    try { chrome.tabs.sendMessage(listTabId, { type: "axlx-pdf-captured", url, ok, bytes }); } catch (_) {}
  })();
}

// ── ヘルパー: PDF 1件をVercel Blobにアップロードして公開URLを返す ──────────
// base64→binary変換して送信（base64より33%軽量・413回避）
async function uploadPdfToBlob(b64, fileName) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  // タイムスタンプをファイル名に付与してCDNキャッシュを完全に回避
  // 同名ファイルをallowOverwrite:trueで上書きしてもCDNが古いキャッシュを返すため
  const uniqueName = fileName.replace(/\.pdf$/i, "") + `_${Date.now()}.pdf`;
  const url = `https://sumora-ai-ui.vercel.app/api/blob-upload?name=${encodeURIComponent(uniqueName)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: bytes,
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Blobアップロード失敗 HTTP ${resp.status}: ${text.slice(0, 120)}`);
  }
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || "Blobアップロードエラー");
  return data.url;
}

// ── ヘルパー: uploadPdfToBlob の個別リトライラッパー（M9修正）──────────────
// 途中失敗で孤立 Blob が出ても LINE 送信を止めないよう最大3回リトライ
async function uploadWithRetry(b64, fileName) {
  for (let i = 0; i < 3; i++) {
    try { return await uploadPdfToBlob(b64, fileName); }
    catch (e) {
      if (i === 2) throw e;
      console.warn(`[uploadWithRetry] 試行 ${i + 1} 失敗、1秒後に再試行:`, e.message);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// ── ヘルパー: スタッフモードか（popup.js が chrome.storage.local に持つ・TTL 2時間）──
//
// 2026-09-21 竹内「スタッフモードで送るときはちゃんとLINEに共有できるように。これを省く（スタッフモード）の時」
//   サーバー（/api/merge-pdfs）は一度送った物件をマンションごとに外すが、
//   **スタッフが自分で選んで送る時は外さない**（意図して選んだ物が減ると困る）。
//   ⚠ 判定はここ1か所だけ。リアプロ・itandi・レインズの3つのファイルに書くと、
//     1つ足し忘れた経路だけ動きが違う（設計知見「出口の配線は経路ごとに確かめる」）。
//   TTL の 2時間は bulk-dl.js / itandi-bulk-dl.js と同じ（popup.js が staffModeAt を入れる）。
function isStaffModeOn() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(["staffMode", "staffModeAt"], (res) => {
        const on = !!(res && res.staffMode);
        const at = (res && res.staffModeAt) || 0;
        resolve(on && (!at || Date.now() - at <= 2 * 60 * 60 * 1000));
      });
    } catch (_) { resolve(false); }
  });
}

// ── ヘルパー: ブレインか（popup.js の 🧠 ブレインの切り替えが chrome.storage.local.brainMode に持つ・TTL なし）──
// 2026-09-23 竹内「物件検索の拡張ツールでもブレインモードつくる」
// 2026-09-25 竹内「ブレインだけ別で、ほかはドロップダウン。ブレインでもスタッフモードや AIX モード、通常モードを行う」:
//   旧は「aixMode と brainMode が両方 true」の時だけ ON（ブレイン＝AIX連動＋判定）。新は **brainMode 単独で ON**。
//   旧「ブレイン」の値 {aixMode:true, brainMode:true} は新でも ON（＝ブレイン×AIX）なので、再読み込みしても動きは変わらない。
//   自動便（11:00/17:00・AIX）・AIXツールの一括検索（web_brain）の claim は _pollAndRunBatch が AxlxModeCore.behavior から読むので、ここは判定の有無だけ。
function isBrainModeOn() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(["brainMode"], (res) => {
        resolve(!!(res && res.brainMode));
      });
    } catch (_) { resolve(false); }
  });
}

// 2026-09-27 竹内「案Aでおこなう」: AIXツールのメモの上書き（web_brain の payload.search_override）で検索している間、
//   そのお客様の merge-pdfs に search_command_id（コマンドの id）を付ける＝サーバーがその回の判定も上書きで行う（search-override-link.ts）。
//   中身は送らない（サーバーがコマンドの行から引き直す）。_runBatchSearch が置き、呼び出し元（_pollAndRunBatch）の finally で必ず消す
var _searchOverrideLink = null; // { commandId, customerIds: [..] } | null

/** merge-pdfs に付ける search_command_id（上書きの検索の最中・同じお客様の時だけ） */
function _searchCommandIdFor(propertyCustomerId) {
  var l = _searchOverrideLink;
  if (!l || !propertyCustomerId) return null;
  return l.customerIds.indexOf(String(propertyCustomerId)) >= 0 ? l.commandId : null;
}

// 2026-09-27 竹内「まずピンポイント検索して、なければ広げて検索する形。検索結果はピンポイント検索で行ったか広げて検索を行ったかも
//   ちゃんと分かるようにする（ブレインモードの場合）」: 検索を始めた時に {お客様×サイト → ピンポイント／広げて} を残し（AxlxModeCore の覚え書き）、
//   送信（callMergeApi）が merge-pdfs に search_mode を付ける。残すのは _batchAutofill（一括・AIXツールの一括・手動の一括）と popup の _auditTag（個別の検索）
async function _rememberSearchMode(customerId, site, isWide) {
  try {
    var core = self.AxlxModeCore;
    if (!core || !core.rememberSearchMode || customerId == null) return;
    var key = core.SEARCH_MODE_MEMO_KEY;
    var st = await chrome.storage.local.get([key]);
    var o = {};
    o[key] = core.rememberSearchMode(st && st[key], String(customerId), site, !!isWide, Date.now());
    await chrome.storage.local.set(o);
  } catch (e) { console.warn("[search-mode] 覚え書きを残せない（検索は続ける）:", e && e.message); }
}
async function _searchModeFor(customerId, site) {
  try {
    var core = self.AxlxModeCore;
    if (!core || !core.pickSearchMode || customerId == null) return null;
    var key = core.SEARCH_MODE_MEMO_KEY;
    var st = await chrome.storage.local.get([key]);
    return core.pickSearchMode(st && st[key], String(customerId), site, Date.now());
  } catch (_) { return null; }
}

// ── 2026-11-10 送信の直列の待ち行列（竹内さん「複数の物件の場合つまったりしないか」）────────
//   1件ずつ押して送る時、複数の送信が同時に来ても **1本ずつ順番に** 流す。
//   中のリアプロのタブ・アップロード・merge-pdfs（サーバー）を取り合わない＝詰まらない。
//   1件が失敗（throw・時間切れ）しても次は流れる（1件の失敗で後の物件が送れなくなるのを防ぐ）。
//   ⚠ 応答（sendResponse）は必ず1回だけ。待ち行列の中で finally で呼ぶ。
var _lineSendQueue = [];
var _lineSendRunning = false;
/** 順番に1件流す。job(done) の形で渡す（done は 1回だけ呼ぶ） */
function _enqueueLineSend(job) {
  _lineSendQueue.push(job);
  if (_lineSendRunning) { console.log("[send-queue] 待ちに追加（いま" + _lineSendQueue.length + "件待ち）"); return; }
  _drainLineSend();
}
function _drainLineSend() {
  if (_lineSendRunning) return;
  var job = _lineSendQueue.shift();
  if (!job) return;
  _lineSendRunning = true;
  var finished = false;
  var next = function () {
    if (finished) return;
    finished = true;
    _lineSendRunning = false;
    // 次の1件（少し置いてから＝サイト・サーバーに続けて当たらない）
    if (_lineSendQueue.length) setTimeout(_drainLineSend, 600 + Math.floor(Math.random() * 700));
    else console.log("[send-queue] 送信の待ちは空になりました");
  };
  var timer = setTimeout(function () {
    console.warn("[send-queue] 1件の送信が 300秒 を超えた → 次へ進む（後の物件を止めない）");
    next();
  }, 300000);
  Promise.resolve()
    .then(function () { return job(); })
    .catch(function (e) { console.warn("[send-queue] 1件の送信でエラー（次へ進む）:", e && e.message); })
    .then(function () { clearTimeout(timer); next(); });
}

// ── ヘルパー: /api/merge-pdfs を background から呼ぶ（CSP/CORS 完全回避）──
async function callMergeApi(payload) {
  // 送信の3経路（リアプロ・itandi・レインズ）は全部ここを通るので、スタッフモードの判定もここで付ける
  const staffMode = await isStaffModeOn();
  // brain_mode はサーバーの記録用（判定そのものは bulk-dl.js が送信前に /api/property-brain/judge で行う）＝ 売上サポ（property_pickups）に1回分を残す。
  // 2026-09-25 竹内「ブレインでもスタッフモードを行う」: 旧はスタッフモード中は false に倒していたが、ブレイン×スタッフでも記録する
  //   （AxlxModeCore.behavior の recordPickup。staff_mode=true で送付済みの除外はしないまま。
  //    ★物件出し★への送り方は brain_mode で決まる: ブレインONなら deferred＝AIX解析後／ブレインOFFなら検索のたび）。
  //   サーバー（merge-pdfs）の brain_mode は記録＋group_notice、staff_mode は除外しない、と独立に効く。
  const brainMode = await isBrainModeOn();
  const searchCommandId = _searchCommandIdFor(payload && payload.property_customer_id);
  // 2026-09-27 この送信がピンポイントの検索か広げての検索か（ブレインの時だけ・分からない時は付けない＝サーバーは加点しない）
  const searchMode = brainMode && payload && payload.property_customer_id ? await _searchModeFor(payload.property_customer_id, payload.site) : null;
  // v2.5.49 物件の付け先の見張り（batch-guard.js sendOwner）: 一括の回が走っている間は、送る相手が「今そのサイトで検索している回のお客様」か照らす。
  //   違えば送らない（点検の段 owner_mismatch に残る＝サーバーの札 OWNER_MISMATCH）。相手が空なら回のお客様で送る。
  //   サーバー（merge-pdfs）にも回のお客様（batch_owner）を渡し、同じ照らしをもう一度させる（名前と ID の食い違いもそこで見る）
  let _own = null;
  try { _own = self.AxlxBatchGuard && self.AxlxBatchGuard.sendOwner ? self.AxlxBatchGuard.sendOwner(_batchWatch, _batchLoopAlive, payload && payload.site, payload && payload.property_customer_id) : null; } catch (_) { _own = null; }
  if (_own && _own.prev) {
    _auditStep(_auditOpenRunId(payload.property_customer_id, null), "owner_prev_ok",
      "次客 " + String(_own.ownerId).slice(0, 8) + " の回が待っている間の前客の送付→前客のまま送る");
  }
  if (_own && _own.batch && !_own.ok) {
    const _why = "送る相手 " + String(payload.property_customer_id).slice(0, 8) + "（" + (payload.customer_name || "名前なし") + "）が、検索している回のお客様 " + _own.ownerId.slice(0, 8) + "（" + (_own.ownerName || "名前なし") + "）と違う";
    console.warn("[owner] 送らない: " + _why);
    _auditStep(_own.runId, "owner_mismatch", _why);
    throw new Error("AXLX_OWNER_MISMATCH: " + _why);
  }
  if (_own && _own.batch && _own.fill) {
    _auditStep(_own.runId, "owner_fill", "送る相手が空だったので検索している回のお客様で送る");
    payload = { ...payload, property_customer_id: _own.ownerId, customer_name: payload.customer_name || _own.ownerName || null };
  }
  // 相手の ID は合っているが見出しの名前が違う（名前ずれ）→ 回のお客様の名前で送り、点検の段に残す
  if (_own && _own.batch && _own.ok && !_own.fill && self.AxlxBatchGuard.nameDrift && self.AxlxBatchGuard.nameDrift(_own.ownerName, payload.customer_name)) {
    _auditStep(_own.runId, "owner_name_drift", "見出しの名前「" + String(payload.customer_name).slice(0, 30) + "」が回のお客様「" + String(_own.ownerName).slice(0, 30) + "」と違う → 回のお客様の名前で送る");
    payload = { ...payload, customer_name: _own.ownerName };
  }
  const batchOwner = _own && _own.batch ? { customer_id: _own.ownerId, customer_name: _own.ownerName, run_id: _own.runId, command_id: _own.commandId } : null;
  // 2026-10-06 v2.5.78（⑯）2つ目の探し物（子の行・ゆいと（物置））: 子は会話を持たない → 送る相手が今の子なら親の会話（linked_conversation）を付ける。
  //   property_customer_id は子のまま（売上サポ・送付の記録は子の探し物として残る）。サーバーも親の会話で補う（customer-family.ts）
  try {
    if (payload && payload.property_customer_id && !payload.conversation_id) {
      const _cc = await chrome.storage.local.get(["current_customer_id", "current_conversation_id"]);
      if (_cc && _cc.current_conversation_id && String(_cc.current_customer_id) === String(payload.property_customer_id)) payload = { ...payload, conversation_id: String(_cc.current_conversation_id) };
    }
  } catch (_) {}
  const resp = await fetch("https://sumora-ai-ui.vercel.app/api/merge-pdfs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, staff_mode: staffMode, brain_mode: brainMode, ...(searchCommandId ? { search_command_id: searchCommandId } : {}), ...(searchMode ? { search_mode: searchMode } : {}), ...(batchOwner ? { batch_owner: batchOwner } : {}) }),
    signal: AbortSignal.timeout(85000), // Vercel maxDuration=90s より5s短く設定（旧60sだと多PDF時にクライアント側が先にタイムアウト）
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`サーバーエラー HTTP ${resp.status}: ${text.slice(0, 120)}`);
  }
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || "APIエラー");
  // 2026-09-25 v2.5.23 売上サポに届いた（ブレイン ON）お客様は、最後の送信から10分半後にまとめを頼む（10分の自動まとめ・下の _schedulePickupIdle）
  if (brainMode && payload && payload.property_customer_id) _schedulePickupIdle(String(payload.property_customer_id), 0);
  // 2026-09-27 v2.5.33 資料が売上サポに届いた → 送る画像（元の資料の1ページ目そのまま）をこのパソコンで先に作る（下の _runPrerender）
  _schedulePrerender(PRERENDER_AFTER_MERGE_MS);
  return data;
}

// ── 売上サポ: お客様に送る物件の画像をこのパソコンで先に作る（2026-09-27・v2.5.33）────────────────
// 竹内「なぜ送れないのか？画像をそのままの蓮産業の画像で保存していたらそのまま使える。ここちゃんとできるようにする」
//   リアプロの資料は MS ゴシックを埋め込んでいないので、元の見た目の画像は MS ゴシックのある所（このパソコンの Chrome）でしか作れない
//   （サーバー・iPhone では作らない決まり＝commit 02747cfc）。スマホで AIX を押すと「画像にできない」で止まっていた。
//   → 資料が届いた後（送信の90秒後）と10分おきに、裏の画面（chrome.offscreen）でウェブアプリの /pickup-prerender を開き、
//     画像の無い行（7日以内・未送信）を描いて property_pickups.trim_image_url に置かせる。スマホはその画像をそのまま使う。
//   先に数だけ聞き（認証なし・数だけ）、0件なら裏の画面は開かない。書体の確認は画面（renderOriginalPageInBrowser）がする。
//   リアプロ・itandi のサイトには触れない（Vercel Blob の写しの PDF を読むだけ）。お客様・LINE には何も送らない
var PRERENDER_ALARM = "axlx-prerender";
var PRERENDER_SWEEP_ALARM = "axlx-prerender-sweep";
var PRERENDER_CLOSE_ALARM = "axlx-prerender-close";
var PRERENDER_AFTER_MERGE_MS = 90 * 1000;
var PRERENDER_PAGE_URL = "https://sumora-ai-ui.vercel.app/pickup-prerender";
var PRERENDER_COUNT_URL = "https://sumora-ai-ui.vercel.app/api/property-pickups/prerender?count=1";
function _schedulePrerender(delayMs) {
  try { chrome.alarms.create(PRERENDER_ALARM, { when: Date.now() + Math.max(delayMs || 0, 1000) }); }
  catch (e) { console.warn("[AX] 送る画像の予約ができない（10分おきの見回りで作る）:", e && e.message); }
}
chrome.alarms.get(PRERENDER_SWEEP_ALARM, function (existing) {
  if (!existing) chrome.alarms.create(PRERENDER_SWEEP_ALARM, { delayInMinutes: 1, periodInMinutes: 10 });
});
async function _closePrerenderDoc() {
  try { if (chrome.offscreen && chrome.offscreen.closeDocument) await chrome.offscreen.closeDocument(); } catch (_) { /* 開いていない */ }
  try { chrome.alarms.clear(PRERENDER_CLOSE_ALARM); } catch (_) {}
}
async function _runPrerender(trigger) {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) return { skipped: "no_offscreen" };
  var count = 0;
  try {
    var r = await fetch(PRERENDER_COUNT_URL, { cache: "no-store", signal: AbortSignal.timeout(10000) });
    var j = await r.json();
    count = j && j.ok ? Number(j.count) || 0 : 0;
  } catch (e) { return { skipped: "count_failed", error: e && e.message }; }
  if (count === 0) return { skipped: "none" };
  try {
    await chrome.offscreen.createDocument({
      url: "prerender-offscreen.html?src=" + encodeURIComponent(PRERENDER_PAGE_URL + "?via=ext&t=" + Date.now()),
      reasons: ["IFRAME_SCRIPTING"],
      justification: "物件資料（PDF）を MS ゴシックで描いて、お客様に送る画像を先に作る"
    });
  } catch (e) {
    // 1つしか開けない＝前の回がまだ動いている
    return { skipped: "busy", error: e && e.message };
  }
  // 終わりの知らせ（axlx-prerender-done）が来なくても4分で閉じる
  chrome.alarms.create(PRERENDER_CLOSE_ALARM, { when: Date.now() + 4 * 60 * 1000 });
  console.log("[AX] 送る画像を作り始めた:", trigger, count + "件");
  return { started: true, count: count };
}
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (!alarm) return;
  if (alarm.name === PRERENDER_ALARM || alarm.name === PRERENDER_SWEEP_ALARM) {
    _runPrerender(alarm.name === PRERENDER_ALARM ? "after_merge" : "sweep").catch(function (e) { console.warn("[AX] 送る画像を作れない:", e && e.message); });
  } else if (alarm.name === PRERENDER_CLOSE_ALARM) {
    _closePrerenderDoc();
  }
});
chrome.runtime.onMessage.addListener(function (msg, sender) {
  if (!msg || msg.type !== "axlx-prerender-done") return;
  // 裏の画面（この拡張の中）からだけ受ける
  if (!sender || sender.id !== chrome.runtime.id) return;
  var res = msg.result || {};
  console.log("[AX] 送る画像を作った:", JSON.stringify(res));
  try { chrome.storage.local.set({ lastPrerender: { at: new Date().toISOString(), result: res } }); } catch (_) {}
  _closePrerenderDoc();
});

// ── 売上サポ: 10分の自動まとめ（2026-09-25・v2.5.23）──────────────────────────────
// 竹内「毎回完了おすよりも最後にスタッフモードで指定したお客さん（例 yuma さん物件完了後）10分たてば自動的に送られた物件まとめて、
//   ほかの一括検索や自動モードのときのようにまとめて判定する」
// 送信（callMergeApi・ブレイン ON）のたびに、そのお客様の alarm を「今から10分半後」に置き直す（同じ名前＝前の alarm は置き換わる＝最後の送信から数える）。
// 鳴ったら /api/property-pickups/complete に idle:true で頼む。10分を数えるのはサーバー（売上サポに届いた時刻 created_at から）で、
// まだなら not_due と due_at が返る → その時刻の30秒後に置き直す。
// ここは「PC が付いている間に早くまとめる」ための物で、本体はサーバーの Cron（/api/cron/pickup-auto-complete・2分おき）。
// PC が消えた・alarm が消えた・ブレインを OFF にした時も Cron がまとめる（同じまとめ ID で冪等＝二重にまとまらない）。
var PICKUP_IDLE_ALARM_PREFIX = "axlx-pickup-idle:";
var PICKUP_IDLE_DELAY_MS = 10.5 * 60 * 1000;
function _schedulePickupIdle(propertyCustomerId, whenMs) {
  try {
    var when = whenMs && whenMs > Date.now() + 30000 ? whenMs : Date.now() + PICKUP_IDLE_DELAY_MS;
    chrome.alarms.create(PICKUP_IDLE_ALARM_PREFIX + propertyCustomerId, { when: when });
  } catch (e) { console.warn("[AX] 売上サポの自動まとめを予約できない（サーバーの Cron がまとめる）:", e && e.message); }
}
chrome.alarms.onAlarm.addListener(async function(alarm) {
  if (!alarm || typeof alarm.name !== "string" || alarm.name.indexOf(PICKUP_IDLE_ALARM_PREFIX) !== 0) return;
  var pcid = alarm.name.slice(PICKUP_IDLE_ALARM_PREFIX.length);
  if (!pcid) return;
  try {
    var d = await callPickupsComplete(pcid, "idle", { idle: true });
    if (d && d.not_due && d.due_at) {
      var dueMs = Date.parse(d.due_at);
      _schedulePickupIdle(pcid, isFinite(dueMs) ? dueMs + 30000 : 0);
    }
  } catch (e) {
    console.warn("[AX] 売上サポの自動まとめに失敗（サーバーの Cron がまとめる）:", e && e.message);
  }
});

// ── 物件検索ブレインの判定（2026-09-23）──────────────────────────────────────
// bulk-dl.js（ブレインモード）が送信前に呼ぶ。content script からは CSP で直接 fetch できないので background 経由。
// 失敗・タイムアウトは { ok:false } を返し、呼び出し側は今までどおり全件送る（fail-open）。
async function callBrainJudgeApi(payload) {
  const resp = await fetch("https://sumora-ai-ui.vercel.app/api/property-brain/judge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000), // 判定 API の maxDuration=30s（画像の読み取り込み）
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`ブレイン判定 HTTP ${resp.status}: ${text.slice(0, 120)}`);
  }
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || "ブレイン判定エラー");
  return data;
}

// ── 売上サポ: お客様の作業を終えた時に回をまとめる（2026-09-25・v2.5.22）──────────────
// 竹内「スタッフモードで送った時は、拡張ツールはお客さんのところ完了ボタン押したら、リアプロと itandi の全部分析されるようにする」
// popup.js（一覧の「確認」☑／リアプロの「✅ 送った」）→ ここ → /api/property-pickups/complete。
// 呼ぶかどうかは AxlxModeCore.behavior の completeGroup（＝ブレイン ON。スタッフ・通常・AIX のどれでも）。ブレイン OFF は呼ばない。
// サーバーはまとめ ID を付けたらすぐ返す（読み取り・順位・👑 は後ろ）。二重押し・2台の PC でもサーバーが冪等にする。
// opts.idle（v2.5.23）: 10分の自動まとめ。サーバーは最後に届いた行から10分経っていなければまとめず not_due・due_at を返す
async function callPickupsComplete(propertyCustomerId, trigger, opts) {
  const raw = await new Promise((resolve) => {
    try { chrome.storage.local.get(["staffMode", "staffModeAt", "aixMode", "brainMode"], (res) => resolve(res || {})); } catch (_) { resolve({}); }
  });
  const core = self.AxlxModeCore;
  const st = core ? core.readState(raw, Date.now()) : { mode: "normal", brain: !!raw.brainMode };
  const bh = core ? core.behavior(st.mode, st.brain) : { completeGroup: !!raw.brainMode };
  if (!bh.completeGroup) return { ok: true, skipped: "brain_off", claimed: 0, toast: "" };
  const authHeader = await _getAutomationKeyHeader();
  const resp = await fetch("https://sumora-ai-ui.vercel.app/api/property-pickups/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader },
    body: JSON.stringify({ property_customer_id: propertyCustomerId, brain: true, mode: st.mode, trigger: trigger || "manual", idle: !!(opts && opts.idle) }),
    signal: AbortSignal.timeout(20000), // まとめ ID を付けるだけ（数百ms）。読み取りはサーバーの後ろ
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`売上サポのまとめ HTTP ${resp.status}: ${text.slice(0, 120)}`);
  }
  return await resp.json();
}

// ── メッセージハンドラ ─────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── 売上サポ: お客様の作業を終えた時に回をまとめる（popup.js → background → /api/property-pickups/complete）──
  if (msg.type === "axlx-pickups-complete") {
    (async () => {
      try {
        if (!msg.property_customer_id) { sendResponse({ ok: false, error: "お客様がありません" }); return; }
        const data = await callPickupsComplete(String(msg.property_customer_id), msg.trigger || null);
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    })();
    return true;
  }

  // ── 物件検索ブレインの判定（bulk-dl.js → background → /api/property-brain/judge）──
  if (msg.type === "axlx-brain-judge") {
    (async () => {
      try {
        const staffMode = await isStaffModeOn();
        const data = await callBrainJudgeApi({
          property_customer_id: msg.property_customer_id || null,
          items: msg.items || [],
          site: msg.site || "realpro",
          staff_mode: staffMode, // スタッフモード中はサーバーが apply_drop=false（人が選んだ物は減らさない）
          // 2026-10-01 一覧の下見（bulk-dl brainPreview）: 記録も画像の読み取りもしない（judge の dry_run）
          ...(msg.dry_run === true ? { dry_run: true } : {}),
        });
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    })();
    return true;
  }

  // ── レインズ新タブ監視開始 ───────────────────────────────────────────────
  if (msg.type === "axlx-reins-watch-tab") {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false }); return true; }
    // 既存watcherの旧タイマーを解除（逐次モードで旧タイマーが新watcherを削除するレース防止）
    const existing = reinsTabWatchers.get(tabId);
    if (existing) clearTimeout(existing.timerId);
    const timerId = setTimeout(() => reinsTabWatchers.delete(tabId), 35000);
    reinsTabWatchers.set(tabId, { senderTabId: tabId, timerId });
    console.log("[AXLX BG] 新タブ監視開始 tabId=" + tabId);
    sendResponse({ ok: true });
    return true;
  }

  // ── itandi: ダウンロード監視開始（JSフック失敗時フォールバック）────────────
  if (msg.type === "axlx-itandi-watch-download") {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false }); return true; }
    itandiWatchExpiry      = Date.now() + 30000;
    itandiWatchOriginalTab = tabId;
    console.log("[AXLX BG] itandi DL watch開始 originalTabId=" + tabId);
    sendResponse({ ok: true });
    return true;
  }

  // ── itandi CSP回避: MAIN worldにPDFキャプチャフックを注入 ─────────────────
  // <script>タグ注入はCSPでブロックされるため chrome.scripting.executeScript を使う
  if (msg.type === "axlx-inject-pdf-hook") {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false }); return true; }
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, // ← iframe内も注入（レインズはiframe内でPDFを処理）
      world: "MAIN",
      func: () => {
        // v3: window.open抑制 + XHRフック追加（レインズ対応）
        // v2フックが入っていても v3は別フラグで追加注入する
        if (!window.__axlxItandiHookV2) {
          window.__axlxItandiHookV2 = true;
          window.__axlxCapturePending = false;

          // axlx-start-pdf-capture シグナルを受信してcapturePendingを再セット
          // 自分自身のwindowで常に受信（content scriptからのiframe直接broadcastに対応）
          window.addEventListener("message", function (e) {
            if (e.data && e.data.from === "axlx-start-pdf-capture") {
              window.__axlxCapturePending = true;
            }
          });
          // 同一オリジンのiframe: window.topのメッセージも受信（追加保護）
          try {
            if (window.top && window.top !== window) {
              window.top.addEventListener("message", function (e) {
                if (e.data && e.data.from === "axlx-start-pdf-capture") {
                  window.__axlxCapturePending = true;
                }
              });
            }
          } catch (_ce) {} // cross-origin: own window listener が機能する

          // Blob URL フック（createObjectURL でPDFを作る場合）
          const origCreate = URL.createObjectURL;
          URL.createObjectURL = function (blob) {
            const url = origCreate.call(URL, blob);
            const t = (blob && blob.type) || "";
            // 診断: capturePending時 or PDF/octetのblob作成を全てログ
            if (window.__axlxCapturePending || t.includes("pdf") || t.includes("octet-stream")) {
              console.log("[AXLX DIAG] createObjectURL:", t || "(empty)", Math.round(blob.size / 1024) + "KB", "pending:", window.__axlxCapturePending);
            }
            // PDF判定: 明示的なPDF/octetタイプ OR capturePending中の空タイプ大きめblob（≥30KB = itandi PDFの最小サイズ）
            const isPdfBlob = t.includes("pdf") || t.includes("octet-stream") || (!t && blob.size >= 30000);
            if (isPdfBlob && window.__axlxCapturePending) {
              window.__axlxCapturePending = false;
              window.__axlxLastBlobUrl = url; // window.open 抑制用に URL を保存
              console.log("[AXLX V2] PDF blob captured:", Math.round(blob.size / 1024) + "KB");
              const r = new FileReader();
              r.onload = (ev) => {
                const b64 = ev.target.result.split(",")[1];
                const ts  = Date.now();
                console.log("[AXLX V2] FileReader完了 → 送信 " + Math.round(b64.length / 1024) + "KB (iframe=" + (window !== window.top) + ")");
                const payload = { from: "axlx-itandi-pdf", b64, ts };
                // トップレベルwindowに送信（iframeからでも届く）
                const _top = window.top || window;
                _top.postMessage(payload, "*");
                // フォールバック: トップレベルdocumentにCustomEvent
                try {
                  const _doc = _top.document || document;
                  _doc.dispatchEvent(new CustomEvent("axlx-pdf-ready", { detail: payload, bubbles: false }));
                } catch (err) {
                  console.error("[AXLX V2] CustomEvent error:", err);
                }
              };
              r.onerror = (err) => console.error("[AXLX V2] FileReader エラー:", err);
              r.readAsDataURL(blob);
            }
            return url;
          };

          // fetch フック（application/pdf を直接返す場合）
          const origFetch = window.fetch;
          window.fetch = function (...args) {
            return origFetch.apply(this, args).then((resp) => {
              const ct = resp.headers.get("content-type") || "";
              if ((ct.includes("application/pdf") || ct.includes("application/octet-stream")) && window.__axlxCapturePending) {
                window.__axlxCapturePending = false;
                resp.clone().arrayBuffer().then((buf) => {
                  const bytes = new Uint8Array(buf);
                  const chunks = [];
                  for (let i = 0; i < bytes.length; i += 8192) {
                    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
                  }
                  (window.top || window).postMessage({ from: "axlx-itandi-pdf", b64: btoa(chunks.join("")), ts: Date.now() }, "*");
                });
              }
              return resp;
            });
          };
        }

        // v3: window.open フック（レインズがblobURLの新タブを開くのを抑制）
        // 新タブが開くと後続のクリックがフォーカスの問題で機能しなくなるため抑制
        if (!window.__axlxOpenHookV3) {
          window.__axlxOpenHookV3 = true;
          const origOpen = window.open;
          window.open = function (...args) {
            const url = String(args[0] || "");
            // 診断: 全window.open呼び出しをログ
            console.log("[AXLX DIAG] window.open:", url.slice(0, 80), "| target:", args[1], "| pending:", window.__axlxCapturePending);
            // ケース1: createObjectURLで既にキャプチャ済みのblob URL → 抑制のみ
            // createObjectURL後はcapturePending=falseになるため別フラグで判定する
            if (url && url === window.__axlxLastBlobUrl) {
              window.__axlxLastBlobUrl = null;
              console.log("[AXLX V3] window.open 抑制（キャプチャ済みblob）:", url.slice(0, 40));
              return null;
            }
            // ケース2: capturePending=true で blob: URL → 抑制 + blob fetchでキャプチャ
            if (window.__axlxCapturePending && url.startsWith("blob:")) {
              console.log("[AXLX V3] window.open 抑制 + blob fetch:", url.slice(0, 60));
              // blob:URLはそのままfetchで取得（同一オリジンのため可能）
              fetch(url).then(r => r.arrayBuffer()).then(buf => {
                if (!window.__axlxCapturePending) return; // createObjectURL側が先にキャプチャした場合はスキップ
                window.__axlxCapturePending = false;
                const bytes = new Uint8Array(buf);
                const chunks = [];
                for (let i = 0; i < bytes.length; i += 8192) {
                  chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
                }
                (window.top || window).postMessage({ from: "axlx-itandi-pdf", b64: btoa(chunks.join("")), ts: Date.now() }, "*");
              }).catch(e => console.error("[AXLX V3] blob fetch error:", e));
              return null;
            }
            // ケース3: capturePending=true でHTTPS URL → パススルー
            // background.jsのitandiWatchExpiry（時刻ベース）がchrome.downloads.onCreatedで捕捉する
            // 旧設計: MAIN worldからfetch＋window.open抑制 → CDN/S3 CORSで失敗しDLイベントも消えるバグあり
            if (window.__axlxCapturePending && (url.startsWith("https:") || url.startsWith("http:"))) {
              console.log("[AXLX V3] window.open HTTPS パススルー（DLウォッチャーに委譲）:", url.slice(0, 80));
              window.__axlxCapturePending = false; // 二重捕捉防止
              return origOpen.apply(this, args);   // ブラウザの自然なDLを発生させる
            }
            return origOpen.apply(this, args);
          };

          // XHR フック（fetchを使わずXHRでPDFを取得する場合）
          const origXHROpen = XMLHttpRequest.prototype.open;
          const origXHRSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function (method, url) {
            this._axlxUrl = url;
            return origXHROpen.apply(this, arguments);
          };
          XMLHttpRequest.prototype.send = function () {
            if (window.__axlxCapturePending) {
              // ⚠️ responseType を変更しない: itandi の XHR が responseText を読めなくなり
              // InvalidStateError が発生してボタンが壊れるため（2026-06-04 根本原因特定）
              var _self = this;
              var _savedType = this.responseType;
              this.addEventListener("load", function () {
                if (!window.__axlxCapturePending) return;
                const ct = _self.getResponseHeader("content-type") || "";
                if (!ct.includes("pdf") && !ct.includes("octet")) return;
                window.__axlxCapturePending = false;
                const _sendPdf = (b64) => (window.top || window).postMessage({ from: "axlx-itandi-pdf", b64, ts: Date.now() }, "*");
                if (_savedType === "blob" && _self.response) {
                  const r = new FileReader();
                  r.onload = (e) => _sendPdf(e.target.result.split(",")[1]);
                  r.readAsDataURL(_self.response);
                  return;
                }
                if (_savedType === "arraybuffer" && _self.response) {
                  const bytes = new Uint8Array(_self.response);
                  const chunks = [];
                  for (let i = 0; i < bytes.length; i += 8192) {
                    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
                  }
                  _sendPdf(btoa(chunks.join("")));
                  return;
                }
                // responseType="" or "text" の場合: URL を再 fetch してバイナリ取得
                var _url = _self._axlxUrl;
                if (_url) {
                  fetch(_url).then(function(r) { return r.arrayBuffer(); }).then(function(buf) {
                    var bytes = new Uint8Array(buf);
                    var chunks = [];
                    for (var i = 0; i < bytes.length; i += 8192) {
                      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
                    }
                    _sendPdf(btoa(chunks.join("")));
                  }).catch(function(e) { console.error("[AXLX XHR] re-fetch error:", e); });
                }
              });
            }
            return origXHRSend.apply(this, arguments);
          };
        }

        // <a download> フック（URLを直接ダウンロードする場合をキャプチャ）
        // 2パターン対応:
        //   (A) DOM上のアンカー要素をクリック → document の capture-phase click で捕捉
        //   (B) detached anchor の .click() → HTMLAnchorElement.prototype.click を上書き
        if (!window.__axlxAnchorHookV1) {
          window.__axlxAnchorHookV1 = true;

          function _axlxFetchAndSend(href) {
            window.__axlxCapturePending = false;
            console.log("[AXLX] anchor captured:", href.slice(0, 60));
            fetch(href).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
              var bytes = new Uint8Array(buf);
              var chunks = [];
              for (var i = 0; i < bytes.length; i += 8192) {
                chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
              }
              var b64 = btoa(chunks.join(""));
              var payload = { from: "axlx-itandi-pdf", b64: b64, ts: Date.now() };
              (window.top || window).postMessage(payload, "*");
              try {
                var _doc = (window.top || window).document || document;
                _doc.dispatchEvent(new CustomEvent("axlx-pdf-ready", { detail: payload }));
              } catch (e) { console.error("[AXLX] anchor CustomEvent:", e); }
            }).catch(function (e) { console.error("[AXLX] anchor fetch error:", e); });
          }

          // (A) DOM上のアンカークリック
          document.addEventListener("click", function (ev) {
            if (!window.__axlxCapturePending) return;
            var el = ev.target;
            while (el && el !== document && el.tagName !== "A") el = el.parentElement;
            if (!el || !el.getAttribute) return;
            if (el.getAttribute("download") === null) return;
            var href = el.href || "";
            if (!href || href.startsWith("javascript:")) return;
            ev.preventDefault();
            ev.stopPropagation();
            _axlxFetchAndSend(href);
          }, true);

          // (B) detached anchor の .click()（DOM外から呼ばれてもキャプチャ）
          // blob: URL も fetch で取得可能（同一オリジン）なので除外しない
          var _origAnchorClick = HTMLAnchorElement.prototype.click;
          HTMLAnchorElement.prototype.click = function () {
            if (window.__axlxCapturePending && this.getAttribute("download") !== null) {
              var href = this.href || "";
              if (href && !href.startsWith("javascript:")) {
                _axlxFetchAndSend(href);
                return; // ブラウザのダウンロードを抑制
              }
            }
            return _origAnchorClick.apply(this, arguments);
          };
        }

        // capturePending は axlx-start-pdf-capture メッセージで true にセット
        // 注入時の自動 ON は廃止: 常時 ON だと itandi の全 XHR に干渉してボタンを壊すため
        console.log("[AXLX] PDF hook ready. capturePending = false (waiting for axlx-start-pdf-capture)");
      },
    }).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── LINE送信: 全件を1つのPDFに結合してURLで送信 ──────────────────────────
  // 2026-11-10 竹内さん「複数の物件の場合つまったりしないか」:
  //   送信（資料の取得→アップロード→merge-pdfs→LINE）を **1本の直列の待ち行列** にした。
  //   複数の 1件送信が同時に来ても、中のリアプロのタブ・アップロード・サーバーが取り合いにならない（順番に流す）。
  //   前の1件が失敗しても次は流れる（1件の失敗で後の物件が送れなくなるのを防ぐ）。
  if (msg.type === "axlx-send-to-line") {
    _enqueueLineSend(async () => {
      try {
        const { urls, customer_name, property_summaries, customer_conditions, site, property_pool, customer_id } = msg;
        const today = new Date().toLocaleDateString("ja-JP").replace(/\//g, "-");
        // 2026-10-01 資料はリアプロのタブの中で取って一時置き場へ（ログイン情報をサーバーに渡さない・realproPdfsToBlobUrls）
        const up = await realproPdfsToBlobUrls(sender, urls, `物件まとめ_${today}`, customer_id);
        const keepAt = (arr) => (Array.isArray(arr) && arr.length === urls.length ? up.keptIdx.map((i) => arr[i]) : arr);

        // fire-and-forget: 物件候補プールを学習ループ用APIに記録
        if (property_pool && property_pool.length > 0) {
          fetch("https://sumora-ai-ui.vercel.app/api/log-property-candidates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              property_customer_id: customer_id || null,
              customer_name: customer_name || null,
              site: site || "realpro",
              candidates: property_pool,
            }),
          }).catch(function() {});
        }

        const data = await callMergeApi({
          // v2.5.81 この一覧を検索した時の条件（search-stamp.js・タブの印）→ 売上サポの回（property_pickups.search_conditions）に残す
          search_stamp: msg.search_stamp || null,
          pdf_urls: up.blobUrls,
          // 元のリアプロの資料の場所（送付済みの照合・売上サポの資料リンク用。サーバーは取りに行かない）
          source_pdf_urls: keepAt(urls),
          cookie_str: "",
          file_name: `物件まとめ_${today}.pdf`,
          send_to_line: true,
          customer_name: customer_name || null,
          property_summaries: keepAt(property_summaries) || null,
          customer_conditions: customer_conditions || null,
          site: site || null,
          // 2026-09-20 竹内「物件ピックアップから送る物件もテーブルかクエリで保管したら、
          //   どれが物件ピックアップで送った物件かも理解できる」:
          //   merge-pdfs は受け取った property_customer_id を sent_properties に入れるが、
          //   ここが渡していなかったため **直近180日の 14,129件（全体の91%）が「誰に送ったか」不明**で記録されていた
          //   （会話にも物件顧客にも紐付かず、ブレインも文生成も読めない）。customer_id は既にこの関数が
          //   受け取っていて log-property-candidates には渡していたので、同じ値をそのまま渡す。
          property_customer_id: customer_id || null,
          // 2026-09-29 v2.5.41 このページで送付済みの部屋として選ばなかった数（★物件出し★の本文に1行・ページの最初の束だけ）
          ext_sent_skipped: msg.sent_skipped || null,
        });

        sendResponse({ ok: true, line_sent: !!data.line_sent, url: data.url, from_cache: up.fromCache || 0,
          // 2026-10-01 送付済みで外した件数と知らせ（merge-pdfs）・全部が送付済みだった回
          excluded_count: data.excluded_count || 0, excluded: data.excluded || "", all_already_sent: !!data.all_already_sent });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    });
    return true;
  }

  // ── itandi用: キャプチャ済みpdf_dataをBlobにアップ→URL取得→まとめてmerge ──
  // 旧: pdf_dataを全件まとめて送信 → 413エラー
  // 新: 1件ずつBlobアップ(binary送信)でURL取得 → URLだけmerge-pdfsに渡す → リアプロと同じ仕組み
  if (msg.type === "axlx-send-pdf-data-to-line") {
    (async () => {
      try {
        const today = new Date().toLocaleDateString("ja-JP").replace(/\//g, "-");
        const baseName = (msg.file_name || `物件まとめ_${today}`).replace(/\.pdf$/, "");

        // fire-and-forget: 物件候補プールを学習ループ用APIに記録
        // 2026-09-25 竹内「候補の記憶を太くする」: 資料の URL（Blob）も候補に残すため、アップロードの後に記録する。
        //   pdf_data と property_pool は同じ組（sendItems）から同じ順で作られている（itandi-bulk-dl.js）ので i 番目どうしが同じ物件。
        //   件数が合わない時は URL を付けない（位置でずらして別の物件の URL を付けない）。アップロードが途中で失敗しても記録は残す（URL なし）
        let _poolLogged = false;
        const logPool = (urls) => {
          if (_poolLogged || !msg.property_pool || !msg.property_pool.length) return;
          _poolLogged = true;
          const sameLen = Array.isArray(urls) && urls.length === msg.property_pool.length;
          const cands = msg.property_pool.map((c, i) => (sameLen && urls[i] && !c.pdf_url ? Object.assign({}, c, { pdf_url: urls[i] }) : c));
          fetch("https://sumora-ai-ui.vercel.app/api/log-property-candidates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              property_customer_id: msg.customer_id || null,
              customer_name: msg.customer_name || null,
              site: msg.site || "itandi",
              candidates: cands,
            }),
          }).catch(function() {});
        };

        // Step1: 1件ずつVercel BlobにアップロードしてURLを収集
        const blobUrls = [];
        try {
        for (let i = 0; i < msg.pdf_data.length; i++) {
          const name = `${baseName}_${i + 1}.pdf`;
          const url = await uploadWithRetry(msg.pdf_data[i], name);
          blobUrls.push(url);
          // 進捗ハートビート: itandi多物件のBlobアップは数分かかるため無進捗タイムアウトを延長
          try { _notifyBatchProgress(msg.customer_id || null); } catch (_) {}  // M10修正: null→customer_id で別顧客タイマーの誤延長を防ぐ
          // タブにアップロード進捗を通知（ボタンテキスト更新のため）
          if (sender.tab?.id) {
            chrome.tabs.sendMessage(sender.tab.id, {
              type: "axlx-blob-upload-progress",
              current: i + 1,
              total: msg.pdf_data.length,
            }).catch(() => {});
          }
        }
        } finally {
          // 全件上がれば URL 付き・途中で失敗すれば URL なしで記録（logPool の中で件数を見る）
          logPool(blobUrls);
        }

        // Step2: URLでまとめてmerge → LINE送信（リアプロと同じ仕組み）
        const data = await callMergeApi({
          search_stamp:        msg.search_stamp || null, // v2.5.81 この一覧を検索した時の条件（ITANDI）
          pdf_urls:            blobUrls,
          cookie_str:          "",   // 公開Blob URLはcookie不要
          file_name:           `${baseName}.pdf`,
          send_to_line:        true,
          customer_name:       msg.customer_name || null,
          property_summaries:  msg.property_summaries || null,
          customer_conditions: msg.customer_conditions || null,
          site:                msg.site || null,
          // 2026-09-20: リアプロ経路と同じ（上のコメント参照）。msg.customer_id は進捗通知で既に使っている値
          property_customer_id: msg.customer_id || null,
          // 2026-09-29 v2.5.41 このページで送付済みの部屋として選ばなかった数（★物件出し★の本文に1行）
          ext_sent_skipped: msg.sent_skipped || null,
        });
        sendResponse({ ok: true, line_sent: !!data.line_sent, url: data.url });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // ── キャッシュ確認（v2.5.59）────────────────────────────────────────────────
  // 2026-10-01 竹内「人が『印刷用PDF』を押して画面で開いた時の動きにすれば問題ない可能性高い」「それで一度試す」:
  //   人が押して開いた資料は、その1回でブラウザが手元（HTTP キャッシュ）に取っておくことがある。
  //   cache: "only-if-cached" は手元に無ければリアプロに行かずに失敗する指定（＝この確認でリアプロには何も届かない）。
  //   手元に残るか（リアプロの Cache-Control 次第）を実物で確かめるための口。送信の道（realproPdfsToBlobUrls）はまだ変えない
  if (msg.type === "axlx-cache-probe") {
    (async () => {
      try {
        const tabId = await _realproTabFor(sender);
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          args: [Array.isArray(msg.urls) ? msg.urls.slice(0, 200) : []],
          func: async (list) => {
            const out = [];
            for (const u of list) {
              let sameOrigin = false;
              try { sameOrigin = new URL(u, location.href).origin === location.origin; } catch (_) {}
              if (!sameOrigin) { out.push({ url: u, ok: false, error: "origin", note: "画面と資料のアドレスの場所が違う（" + location.origin + "）" }); continue; }
              try {
                const r = await fetch(u, { cache: "only-if-cached", mode: "same-origin", credentials: "include" });
                const ct = r.headers.get("content-type") || "";
                const buf = await r.arrayBuffer();
                out.push({ url: u, ok: r.ok && !ct.includes("text/html"), status: r.status, type: ct, bytes: buf.byteLength,
                  cacheControl: r.headers.get("cache-control") || "", expires: r.headers.get("expires") || "", pragma: r.headers.get("pragma") || "" });
              } catch (e) {
                out.push({ url: u, ok: false, error: "not_cached", note: String((e && e.message) || e) });
              }
            }
            return out;
          },
        });
        sendResponse({ ok: true, results: (res && res.result) || [] });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // ── PDF結合ダウンロード ───────────────────────────────────────────────────
  // 2026-10-01 案内モード（realpro-guide.js）: 一覧で隠すため、そのお客様に送付済みの部屋を読む（サーバーの記録を読むだけ・サイトには触らない）。
  //   一括の _loadSentRooms と違い、スタッフモードでも読む（竹内「一度送ったことある物件などは出ないようにする。監視画面が判断する形で」）
  // 2026-10-01 竹内「建物ごとはずすってのはみたら分かる状態になっているのかな？」: 一覧の行を送ったらサーバーが送付済みとして外すかを聞く
  //   （判定は merge-pdfs と同じ関数・/api/automation/sent-check。サーバーの記録を読むだけ・サイトには触らない）
  if (msg.type === "axlx-guide-sent-check") {
    (async () => {
      try {
        const headers = Object.assign({ "Content-Type": "application/json" }, await _getAutomationKeyHeader());
        const res = await fetch(SUMORA_BATCH_API + "/api/automation/sent-check", {
          method: "POST", headers, signal: AbortSignal.timeout(8000),
          body: JSON.stringify({ customer_id: String(msg.customerId || ""), rows: Array.isArray(msg.rows) ? msg.rows.slice(0, 300) : [] }),
        });
        const j = res.ok ? await res.json() : null;
        sendResponse({ ok: !!(j && j.ok), dropped: j && Array.isArray(j.dropped) ? j.dropped : [] });
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message });
      }
    })();
    return true;
  }

  // 2026-10-06 v2.5.84 案内（光って選択）の駅の手順で「見つからない駅」（realpro-guide.js／v2.5.85 itandi-guide.js の reportStationMiss）。
  //   ①拡張の中に最新 50回（axlx_guide_station_miss_log・ブレインでない時もここだけは残る）
  //   ②ブレインの回（popup が run_id を作った回）は search_audits の filled.guide_stations に（案内モードは拡張が入力しない＝filled は他に使われない）
  //   集計は scripts/audit-guide-station-miss.ts
  //
  // 2026-11-10 案内モードの「実際に入った値」（realpro-guide.js／itandi-guide.js の reportFilledForm）。
  //   拡張の入力の中だけで audit.form を読んでいたため、案内モード（入力しない）では search_audits.filled.form が
  //   10/05 からほぼ0件だった。スタッフが検索を押した時に案内の側が読んで、ここへ来る。
  //   search_audits.filled に form・intended・guide_stations を入れる（phase=started の口を使い回す＝新しい表・列は要らない）。
  if (msg.type === "axlx-guide-filled") {
    (async () => {
      try {
        const _site = (msg.site === "itandi") ? "itandi" : "realpro";
        const runId = msg.runId ? String(msg.runId) : null;
        if (!runId) { sendResponse({ ok: false, error: "runId なし" }); return; }
        const filled = { v: 1, site: _site, form: msg.form || null };
        if (msg.guide_stations) filled.guide_stations = msg.guide_stations;
        // 2026-11-10 竹内「人間が動いているか確認もできるように」: 人の押した・打った・動かした数（点検の記録に残す）
        if (msg.human && typeof msg.human === "object") filled.human = msg.human;
    /**
     * ★ 2026-11-15 竹内さん「学んだ『押す位置』を自動モードが実際に使っているか未検証」:
     *   **学んだ位置を狙ったか（狙えなかった理由も）**を点検に残す。
     *   ⚠ これで「学習が効いているか」を数字で確かめられる。
     *   ⚠ 中身は欄の名前と座標だけ（入力した値は入れない）。
     */
    if (Array.isArray(msg.aim_used) && msg.aim_used.length) filled.aim_used = msg.aim_used.slice(-20);
        // 2026-11-10 竹内「人と自動の動きの差」: 人の操作の時刻（自動の ops と同じ形・人と自動を比べる材料）
        if (Array.isArray(msg.ops) && msg.ops.length) filled.ops = msg.ops.slice(-80);
        const body = { phase: "started", brain: true, run_id: runId, site: _site, filled: filled };
        // 2026-11-10 v2.6.19 竹内さん「ここ1ヶ月は実際にスタッフが動かしている」:
        //   人が動いた記録（filled.human / ops の by=human）は**ブレインでない回でも**残す。
        //   ブレインの回（点検・判定の対象）は今まで通り brain: true。人だけの記録は brain: false で送り、
        //   サーバーが「人の学習用の行」として受ける（点検の判定は走らせない）。
        const _humanOnly = msg.brain === false || msg.humanOnly === true;
        if (_humanOnly) body.brain = false;
        if (msg.trigger) body.trigger = msg.trigger;
        if (msg.customerId) body.property_customer_id = String(msg.customerId);
        if (msg.intended && typeof msg.intended === "object") body.intended = msg.intended;
        const posted = self.AxlxSearchAudit ? await self.AxlxSearchAudit.post(body) : null;
        // ★ 2026-11-18 F9/F18: 案内モードで人が検索を押した回（brain:true）は結果読込が無いためここで閉じて abandoned を防ぐ
        if (!_humanOnly && self.AxlxSearchAudit && posted && posted.ok) {
          try {
            await self.AxlxSearchAudit.post({
              phase: "finished",
              brain: true,
              run_id: runId,
              site: _site,
              steps: [{ k: "guide_search_click", d: "案内モードで人が検索を実行", at: Date.now() }],
            });
          } catch (_) {}
        }
        sendResponse({ ok: !!(posted && posted.ok), posted: posted });
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message });
      }
    })();
    return true;
  }
  if (msg.type === "axlx-guide-station-miss") {
    (async () => {
      try {
        const rec = Object.assign({}, msg.record || {}, { customer_id: msg.customerId || null, run_id: msg.runId || null });
        await new Promise((res) => chrome.storage.local.get(["axlx_guide_station_miss_log"], (r) => {
          const log = Array.isArray(r && r.axlx_guide_station_miss_log) ? r.axlx_guide_station_miss_log : [];
          log.push(Object.assign({}, rec, { page_labels: undefined }));
          chrome.storage.local.set({ axlx_guide_station_miss_log: log.slice(-50) }, res);
        }));
        let posted = null;
        if (msg.runId && self.AxlxSearchAudit) {
          // v2.5.85 ITANDI も同じ形（record.site）
          const _site = (msg.record && msg.record.site === "itandi") ? "itandi" : "realpro";
          posted = await self.AxlxSearchAudit.post({ phase: "started", brain: true, run_id: String(msg.runId), site: _site, filled: { v: 1, site: _site, guide_stations: msg.record || null } });
        }
        if (msg.record && msg.record.missing && msg.record.missing.length) console.warn("[guide] 見つからない駅 " + msg.record.missing.length + ": " + msg.record.missing.slice(0, 10).join("・"));
        sendResponse({ ok: true, posted: posted });
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message });
      }
    })();
    return true;
  }

  if (msg.type === "axlx-guide-sent-rooms") {
    (async () => {
      try {
        const headers = await _getAutomationKeyHeader();
        const res = await fetch(SUMORA_BATCH_API + "/api/automation/sent-rooms?customer_id=" + encodeURIComponent(String(msg.customerId || "")), { headers, signal: AbortSignal.timeout(8000) });
        const j = res.ok ? await res.json() : null;
        const rooms = j && Array.isArray(j.rooms) ? j.rooms.slice(0, 3000) : [];
        /**
         * ★ 2026-11-16: 通常（案内）が読んだ送付済みを、自動の選別（axlx_sent_rooms）にも置く。
         *   旧は案内だけが持っていて自動押下は storage を見ていなかった／バッチ以外では未読込だった。
         */
        try {
          const SK = self.AxlxSentSkip;
          if (SK && msg.customerId != null) {
            const rec = { customerId: String(msg.customerId), rooms: rooms, at: Date.now() };
            const o = {}; o[SK.STORAGE_KEY] = rec;
            await chrome.storage.session.set(o);
          }
        } catch (_) {}
        sendResponse({ ok: !!(j && Array.isArray(j.rooms)), rooms: rooms, customerRooms: j && Array.isArray(j.customer_rooms) ? j.customer_rooms.slice(0, 3000) : null });
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message });
      }
    })();
    return true;
  }

  /**
   * ★ 2026-11-16: 自動押下の直前に送付済みを必ず読む（バッチ以外の自動でも同じ）。
   *   bulk-dl が押す前に呼び、`axlx_sent_rooms` を更新してから選別する。
   */
  if (msg.type === "axlx-load-sent-rooms") {
    (async () => {
      try {
        const cid = msg.customerId != null ? String(msg.customerId) : null;
        if (!cid) { sendResponse({ ok: false, error: "customerId なし" }); return; }
        await _loadSentRooms(cid, msg.site || null);
        const SK = self.AxlxSentSkip;
        const key = SK ? SK.STORAGE_KEY : "axlx_sent_rooms";
        const stored = await chrome.storage.session.get([key]);
        const rec = stored && stored[key];
        sendResponse({
          ok: true,
          count: rec && Array.isArray(rec.rooms) ? rec.rooms.length : 0,
          customerId: cid,
        });
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message });
      }
    })();
    return true;
  }

  if (msg.type === "axlx-merge-pdf") {
    (async () => {
      try {
        // 2026-10-01 資料はリアプロのタブの中で取って一時置き場へ（ログイン情報をサーバーに渡さない）
        const up = await realproPdfsToBlobUrls(sender, msg.urls, String(msg.file_name || "物件まとめ").replace(/\.pdf$/, ""), null);
        const data = await callMergeApi({
          pdf_urls: up.blobUrls,
          cookie_str: "",
          file_name: msg.file_name,
          send_to_line: false,
          customer_name: msg.customer_name || null,
          property_summaries: null,
        });
        sendResponse({ ok: true, pdf: data.pdf, fileName: msg.file_name });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // ── WebApp からの即時ポーリング要求（30秒アラーム待ちをスキップ）────────────
  if (msg.type === "axlx-poll-now") {
    (async () => {
      // スタッフモード中は即時ポーリングも行わない（別PCの30秒ポーリングに任せる）
      if (await _isStaffModeActive()) {
        sendResponse({ ok: false, reason: "staff-mode" });
        return;
      }
      var st = await chrome.storage.local.get("batchRunning");
      var lock = st.batchRunning;
      if (lock) {
        var startedAt = (typeof lock === "object" && lock) ? lock.startedAt : 0;
        if (startedAt && Date.now() - startedAt < BATCH_LOCK_TTL_MS) {
          sendResponse({ ok: false, reason: "locked" });
          return;
        }
      }
      sendResponse({ ok: true });
      _pollAndRunBatch().catch(function(e) {
        console.warn("[poll-now] error:", e.message || e);
      });
    })();
    return true;
  }

  // ── WebApp（sumora-ai-ui）からの直接検索トリガー ──────────────────────────
  if (msg.type === "axlx-webapp-search") {
    const { site, conditions } = msg;
    console.log("[webapp-search] ▶ 受信 site=" + site + " customerId=" + (conditions && conditions.customerId));
    /**
     * 2026-11-11 竹内さん「普通モードにしているとき自動検索されないようにする。今勝手に自動検索が普通モードでもおきてしまったり」:
     *   ここには**モードの関所が無かった**。ウェブアプリ・スマホからの検索の指示は、
     *   モードが 通常／スタッフ でも届いて、勝手に検索が走っていた。
     *   → 自動の道を開いているモード（自動・AIX）を選んでいる時だけ受ける。
     *     それ以外は受け取らない（指示はサーバーに残る＝他の PC が拾える）。
     */
    if (_guideOnly()) {
      console.warn("[webapp-search] 通常／スタッフモードのため検索しない（自動モード・AIXを選ぶと動きます）");
      sendResponse({ ok: false, error: "guide_only" });
      return true;
    }

    // ─── リアプロ: popup.js直接メッセージ経由（Dijkstra展開含む完全な条件組み立てを使う）──
    if (site === "realnetpro" || site === "realpro") {
      (async () => {
        try {
          var _cid      = conditions && conditions.customerId;
          var _custName = (conditions && conditions.customerName) || null;
          var _areaMode = (conditions && conditions.area_mode) || null;
          var _isWide   = !!(conditions && conditions.is_wide);

          if (!_cid) { sendResponse({ ok: false, error: "no customerId" }); return; }

          // underbar.js（content script）経由でpopup.js iframeに中継
          // chrome.tabs.sendMessage はContent Script経路で確実にデリバリされる（iframe frame登録ラグなし）
          var _allTabs = await chrome.tabs.query({});
          var _realTab = _allTabs.find(function(t) { return t.url && t.url.startsWith("https://www.realnetpro.com"); });
          console.log("[webapp-search] リアプロタブ:", _realTab ? _realTab.url : "見つからない");
          var _directOk = false;
          if (_realTab) {
            _directOk = await new Promise(function(resolve) {
              chrome.tabs.sendMessage(_realTab.id, {
                type:         "axlx-switch-customer",
                customerId:   String(_cid),
                customerName: _custName,
                site:         "realpro",
                areaMode:     _areaMode,
                is_wide:      _isWide,
                auto_send_all: !!(msg.auto_send_all),
              }, function(resp) {
                if (chrome.runtime.lastError) {
                  console.log("[webapp-search] tabs.sendMessage エラー:", chrome.runtime.lastError.message);
                  resolve(false); return;
                }
                console.log("[webapp-search] underbar.js応答:", JSON.stringify(resp));
                resolve(!!(resp && resp.ok));
              });
            });
          }
          if (_directOk) {
            console.log("[webapp-search] ✔ underbar.js中継メッセージ成功");
            sendResponse({ ok: true });
            return;
          }
          console.log("[webapp-search] ✗ popup未応答 → フォールバック: ページ更新経由");

          // フォールバック: main.phpへナビゲート + pendingPopupCmd
          //   _realTab は上で取得済み（null の場合は新規タブ作成）
          /**
           * 2026-11-11 竹内さん「画面検索中なぜかトップページに戻ったりして崩れてしまう」:
           *   すでに検索の画面なら main.php へ移らない（トップへ戻ると崩れる）。URL だけで判定する。
           */
          var _wu = _realTab ? String(_realTab.url || "") : "";
          var _wLooksSearch = /[?&]display=building/.test(_wu) || /[?&]method=estate/.test(_wu);
          if (_realTab && _wLooksSearch) {
            console.log("[webapp-search] すでに検索の画面 → main.php へ移らない");
          } else if (_realTab) {
            await chrome.tabs.update(_realTab.id, { url: "https://www.realnetpro.com/main.php", active: true });
            await _batchWaitForTabComplete(_realTab.id);
            await new Promise(function(r) { setTimeout(r, _settleMs(1500)); });
          } else {
            _realTab = await chrome.tabs.create({ url: "https://www.realnetpro.com/main.php", active: true });
            await _batchWaitForTabComplete(_realTab.id);
            await new Promise(function(r) { setTimeout(r, _settleMs(2000)); });
          }
          await chrome.storage.session.set({
            pendingPopupCmd: {
              customerId:   String(_cid),
              customerName: _custName,
              site:         "realpro",
              areaMode:     _areaMode,
              is_wide:      _isWide,
              auto_send_all: !!(msg.auto_send_all),
            }
          });
          sendResponse({ ok: true });
        } catch (e) {
          console.error("[webapp-search] realnetpro error:", e);
          sendResponse({ ok: false, error: String(e.message) });
        }
      })();
      return true;
    }

    // ─── itandi: switch-customer経由でunderbar.js→popup.js→自動入力（リアプロと同一仕組み）──
    if (site === "itandi") {
      (async () => {
        try {
          var _cid      = conditions && conditions.customerId;
          var _custName = (conditions && conditions.customerName) || null;
          var _areaMode = (conditions && conditions.area_mode) || null;
          var _isWide   = !!(conditions && conditions.is_wide);

          if (!_cid) { sendResponse({ ok: false, error: "no customerId" }); return; }

          // fill-done後にスクレイプ→LINE送信するため先に作成
          var _siteFillDone = _createFillDoneWaiter("itandi", String(_cid), _fillDoneTimeoutMs("itandi"));

          // itandiタブを探す（なければ新規作成）
          var _allTabs = await chrome.tabs.query({});
          var _itandiTab = _allTabs.find(function(t) { return t.url && t.url.startsWith("https://itandibb.com"); });
          if (!_itandiTab) {
            _itandiTab = await chrome.tabs.create({ url: "https://itandibb.com/rent_rooms/list", active: false });
            await _batchWaitForTabComplete(_itandiTab.id);
            await new Promise(function(r) { setTimeout(r, _settleMs(2000)); });
          }
          console.log("[webapp-search] itandiタブ:", _itandiTab.url);
          // itandi-content.js に現在の顧客IDを通知（fill-done relay に customerId を付与するため）
          try { await chrome.tabs.sendMessage(_itandiTab.id, { type: "axlx-set-fill-customer", customerId: String(_cid), customerName: _custName }); } catch(_) {}

          // underbar.js → popup.js 経由でリアプロと同じ仕組みで自動入力
          var _directOk = await new Promise(function(resolve) {
            chrome.tabs.sendMessage(_itandiTab.id, {
              type:         "axlx-switch-customer",
              customerId:   String(_cid),
              customerName: _custName,
              site:         "itandi",
              areaMode:     _areaMode,
              is_wide:      _isWide,
              auto_send_all: !!(msg.auto_send_all),
            }, function(resp) {
              if (chrome.runtime.lastError) {
                console.log("[webapp-search] itandi tabs.sendMessage エラー:", chrome.runtime.lastError.message);
                resolve(false); return;
              }
              console.log("[webapp-search] itandi underbar.js応答:", JSON.stringify(resp));
              resolve(!!(resp && resp.ok));
            });
          });

          if (!_directOk) {
            // フォールバック: popup.js未応答 → _batchAutofill直接呼び出し
            console.warn("[webapp-search] itandi popup未応答 → _batchAutofill fallback");
            var _fetchRes = await fetch("https://sumora-ai-ui.vercel.app/api/property-customers?id=" + encodeURIComponent(String(_cid)), { cache: "no-store" }); // v2.5.80 1人だけ取る（旧は全員 1.7MB を取って探していた）
            var _custList = await _fetchRes.json();
            var _customer = Array.isArray(_custList)
              ? _custList.find(function(x) { return String(x.id) === String(_cid); })
              : null;
            if (_customer) {
              if (_areaMode) _customer = Object.assign({}, _customer, { area_mode: _areaMode });
              await _batchAutofill(_customer, "itandi", _isWide);
            }
          }

          sendResponse({ ok: true });

          // fill完了後: リアプロと同様に fill-done + batch-customer-done 待機（itandi-bulk-dl.js 経由）
          _scrapeAndSendRealpro(
            _siteFillDone,
            String(_cid),
            _custName,
            conditions,
            "itandi"
          ).catch(function(e) {
            console.error("[webapp-search] itandi _scrapeAndSendRealpro error:", e.message || e);
          });
        } catch (e) {
          console.error("[webapp-search] itandi error:", e);
          sendResponse({ ok: false, error: String(e.message) });
        }
      })();
      return true;
    }

    // ─── reins: _batchAutofill直接呼び出し ──────────────────────────────────
    (async () => {
      try {
        var _cid      = conditions && conditions.customerId;
        var _isWide   = !!(conditions && conditions.is_wide);
        var _areaMode = (conditions && conditions.area_mode) || null;

        if (!_cid) { sendResponse({ ok: false, error: "no customerId" }); return; }

        var _fetchRes = await fetch("https://sumora-ai-ui.vercel.app/api/property-customers?id=" + encodeURIComponent(String(_cid)), { cache: "no-store" }); // v2.5.80 1人だけ取る（旧は全員 1.7MB を取って探していた）
        var _custList = await _fetchRes.json();
        var _customer = Array.isArray(_custList)
          ? _custList.find(function(x) { return String(x.id) === String(_cid); })
          : null;
        if (!_customer) { sendResponse({ ok: false, error: "customer not found" }); return; }

        if (_areaMode) _customer = Object.assign({}, _customer, { area_mode: _areaMode });

        console.log("[webapp-search] ▶ " + site + " _batchAutofill直接呼び出し customerId=" + _cid);
        await _batchAutofill(_customer, site, _isWide);
        console.log("[webapp-search] ✔ " + site + " _batchAutofill完了");

        sendResponse({ ok: true });
      } catch (e) {
        console.error("[webapp-search] " + site + " error:", e);
        sendResponse({ ok: false, error: String(e.message) });
      }
    })();
    return true;
  }

  // ── CSP回避: content.jsに代わってproperty-customersをfetch ─────────────────
/**
 * ★ 2026-11-15 竹内さん「許可の記憶もごっちゃごちゃにならないように土台整えるのも強化していく」:
 *
 *   **このPCの名前を自動で決める**（一度決めたら変えない）。
 *   ⚠ 実測: `device_label` が全部空だったので、記録が**どのPCの物か分からなかった**。
 *     複数台で使うと「このPCは自動モードにしてよい」のような**許可の記憶が混ざる**。
 *
 *   ⚠ 名前は**人が読める短い物**にする（OS と画面の大きさから作る）。
 *     例: `Win-1920` / `Mac-1512`。⚠ 個人名・IP・シリアルは入れない。
 *   ⚠ 一度保存したら**変えない**（名前が変わると記録が別のPCに見える）。
 */
async function _ensureDeviceLabel() {
  try {
    const cur = await chrome.storage.local.get("deviceLabel");
    if (cur && cur.deviceLabel) return String(cur.deviceLabel);
    let os = "PC";
    try {
      const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
      if (/win/i.test(String(p))) os = "Win";
      else if (/mac/i.test(String(p))) os = "Mac";
      else if (/linux/i.test(String(p))) os = "Linux";
      else if (/android/i.test(String(p))) os = "Android";
    } catch (_) {}
    let w = 0;
    try { w = (screen && screen.width) || 0; } catch (_) {}
    const label = os + "-" + (w || "?");
    try { await chrome.storage.local.set({ deviceLabel: label, deviceLabelAt: Date.now() }); } catch (_) {}
    console.log("[device] このPCの名前を決めました: " + label);
    return label;
  } catch (_) { return null; }
}

/**
 * 2026-11-11 竹内さん「データベース等にはいっているのか」:
   *   通常モードで覚えた人の動きを DB（human_motion_learn）に残す。
   *   ・画面側（human-learn-upload.js）は**鍵を持たない**ので、ここで付けて送る（認証情報をページに出さない）
   *   ・送るのは数と傾向だけ。入力した中身・名前・電話は送らない
   *   ・送れなくても学習は止めない（失敗は console だけ）
   */
  if (msg.type === "axlx-human-motion") {
    (async () => {
      try {
        const hdr = await _getAutomationKeyHeader();
        const body = {
          motion: msg.motion || null,
          site: msg.site || null,
          mode: msg.mode || null,
          shot_taken: !!msg.shot_taken,
          shot_key: msg.shot_key || null,
          shot_w: msg.shot_w || null,
          shot_h: msg.shot_h || null,
          install_id: await _snapInstallId(),
          /**
           * ★ 2026-11-15 竹内さん「許可の記憶もごっちゃごちゃにならないように土台整えるのも強化していく」:
           *   ⚠ 実測: 記録は**全部 `device_label` が空**だった（1台しか無いのに、どのPCか分からない）。
           *     これでは「このPCは自動モードにしてよい／このPCはスタッフ用」のような**許可の記憶**が
           *     混ざっても**区別できない**。
           *   → **端末名を自動で決めて保存**する（人は何もしなくてよい）。
           */
          device_label: await _ensureDeviceLabel(),
          ext_version: _extVersion(),
          at: Date.now(),
        };
        const res = await fetch(SUMORA_BATCH_API + "/api/human-motion", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, hdr),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) console.warn("[human-motion] 送れませんでした:", res.status);
        sendResponse({ ok: res.ok, status: res.status });
      } catch (e) {
        console.warn("[human-motion] 送信エラー:", (e && e.message) || e);
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

/**
 * 2026-11-11 竹内さん「画面の動き方もちゃんと把握できているのかな録画のような形で」→「操作のたびに1枚」
 *
 *   **操作のたびに画面の写真を1枚**撮って Storage に置く（1検索で30〜80枚）。
 *   ・撮るのは**見えているタブだけ**（裏のタブは撮れない・撮ると画面が切り替わって邪魔になる）
 *   ・`<all_urls>` の許可が要る（無ければ撮らずに「撮れなかった」を返す＝止まらない）
 *   ・**間引く**: 最短 MIN_GAP_MS（350ms）はあける（連打で何十枚も撮らない）
 *   ・**まとまり（run）ごと**に番号を振る（`shot_run_id` + 連番）＝並べると操作の流れになる
 *   ・保存は最大 SHOT_TOTAL 枚（古い物から消す＝Storage を溢れさせない）
 *   ・写真の**中身は DB の表に入れない**（1行が数百KBになり集計が重くなる）。Storage に置き、名前だけ DB に送る
 *
 * 返す物: { ok, shot_key, run_id, seq, ms }（ms は撮るのにかかった時間）
 */
var _shotLastAt = 0;
var _shotRun = null;
/**
 * 2026-11-14 竹内さん「連続して画像をみたらアニメーションのように動き理解できる」
 *   → **撮影のまとまり（run_id）を1つに保つ**。
 *
 *   ⚠ 旧は変数だけで持っていたので:
 *     ・Service Worker が休むと消える（→ 再開時に新しいまとまり）
 *     ・押すたびに来る撮影要求が**同時に走ると、それぞれが新しいまとまり**を作った
 *       （実測: 1秒ごとに run_id が変わり、25まとまり全部1枚だった＝連続画像にならない）
 *   → `chrome.storage.local` に保存し、**最後に撮った時刻**で判定する（SWが休んでも続く）。
 *     ⚠ 10分あいたら新しいまとまり（1回の検索の流れ＝連続再生の単位）。
 */
var SHOT_RUN_GAP_MS = 10 * 60 * 1000;
var _shotRunLock = null;   // 同時に走っても1つにする（Promise を共有）

async function _shotRunFor(nowMs) {
  const t = typeof nowMs === "number" ? nowMs : Date.now();
  if (_shotRunLock) { await _shotRunLock.catch(function () {}); }
  // 既にメモリにあって、10分以内ならそのまま使う（一番多い道）
  if (_shotRun && _shotLastAt && t - _shotLastAt <= SHOT_RUN_GAP_MS) return _shotRun;
  // 保存されている物を見る（SW が休んでいた場合）
  let saved = null;
  try {
    const st = await chrome.storage.local.get(["axlx_shot_run", "axlx_shot_last_at"]);
    saved = { run: st && st.axlx_shot_run ? String(st.axlx_shot_run) : null, at: Number(st && st.axlx_shot_last_at) || 0 };
  } catch (_) { saved = null; }
  if (saved && saved.run && saved.at && t - saved.at <= SHOT_RUN_GAP_MS) {
    _shotRun = saved.run;
    _shotLastAt = saved.at;
    return _shotRun;
  }
  // 新しいまとまり（10分あいた・初回）
  _shotRun = t.toString(36) + "_" + Math.random().toString(36).slice(2, 6);
  _shotSeq = 0;
  _shotLastAt = t;
  try { await chrome.storage.local.set({ axlx_shot_run: _shotRun, axlx_shot_last_at: t }); } catch (_) {}
  return _shotRun;
}

/** いまのまとまりを**明示的に閉じる**（検索を始めた時・人が「新しい録画」を押した時） */
async function _shotRunNew() {
  const t = Date.now();
  _shotRun = t.toString(36) + "_" + Math.random().toString(36).slice(2, 6);
  _shotSeq = 0;
  _shotLastAt = t;
  try { await chrome.storage.local.set({ axlx_shot_run: _shotRun, axlx_shot_last_at: t }); } catch (_) {}
  return _shotRun;
}

/** 2026-11-14: 同じ画像が何枚続いたか（画面が変わっていない・別タブを撮っている疑い） */
var _shotSameRun = 0;
var _shotSeq = 0;
/**
 * 2026-11-11 竹内さん「まだ写真クラウドにおくれていないのか」:
 *   写真を**送る前に縮める**（長辺 maxSide px・JPEG quality）。
 *   service worker には DOM が無いので **OffscreenCanvas** を使う（Chrome の MV3 で使える）。
 *   使えない環境では null を返す（呼ぶ側は元の大きさで送る）。
 */
/**
 * 2026-11-15 竹内さん「録画のサイズ読めるサイズにする」:
 *   **写真の大きさを「読める」基準に上げた**（実測で決めた）。
 *
 *   ⚠ 今までの何が悪かったか（実測）:
 *     480px に**縮めてから**左34%を切り出すので、欄がある左側は**実質163px**しか無かった。
 *     拡大しても情報は戻らない（163px幅の文字は潰れている）。
 *   ⚠ 同じ画面で比べた結果:
 *     163px 相当（今）  … 「賃料」「フリーワード」は読めるが「14万」「1日以内」は読めない
 *     435px 相当（等倍）… 「1日以内」「14万円」「15年以内」「1LDK」「空室」まで読める
 *   ⚠ 容量（1280x650 の画面・左34%=435px を等倍で送る場合）:
 *     q60 → 37KB / q70 → 40KB / q80 → 42KB / q90 → 50KB
 *   → **等倍のまま（縮めない）・q70**を既定にする。1枚 40KB 前後。
 *
 *   ⚠ 「等倍」の意味: **撮った画面のまま送る**（縮小しない）。
 *     画面が1920px幅なら 1920px で送る＝もっと細かい（容量は 80〜120KB 目安）。
 *     上限だけ決めて、それを超える時だけ縮める（`SHOT_MAX_SIDE`）。
 */
var SHOT_MAX_SIDE = 1920;   // これを超える画面だけ縮める（通常のフルHD画面はそのまま）
var SHOT_SEND_Q = 0.70;     // 等倍で送る時の JPEG 品質（実測 40KB 前後）
/**
 * 小窓（プルダウン・地域選択）が開いた時は**さらに細かく**送る。
 *   小窓は文字が小さいので、品質を上げる（容量は 60〜90KB 目安）。
 */
var SHOT_BIG_SIDE = 1920;
var SHOT_BIG_Q = 0.82;

/**
 * この写真を**大きく撮るべきか**（純関数に近い・DOMは触らない）。
 *
 * 拡張の `content.js` が「小窓が開いた」を `msg.opened` に載せてくる。
 *   opened … "modal" | "options" | "form" | "result" | "none"
 * それに加えて、押した所（msg.what）が「プルダウン・小窓の中」なら大きく撮る。
 *
 * ⚠ 迷ったら**小さく撮る**（容量を守る）。大きく撮る条件を広げすぎない。
 */
function _shouldShotBig(msg) {
  try {
    if (!msg) return false;
    // ① 小窓・選択肢が開いた直後
    const opened = String(msg.opened || "").toLowerCase();
    if (opened === "modal" || opened === "options") return true;
    // ② 押した欄がプルダウン・小窓の中（名前で判断）
    const what = String(msg.what || "");
    if (/select|transportation|rental_cost|square_meter|structured_date|update_date|room_layout|city_code|town_code|station|路線|駅|区/.test(what)) return true;
    // ③ 拡張が「この写真は大きく」と言ってきた（将来の余地・サイト側の判断）
    if (msg.big === true) return true;
    return false;
  } catch (_) { return false; }
}

var SHOT_LOCAL_SIDE = 320;   // Chrome の中に残す時の長辺（上げられなかった時だけ）
var SHOT_LOCAL_Q = 0.15;
/**
 * Chrome に残す写真の上限（**枚数ではなく容量**で守る）。
 *   ⚠ 2026-11-12 `ResourceExceeded`（保存0枚）の原因は、フルサイズ画像を Chrome に貯めて 10MB を超えた事。
 *   → 画像を持つ物は**合計 1.5MB まで・15枚まで**に絞る（超えたら古い物から消す）。
 */
var SHOT_LOCAL_MAX_BYTES = 1.5 * 1000 * 1000;
var SHOT_LOCAL_MAX_COUNT = 15;
var SHOT_META_MAX_COUNT = 200;   // 目印だけの物（軽い）は多めに残す

/** 写真の「目印だけ」を残す（画像は持たない・数十バイト） */
async function _keepShotMeta(key, meta) {
  try {
    const o = {};
    o[key] = Object.assign({}, meta, { cloud: true });
    await chrome.storage.local.set(o);
  } catch (e) {
    console.warn("[human-shot] 目印を残せません:", (e && e.message) || e);
  }
}
/** 上げられなかった時だけ、**小さくした画像**を Chrome に残す（無いよりまし・容量は _trimShots で守る） */
async function _keepShotLocal(key, meta, shrunkDataUrl) {
  try {
    let small = shrunkDataUrl;
    try {
      const s2 = await _shrinkShot(shrunkDataUrl, SHOT_LOCAL_SIDE, SHOT_LOCAL_Q);
      if (s2 && s2.dataUrl) small = s2.dataUrl;
    } catch (_) {}
    const o = {};
    o[key] = Object.assign({}, meta, { cloud: false, data: small });
    await chrome.storage.local.set(o);
  } catch (e) {
    // 容量が足りない時は目印だけにする（写真は Cloud に上がっている前提）
    console.warn("[human-shot] 画像を残せません（目印だけにします）:", (e && e.message) || e);
    try { const o = {}; o[key] = Object.assign({}, meta, { cloud: false }); await chrome.storage.local.set(o); } catch (_) {}
  }
}
/**
 * Chrome に残した写真を整理する（**容量**で守る）。
 *   ① 画像を持つ物（`data` あり）は合計 3MB・24枚まで。超えたら古い順に消す
 *   ② 目印だけの物は 200件まで
 *   ⚠ 消すのは Chrome の中だけ。Cloud（Storage）の写真は消さない。
 */
async function _trimShots() {
  try {
    const all = await chrome.storage.local.get(null);
    const withImg = [], metaOnly = [];
    for (const k of Object.keys(all)) {
      if (k.indexOf("shot_") !== 0) continue;
      const v = all[k] || {};
      if (typeof v.data === "string" && v.data.length > 100) withImg.push({ k, at: Number(v.at) || 0, bytes: v.data.length });
      else metaOnly.push({ k, at: Number(v.at) || 0 });
    }
    const del = [];
    withImg.sort(function (a, b) { return b.at - a.at; }); // 新しい順
    let total = 0;
    for (let i = 0; i < withImg.length; i++) {
      total += withImg[i].bytes;
      if (i >= SHOT_LOCAL_MAX_COUNT || total > SHOT_LOCAL_MAX_BYTES) del.push(withImg[i].k);
    }
    metaOnly.sort(function (a, b) { return b.at - a.at; });
    for (let j = SHOT_META_MAX_COUNT; j < metaOnly.length; j++) del.push(metaOnly[j].k);
    if (del.length) {
      try { await chrome.storage.local.remove(del); } catch (_) {}
      console.log("[human-shot] Chrome の中の写真を整理しました（消した " + del.length + "件・画像は合計 " + Math.round(total / 1024) + "KB）");
    }
    return del.length;
  } catch (_) { return 0; }
}

/**
 * 2026-11-13 竹内さん「今ちゃんと録画保存されていたか」（画面に
 *   `録画を停止しました: 保持 14件 - 失敗 11件 {capture_error: This request exceeds the
 *    MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota ...}`）
 *
 * ⚠ Chrome は `captureVisibleTab` を **1秒あたり数回まで**に制限している
 *   （`MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`）。録画（1.5〜3.5秒ごと）と
 *   「人の操作のたびに撮る」が重なると、**この上限に当たって失敗が続き、録画が止まる**。
 * → 撮影を**1か所に直列化**し、前の撮影から**一定時間（既定 700ms）あける**。
 *   さらに「制限に当たった」時は**少し待って1回だけやり直す**（すぐ諦めない）。
 */
var _capChain = Promise.resolve();
var _capLastAt = 0;
/**
 * 2026-11-14 竹内さん「データベースで連続で写真保存できてたんやから、間隔は前の細かいの方が良い」:
 *   ⚠ 前回 700ms → 1100ms に広げたが、**それは誤りだった**。
 *     実際に `capture_error` が出ていた原因は**録画ループの多重化**（SW 復帰のたびに増殖）であって、
 *     間隔ではなかった。DB には 392枚が**連続して保存できていた**（間隔 700ms 時代の実績）。
 *   → **700ms に戻す**（細かい間隔の方が写真が多く残る＝学習の材料が増える）。
 *   ⚠ 多重化は `_recGen`（世代番号）で止めたので、700ms でも制限に当たり続けない。
 */
var CAP_MIN_GAP_MS = 700;
/**
 * 2026-11-14 実測: 写真に拡張の小窓が写ると、読む AI が**サイトの欄ではなく拡張のボタン**を読む。
 * ★ 2.8.141 竹内さん「白黒にフラッシュになってしまう」:
 *   旧 `_setShotHidden` は撮る瞬間だけ小窓を隠して戻していた → 自動の回（写真 中央値 400ms おき）で点滅。
 *   → 画面は変えず、窓の位置を content script に聞き（`axlx-shot-rects`）、撮った写真のその所を塗る。
 *   ⚠ 答えが無いタブ（content script が居ない）は塗らずにそのまま撮る。
 *   @returns { rects, vw, vh } または null
 */
async function _shotMaskInfo(tabId) {
  if (typeof tabId !== "number") return null;
  try {
    // ⚠ 上のフレームだけに聞く（サイト内の別フレームが先に「無し」と答えると塗られない）
    const r = await chrome.tabs.sendMessage(tabId, { type: "axlx-shot-rects" }, { frameId: 0 });
    if (!r || !Array.isArray(r.rects) || !r.rects.length || !(r.vw > 0) || !(r.vh > 0)) return null;
    return { rects: r.rects.slice(0, 12), vw: r.vw, vh: r.vh };
  } catch (_) {
    return null;
  }
}
/**
 * 撮った写真の拡張の窓の所を灰色一色で塗る（読む AI に「ここは拡張の窓」と分かる形）。
 *   ⚠ 写真は画面の CSS px × 拡大率なので、写真の幅 ÷ 画面の幅で合わせる。
 *   ⚠ 失敗したら塗らない写真を返す（撮影は止めない）。
 */
async function _maskShot(dataUrl, info) {
  try {
    if (!info || !info.rects || !info.rects.length) return dataUrl;
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") return dataUrl;
    const comma = String(dataUrl).indexOf(",");
    if (comma < 0) return dataUrl;
    const bin = atob(String(dataUrl).slice(comma + 1));
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([arr], { type: "image/jpeg" }));
    const W = bmp.width, H = bmp.height;
    const sx = W / info.vw, sy = H / info.vh;
    const cv = new OffscreenCanvas(W, H);
    const ctx = cv.getContext("2d");
    if (!ctx) { try { bmp.close && bmp.close(); } catch (_) {} return dataUrl; }
    ctx.drawImage(bmp, 0, 0);
    try { bmp.close && bmp.close(); } catch (_) {}
    ctx.fillStyle = "#808080";
    for (const r of info.rects) {
      ctx.fillRect(Math.floor(r.x * sx), Math.floor(r.y * sy), Math.ceil(r.w * sx), Math.ceil(r.h * sy));
    }
    const out = await cv.convertToBlob({ type: "image/jpeg", quality: 0.6 });
    const buf = new Uint8Array(await out.arrayBuffer());
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
    return "data:image/jpeg;base64," + btoa(s);
  } catch (_) {
    return dataUrl;
  }
}
function _capturePaced(windowId) {
  var run = function () {
    return (async function () {
      var wait = CAP_MIN_GAP_MS - (Date.now() - _capLastAt);
      if (wait > 0) await new Promise(function (r) { setTimeout(r, wait); });
      try {
        return await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 55 });
      } catch (e) {
        var msg = String((e && e.message) || e);
        if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(msg)) {
          /**
           * 2026-11-14 竹内さん「間隔は前の細かいの方が良い」:
           *   やり直しの待ちも 900ms に戻す（2.2秒は間隔を空けすぎ）。
           *   ⚠ 本当の原因（多重ループ）は `_recGen` で止めたので、これで足りる。
           */
          await new Promise(function (r) { setTimeout(r, 900) });
          return await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 55 });
        }
        throw e;
      } finally {
        _capLastAt = Date.now();
      }
    })();
  };
  // 直列にする（同時に何枚も撮りに行かない）
  var p = _capChain.then(run, run);
  _capChain = p.then(function () {}, function () {});
  return p;
}
async function _shrinkShot(dataUrl, maxSide, quality) {
  try {
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") return null;
    // data:image/jpeg;base64,... → Blob
    const comma = String(dataUrl).indexOf(",");
    if (comma < 0) return null;
    const b64 = String(dataUrl).slice(comma + 1);
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: "image/jpeg" });
    const bmp = await createImageBitmap(blob);
    let w = bmp.width, h = bmp.height;
    const long = Math.max(w, h);
    /**
     * ★ 2026-11-15 竹内さん「録画のサイズ読めるサイズにする」:
     *   ⚠ 旧は**いつも再エンコード**していた。上限より小さい写真でも
     *     もう一度JPEGにし直すので、**画質が落ちるのに容量は増える**事があった
     *     （実測: 元 85KB → q70 で 98KB。しかも画質は元のまま以下）。
     *   → **上限に収まっているなら、そのまま送る**（縮めない・作り直さない）。
     *     これで「読める大きさ」を保ち、容量も最小になる。
     */
    if (long <= maxSide) {
      try { bmp.close && bmp.close(); } catch (_) {}
      return { dataUrl: dataUrl, w: w, h: h, passthrough: true };
    }
    const k = maxSide / long;
    w = Math.round(w * k); h = Math.round(h * k);
    const cv = new OffscreenCanvas(w, h);
    const ctx = cv.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, h);
    const out = await cv.convertToBlob({ type: "image/jpeg", quality: quality || 0.45 });
    const buf = new Uint8Array(await out.arrayBuffer());
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
    return { dataUrl: "data:image/jpeg;base64," + btoa(s), w: w, h: h };
  } catch (_) { return null; }
}

/**
 * 2026-11-12 竹内さん「画面録画モード押しているときは連続でさつえいされていればちゃんと記録される」:
 *   ⚠ `chrome.runtime.sendMessage` は**自分（background）には届かない**ので、録画の連続撮影からは
 *     メッセージを送らず、この関数を直接呼ぶ（撮影の中身は今までと同じ1本）。
 */
async function _takeShot(msg, done) {
  const sendResponse = typeof done === "function" ? done : function () {};
  (async () => {
    const t0 = Date.now();
    /**
     * 2026-11-11: 呼ばれた回数も残す（記録側の "tried" と一致するかで、どこで止まっているか分かる）
     */
    try {
      chrome.storage.local.get(["axlx_human_shot_bg"], function (r) {
        var b = (r && r.axlx_human_shot_bg) || { called: 0, ok: 0 };
        b.called = (Number(b.called) || 0) + 1;
        b.last_at = Date.now();
        try { chrome.storage.local.set({ axlx_human_shot_bg: b }); } catch (_) {}
      });
    } catch (_) {}
    /**
     * 2026-11-11 竹内さん「許可済みになっているはず」→ 学習は入るが写真が0枚だった。
     *   何で失敗したのか分からないと直せないので、**失敗の理由を残す**（コンソール＋最後の理由を storage に）。
     */
    const fail = function (error) {
      try {
        var o = { axlx_human_shot_error: { error: error, at: Date.now() } };
        chrome.storage.local.set(o);
      } catch (_) {}
      console.warn("[human-shot] 撮れません:", error);
      sendResponse({ ok: false, error: error, ms: Date.now() - t0 });
    };
    try {
      const SHOT_TOTAL = 600;      // 全体で残す枚数（1検索 30〜80枚 × 数回分）
      const MIN_GAP_MS = 350;      // これより短い間隔では撮らない（連打対策）
      // 間引き（最後に撮ってから短すぎる時は理由を返す＝呼ぶ側は諦める）
      if (_shotLastAt && t0 - _shotLastAt < MIN_GAP_MS) {
        sendResponse({ ok: false, error: "too_soon", ms: Date.now() - t0 });
        return;
      }
      const has = await chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(function () { return false; });
      if (!has) { fail("no_permission"); return; }
      /**
       * 2026-11-11 竹内さん「許可済みになっているはず」:
       *   `active: true, currentWindow: true` は**サイドパネルが前面の時**に別の窓を指す事がある
       *   → ① まず今の窓のアクティブなタブ ② 無ければ**リアプロのタブ** ③ それも無ければ今のタブ
       */
      let tab = null;
      try {
        const act = await chrome.tabs.query({ active: true, currentWindow: true });
        tab = act && act[0] ? act[0] : null;
      } catch (_) { tab = null; }
      if (!tab) {
        try {
          const rp = (await chrome.tabs.query({})).filter(function (t) {
            return t.url && /realnetpro\.com|itandibb\.com|reins\.jp/.test(t.url);
          });
          tab = rp.length ? rp[0] : null;
        } catch (_) { tab = null; }
      }
      if (!tab || !tab.windowId) { fail("no_tab"); return; }
      /**
       * 2026-11-14 竹内さん「一番直近で録画したのから動き方学ぶ。連続して画像をみたら
       *   アニメーションのように動き理解できるので、それで押したところ学ぶ」
       *
       *   ⚠ **run_id が毎回変わっていて、連続画像になっていなかった**（実測・決定的）:
       *     20:06:06 run=mwgaus2e / 20:06:06 run=mwgau995 / 20:06:07 run=mwgau1of …
       *     → 1秒ごとに別のまとまり。1まとまり＝1枚だけ。**25個あって全部1枚**だった。
       *     だから「連続して見る」ができず、押した所も学べない。
       *
       *   原因: `_shotLastAt`（最後に撮った時刻）を**撮影が始まる前**に更新していたため、
       *     押すたびに来る撮影要求（同時に複数走る）が**それぞれ「10分あいた」と判断**していた。
       *     ⚠ さらに `_shotRun` は Service Worker が休むと消える（変数なので）。
       *
       *   → ① まとまりの印を **chrome.storage.local に保存**する（SWが休んでも続く）
       *     ② 「10分あいたら新しいまとまり」の判定は**保存した最後の撮影時刻**で行う
       *     ③ 同時に走っても**同じまとまり**になる（判定と保存を1か所で行う）
       *     ④ 検索を始めたら（axlx-rec-start 等）**明示的に新しいまとまり**にする
       */
      _shotRun = await _shotRunFor(t0);
      _shotSeq++;
      _shotLastAt = t0;
      try { await chrome.storage.local.set({ axlx_shot_last_at: t0, axlx_shot_run: _shotRun }); } catch (_) {}

      let dataUrl = null;
      /**
       * 2026-11-14 竹内さん「ここちゃんと学習できるように。弱い部分を統括判断して改善できるよう」
       *
       *   ⚠ 実測: **100枚の写真が全部同じ画像**だった（1分47秒の間、画面が一度も変わらない＝おかしい）。
       *     写真を見ると**リアプロではなく別のタブ**が写っていた。
       *     `captureVisibleTab(windowId)` は**その窓の「今アクティブなタブ」**を撮るので、
       *     リアプロがアクティブでないと**別のタブが撮れる**（＝学習に使えない写真が貯まる）。
       *
       *   旧は「**失敗した時だけ**」タブをアクティブにして撮り直していた。
       *   ⚠ 失敗しないので、**別のタブのまま撮れ続けていた**（誰も気づけない）。
       *   → **最初から**「リアプロのタブをアクティブにして撮り、**すぐ元に戻す**」。
       *     ⚠ 人が別のタブを見ている時間を奪わないよう、撮ったら必ず戻す。
       */
      try {
        const prev = await chrome.tabs.query({ active: true, windowId: tab.windowId }).catch(function () { return []; });
        const prevId = prev && prev[0] ? prev[0].id : null;
        const wasActive = (prevId === tab.id);
        if (!wasActive) {
          try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
          try { await chrome.tabs.update(tab.id, { active: true }); } catch (_) {}
          await new Promise(function (r) { setTimeout(r, 320); });
        }
        /**
         * 2026-11-14 竹内さん「1から順に進めていく」→ **実測で判明（写真から学べない一番の原因）**:
         *   ⚠ 写真の**中央に拡張自身の小窓**が写っていて、AI はそれを読んでいた（実測で確定）:
         *     実物: ピンポイント / 広げて検索 / リアプロで自動検索 / レインズでも探す / 全条件をコピー
         *     誤読: ビジポイント / 近い順で検索 / リアプロで看護師募集 / Banch何度も利用 / 全自動キーコピー
         *   ⚠ プロンプトで「小窓は読まない」と指示しても直らない（小窓が後ろの欄を**覆っている**）。
         *   → 撮った写真の小窓の所を灰色で塗る（2.8.141〜。画面は変えない＝点滅させない）。
         */
        const _mask = await _shotMaskInfo(tab.id);
        try {
          dataUrl = await _capturePaced(tab.windowId);
          if (dataUrl && _mask) dataUrl = await _maskShot(dataUrl, _mask);
        } finally {
          if (!wasActive && prevId != null) {
            try { await chrome.tabs.update(prevId, { active: true }); } catch (_) {}
          }
        }
      } catch (e) {        /**
         * 2026-11-11 竹内さん「写真撮ってるかな？」→ 0枚のまま。
         *   `captureVisibleTab` は**その窓のアクティブなタブ**しか撮れない。小窓を開いていると失敗する。
         *   → 一度そのタブをアクティブにして撮り、**すぐ元に戻す**（人の操作を邪魔しない）。
         */
        try {
          /**
           * 2026-11-12 竹内さん「くれさん通常モードで検索したけどちゃんと画面録画はできるようになっているかな」:
           *   `captureVisibleTab` は**その窓が前に出ている（focused）**事も要る。
           *   拡張の小窓（ポップアップの別窓）を開いていると本体の窓が後ろに下がり、毎回失敗する。
           *   → 撮る前に**窓を前に出す**（人が見ている前提の軽い操作・タブは元に戻す）。
           */
          try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
          const prev = await chrome.tabs.query({ active: true, windowId: tab.windowId }).catch(function () { return []; });
          const prevId = prev && prev[0] ? prev[0].id : null;
          await chrome.tabs.update(tab.id, { active: true });
          await new Promise(function (r) { setTimeout(r, 320); });   // 描画が変わるのを待つ（少し長め）
          // 1つ目の経路と同じく、撮った写真の小窓の所を塗る（画面は変えない）
          const _mask2 = await _shotMaskInfo(tab.id);
          dataUrl = await _capturePaced(tab.windowId);
          if (dataUrl && _mask2) dataUrl = await _maskShot(dataUrl, _mask2);
          if (prevId != null && prevId !== tab.id) {
            try { await chrome.tabs.update(prevId, { active: true }); } catch (_) {}
          }
        } catch (e2) {
          fail("capture_error: " + String((e && e.message) || e) + " / retry: " + String((e2 && e2.message) || e2));
          return;
        }
      }
      if (!dataUrl) { fail("no_image"); return; }

      /**
       * 2026-11-14 竹内さん「足りていない部分や弱い部分はきょうかするようにする」:
       *   ⚠ **同じ画像が延々と撮れている**事に誰も気づけなかった（実測100枚が同一）。
       *   → 撮った直後に**直前の写真と同じか**を見て、続いた枚数を数える。
       *     ⚠ 比べるのは**長さと先頭200文字**だけ（軽い・中身を読まない）。
       *     ⚠ `same_run` が大きい＝「画面が変わっていない」＝止まっている／別のタブを撮っている疑い。
       */
      try {
        var _sigNow = String(dataUrl.length) + ":" + String(dataUrl.slice(0, 200));
        if (window.__axLastShotSig && window.__axLastShotSig === _sigNow) {
          _shotSameRun = (_shotSameRun || 0) + 1;
        } else {
          _shotSameRun = 0;
          window.__axLastShotSig = _sigNow;
        }
      } catch (_) {}

      /**
       * 2026-11-11 竹内さん「まだ写真クラウドにおくれていないのか」:
       *   ⚠ フルHD画面のJPEG（quality 55）は **3MB を超える**ことがある。
       *     サーバーは 3MB 超の写真を**黙って捨てていた**（エラーも出さない）＝「送ったのに届かない」。
       *   → 送る前に**縮める**（長辺 1280px・JPEG 45%）。1枚あたり 200〜400KB になり確実に通る。
       */
      /**
       * 2026-11-11 竹内さん「画像もっと容量落としても大丈夫」:
       *   長辺 **800px・JPEG 32%**（40〜90KB 目安）。物件名・賃料・ボタンの位置は読める。
       *   1検索で 30〜80枚たまるので、1枚を小さくするのが効く。
       */
      let shotForUpload = dataUrl;
      let shotW = 0, shotH = 0;
      /**
       * 2026-11-15 竹内さん「録画のサイズ読めるサイズにする」:
       *   ⚠ 旧は **480px に縮めてから** 左34%を切り出すので、欄がある左側は実質 **163px** だった
       *     （拡大しても情報は戻らない）。
       *   → **等倍のまま送る**（縮めない）。画面が `SHOT_MAX_SIDE` を超える時だけ縮める。
       *     実測: 1280x650 の画面で 40KB 前後／q70。
       */
      const _big = _shouldShotBig(msg);
      try {
        const cap = _big ? SHOT_BIG_SIDE : SHOT_MAX_SIDE;
        const q = _big ? SHOT_BIG_Q : SHOT_SEND_Q;
        const shrunk = await _shrinkShot(dataUrl, cap, q);
        if (shrunk && shrunk.dataUrl) { shotForUpload = shrunk.dataUrl; shotW = shrunk.w; shotH = shrunk.h; }
      } catch (e) {
        console.warn("[human-shot] 縮められませんでした（元の大きさで送ります）:", (e && e.message) || e);
      }
      const shotBytes = Math.round(String(shotForUpload).length * 3 / 4);
      console.log("[human-shot] 撮りました: 元 " + Math.round(dataUrl.length * 3 / 4 / 1024) + "KB → 送る物 " + Math.round(shotBytes / 1024) + "KB（" + shotW + "x" + shotH + "）" + (_big ? "・大きく撮る（小窓/プルダウン）" : ""));

      // 名前を「まとまり＋連番」にする（並べ替えると操作の流れになる）
      const key = "shot_" + _shotRun + "_" + String(_shotSeq).padStart(4, "0");
      const meta = {
        at: t0, seq: _shotSeq, run_id: _shotRun,
        site: msg.site || null,
        kind: typeof msg.kind === "string" ? msg.kind.slice(0, 20) : null, // 何の操作の直後か（click/change/key/scroll）
        what: typeof msg.what === "string" ? msg.what.slice(0, 40) : null, // どの欄か
        x: typeof msg.x === "number" ? Math.round(msg.x) : null,           // 押した所（画面の座標）
        y: typeof msg.y === "number" ? Math.round(msg.y) : null,
        url: String(tab.url || "").slice(0, 300),
        /**
         * 2026-11-13 竹内さん「ほかに抜けている箇所はあるのか」:
         *   どのタブを撮ったか。写真と一緒に**その場の動きの癖**を送るために使う。
         */
        tab_id: typeof tab.id === "number" ? tab.id : null,
        /**
         * 2026-11-14 竹内さん「３にする」:
         *   この写真を**大きく撮ったか**を残す（後から「大きく撮れているか」を確かめられる）。
         */
        big: !!_big,
        opened: String(msg.opened || "").slice(0, 12) || null,
      };
      /**
       * 2026-11-12 竹内さん「いまちゃんとろくがされてたかな？」→ **保存0枚・失敗6回・ResourceExceeded**。
       *
       * ⚠ 本当の原因: Chrome の `storage.local` は **10MB まで**（`unlimitedStorage` 無し）。
       *   旧はここに **縮小前のフルサイズ画像（dataUrl・1枚 2〜3MB）** を入れていた。
       *   → 3〜4枚で 10MB を超え、**それ以降の保存が全部 `ResourceExceeded` で失敗**（＝1枚も保存されない）。
       *   ⚠ Cloud（Storage）には上げていたが、ここの `set` が先に例外になって
       *     送信まで届かない事もあった（`await chrome.storage.local.set(o)` の後ろで送っている）。
       *
       * → **画像は Chrome の中に貯めない**。Cloud に上げて、Chrome には**小さな目印だけ**残す。
       *   上げられなかった時だけ、**縮小した画像（40〜90KB）** を残す（無いよりまし・上限は下で掃除）。
       */
      const uploadOn = msg.upload !== false;
      const up = uploadOn ? _sendShotNow({
        data_url: shotForUpload, site: msg.site || null, what: msg.what || null,
        shot_w: shotW, shot_h: shotH,
        kind: msg.kind || null, x: msg.x, y: msg.y,
        // 2026-11-14 竹内さん「通常と自動のところで自動で強化必要な部分強化する」:
        //   ⚠ 旧は `mode: null` 固定だったので、どのモードの写真か分からなかった（DBのmodeが空）。
        //   → 今のモードを入れる（normal / staff / aix / brain…）。
        mode: await _modeLabelNow(), run_id: _shotRun, seq: _shotSeq,
        /**
         * 2026-11-14 竹内さん「ここちゃんと学習できるように」:
         *   ⚠ **同じ画像が延々と撮れている**事に誰も気づけなかった（実測100枚が同一）。
         *   → 直前の写真と同じなら `same_run` に**何枚続いたか**を入れて送る。
         *     統括が「画面が変わっていない＝止まっている／別のタブを撮っている」を判断できる。
         *   ⚠ 比べるのは**長さと先頭200文字**だけ（軽い・中身を読まない・個人情報を扱わない）。
         */
        same_run: (function () { try { return _shotSameRun || 0; } catch (_) { return 0; } })(),
        // 2026-11-13 竹内さん「写真から学習する」: この写真の直前までの操作の並び
        // ★ 2026-11-17: クリック撮影経路でも cs 欠落を埋める（録画→改善土台）
        ops: (function () {
          var raw = Array.isArray(msg.ops) ? msg.ops : null;
          if (!raw) return null;
          try {
            return raw.map(function (o) {
              if (!o || typeof o !== "object" || o.cs) return o;
              var w = String(o.w || ""), f = String(o.f || "");
              if (/checkbox|radio|button|select|link|label|click/.test(w)
                || /one_city|one_station|one_line|city_code|station|route|go_search|room_layout|絞り込み|検索/.test(f)) {
                return Object.assign({}, o, { cs: "pointer" });
              }
              return o;
            });
          } catch (_) { return raw; }
        })(),
        // 2026-11-13: どのタブか（その場の動きの癖を一緒に送るため）
        tab_id: typeof tab.id === "number" ? tab.id : null,
      }) : null;

      let ur = null;
      if (up) {
        if (msg.wait_upload) {
          try { ur = await up; } catch (e) { ur = { ok: false, error: String((e && e.message) || e) }; }
        } else {
          // 待たない時も、失敗したら小さく残す（あとで見られるように）
          up.then(function (r) { if (!r || !r.ok) _keepShotLocal(key, meta, shotForUpload); return r; })
            .catch(function (e) { void e; _keepShotLocal(key, meta, shotForUpload); });
        }
      }
      // Cloud に上がった（or 送らない設定）＝Chrome には**目印だけ**。上がらなかった時は縮小画像を残す
      if (!msg.wait_upload) {
        if (!uploadOn) await _keepShotLocal(key, meta, shotForUpload);
        else { /* 送信の結果で決める（上の then の中） */ }
      } else if (!(ur && ur.ok)) {
        await _keepShotLocal(key, meta, shotForUpload);
      } else {
        await _keepShotMeta(key, meta);
      }

      // 古い物から消す（全体の上限）。画像を持つ物は少なめに残す（容量を守る）
      await _trimShots();
      sendResponse({ ok: true, shot_key: key, run_id: _shotRun, seq: _shotSeq, upload: ur || null, ms: Date.now() - t0 });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 });
    }
  })();
}

if (msg.type === "axlx-human-shot") {
  _takeShot(msg, function (r) { try { sendResponse(r); } catch (_) {} });
  return true;
}

/**
 * 2026-11-13 竹内さん「つなぐ」（学んだ押す順番を自動モードに繋ぐ）:
 *   学習担当のブレインが毎晩まとめた「束」を取りに行き、**押す順番（next）と押す場所（points）**だけを
 *   chrome.storage.local に置く（ページ側 page-script が読む）。
 *
 *   ⚠ 取るのは**1日1回まで**（起動時と、前回から24時間たった時）。サーバーを叩きすぎない。
 *   ⚠ 失敗しても何もしない（今まで通りの動き・学習は「あれば使う」）。
 */
/**
 * 2026-11-13 竹内さん「ほかにちゃんと学習の面とかで連携できていない部分などあるか」:
 *   ⚠ 旧は `next`（押す順番）と `points`（押す場所）**だけ**を storage に置いていた。
 *     サーバーは `motion`（速さ・曲がり）・`gaps`（操作の間）・`weak`（次に学ぶ事）・
 *     `site_flow`（サイトごとの手順）まで計算して返しているのに、**拡張が捨てていた**
 *     （＝サーバーで学んだ事が現場に届いていない）。
 *   → 使える物も一緒に置く。ページ側は「あれば使う」（無ければ今まで通り）。
 */
var _LEARN_KEYS = ["axlx_learn_next", "axlx_learn_points", "axlx_learn_at", "axlx_learn_ver", "axlx_learn_by_site"];
/**
 * 2026-11-14 竹内さん「学習して改善したら自動モード強化されるように」:
 *   ⚠ 旧は**24時間に1回**しか取りに行かなかったので、学習しても**最大24時間反映されなかった**
 *     （「改善したのに自動モードが変わらない」の一因）。
 *   → ① **起動時と定期的**に軽く見に行く（`?touch=0` で「版」だけ確認・重くない）
 *     ② **学習の版（generated_at）が変わっていたら**すぐ取り直す
 *     ③ 版が同じなら何もしない（サーバーも拡張も無駄に動かない）
 *
 * 2026-11-14 竹内さん「最新の学びが反映されるようになっているのか」:
 *   ⚠ 旧は `_LEARN_CHECK_MS = 1時間` で、しかも **「前回取り込んでから1時間」経つまで版の確認すらしない**
 *     （`if (!force && last && Date.now() - last < _LEARN_CHECK_MS) return skipped`）。
 *     つまり **学んだ直後は最大1時間、新しい学びが自動検索に入らない**。
 *     実測でも「束は 6分前なのに、拡張はまだ前の版を持っている」状態だった。
 *   → 版の確認は **5分ごと**にする（`?touch=0` は軽い＝束を作り直さないので安全）。
 *     ⚠ 束の取り直し（重い方）は版が変わった時だけなので、5分ごとでも通信は増えない。
 */
var _LEARN_CHECK_MS = 5 * 60 * 1000;   // 版を見に行く間隔（5分。軽い確認だけ）
/** 自動モード中は短く見る（改善がすぐ届く・2026-11-15 ボトルネック改善） */
var _LEARN_CHECK_AUTO_MS = 60 * 1000;
/**
 * ★ 2026-11-15 竹内さん「学習の束の取り直しが重なって、DB が止まった件（急ぎ）」
 *
 *   ⚠ 実際に起きた事（実測・サーバーの記録）:
 *     01:40:30〜01:41:30 UTC（JST 10:40〜10:41）に、拡張から
 *     `GET /api/human-learn-profile` が**約1秒で約130回**重なって届いた（同じ事務所の端末から）。
 *     サーバーは1回ごとに束（1行 約40KB）を読み、同じ1行に読んだ印を書いていたため DB の手が埋まり、
 *     **約1分後に DB 全体が約1分半止まった**（1行読むだけの処理まで15秒）。
 *     ＝ 下書き・AIX・画面の読み込みが時間切れ。
 *
 *   ⚠ 原因（拡張の側）:
 *     ① `_refreshLearnedBundle` が**同時に何本も走れた**（起動・タブ読み込み・5分ごと・サイト切替が重なる）
 *     ② 失敗しても**すぐ次の呼び出しが来た**（間を空けていなかった）
 *     ③ 起動時に**全端末が同じ瞬間**に取りに行った（ずらしが無い）
 *     ④ 版が同じでも **scope ごとの取り直し（realpro / itandi / 全体）**をしていた
 *        → 1回の `?touch=0` で足りるのに、**3回の重い取得**が発生
 *
 *   → 下の4つで直す（サーバー側の対策と重ねて、呼ばない側でも守る）。
 */
var _learnInflight = null;       // 実行中の1本（これがあれば新しい実行はせず、この結果を待つ）
var _learnFailCount = 0;         // 続けて失敗した回数（間隔を延ばすのに使う）
var _learnNextTryAt = 0;         // 次に試してよい時刻（失敗の後はここまで待つ）
/** 失敗した後の間: 1分 → 5分 → 15分（それ以上は15分のまま） */
function _learnBackoffMs(n) {
  if (n <= 0) return 0;
  if (n === 1) return 60 * 1000;
  if (n === 2) return 5 * 60 * 1000;
  return 15 * 60 * 1000;
}
/** 起動・タブ読み込みの時にずらす（端末ごとにばらばら・0〜30秒） */
function _learnStartJitterMs() {
  return Math.floor(Math.random() * 30000);
}

/**
 * 同時に1本だけ。実行中なら**新しく呼ばずに、実行中の結果を待って使う**。
 *   ⚠ `force` が来ても、実行中なら**その結果でよい**（同じ束を取りに行くだけなので）。
 *     ただし**サイトが違う**時（`force` かつ実行中の物と違う）は、終わってから1回だけ走らせる。
 *
 *   ⚠ 成否の後始末（間隔を延ばす・戻す）は**ここで1か所**でやる。
 *     `_refreshLearnedBundle` の中に散らすと、早期 return のどれかで記録し忘れて静かに壊れる。
 */
function _refreshLearnedBundleQueued(force, _noChain) {
  if (_learnInflight) {
    /**
     * ★ 2026-11-19 タクヤ audit #1513（screen=0 のまま自動開始）:
     *   強制の取り直しが、実行中の通常確認（版が同じで何もしない）に吸収されて終わっていた。
     *   → 実行中の結果が「何もしなかった」なら、終わった後に1回だけ強制で取り直す（backoff 中は待つ）。
     */
    if (force && !_noChain) {
      return _learnInflight.then(function (r) {
        if (r && r.skipped && r.skipped !== "backoff") return _refreshLearnedBundleQueued(true, true);
        return r;
      });
    }
    // 実行中 → そのまま待つ（重ねて呼ばない）
    return _learnInflight;
  }
  var p = _refreshLearnedBundle(force).then(function (r) {
    _learnInflight = null;
    /**
     * 失敗したら間隔を延ばす（1分 → 5分 → 15分）。
     *   ⚠ `skipped` は失敗ではない（版が同じ・間隔内・backoff 中）＝**失敗回数を戻す**。
     *     「何もしなかった」を失敗に数えると、正常な時まで間隔が延びて学びが届かなくなる。
     */
    var hardFail = !r || r.ok === false;
    if (hardFail) {
      _learnFailCount = Math.min(9, (_learnFailCount || 0) + 1);
      _learnNextTryAt = Date.now() + _learnBackoffMs(_learnFailCount);
      console.warn("[learn] 取り直しに失敗（" + _learnFailCount + "回目）→ " + Math.round(_learnBackoffMs(_learnFailCount) / 1000) + "秒あけます");
    } else {
      _learnFailCount = 0;
      _learnNextTryAt = 0;
    }
    return r;
  }).catch(function (e) {
    _learnInflight = null;
    _learnFailCount = Math.min(9, (_learnFailCount || 0) + 1);
    _learnNextTryAt = Date.now() + _learnBackoffMs(_learnFailCount);
    console.warn("[learn] 取り直しで例外（" + _learnFailCount + "回目）→ 間隔をあけます:", (e && e.message) || e);
    return { ok: false, error: String((e && e.message) || e) };
  });
  _learnInflight = p;
  return p;
}

/**
 * ★ 2026-11-18: autofill（手動・一括・webapp）の直前に学習束を版確認／必要なら取り直す。
 *   ポップアップを開かない経路でも content script が storage 経由で最新束を使えるようにする。
 */
async function _learnRefreshForAutofill() {
  try {
    var st = await chrome.storage.local.get([
      "axlx_learn_needs_auto",
      "axlx_learn_screen",
      "axlx_learn_ver",
      "axlx_learn_link",
      "axlx_learn_next",
      "axlx_learn_points",
      "axlx_learn_playbook",
      "axlx_learn_after_update",
    ]);
    /**
     * ★ 2026-11-22 2.8.183: 手順書欠落・更新直後も force（画面位置だけ揃って古い手順書のまま押し始めない）。
     */
    var _gate = (self.AxlxLearnRefreshGate && self.AxlxLearnRefreshGate.shouldForceLearnRefresh)
      ? self.AxlxLearnRefreshGate.shouldForceLearnRefresh(st)
      : { force: !!(st.axlx_learn_needs_auto || !st.axlx_learn_ver), reason: "fallback" };
    try {
      if (_gate.force) console.log("[learn] autofill前の取込 force=" + _gate.reason);
    } catch (_) {}
    return await _refreshLearnedBundleQueued(!!_gate.force);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function _refreshLearnedBundle(force) {
  try {
    /**
     * ④ 失敗の後は間を空ける（1分 → 5分 → 15分）。
     *   ⚠ 旧は失敗しても次の呼び出しがすぐ来た（5分ごと・サイト切替・起動）。
     *     サーバーが重い時ほど**追い打ち**になっていた。
     */
    if (Date.now() < _learnNextTryAt) {
      return { ok: true, skipped: "backoff", retry_in_ms: _learnNextTryAt - Date.now() };
    }
    var st = await chrome.storage.local.get(_LEARN_KEYS.concat([
      "axlx_learn_link",
      "axlx_learn_needs_auto",
      "axlx_learn_screen",
      "axlx_learn_empty_refetch_at",
    ]));
    var last = Number(st && st.axlx_learn_at) || 0;
    var lastVer = String((st && st.axlx_learn_ver) || "");
    /**
     * 強制でない時: 1時間たっていなければ「版だけ」確かめる（軽い）。
     *   ・版が変わっていなければ何もしない
     *   ・版が変わっていたら取り直す（＝学習が進んだ瞬間に反映される）
     */
    /**
     * ★ 2026-11-15「新しくなったら新しくしたのもちゃんと把握」:
     *   自動モード中は確認間隔を短くする（改善がすぐ版チェックに乗る）。
     */
    var _checkMs = _LEARN_CHECK_MS;
    try {
      if (_autoModeOn || _autoModeChosen) _checkMs = _LEARN_CHECK_AUTO_MS;
    } catch (_) {}
    /**
     * ★ 2026-11-16 連携ボトルネック除去（read_count=0が続く／新束が届かない）:
     *   旧は「前回取込から5分未満」だと **版確認すらせず return** していた。
     *   → photo_learn で束が新しくなっても、通常モードでは最大5分気づかない。
     *   → **版確認（touch=0）は毎回やる**。版が同じかつ新鮮な時だけ取得をスキップ。
     */
    if (!force) {
      try {
        /**
         * ⚠ 2026-11-14 竹内さん「1と2順に改善するようにする」→ **実測で判明（ここが止まっていた）**:
         *   版を見る `?touch=0` のタイムアウトが **8秒**だったが、
         *   束が古い時はサーバーが**その場で作り直す**ので **14.6秒かかる**（実測）。
         *   → 8秒で切れて `catch` に入り「取りに行く」流れになるが、
         *     その直後の取得（15秒）も**足りずに失敗**し、結果として**新しい学びが届かなかった**。
         *   → 版確認を **25秒**、取得を **40秒** に延ばす（実測 14.6秒＋余裕）。
         *     ⚠ 1分ごとに走るが、`lastVer` が同じなら通信は1回で終わる（重くならない）。
         */
        var head = await fetch(SUMORA_BATCH_API + "/api/human-learn-profile?touch=0", { cache: "no-store", signal: AbortSignal.timeout(25000) });
        if (head.ok) {
          var hj = await head.json();
          var hv = String((hj && hj.generated_at) || "");
          /**
           * ★ 2026-11-15 竹内さん「版が同じなら取り直さない」（依頼1-4）
           *   ⚠ 旧は `lastVer` が**空**（初回）の時や、版は同じでも `axlx_learn_at` が古い時に
           *     scope ごとの重い取得（realpro / itandi / 全体）を**3回**やっていた。
           *   → 版が**分かっている**（`hv` がある）かつ `hv === lastVer` なら**ここで終わる**（取得しない）。
           *     ⚠ `lastVer` が空の時も `hv` があれば、手元に束が入っているかを別に見る（下）。
           */
          /**
           * ★ 2026-11-16: 版同じでも read_count=0 なら「届いていない」扱い → 取り直して印を付ける。
           *   版同じかつ既に読まれている時は mark_read=1 だけ飛ばしてスキップ（重い束は取らない）。
           */
          var _serverRead = (hj && typeof hj.read_count === "number") ? hj.read_count : 0;
          var _serverSolid = (hj && typeof hj.screen_solid === "number") ? hj.screen_solid : null;
          var _needsAuto = !!(hj && hj.needs_auto);
          /** ★ 2026-11-23: 手順書決まり版（attach で generated_at 据え置きでも検知） */
          var _serverRulesV = (hj && hj.playbook_rules_v != null) ? String(hj.playbook_rules_v) : "";
          var _localRulesV = "";
          try {
            var _lpb = st && st.axlx_learn_playbook;
            if (_lpb && typeof _lpb === "object") _localRulesV = String(_lpb.rules_v || "");
          } catch (_) {}
          var _rulesStale = !!(!_serverRulesV || !_localRulesV ? false : _serverRulesV !== _localRulesV);
          if (_rulesStale) {
            try { console.log("[learn] 手順書の決まり版が違う（手元" + _localRulesV.slice(0, 8) + "→サーバ" + _serverRulesV.slice(0, 8) + "）→取り直します"); } catch (_) {}
          }
          /**
           * ★ 2026-11-17「学習しても改善されない／反映の抜け」:
           *   版同じでも (1) サーバー solid が手元より多い → 取り直す
           *   (2) needs_auto → 印を付けて返す（自動1回を促す・束は再取しない）
           */
          var _localSolid = null;
          try {
            var _lnk0 = st && st.axlx_learn_link;
            if (_lnk0 && typeof _lnk0.screen_solid === "number") _localSolid = _lnk0.screen_solid;
          } catch (_) {}
          if (!_rulesStale && hv && hv === lastVer) {
            /**
             * ★ 2026-11-17 実測 2.8.76: 版同じ・read≥1 でも axlx_learn_screen が空 → aim無・reflect_gap。
             *   → 手元 solid=0／screen空 かつサーバ solid>0 なら必ず取り直す。
             */
            var _localScreenN = 0;
            try {
              var _scr0 = st && st.axlx_learn_screen;
              if (_scr0 && typeof _scr0 === "object") _localScreenN = Object.keys(_scr0).length;
            } catch (_) {}
            if (_serverRead <= 0) {
              try { console.log("[learn] 版同じだが未読(read_count=0)→取り直して印を付けます"); } catch (_) {}
            } else if (_serverSolid != null && _localSolid != null && _serverSolid > _localSolid) {
              try { console.log("[learn] 版同じだが solid 増（手元" + _localSolid + "→サーバ" + _serverSolid + "）→取り直します"); } catch (_) {}
            } else if ((_localSolid === 0 || _localSolid == null || _localScreenN === 0) && _serverSolid != null && _serverSolid > 0) {
              try { console.log("[learn] 版同じだが手元screen空/solid0（サーバ solid=" + _serverSolid + "）→取り直します"); } catch (_) {}
            } else if (_localScreenN === 0 && Date.now() - (Number(st && st.axlx_learn_empty_refetch_at) || 0) > 10 * 60 * 1000) {
              /**
               * ★ 2026-11-19: 本番の版確認が screen_solid を返さない時（_serverSolid=null）も、
               *   手元の画面位置が空なら取り直す（10分に1回まで・サーバーの負担を抑える）。
               */
              try { console.log("[learn] 版同じだが手元screen空（サーバ solid 不明）→取り直します"); } catch (_) {}
              try { await chrome.storage.local.set({ axlx_learn_empty_refetch_at: Date.now() }); } catch (_) {}
            } else {
              var _localNextN = 0;
              var _localPtsN = 0;
              try { _localNextN = Object.keys(st.axlx_learn_next || {}).length; } catch (_) {}
              try { _localPtsN = Object.keys(st.axlx_learn_points || {}).length; } catch (_) {}
              if (_needsAuto && (_localNextN === 0 || _localPtsN === 0 || _localScreenN === 0)) {
                try {
                  console.log("[learn] needs_autoだが手元の束が薄い（next=" + _localNextN + " points=" + _localPtsN + " screen=" + _localScreenN + "）→取り直します");
                } catch (_) {}
              } else {
              /**
               * ★ 2026-11-17 実測: same_version のたびに mark_read×3 を飛ばし
               *   read_count が 0→738 まで水増し（束は読んだが自動未使用なのに「拡張が読んだ738回」と誤認）。
               *   → 心拍では mark_read しない。印は**実際に束を取り込んだ時だけ**付ける。
               */
              try {
                await chrome.storage.local.set({
                  axlx_learn_needs_auto: _needsAuto,
                  axlx_learn_server_solid: _serverSolid,
                });
              } catch (_) {}
              return {
                ok: true,
                skipped: "same_version",
                server_read_count: _serverRead,
                screen_solid: _serverSolid,
                needs_auto: _needsAuto,
                link: _needsAuto ? "needs_auto" : "same_version",
              };
              }
            }
          }
          if (hv && !lastVer) {
            // 初回でも、既に同じ版の束が storage に入っているなら取り直さない
            var bySiteNow = st && st.axlx_learn_by_site;
            if (bySiteNow && typeof bySiteNow === "object" && Object.keys(bySiteNow).length) {
              await chrome.storage.local.set({ axlx_learn_ver: hv });
              if (_serverRead <= 0) {
                try { console.log("[learn] 手元に束あり・サーバー未読→取り直して印を付けます"); } catch (_) {}
              } else {
                // ★ 2026-11-17: ここも mark_read 連打しない（上と同じ穴）
                return { ok: true, skipped: "same_version_first", server_read_count: _serverRead, needs_auto: _needsAuto };
              }
            }
          } else if (hv && hv !== lastVer) {
            console.log("[learn] 学習が新しくなりました（" + lastVer + " → " + hv + "）→ 取り込みます");
          }
        }
      } catch (e) {
        // ⚠ 版が読めなくても取りに行く（安全側）。理由を残す（次に同じ事が起きたら分かる）
        try { console.log("[learn] 版を確かめられません（取りに行きます）:", (e && e.message) || e); } catch (_) {}
      }
    }
    // touch=1（既定）で読む＝**読んだ印**をサーバーに残す（どの PC が読んでいるか分かる）
    /**
     * 2026-11-14 竹内さん「リアプロ itandi それぞれちゃんと区別して学習。それぞれの性質を理解するためにも
     *   改善していくためにも必要」:
     *
     *   ⚠ 旧は `?scope=` を付けずに読んでいたので、**リアプロと itandi の学びが1つに混ざった束**を
     *     両方のサイトで使っていた。サイトごとに手順も欄の名前も違うので、
     *     混ぜると「itandi で学んだ順番をリアプロで使う」ような**誤適用**が起きる。
     *
     *   → **サイトごとに別々に取る**（`?scope=realpro` / `?scope=itandi`）。
     *     ・`axlx_learn_by_site` … `{ realpro: {next, points, ...}, itandi: {...} }`（サイト別の正本）
     *     ・今までのキー（`axlx_learn_next` など）は**今いるサイトの物**を入れる
     *       （page-script は今まで通り読める＝変更が要らない）
     */
    var SITES = ["realpro", "itandi"];
    var perSite = {};
    for (var si = 0; si < SITES.length; si++) {
      var sc = SITES[si];
      try {
        var sres = await fetch(SUMORA_BATCH_API + "/api/human-learn-profile?scope=" + sc, { cache: "no-store", signal: AbortSignal.timeout(40000) });
        if (!sres.ok) continue;
        var sjson = await sres.json();
        if (sjson && sjson.bundle && typeof sjson.bundle === "object") {
          perSite[sc] = sjson.bundle;
          try {
            if (typeof sjson.read_count === "number") perSite[sc]._server_read_count = sjson.read_count;
          } catch (_) {}
        }
      } catch (_) { /* 片方が取れなくても、もう片方は使う */ }
    }
    // 今いるタブのサイト（分からなければ realpro）
    var curSite = "realpro";
    try {
      var tabsNow = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      var uNow = String((tabsNow && tabsNow[0] && tabsNow[0].url) || "");
      if (/itandibb\.com/.test(uNow)) curSite = "itandi";
      else if (/realnetpro\.com/.test(uNow)) curSite = "realpro";
    } catch (_) {}
    /**
     * ★ 2026-11-15 竹内さん「改善したら更新されていく」「ボトルネックとなっている部分改善」:
     *   ⚠ 実測: `all` に画面位置 x/y=71・n≥3=33 があるのに、拡張は **古い realpro**（x/y=0）を優先して
     *     **全体を見に行かなかった** → 学んでも自動に届かない（ボトルネックの本体）。
     *   → **必ず all も取る**。サイト別と全体で **新しい方を正**にする。
     *     サイト別の next/points はサイト別を優先しつつ、`shots.learned`（画面位置）は新しい方から載せる。
     */
    var allBundle = null;
    try {
      var allRes = await fetch(SUMORA_BATCH_API + "/api/human-learn-profile", { cache: "no-store", signal: AbortSignal.timeout(40000) });
      if (allRes.ok) {
        var allJson = await allRes.json();
        if (allJson && allJson.bundle && typeof allJson.bundle === "object") {
          allBundle = allJson.bundle;
          try {
            if (typeof allJson.read_count === "number") allBundle._server_read_count = allJson.read_count;
          } catch (_) {}
        }
      }
    } catch (_) {}
    function _genMs(b) {
      if (!b || typeof b !== "object") return 0;
      return Date.parse(String(b.generated_at || "")) || 0;
    }
    function _mergeLearnedShots(into, from) {
      if (!into || !from) return into;
      try {
        if (!into.shots || typeof into.shots !== "object") into.shots = {};
        if (from.shots && from.shots.learned) into.shots.learned = from.shots.learned;
        if (from.shots && typeof from.shots.total === "number") into.shots.total = from.shots.total;
        if (from.screen_flow && typeof from.screen_flow === "object") into.screen_flow = from.screen_flow;
      } catch (_) {}
      return into;
    }
    var siteBundle = perSite[curSite] || null;
    var bundle = null;
    if (siteBundle && allBundle) {
      if (_genMs(allBundle) > _genMs(siteBundle)) {
        // 全体の方が新しい＝学習が進んだ側。サイト別の順番は残しつつ、画面位置は全体から載せる
        bundle = siteBundle;
        _mergeLearnedShots(bundle, allBundle);
        // サイト別の next が薄い時は全体の next/points も新しい方で補う
        try {
          if ((!bundle.next || !Object.keys(bundle.next).length) && allBundle.next) bundle.next = allBundle.next;
          if ((!bundle.points || !Object.keys(bundle.points).length) && allBundle.points) bundle.points = allBundle.points;
          if (allBundle.supervisor) bundle.supervisor = allBundle.supervisor;
          bundle.generated_at = allBundle.generated_at || bundle.generated_at;
        } catch (_) {}
        console.log("[learn] 全体の束の方が新しい → 画面位置を all から載せました（" + curSite + " は " + String((siteBundle.generated_at || "")).slice(0, 19) + " / all " + String((allBundle.generated_at || "")).slice(0, 19) + "）");
      } else {
        bundle = siteBundle;
      }
    } else {
      bundle = siteBundle || allBundle;
    }
    // perSite 台帳にも、新しい画面位置を載せておく（サイト切替ですぐ使える）
    if (allBundle && _genMs(allBundle) > 0) {
      for (var _psk in perSite) {
        if (_genMs(allBundle) > _genMs(perSite[_psk])) _mergeLearnedShots(perSite[_psk], allBundle);
      }
      if (!perSite[curSite] && allBundle) perSite[curSite] = allBundle;
    }
    if (!bundle || typeof bundle !== "object") {
      // まだ束が無い（学習の記録が少ない・cron の前）→ 何もしない
      await chrome.storage.local.set({ axlx_learn_at: Date.now() });
      return { ok: true, empty: true };
    }
    var next = (bundle.next && typeof bundle.next === "object") ? bundle.next : {};
    var points = (bundle.points && typeof bundle.points === "object") ? bundle.points : {};
    // 2026-11-13: サーバーが計算した**動き・間・弱い所・サイトの手順**も一緒に置く（捨てない）
    var motion = (bundle.motion && typeof bundle.motion === "object") ? bundle.motion : {};
    var gaps = (bundle.gaps && typeof bundle.gaps === "object") ? bundle.gaps : {};
    var weak = Array.isArray(bundle.weak) ? bundle.weak.slice(0, 80) : [];
    var siteFlow = (bundle.site_flow && typeof bundle.site_flow === "object") ? bundle.site_flow : {};
    /**
     * 2026-11-13 竹内さん「録画した画像もみて押し方や仕組みなども学習おねがい
     *   抜けている部分徹底的に学習できるように」:
     *   **写真から学んだ画面ごとの手順**（地域の小窓・駅の小窓・条件の入力）も置く。
     *   ⚠ 旧は計算して返しているのに、拡張が受け取っていなかった（＝現場に届かない）。
     */
    var screenFlow = (bundle.screen_flow && typeof bundle.screen_flow === "object") ? bundle.screen_flow : {};
    /**
     * 2026-11-14 竹内さん「一連の動きの学習や強化、反映の為に抜けている部分がある可能性もある」:
     *   ⚠ **サーバーで計算したのに拡張が1つも読んでいなかった物**（実測 0箇所）:
     *     `by_mode`（モード別の学び）・`mode_plan`（統括の判断）・
     *     `sequence_flow`（一連の動きの型）・`learn_plan`（次にやる事）。
     *   → 現場（自動モード）で使えるように storage へ置く。
     *     ・`axlx_learn_seq` … 一連の動きの型（押す順番の鎖）
     *     ・`axlx_learn_by_mode` … モード別の押す順番
     *     ・`axlx_learn_plan` … 統括の判断（何が足りないか）
     */
    var seqFlow = (bundle.sequence_flow && typeof bundle.sequence_flow === "object") ? bundle.sequence_flow : {};
    var byMode = (bundle.by_mode && typeof bundle.by_mode === "object") ? bundle.by_mode : {};
    var plan = (bundle.learn_plan && typeof bundle.learn_plan === "object") ? bundle.learn_plan : {};
    /**
     * 2026-11-14 竹内さん「ボタンなのかプルダウンなのか、どこで展開されるのかも意識して学習して改善する」:
     *   **押したら何が開くか**（modal / options / form / result）も置く。
     *   ⚠ サーバーが計算して返しているのに拡張が読まなければ、現場では使われない（学習が届かない）。
     */
    var opens = (bundle.opens && typeof bundle.opens === "object") ? bundle.opens : {};
    /** ★ 2026-11-16: 通常録画で手が付いた欄（見えるカーソルの手の形学習） */
    var cursorHand = (bundle.cursor_hand && typeof bundle.cursor_hand === "object") ? bundle.cursor_hand : {};
    /** 今のモードの押す順番（あれば mode 別、無ければ全体） */
    var myMode = await _modeLabelNow();
    var modeNext = (myMode && byMode[myMode] && byMode[myMode].next) ? byMode[myMode].next : null;
    /**
     * ★ 2026-11-15 竹内さん「理論上この通常のように自動もできる」「実装する」:
     *   **画像から読んだ「画面のどこか」**を、押す位置とは**別の入れ物**に入れる。
     *   ⚠ 押す位置（`axlx_learn_points`）は**要素の中の割合**。画像の位置は**画面の割合**。
     *     意味が違うので混ぜない。
     * ★ 2026-11-17 統括Pro「押した位置35%→60%／aim無だらけ」:
     *   旧は n≥3 だけ → flashで読んだ弱い欄（n=1〜2）が storage に載らず aim無のまま。
     *   → **n≥1 も載せる**（thin）。連携完了の solid 数えは n≥3 のまま。
     */
    var _screenAim = {};
    try {
      var learned = (bundle.shots && bundle.shots.learned) ? bundle.shots.learned : null;
      if (learned && typeof learned === "object") {
        for (var _sc in learned) {
          var list = Array.isArray(learned[_sc]) ? learned[_sc] : [];
          for (var _i = 0; _i < list.length; _i++) {
            var f = list[_i];
            if (!f || typeof f.name !== "string" || typeof f.x !== "number" || typeof f.y !== "number") continue;
            if ((Number(f.n) || 0) < 1) continue;
            var k = String(f.name).slice(0, 40);
            if (!_screenAim[k] || (Number(_screenAim[k].n) || 0) < (Number(f.n) || 0)) {
              _screenAim[k] = {
                x: Math.round(f.x * 100) / 100,
                y: Math.round(f.y * 100) / 100,
                n: Number(f.n) || 0,
                kind: f.kind || null,
                screen: _sc,
                thin: (Number(f.n) || 0) < 3,
              };
            }
          }
        }
      }
      /** ★ 2026-11-17: HTML名↔日本語名を複製（page-script の別名引きと二重で連動） */
      var _aimAliasPairs = [
        ["city_code[]", "所在地絞り込み", "所在地を絞り込み", "区を選ぶ"],
        ["route_id[]", "沿線を選ぶ", "沿線・駅絞り込み＋", "沿線・駅絞り込み", "路線"],
        ["station_id[]", "駅", "駅を選ぶ"],
        ["transportation_id", "駅からの移動手段", "移動手段"],
        ["required_time", "分数", "徒歩分数", "駅徒歩"],
        ["rental_cost1", "賃料下限", "下限賃料", "賃料"],
        ["rental_cost2", "賃料上限", "上限賃料"],
        ["update_date", "更新日"],
        ["structured_date", "築年数", "築年"],
        ["確定してリストへ", "確定してリストへ｜span", "確定"],
      ];
      for (var _ap = 0; _ap < _aimAliasPairs.length; _ap++) {
        var _pair = _aimAliasPairs[_ap];
        var _src = null;
        for (var _pj = 0; _pj < _pair.length; _pj++) {
          var _pv = _screenAim[_pair[_pj]];
          if (_pv && typeof _pv.x === "number" && typeof _pv.y === "number") {
            if (!_src || (Number(_pv.n) || 0) > (Number(_src.n) || 0)) _src = _pv;
          }
        }
        if (!_src) continue;
        for (var _pk = 0; _pk < _pair.length; _pk++) {
          var _nm = _pair[_pk];
          if (!_screenAim[_nm] || (Number(_screenAim[_nm].n) || 0) < (Number(_src.n) || 0)) {
            _screenAim[_nm] = { x: _src.x, y: _src.y, n: _src.n, kind: _src.kind || null, screen: _src.screen || null };
          }
        }
      }
    } catch (_) {}
    /**
     * ★ 2026-11-15 竹内さん「学習からの連携をしっかり完了するまで一連の流れを拡張ちゃんと把握して
     *   新しくなったら新しくしたのもちゃんと把握してつくる」:
     *   取り込みのたびに **一連の到達点**を storage に残す（版・前の版・画面位置の数・完了か）。
     *   ⚠ これが無いと「取ったつもり・新しいのに古い」が現場で分からない。
     */
    /**
     * ★ 2026-11-18 竹内さん「場面ごとの強化を画像学習にも紐づける」:
     *   束の shots.learned_scene（場面 area/station/cond… ごとの欄の位置）を axlx_learn_scene へ。
     *   拡張は「今いる場面」の位置を先に引き、無ければ従来の axlx_learn_screen（画面単位）へ戻る。
     */
    var _sceneAim = {};
    try {
      var _ls = (bundle.shots && bundle.shots.learned_scene) ? bundle.shots.learned_scene : null;
      if (_ls && typeof _ls === "object") {
        for (var _sck in _ls) {
          var _sarr = _ls[_sck];
          if (!Array.isArray(_sarr)) continue;
          var _sm = {};
          for (var _si = 0; _si < _sarr.length; _si++) {
            var _sf = _sarr[_si];
            if (!_sf || typeof _sf.name !== "string" || typeof _sf.x !== "number" || typeof _sf.y !== "number") continue;
            if ((Number(_sf.n) || 0) < 2) continue;
            var _sk = String(_sf.name).slice(0, 40);
            if (!_sm[_sk] || (Number(_sm[_sk].n) || 0) < (Number(_sf.n) || 0)) {
              _sm[_sk] = { x: Math.round(_sf.x * 100) / 100, y: Math.round(_sf.y * 100) / 100, n: Number(_sf.n) || 0, kind: _sf.kind || null };
            }
          }
          if (Object.keys(_sm).length) _sceneAim[String(_sck).slice(0, 12)] = _sm;
        }
      }
    } catch (_) { _sceneAim = {}; }
    /**
     * ★ 2026-11-19 竹内さん「束不安定なのはどう改善したら最善なのか」→「拡張の保険」:
     *   本番の作り直し（#2413〜#2420）は位置0の束を出し、手元の良い位置を空で上書きしていた。
     *   → サイトごとに最後の良い位置を控え（axlx_learn_screen_keep）、新しい束が位置0ならそのサイトの控えを使う。
     *   ⚠ 控えはサイト別（リアプロの位置を ITANDI に使わない・タブ切替で消さない）。
     */
    var _screenKept = null;
    try {
      var _keepSt = await chrome.storage.local.get(["axlx_learn_screen_keep"]);
      var _keep = (_keepSt && _keepSt.axlx_learn_screen_keep && typeof _keepSt.axlx_learn_screen_keep === "object")
        ? _keepSt.axlx_learn_screen_keep : {};
      var _ks = String(curSite || "");
      if (_ks) {
        if (Object.keys(_screenAim).length) {
          _keep[_ks] = { screen: _screenAim, scene: _sceneAim, ver: String(bundle.generated_at || ""), at: Date.now() };
          await chrome.storage.local.set({ axlx_learn_screen_keep: _keep });
        } else if (_keep[_ks] && _keep[_ks].screen && typeof _keep[_ks].screen === "object" && Object.keys(_keep[_ks].screen).length) {
          _screenAim = _keep[_ks].screen;
          if (!Object.keys(_sceneAim).length && _keep[_ks].scene && typeof _keep[_ks].scene === "object") _sceneAim = _keep[_ks].scene;
          _screenKept = String(_keep[_ks].ver || "kept").slice(0, 19);
          try { console.log("[learn] 新しい束の画面位置が0 → " + _ks + " の控え（版 " + _screenKept + "）を使います"); } catch (_) {}
        }
      }
    } catch (_) {}
    var _screenAllKeys = Object.keys(_screenAim).length;
    var _screenSolid = 0;
    try {
      for (var _ssk in _screenAim) {
        if ((Number(_screenAim[_ssk].n) || 0) >= 3) _screenSolid++;
      }
    } catch (_) { _screenSolid = 0; }
    var _screenAll = 0;
    try {
      var _lrn = (bundle.shots && bundle.shots.learned) ? bundle.shots.learned : null;
      if (_lrn && typeof _lrn === "object") {
        for (var _sc2 in _lrn) {
          var _lst2 = Array.isArray(_lrn[_sc2]) ? _lrn[_sc2] : [];
          for (var _j2 = 0; _j2 < _lst2.length; _j2++) {
            if (_lst2[_j2] && typeof _lst2[_j2].x === "number" && typeof _lst2[_j2].y === "number") _screenAll++;
          }
        }
      }
    } catch (_) {}
    var _newVer = String(bundle.generated_at || "");
    var _prevVer = lastVer || "";
    var _updated = !!(_newVer && _prevVer && _newVer !== _prevVer);
    var _linkComplete = _screenSolid >= 3 && Object.keys(next).length > 0 && Object.keys(points).length > 0;
    var _link = {
      ver: _newVer,
      prev_ver: _prevVer || null,
      updated: _updated,
      at: new Date().toISOString(),
      site: curSite,
      next: Object.keys(next).length,
      points: Object.keys(points).length,
      screen_solid: _screenSolid,
      screen_all: _screenAll,
      screen_keys: _screenAllKeys,
      screen_kept: _screenKept,
      complete: _linkComplete,
      server_read_count: (typeof bundle._server_read_count === "number")
        ? bundle._server_read_count
        : ((perSite[curSite] && typeof perSite[curSite]._server_read_count === "number")
          ? perSite[curSite]._server_read_count
          : null),
      steps: [
        "1.サーバーの束を取得（read印つき）",
        "2.サイト別と全体で新しい方を採用",
        "3.画面位置 n≥1=" + _screenAllKeys + "欄（うち solid n≥3=" + _screenSolid + "）を axlx_learn_screen へ",
        "4.順番 " + Object.keys(next).length + "・場所 " + Object.keys(points).length + " を配置",
        _linkComplete ? "5.連携完了（自動が使える状態）" : "5.まだ不足（画面位置か順番が薄い）",
        "6.自動1回で効果確認（F6/F31/F38・読んだだけでは改善済みにしない）",
      ],
      needs_auto: true,
    };
    if (_updated) {
      try { console.log("[learn] ★学びが新しくなりました: " + _prevVer.slice(0, 19) + " → " + _newVer.slice(0, 19) + "／画面位置 keys=" + _screenAllKeys + " solid=" + _screenSolid + "／連携" + (_linkComplete ? "完了" : "未完了")); } catch (_) {}
    } else {
      try { console.log("[learn] 学びを取り込みました（版 " + _newVer.slice(0, 19) + "）画面位置 keys=" + _screenAllKeys + " solid=" + _screenSolid + " 連携" + (_linkComplete ? "完了" : "未完了")); } catch (_) {}
    }
    await chrome.storage.local.set({
      axlx_learn_screen: _screenAim,
      axlx_learn_scene: _sceneAim,
      axlx_learn_link: _link,
      axlx_learn_next: next,
      axlx_learn_points: points,
      axlx_learn_motion: motion,
      axlx_learn_gaps: gaps,
      axlx_learn_weak: weak,
      axlx_learn_site_flow: siteFlow,
      axlx_learn_screen_flow: screenFlow,
      /**
       * 2026-11-14 竹内さん「リアプロ itandi それぞれちゃんと区別して学習」:
       *   **サイト別の正本**（リアプロ用と itandi 用を別々に持つ）。
       *   ⚠ 上のキー（`axlx_learn_next` など）は**今いるサイトの物**なので、
       *     タブを切り替えた時に取り直せば、そのサイトの学びに切り替わる。
       */
      axlx_learn_by_site: perSite,
      /**
       * 2026-11-14 竹内さん「学習の統括の部分判断できるようにちゃんと強化していく」:
       *   統括の**判断**（結論・次にやる事・数字）も置く。
       *   ⚠ これが無いと「今の学びを自動検索に渡してよいか」が現場で分からない。
       */
      axlx_learn_supervisor: (bundle.supervisor && typeof bundle.supervisor === "object") ? bundle.supervisor : null,
      axlx_learn_supervisor_by_site: (bundle.supervisor_by_site && typeof bundle.supervisor_by_site === "object") ? bundle.supervisor_by_site : null,
      /**
       * 2026-11-14 竹内さん「自動検索の部分これでちゃんと強化されたかな」→ **まだだった**。
       *
       *   ⚠ サーバーで**場面ごとの手順**（`scene_flows`・人が実際に押した順）を作ったのに、
       *     拡張は**1箇所も読んでいなかった**（実測 0箇所）。
       *     ＝「計算したが現場に届かない」を、前回（`screen_flow`）と**同じ穴でもう一度**作っていた。
       *
       *   → 自動検索が使える形で置く:
       *     ・`axlx_learn_scene_flows` … 場面ごとの手順（area/station/cond/search/list/next）
       *     ・`axlx_learn_stopped_scene` … 止まる回が多い場面（自動が「ここで慎重に」を選べる）
       *     ・`axlx_learn_scene_missing` … 手本が無い場面（自動で**推測しない**ための印）
       *   ⚠ これらは**並べ替えの材料**として使う（項目の増減は絶対にしない＝検索漏れを出さない）。
       */
      axlx_learn_scene_flows: Array.isArray(bundle.scene_flows) ? bundle.scene_flows.slice(0, 12) : null,
      axlx_learn_stopped_scene: (typeof bundle.stopped_scene === "string" && bundle.stopped_scene) ? bundle.stopped_scene : null,
      axlx_learn_scene_missing: (typeof bundle.scene_missing === "number" && bundle.scene_missing > 0)
        ? { n: bundle.scene_missing, names: String(bundle.scene_missing_names || "") } : null,
      /**
       * 2026-11-20 竹内さん「手順書は束の中に載せる」: 束から作った手順書（場面の手順・押す位置・開く欄・次のページの件数）。
       *   ⚠ 並べ替え・確かめの材料として使う（項目の増減はしない）。サーバーが作れなかった時は null。
       */
      axlx_learn_playbook: (bundle.playbook && typeof bundle.playbook === "object") ? bundle.playbook : null,
      /** 今どのサイトの学びを上のキーに入れたか（点検用） */
      axlx_learn_for_site: curSite,
      /** サイト別に何が学べているか（1行ずつ） */
      axlx_learn_site_summary: (function () {
        var o = {};
        for (var k in perSite) {
          if (!Object.prototype.hasOwnProperty.call(perSite, k)) continue;
          var b = perSite[k] || {};
          o[k] = {
            rows: (b.source && b.source.rows) || 0,
            next: Object.keys(b.next || {}).length,
            points: Object.keys(b.points || {}).length,
            opens: Object.keys(b.opens || {}).length,
            screens: Object.keys(b.screen_flow || {}).length,
            mode: (b.mode_counts || null),
          };
        }
        return o;
      })(),
      axlx_learn_opens: opens,
      axlx_learn_cursor_hand: cursorHand,
      axlx_learn_shots: (bundle.shots && typeof bundle.shots === "object") ? bundle.shots : null,
      axlx_learn_seq: seqFlow,
      axlx_learn_by_mode: byMode,
      axlx_learn_plan: plan,
      /** モード別の押す順番（そのモードで学べている時だけ） */
      ...(modeNext ? { axlx_learn_next_mode: modeNext, axlx_learn_next_mode_name: myMode } : {}),
      axlx_learn_at: Date.now(),
      /** 2026-11-14: 学習の版（変わったら取り直す印） */
      axlx_learn_ver: String(bundle.generated_at || ""),
      axlx_learn_src: { rows: (bundle.source && bundle.source.rows) || 0, at: bundle.generated_at || null, dropped: bundle.dropped_cols || null },
      /**
       * ★ 2026-11-17: 新束を読んだ直後は「自動未確認」。自動1回後に false にする。
       *   学習しても改善されない抜け＝読むだけで終わるのを止める印。
       */
      axlx_learn_needs_auto: _linkComplete,
      axlx_learn_server_solid: _screenSolid,
      /** ★ 2.8.183: 更新直後の強制取込が成功したら印を下ろす（次回は版確認だけでよい） */
      axlx_learn_after_update: false,
    });
    console.log("[learn] 学習の束を取り込みました: 順番 " + Object.keys(next).length + "通り・場所 " + Object.keys(points).length + "個・弱い所 " + weak.length + "件・画面 " + Object.keys(screenFlow).length + "種類・一連 " + ((seqFlow.sequence || []).length) + "手・展開先 " + Object.keys(opens).length + "個"
      + (modeNext ? "・モード別(" + myMode + ") " + Object.keys(modeNext).length + "通り" : "")
      + "・サイト " + Object.keys(perSite).join("/")
      + (_linkComplete ? "・⚠自動1回で効果確認" : ""));
    /**
     * 2026-11-14 竹内さん「学習の統括の部分判断できるようにちゃんと強化していく」:
     *   統括の判断を1行で出す（現場で「今の学びを使ってよいか」が分かる）。
     */
    try {
      var sup = bundle.supervisor;
      if (sup && sup.headline) {
        console.log("[learn] 統括: " + sup.headline + (sup.score ? "（材料 " + sup.score.coverage + "/100・弱い所 " + sup.score.weak + "件）" : ""));
        if (sup.block) console.warn("[learn] 統括の警告: " + sup.block);
        if (Array.isArray(sup.actions) && sup.actions.length) {
          console.log("[learn] 次にやる事: " + sup.actions.slice(0, 3).map(function (a) { return a.what; }).join(" / "));
        }
      }
    } catch (_) {}
    return {
      ok: true, next: Object.keys(next).length, points: Object.keys(points).length, weak: weak.length,
      opens: Object.keys(opens).length,
      screens: Object.keys(screenFlow).length, seq: ((seqFlow.sequence || []).length),
      mode: myMode, mode_next: modeNext ? Object.keys(modeNext).length : 0,
      screen_solid: _screenSolid, screen_all: _screenAll,
      updated: _updated, complete: _linkComplete, ver: _newVer, prev_ver: _prevVer || null,
      needs_auto: _linkComplete,
      link: _linkComplete ? "needs_auto" : "incomplete",
      server_read_count: _link.server_read_count,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
/**
 * 起動した時（前回から5分たっていれば版を確かめ、新しければ取りに行く）。
 *   ★ 2026-11-15 竹内さん「起動の時はずらす」（依頼1-3）
 *     ⚠ 旧は**全端末が同じ瞬間**に取りに行った（事務所の PC を同時に起動すると全部が重なる）。
 *     → **0〜30秒のずらし**を入れる（端末ごとにばらばら＝同時に来ない）。
 *     ⚠ ずらしても、起動直後に必要な物は storage に**前回の束**が残っているので動く。
 */
try {
  setTimeout(function () {
    _refreshLearnedBundleQueued(false).catch(function () {});
  }, _learnStartJitterMs());
} catch (_) {}
/**
 * 2026-11-14 竹内さん「学習して改善したら自動モード強化されるように」:
 *   **5分ごと**に版を確かめ、新しければ取り込む。
 *   ⚠ 版が同じなら通信は1回だけ（軽い）。
 *   ★ 2026-11-15: 実際に走るのは `Queued`（同時1本・失敗後は間隔をあける）。
 *     ⚠ 全端末が同じタイミングにならないよう、**開始を少しばらす**（0〜60秒）。
 */
/**
 * ★ 2026-11-15「新しくなったら把握して取り込む」:
 *   通常は5分・自動モード中は1分で版を見る（setInterval は短い方で回し、中で間隔を見る）。
 */
try {
  setTimeout(function () {
    setInterval(function () {
      _refreshLearnedBundleQueued(false).catch(function () {});
    }, _LEARN_CHECK_AUTO_MS);
  }, Math.floor(Math.random() * 60000));
} catch (_) {}
try {
  chrome.runtime.onMessage.addListener(function (msg, _s, sendResponse) {
    if (!msg) return;
    if (msg.type === "axlx-learn-refresh") { _refreshLearnedBundleQueued(true).then(function (r) { try { sendResponse(r); } catch (_) {} }); return true; }
    /**
     * ★ 2.8.238: 詰まり時にリアプロタブを前へ（画面照会で tab_hidden の最善次手）
     */
    if (msg.type === "axlx-stuck-focus-tab") {
      (async function () {
        try {
          var tabs = await chrome.tabs.query({ url: ["*://www.realnetpro.com/*", "*://*.realnetpro.com/*"] });
          var t = tabs && tabs[0];
          if (!t || t.id == null) { try { sendResponse({ ok: false, error: "no_tab" }); } catch (_) {} return; }
          try { await chrome.tabs.update(t.id, { active: true }); } catch (_) {}
          try { if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true }); } catch (_) {}
          try { sendResponse({ ok: true, tabId: t.id }); } catch (_) {}
        } catch (e) {
          try { sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 80) }); } catch (_) {}
        }
      })();
      return true;
    }
    /**
     * ★ 2026-11-17: page-script が learn_reflect_ok を出したら即連動完了印。
     *   fill-done 前に反映できた回も needs_auto を下ろせる。
     */
    if (msg.type === "axlx-learn-auto-linked") {
      try {
        if (msg.ok) {
          chrome.storage.local.set({
            axlx_learn_needs_auto: false,
            axlx_learn_auto_linked: true,
            axlx_learn_auto_linked_at: Date.now(),
            axlx_learn_auto_linked_screen: Number(msg.screen) || 0,
            axlx_learn_flow_linked: !!msg.flow,
          });
        } else {
          /** ★ F46: 流れ反映不足なら needs_auto を残す（録画強化→自動反映を切らない） */
          chrome.storage.local.set({
            axlx_learn_needs_auto: true,
            axlx_learn_auto_linked: false,
            axlx_learn_flow_linked: !!msg.flow,
            axlx_learn_auto_reflect_miss_at: Date.now(),
          });
        }
      } catch (_) {}
      try { sendResponse({ ok: true }); } catch (_) {}
      return true;
    }
    if (msg.type !== "axlx-learn-status") return;
    chrome.storage.local.get(_LEARN_KEYS.concat(["axlx_learn_src", "axlx_learn_link", "axlx_learn_screen", "axlx_learn_ver"])).then(function (r) {
      var nx = (r && r.axlx_learn_next) || {};
      var pt = (r && r.axlx_learn_points) || {};
      var link = (r && r.axlx_learn_link) || null;
      var scr = (r && r.axlx_learn_screen) || {};
      try {
        sendResponse({
          ok: true,
          at: (r && r.axlx_learn_at) || null,
          src: (r && r.axlx_learn_src) || null,
          ver: (r && r.axlx_learn_ver) || null,
          link: link,
          screen_solid: link && typeof link.screen_solid === "number" ? link.screen_solid : Object.keys(scr).length,
          complete: !!(link && link.complete),
          next_count: Object.keys(nx).length,
          points_count: Object.keys(pt).length,
          sample: Object.keys(nx).slice(0, 5).map(function (k) { return k + " → " + nx[k].next + "（" + nx[k].n + "/" + nx[k].total + "）"; }),
        });
      } catch (_) {}
    });
    return true;
  });
} catch (_) {}

/**
 * 2026-11-12 竹内さん「画面録画モード等のボタンをつけることができればさらに簡単にできるようになる。
 *   画面録画モード押しているときは連続でさつえいされていればちゃんと記録されるので、
 *   それで動かすことができればさらに質が高くなる」
 *
 *   押している間、**1.5〜3.5秒ごと（平均2.5秒）に続けて撮る**（操作の時だけ撮るのでは、画面の移り変わりが残らない）。
 *   ・撮る中身は今までと同じ道（`_takeShot`）＝縮小・Storage 送信・上限の掃除も同じ
 *   ・間隔は毎回ばらつかせる（等間隔で撮ると機械らしい）
 *   ・**最大 7分**（竹内さん「最大時間も7分とかでくひりいれといた方が良い」）。
 *     7分 × 平均2.5秒 ＝ およそ **170枚**。1検索（30秒〜3分）は十分収まる。
 *   ・枚数の上限（400枚）も残す（二重の歯止め）
 *   ・止める: もう一度ボタンを押す／7分たつ／400枚たまる／`axlx_rec_mode` が消える
 *   ⚠ Service Worker は30秒で眠る事があるので、**chrome.alarms**（1分より短くは作れない）ではなく
 *     storage の値を見張る＋短い setTimeout の連鎖で回す（動いている間は眠らない）。
 */
var _recTimer = null;
/**
 * 2026-11-14 竹内さん「通常と自動のところで自動で強化必要な部分強化する」:
 *   今のモードを1語で返す（写真と記録の `mode` 列に入れる）。
 *   ⚠ これが無いと「自動の時に何が起きたか」「通常の時に何を学んだか」を分けられない。
 *   ⚠ 読めない時は null（推測で埋めない）。
 */
async function _modeLabelNow() {
  try {
    var core = self.AxlxModeCore;
    if (!core || !core.readState) return null;
    var keys = core.STORAGE_KEYS || ["staffMode", "staffModeAt", "aixMode", "aiMode", "brainMode", "autoModeAt"];
    var raw = await chrome.storage.local.get(keys);
    var st = core.readState(raw || {}, Date.now());
    var m = st && st.mode ? String(st.mode) : null;
    return m ? m.slice(0, 20) : null;
  } catch (_) { return null; }
}
/**
 * 2026-11-14 竹内さん「なんで自動モードまだかいぜんされていないのか」:
 *   ⚠ **録画ループが多重に走っていた**（実測: 2分間で392枚・間隔 2ms/17ms。
 *     1.5〜3.5秒間隔なら最大80枚のはず）。
 *   ⚠ 原因: `_recIsOn()` が `!!_recTimer` だけを見ていた。Chrome は Service Worker を
 *     数十秒で止めるので、**起き直すたびに `_recTimer` が null に戻る** →
 *     復帰処理が「録画中」と知りながら**新しいループを追加**していた。
 *     → ループが2本3本になり、`captureVisibleTab` の制限（2回/秒）に当たり続けて
 *       **全部 `capture_error` で失敗**（写真0枚・ops も空）。
 *   → **世代番号で1本だけにする**。古いループは自分の世代でなくなったら黙って止まる。
 */
var _recGen = 0;
var _recCount = 0;
var _recSaved = 0;
var _recFailed = 0;
var _recLastErr = null;
var _recStartedAt = 0;
var _REC_MAX_SHOTS = 400;
/**
 * 2026-11-12 竹内さん「最大時間も7分とかでくひりいれといた方が良い」: 60分 → **7分**。
 *   7分を過ぎたら自動で止める（撮りっぱなしで容量とStorageを圧迫しない）。
 */
var _REC_MAX_MS = 7 * 60 * 1000;
/** 撮る間隔（ミリ秒）。1.5〜3.5秒＝平均2.5秒。7分で約170枚 */
var _REC_GAP_MIN = 1500;
var _REC_GAP_MAX = 3500;
function _recRemainMs() {
  return Math.max(0, _REC_MAX_MS - (Date.now() - _recStartedAt));
}
function _recIsOn() {
  /**
   * 2026-11-14 修正: **世代番号**で判定する（`_recTimer` は Service Worker が止まると消えるので
   *   それだけを見ると「録画していない」と誤判定し、復帰のたびにループが増えていた）。
   */
  return _recGen > 0;
}
async function _recTick(gen) {
  /**
   * 2026-11-14: **自分の世代でなければ黙って止まる**（古いループが生き残らないように）。
   *   ⚠ これが無いと、復帰のたびに増えたループが全部撮りに行き、制限に当たり続ける。
   */
  if (gen != null && gen !== _recGen) return;
  if (!_recIsOn()) return;
  if (_recCount >= _REC_MAX_SHOTS || Date.now() - _recStartedAt > _REC_MAX_MS) {
    await _recStop(_recCount >= _REC_MAX_SHOTS ? "上限" : "7分");
    return;
  }
  // 途中で止められたか（別の窓で止めた時も効く）
  try {
    var st = await chrome.storage.local.get(["axlx_rec_mode"]);
    if (!(st && st.axlx_rec_mode && st.axlx_rec_mode.on)) { await _recStop("解除"); return; }
  } catch (_) {}
  _recCount++;
  /**
   * ⚠ 2026-11-14: ここでもう一度世代を確かめる（`await` の間に止められたかもしれない）。
   *   止められていたら**この1枚は数えない**（二重に数えない）。
   */
  if (gen != null && gen !== _recGen) { _recCount--; return; }
  /**
   * 2026-11-12 竹内さん「ちゃんと撮影されてたかな？」:
   *   ⚠ 旧は「撮った回数」を数えていたので、**クラウドに1枚も入っていなくても「22枚」と出た**。
   *   → **本当に保存できた枚数**（`_recSaved`）と、失敗した回数・理由（`_recFailed` / `_recLastErr`）を別に持つ。
   */
  var r = null;
  try { r = await _recordOneShot(); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  if (r && r.ok) {
    _recSaved++;
  } else {
    _recFailed++;
    _recLastErr = String((r && (r.error || (r.upload && r.upload.error))) || "理由なし").slice(0, 120);
    console.warn("[rec] 保存できませんでした:", _recLastErr);
  }
  try {
    await chrome.storage.local.set({
      axlx_rec_stat: {
        on: true, tried: _recCount, saved: _recSaved, failed: _recFailed,
        last_error: _recLastErr || null,
        started_at: _recStartedAt, last_at: Date.now(),
      },
    });
  } catch (_) {}
  // 1.5〜3.5秒（毎回ちがう・機械的に見せない）。7分の残りが少なければそこで止める
  var gap = _REC_GAP_MIN + Math.floor(Math.random() * (_REC_GAP_MAX - _REC_GAP_MIN));
  /**
   * 2026-11-13 竹内さん「まだ自動モードで地域などの部分おせていない、ここ録画しているので
   *   その点も含めて学習して改善する」（画面に「失敗5」と出て写真が1枚も残らなかった）:
   *   ⚠ 旧は `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota` だけを見て間隔を延ばしていた。
   *     実際の失敗はそれだけではない（権限・窓が前に出ていない・タブが見つからない 等）。
   *   → **失敗の種類ごとに手を打つ**（次の1回で直るように）。
   *     ⚠ 録画は止めない（7分を使い切る）。
   */
  var _kind = _recErrKind(_recLastErr);
  if (_kind === "quota") {
    // 撮りすぎの制限 → 間隔を延ばす（1秒あたり2回まで）
    gap += 800 + Math.floor(Math.random() * 900);
  } else if (_kind === "permission") {
    // 権限が無い → 帯で知らせる（押せば許可できる）。間隔はそのまま
    try { await _recMarkNeedsPermission(); } catch (_) {}
  } else if (_kind === "not_focus") {
    // 窓が前に出ていない → 次は窓を前に出してから撮る（_takeShot 側で実施）
    gap += 200;
  } else if (_kind === "no_tab") {
    // 対象のタブが無い → 少し待つ（人がリアプロを開くのを待つ）
    gap += 1500;
  }
  var left = _recRemainMs();
  if (left > 0 && gap > left) gap = left;
  // 2026-11-14: **自分の世代でだけ**次の1枚を予約する（古いループは予約しない＝増殖しない）
  if (gen == null || gen === _recGen) {
    _recTimer = setTimeout(function () { _recTick(gen).catch(function () {}); }, Math.max(200, gap));
  }
  }
  /**
   * 2026-11-13: 失敗の理由を**種類に分ける**（次の手を決めるため）。
   *   quota … 撮りすぎの制限／permission … 許可が無い／not_focus … 窓が後ろ／no_tab … タブが無い
   */
  function _recErrKind(msg) {
    var s = String(msg || "");
    if (!s) return "unknown";
    if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(s)) return "quota";
    if (/no_permission|permission|許可/i.test(s)) return "permission";
    if (/no_tab|no_tab_found|タブ/i.test(s)) return "no_tab";
    if (/focused|active|activeTab|not.?focus|window/i.test(s)) return "not_focus";
    return "unknown";
  }
  /** 許可が要る事を帯に出す（押せば許可できる・録画は止めない） */
  async function _recMarkNeedsPermission() {
    try {
      await chrome.storage.local.set({
        axlx_rec_need_perm: { at: Date.now(), why: "photo" },
      });
    } catch (_) {}
  }
/**
 * 2026-11-13 竹内さん「録画から学習できるのか」:
 *   録画モードで撮った写真にも**直前までの操作（押す順番の材料）**を付ける。
 *   ⚠ 旧は録画からは `ops` を送っていなかったので、**録画しても押す順番を学べなかった**
 *     （記録の `ops` が 0・`shot_ops` が空）。
 *   → 録画の時も page-script（人と同じ見張り）が持っている直近の操作を読んで送る。
 *     読めない時は null（今まで通り・写真だけ）。
 */
async function _recordOneShot() {
    var ops = null;
    /** 2026-11-14: なぜ操作が取れなかったかを残す印（診断用） */
    var _lastOpsWhy = null;
  var siteName = null;
  try {
    // 録画しているタブに「直近の操作をください」と聞く（page-script が答える）
    var tabs = await chrome.tabs.query({});
    var rp = tabs.filter(function (t) { return t.url && /realnetpro\.com|itandibb\.com|reins\.jp/.test(t.url); });
    if (rp.length) {
      /**
       * 2026-11-14 竹内さん「地域押さなかったのでこっちでおした画面確認して録画した画面」:
       *   ⚠ 実測で **写真200枚すべて ops が空**だった。`rp[0]` は**タブの並び順の先頭**で、
       *     録画している画面（前に出ているタブ）とは限らない。
       *     さらに `sendMessage` は**そのタブの中の content script** にしか届かない。
       *   → **前に出ているタブを最優先**（`active`）→ 無ければリアプロのタブ。
       *     それでも空なら、**リアプロの全タブに聞いて回る**（1つでも答えたら使う）。
       */
      var activeTab = null;
      try {
        var act = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        activeTab = act && act[0] ? act[0] : null;
      } catch (_) { activeTab = null; }
      var order = [];
      if (activeTab && /realnetpro\.com|itandibb\.com|reins\.jp/.test(String(activeTab.url || ""))) order.push(activeTab);
      rp.forEach(function (t) { if (!order.some(function (x) { return x.id === t.id; })) order.push(t); });

      for (var ti = 0; ti < order.length && (!ops || !ops.length); ti++) {
        var tab = order[ti];
        siteName = siteName || (/realnetpro\.com/.test(tab.url) ? "realpro" : (/itandibb\.com/.test(tab.url) ? "itandi" : "reins"));
        /**
         * 2026-11-14 竹内さん「これ録画したの見たら学習できるのでは」→ **学習できていなかった**。
         *
         *   ⚠ 実測: 2.7.41 の 195枚すべて `shot_ops` が `k:"diag"` の1件だけ、理由は
         *     **`no_answer:tab…`（49回）** ＝ **タブが答えていない**。
         *     `human-learn-record.js` は manifest の `document_idle`（読み込み完了後）で入るのに、
         *     録画は `content.js`（`document_start`）の時点で始まる。
         *     → **ページが読み込み中の時は、記録側がまだ居ない**ので答えられない。
         *
         *   → ① 答えが無ければ**少し待ってからもう一度**聞く（ページが落ち着いてから）。
         *     ② それでも駄目なら、**注入してから聞く**（`chrome.scripting.executeScript` が使える時）。
         *     ③ 最後まで駄目なら理由を残す（今まで通り）。
         */
        var resp = await chrome.tabs.sendMessage(tab.id, { type: "axlx-recent-ops" }).catch(function () { return null; });
        if (!resp) {
          // ① ページが落ち着くのを待って、もう一度だけ聞く（人が開いてから操作するまでの間）
          await new Promise(function (r) { setTimeout(r, 900); });
          resp = await chrome.tabs.sendMessage(tab.id, { type: "axlx-recent-ops" }).catch(function () { return null; });
        }
        if (!resp) {
          /**
           * ② 記録側がまだ入っていない → **注入してから聞く**。
           *   ⚠ 失敗しても止めない（権限や状態で入らない事がある）。
           */
          try {
            if (chrome.scripting && chrome.scripting.executeScript) {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ["human-learn.js", "human-learn-record.js"],
              }).catch(function () { return null; });
              await new Promise(function (r) { setTimeout(r, 400); });
              resp = await chrome.tabs.sendMessage(tab.id, { type: "axlx-recent-ops" }).catch(function () { return null; });
            }
          } catch (_) {}
        }
        /**
         * 2026-11-14 竹内さん「データベースの写真から学習する」:
         *   どこで落ちているか（タブに届いていない／輪が空／拾えていない）を**DBに残す**。
         */
        if (!resp) {
          _lastOpsWhy = "no_answer:tab" + tab.id;
        } else if (!Array.isArray(resp.ops)) {
          _lastOpsWhy = "ops_not_array:tab" + tab.id;
        } else if (!resp.ops.length) {
          _lastOpsWhy = "ring_empty:tab" + tab.id + (resp.diag ? ":ring" + resp.diag.ring + ":seen" + resp.diag.seen + ":watch" + resp.diag.watching : "");
        }
        if (resp && Array.isArray(resp.ops) && resp.ops.length) {
          ops = resp.ops;
          _lastOpsWhy = "ok:tab" + tab.id + ":" + resp.ops.length + "件";
          siteName = /realnetpro\.com/.test(tab.url) ? "realpro" : (/itandibb\.com/.test(tab.url) ? "itandi" : "reins");
        }
      }
      /** どのタブから何件取れたか・なぜ取れなかったかを残す（次に空だった時の手がかり） */
      try {
        var d = {}; d.axlx_rec_ops = { at: Date.now(), tabs: order.length, got: ops ? ops.length : 0, site: siteName, why: _lastOpsWhy || null };
        chrome.storage.local.set(d);
      } catch (_) {}
    }
  } catch (_) {}
  return new Promise(function (resolve) {
    try {
      // 2026-11-12: 録画は**送り終わるまで待つ**（「撮れた」と「保存できた」を同じにする）
      /**
       * 2026-11-14 竹内さん「取り組む」（材料つき記録が 7% しかない）:
       *   ⚠ なぜ操作が取れないのか、Chrome の中（`axlx_rec_ops`）にしか無くて**私が見て直せない**。
       *   → **理由を `ops` に混ぜてDBへ送る**（`k:"diag"` の1件として載せる）。
       *     ⚠ 載せるのは**数と理由の言葉だけ**（操作した中身は入れない）。
       *     ⚠ `ops` が空でも、この1件があるので「なぜ空か」がDBに残る。
       *     学習側は `k:"diag"` を**欄の名前として扱わない**ようにする（`f` が無いので自動的に外れる）。
       */
      var _opsForSend = ops;
      if ((!ops || !ops.length) && _lastOpsWhy) {
        _opsForSend = [{ t: Date.now(), k: "diag", f: null, w: null, why: String(_lastOpsWhy).slice(0, 60) }];
      }
      /**
       * ★ 2026-11-17 録画→改善土台: 送信直前に cs 欠落を埋める。
       *   content が古くても / API が補完する前でも、押す系は pointer を落とさない。
       */
      try {
        if (Array.isArray(_opsForSend)) {
          _opsForSend = _opsForSend.map(function (o) {
            if (!o || typeof o !== "object") return o;
            if (o.cs) return o;
            var w = String(o.w || "");
            var f = String(o.f || "");
            if (/checkbox|radio|button|select|link|label|click/.test(w)
              || /one_city|one_station|one_line|city_code|station|route|go_search|room_layout|絞り込み|検索/.test(f)) {
              return Object.assign({}, o, { cs: "pointer" });
            }
            return o;
          });
        }
      } catch (_) {}
      /**
       * 2026-11-14 竹内さん「足りていない部分や弱い部分はきょうかするようにする」:
       *   ⚠ **同じ画像が延々と撮れている**事に誰も気づけなかった（実測100枚が同一）。
       *   → 新しい列を作らず、**`shot_ops` に `k:"same"` の1件**として「何枚続いたか」を載せる
       *     （DBの変更なし・統括が読める）。
       *   ⚠ 2枚以上続いた時だけ入れる（1枚目は入れない）。
       */
      try {
        if (Number(_shotSameRun) >= 2 && Array.isArray(_opsForSend)) {
          _opsForSend = _opsForSend.concat([{ t: Date.now(), k: "same", f: null, w: null, same: Number(_shotSameRun) }]);
        }
      } catch (_) {}
      _takeShot({ type: "axlx-human-shot", site: siteName || "record", kind: "rec", wait_upload: true, ops: _opsForSend }, function (res) { resolve(res || null); });
    } catch (_) { resolve(null); }
  });
}
async function _recStart() {
  if (_recIsOn()) return { ok: true, already: true, count: _recCount, saved: _recSaved };
  _recCount = 0; _recSaved = 0; _recFailed = 0; _recLastErr = null;
  _recStartedAt = Date.now();
  /**
   * 2026-11-14: **世代を新しくする**（古いループは自分の世代でなくなるので止まる）。
   *   ⚠ 旧は `_recIsOn()` が `_recTimer` だけを見ていたので、Service Worker が起き直すと
   *     「録画していない」と誤判定して**もう1本ループを増やしていた**。
   */
  _recGen = (_recGen || 0) + 1;
  var gen = _recGen;
  try {
    await chrome.storage.local.set({
      axlx_rec_mode: { on: true, started_at: _recStartedAt, gen: gen },
      axlx_rec_stat: { on: true, tried: 0, saved: 0, failed: 0, last_error: null, started_at: _recStartedAt, last_at: null },
    });
  } catch (_) {}
  console.log("[rec] 画面録画モード: 開始（1.5〜3.5秒ごとに撮ります・最長7分・世代" + gen + "）");
  _recTimer = setTimeout(function () { _recTick(gen).catch(function () {}); }, 300);
  return { ok: true, count: 0, saved: 0, max_ms: _REC_MAX_MS };
}
async function _recStop(why) {
  // 2026-11-14: 世代を0に戻す（走っているループは自分の世代でなくなるので止まる）
  _recGen = 0;
  if (_recTimer) { clearTimeout(_recTimer); _recTimer = null; }
  try { await chrome.storage.local.set({ axlx_rec_mode: { on: false, stopped_at: Date.now(), tried: _recCount, saved: _recSaved, failed: _recFailed, why: why || null } }); } catch (_) {}
  try {
    var st = await chrome.storage.local.get(["axlx_rec_stat"]);
    var s = (st && st.axlx_rec_stat) || {};
    await chrome.storage.local.set({
      axlx_rec_stat: {
        on: false, tried: _recCount, saved: _recSaved, failed: _recFailed,
        last_error: _recLastErr || s.last_error || null,
        started_at: s.started_at || _recStartedAt, last_at: Date.now(), why: why || null,
      },
    });
  } catch (_) {}
  console.log("[rec] 画面録画モード: 停止（" + (why || "") + "・試した " + _recCount + "回・保存 " + _recSaved + "枚・失敗 " + _recFailed + "回" + (_recLastErr ? "・理由: " + _recLastErr : "") + "）");
  return { ok: true, count: _recCount, saved: _recSaved, failed: _recFailed, last_error: _recLastErr || null, why: why || null };
}
try {
  chrome.runtime.onMessage.addListener(function (msg, _s, sendResponse) {
    if (!msg) return;
    if (msg.type === "axlx-rec-start") { _recStart().then(function (r) { try { sendResponse(r); } catch (_) {} }); return true; }
    if (msg.type === "axlx-rec-stop") { _recStop("手で止めた").then(function (r) { try { sendResponse(r); } catch (_) {} }); return true; }
    /**
     * 2026-11-12 竹内さん「いまちゃんとろくがされてたかな？」→ ResourceExceeded で保存0枚:
     *   溜まった写真を今すぐ片付ける口（小窓の「写真を片付ける」から呼ぶ）。
     *   ⚠ 消すのは **Chrome の中だけ**。Cloud（Storage）の写真は消さない。
     */
    if (msg.type === "axlx-shot-trim") {
      _trimShots().then(function (n) { try { sendResponse({ ok: true, removed: n }); } catch (_) {} });
      return true;
    }
    if (msg.type !== "axlx-rec-status") return;
    (async function () {
      var st = await chrome.storage.local.get(["axlx_rec_stat", "axlx_rec_mode"]);
      try {
        sendResponse({
          on: _recIsOn(),
          count: _recSaved,
          tried: _recCount,
          saved: _recSaved,
          failed: _recFailed,
          last_error: _recLastErr || null,
          started_at: _recStartedAt,
          max_ms: _REC_MAX_MS,
          remain_ms: _recIsOn() ? _recRemainMs() : 0,
          gap_ms: [_REC_GAP_MIN, _REC_GAP_MAX],
          max_shots: _REC_MAX_SHOTS,
          stat: (st && st.axlx_rec_stat) || null,
          mode: (st && st.axlx_rec_mode) || null,
        });
      } catch (_) {}
    })();
    return true;
  });
} catch (_) {}
// SW が起き直した時: 録画中だったら続ける（止まったまま残らない）
try {
  chrome.storage.local.get(["axlx_rec_mode"]).then(function (st) {
    var m = st && st.axlx_rec_mode;
    if (!m || !m.on) return;
    if (Date.now() - Number(m.started_at || 0) > _REC_MAX_MS) { _recStop("7分"); return; }
    /**
     * 2026-11-14 修正（**これが多重化の原因だった**）:
     *   ⚠ 旧は毎回 `_recTick` の新しいループを起こしていた。
     *     Service Worker は数十秒で止まるので、**起き直すたびに1本増えていた**
     *     （実測: 2分間で392枚・間隔 2ms/17ms・全部 capture_error）。
     *   → **すでに走っている世代があれば何もしない**（`gen` を保存して見分ける）。
     *     走っていなければ（＝本当に止まっていた）**同じ世代を引き継いで**1本だけ起こす。
     */
    var gen = Number(m.gen) || 0;
    if (_recGen > 0) return;                 // すでにこの SW で走っている → 増やさない
    _recGen = gen || ((_recGen || 0) + 1);
    _recStartedAt = Number(m.started_at) || Date.now();
    console.log("[rec] 画面録画モード: SW の起き直し → 続けます（世代" + _recGen + "）");
    _recTimer = setTimeout(function () { _recTick(_recGen).catch(function () {}); }, 500);
  }).catch(function () {});
} catch (_) {}

/**
 * 2026-11-12 竹内さん「いまちゃんとろくがされてたかな？」→ ResourceExceeded（保存0枚）:
 *   起動した時に**溜まりすぎた写真を掃除する**（旧版がフルサイズで貯めた物が 10MB を埋めている）。
 *   これをしないと、直した版でも**空きが無いまま**で保存が失敗し続ける。
 */
try {
  _trimShots().then(function (n) {
    if (n) console.log("[human-shot] 起動時: 古い写真を " + n + "件 整理しました");
  }).catch(function () {});
} catch (_) {}
/**
 * 2026-11-11: 撮った写真の一覧（何枚・どのまとまり・どの操作の後か）。中身（画像）は含めない＝軽い。
 *   ?run_id= で1つのまとまりだけ。?with_data=1 で画像も返す（確認用・重い）。
 */
/**
 * 2026-11-11 竹内さん「画面画像みればわかるのでは」:
 *   撮った写真を **Supabase Storage に上げる**（Chrome の中だけだと外から見られない）。
 *   `/api/human-motion` に画像を付けて送る → サーバーが Storage に置き、表には名前だけ残す。
 *   ・上げるのは1枚ずつ・直列（サーバーを叩きすぎない・順番が崩れない）
 *   ・失敗しても止めない（写真は Chrome の中に残る）
 */
/**
 * 2026-11-11 竹内さん「写真もまだとれていない真の原因をちゃんとみつける。写真の容量も小さく」
 *
 * ⚠ 0枚が続いた本当の理由:
 *   ① 写真は「学習」の中から撮っていた → 自動・AIX では学習しないので**撮られもしない**
 *   ② 送信は**キュー**（`_shotUploadQueue`）を通していた → 大きな `if (msg.type === ...)` の
 *      中に置いてあり、**メッセージのたびに作り直される**。積んだ物が消える事があった
 *   ③ 送る前に縮めていなかった → フルHD の JPEG は 3MB を超え、サーバーが**黙って捨てた**
 *
 * → **キューをやめて、撮ったらその場で縮めて送る**（1本の関数・共有の変数に頼らない）。
 *   縮める: **長辺 1000px・JPEG 40%**（100〜250KB 目安）。
 *   失敗したら**理由を必ず残す**（`axlx_human_shot_upload`）。
 */
var _shotSending = 0;
async function _sendShotNow(job) {
  if (!job || !job.data_url) return { ok: false, error: "no_data" };
  if (_shotSending >= 3) {
    try { chrome.storage.local.set({ axlx_human_shot_upload: { ok: false, error: "busy", at: Date.now() } }); } catch (_) {}
    return { ok: false, error: "busy" };
  }
  _shotSending++;
  try { chrome.storage.local.set({ axlx_human_shot_upload: { ok: null, phase: "sending", at: Date.now() } }); } catch (_) {}
  try {
    const hdr = await _getAutomationKeyHeader();
    let devLabel = null;
    try { devLabel = await _ensureDeviceLabel(); } catch (_) {}
    /**
     * 2026-11-13 竹内さん「ほかに抜けている箇所はあるのか。原因見つけて改善する」:
     *   ⚠ 旧は `motion` を**全部ゼロ**（n:0・kinds:{}・scrolls:{n:0}…）で送っていた。
     *     写真は録画中に数秒ごとに撮る＝**記録の大半がこの形**なので、
     *     写真つきの行には速さ・押す位置・スクロールが**1つも入っていなかった**
     *     （実測: 2944行中 scrolls が 0・scroll_dy が null）。
     *   → **同じタブでその直前に貯まった「動きの癖」を一緒に送る**（写真と動きが結びつく）。
     *   ⚠ `executeScript` を数秒ごとに走らせると重い（録画の間隔を圧迫する）ので、
     *     記録側（page）が持っている**まとめを `axlx-recent-motion` で1回だけ聞く**。
     *     読めない時は今まで通りゼロ（写真だけ）。
     */
    let motion = null;
    try {
      if (typeof job.tab_id === "number") {
        const got = await chrome.tabs.sendMessage(job.tab_id, { type: "axlx-recent-motion" })
          .catch(function () { return null; });
        if (got && got.ok && got.motion && typeof got.motion === "object") motion = got.motion;
      }
    } catch (_) { motion = null; }
    const body = {
      shot_b64: job.data_url,
      motion: motion || { n: 0, kinds: {}, gaps: [], gap_ms: null, fields: [], order: [],
                moves: { n: 0 }, points: { n: 0 }, scrolls: { n: 0 } },
      site: job.site || null,
      mode: job.mode || null,
      shot_taken: true,
      shot_key: null,
      shot_w: job.shot_w || null,
      shot_h: job.shot_h || null,
      install_id: await _snapInstallId(),
      device_label: devLabel,
      ext_version: _extVersion(),
      at: Date.now(),
      shot_meta: { what: job.what, kind: job.kind, x: job.x, y: job.y, run_id: job.run_id, seq: job.seq },
      /**
       * 2026-11-13 竹内さん「写真から学習する。押す場所や押す順番などもりかいできるから」
       *   「おしかたのボタンの仕様の理解の為にも」「自動モードでは実際に人間がおしたようにおすことができる」:
       *   ⚠ 旧は `shot_meta` を送っていたが**サーバーが捨てていた**ので、写真と「どの操作だったか」が
       *     結びついていなかった（＝写真から学習できない）。
       *   → `ops`（押した物の並び・時刻・どの欄か）も一緒に送る。
       *     サーバーは表の `shot_ops` に残し、後で「この画面で次に何を押すか」を写真と突き合わせられる。
       *   ⚠ 送るのは**欄の名前と操作の種類・時刻だけ**（入力した中身・文字は送らない）。
       */
      shot_ops: Array.isArray(job.ops) ? job.ops.slice(0, 80) : null,
    };
    const res = await fetch(SUMORA_BATCH_API + "/api/human-motion", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, hdr),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    let txt = "";
    try { txt = await res.text(); } catch (_) {}
    if (!res.ok) {
      console.warn("[human-shot] 上げられませんでした:", res.status, String(txt).slice(0, 200));
      try { chrome.storage.local.set({ axlx_human_shot_upload: { ok: false, status: res.status, error: String(txt).slice(0, 200), at: Date.now() } }); } catch (_) {}
      return { ok: false, status: res.status, error: String(txt).slice(0, 200) };
    }
    console.log("[human-shot] クラウドに上がりました:", String(txt).slice(0, 120));
    try { chrome.storage.local.set({ axlx_human_shot_upload: { ok: true, status: 200, at: Date.now() } }); } catch (_) {}
    return { ok: true, status: 200 };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 200);
    console.warn("[human-shot] 上げる時のエラー:", msg);
    try { chrome.storage.local.set({ axlx_human_shot_upload: { ok: false, error: msg, at: Date.now() } }); } catch (_) {}
    return { ok: false, error: msg };
  } finally {
    _shotSending = Math.max(0, _shotSending - 1);
  }
}
function _pumpShotUpload() {
  /* 旧のキュー方式は廃止（_sendShotNow を直接呼ぶ）。互換のため空で残す */
}
if (msg.type === "axlx-human-shot-upload") {
  // 2026-11-11: キューをやめて**その場で送る**（共有の変数に頼らない）
  _sendShotNow({
    data_url: msg.data_url, site: msg.site, what: msg.what, kind: msg.kind,
    x: msg.x, y: msg.y, run_id: msg.run_id, seq: msg.seq,
  }).then(function (r) {
    try { sendResponse({ ok: !!(r && r.ok), error: r && r.error }); } catch (_) {}
  });
  return true;
}

if (msg.type === "axlx-human-shots-list") {  (async () => {
    try {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter(function (k) { return k.indexOf("shot_") === 0; }).sort();
      const wantRun = typeof msg.run_id === "string" ? msg.run_id : null;
      const list = [];
      for (const k of keys) {
        const v = all[k];
        if (!v) continue;
        if (wantRun && v.run_id !== wantRun) continue;
        const item = { key: k, at: v.at, seq: v.seq, run_id: v.run_id, site: v.site, kind: v.kind, what: v.what, x: v.x, y: v.y, w: v.w, h: v.h };
        if (msg.with_data) item.data = v.data;
        list.push(item);
      }
      // まとまりごとの要約
      const runs = {};
      list.forEach(function (it) {
        const r = it.run_id || "?";
        runs[r] = runs[r] || { run_id: r, n: 0, from: it.at, to: it.at, kinds: {} };
        runs[r].n++;
        runs[r].from = Math.min(runs[r].from, it.at);
        runs[r].to = Math.max(runs[r].to, it.at);
        if (it.kind) runs[r].kinds[it.kind] = (runs[r].kinds[it.kind] || 0) + 1;
      });
      sendResponse({ ok: true, total: list.length, runs: Object.keys(runs).map(function (k) { return runs[k]; }), shots: msg.with_data ? list : list.slice(0, 200) });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
}

  if (msg.type === "axlx-fetch-customer") {    (async () => {
      try {
        const res = await fetch("https://sumora-ai-ui.vercel.app/api/property-customers", { cache: "no-store" });
        const list = await res.json();
        const customer = Array.isArray(list)
          ? list.find(function (x) { return String(x.id) === String(msg.customerId); })
          : null;
        sendResponse({ customer: customer || null });
      } catch (e) {
        console.warn("[bg] axlx-fetch-customer error:", e);
        sendResponse({ customer: null });
      }
    })();
    return true;
  }

  // ── 手動一括検索: popup.jsのチェックボックスで選択した顧客を連続処理 ──────
  // popup.jsはリアプロページリロードで消えるため、ループをbackground.jsに委ねる
  if (msg.type === "axlx-manual-bulk-search") {
    // v2.5.77: 一括検索（拡張がお客様を順に開いて検索・送る）は「光って選択するモード」の間は始めない
    if (_guideOnly()) { console.warn("[manual-bulk-search] 光って選択するモードのため一括検索は始めない"); sendResponse({ ok: false, error: "guide_only" }); return true; }
    var _bulkSite = msg.site;
    var _bulkIds  = Array.isArray(msg.customerIds) ? msg.customerIds : [];
    // 2026-09-18 竹内「一括検索も条件広げて検索でできるようにする」:
    //   _batchAutofill は元から isWide を受ける作りだったのに、ここが常に false を渡していた
    var _bulkIsWide = !!msg.isWide;
    // ★ 2026-11-20: キューの一括・Realtime・手動の一括が同じタブで同時に動くと、お客さんが混ざる → 動いている間は始めない
    if (_batchLoopAlive || _manualBulkAlive) {
      console.warn("[manual-bulk-search] 別の一括が動いている → 始めない");
      sendResponse({ ok: false, error: "batch_running" });
      return true;
    }
    sendResponse({ ok: true, started: true });
    _manualBulkRun({ site: _bulkSite, ids: _bulkIds, isWide: _bulkIsWide, startIndex: 0, resume: false, why: "popup" });
    return true;
  }

  // ── 見積書自動モード: 開いている物件詳細タブをスクレイプ ─────────────────
  if (msg.type === "axlx-estimate-auto") {
    var _site = msg.site || "unknown";
    (async function() {
      try {
        var allTabs = await chrome.tabs.query({});
        var realproDetailTabs = allTabs.filter(function(t) {
          return t.url && t.url.includes("realnetpro.com") &&
            (t.url.includes("room_detail") || t.url.includes("/detail"));
        });
        var itandiDetailTabs = allTabs.filter(function(t) {
          return t.url && t.url.includes("itandibb.com") && t.url.includes("rent_rooms");
        });
        var targetTabs = [];
        if (_site === "realnetpro") {
          targetTabs = realproDetailTabs.length > 0 ? realproDetailTabs :
            allTabs.filter(function(t) { return t.url && t.url.includes("realnetpro.com"); });
        } else if (_site === "itandi") {
          targetTabs = itandiDetailTabs.length > 0 ? itandiDetailTabs :
            allTabs.filter(function(t) { return t.url && t.url.includes("itandibb.com"); });
        } else {
          targetTabs = realproDetailTabs.concat(itandiDetailTabs);
          if (targetTabs.length === 0) {
            targetTabs = allTabs.filter(function(t) {
              return t.url && (t.url.includes("realnetpro.com") || t.url.includes("itandibb.com"));
            });
          }
        }
        if (targetTabs.length === 0) {
          sendResponse({ ok: false, error: "リアプロ/itandiの物件詳細ページが見つかりません。物件詳細ページを開いてからお試しください。" });
          return;
        }
        var targetTab = targetTabs.sort(function(a, b) {
          return ((b.lastAccessed || 0) - (a.lastAccessed || 0));
        })[0];
        var isRealpro = !!(targetTab.url && targetTab.url.includes("realnetpro.com"));
        var estimateTabId = targetTab.id;
        if (!estimateTabId) { sendResponse({ ok: false, error: "タブIDが取得できません" }); return; }
        var scrapeResults = await chrome.scripting.executeScript({
          target: { tabId: estimateTabId },
          world: "MAIN",
          func: function() {
            var lines = [];
            var titleEl = document.querySelector("h1, h2, .property-name, .room-name, .building-name");
            if (titleEl) lines.push("物件名: " + titleEl.innerText.trim());
            document.querySelectorAll("table").forEach(function(table) {
              table.querySelectorAll("tr").forEach(function(row) {
                var ths = Array.from(row.querySelectorAll("th"));
                var tds = Array.from(row.querySelectorAll("td"));
                if (ths.length > 0 && tds.length > 0) {
                  ths.forEach(function(th, i) {
                    var val = tds[i] ? tds[i].innerText.trim() : "";
                    var label = th.innerText.trim();
                    if (label && val && val.length < 300) lines.push(label + ": " + val);
                  });
                } else if (tds.length >= 2 && ths.length === 0) {
                  for (var i = 0; i < tds.length - 1; i += 2) {
                    var l = tds[i].innerText.trim();
                    var v = tds[i + 1].innerText.trim();
                    if (l && v && v.length < 300) lines.push(l + ": " + v);
                  }
                }
              });
            });
            document.querySelectorAll("dl").forEach(function(dl) {
              var dts = Array.from(dl.querySelectorAll("dt"));
              var dds = Array.from(dl.querySelectorAll("dd"));
              dts.forEach(function(dt, i) {
                if (dds[i]) {
                  var l = dt.innerText.trim();
                  var v = dds[i].innerText.trim();
                  if (l && v && v.length < 300) lines.push(l + ": " + v);
                }
              });
            });
            return lines.filter(function(x) { return x.trim().length > 0; }).join("\n");
          }
        });
        var pageText = (scrapeResults && scrapeResults[0] && scrapeResults[0].result) || "";
        var page2Text = "";
        if (isRealpro) {
          try {
            var currentUrl = targetTab.url || "";
            var page2Url = currentUrl.includes("page=") ?
              currentUrl.replace(/page=\d+/, "page=2") :
              currentUrl + (currentUrl.includes("?") ? "&" : "?") + "page=2";
            var page2Results = await chrome.scripting.executeScript({
              target: { tabId: estimateTabId },
              world: "MAIN",
              func: function(url) {
                return fetch(url, { credentials: "include" })
                  .then(function(r) { return r.text(); })
                  .then(function(html) {
                    var parser = new DOMParser();
                    var doc = parser.parseFromString(html, "text/html");
                    var lines = [];
                    doc.querySelectorAll("table tr").forEach(function(row) {
                      var ths = Array.from(row.querySelectorAll("th"));
                      var tds = Array.from(row.querySelectorAll("td"));
                      if (ths.length > 0 && tds.length > 0) {
                        ths.forEach(function(th, i) {
                          var val = tds[i] ? tds[i].innerText.trim() : "";
                          var label = th.innerText.trim();
                          if (label && val && val.length < 300) lines.push(label + ": " + val);
                        });
                      }
                    });
                    return lines.join("\n");
                  })
                  .catch(function() { return ""; });
              },
              args: [page2Url]
            });
            page2Text = (page2Results && page2Results[0] && page2Results[0].result) || "";
          } catch (_) { /* page2取得失敗は無視 */ }
        }
        var siteName = isRealpro ? "リアプロ" : "itandi";
        var fullText = "【" + siteName + " 物件詳細】\n" + pageText;
        if (page2Text) fullText += "\n\n【" + siteName + " 次ページ詳細】\n" + page2Text;
        if (!pageText) {
          sendResponse({ ok: false, error: "ページから情報を取得できませんでした。詳細ページを開いているか確認してください。" });
          return;
        }
        sendResponse({ ok: true, text: fullText });
      } catch (e) {
        console.error("[axlx-estimate-auto] error:", e);
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // axlx-estimate-realpro-search
  // リアプロ main.php でフリーワード検索 → 号室マッチ行のhref取得 → 詳細タブ開いて
  // 「客付業者様へ」セクションを抽出 → 補足情報フィールドに注入
  // ──────────────────────────────────────────────────────────────────────────────
  if (msg.type === "axlx-estimate-realpro-search") {
    var _epPropName = (msg.propertyName || "").trim();
    var _epRoomNum  = (msg.roomNumber   || "").trim();

    if (!_epPropName) {
      sendResponse({ ok: false, error: "物件名が指定されていません" });
      return true;
    }

    (async function() {
      try {
        // 2026-09-25（webapp-bridge の文法の誤りを直して見積書の画面からもここへ来るようになった）:
        //   この後 main.php のタブでフリーワード検索を押す。キューの一括（batchRunning のロック中）が同じタブで
        //   検索している最中に押すと、そのお客様の検索条件が壊れる → ロック中は断る（ポップアップからの時も同じ）
        var _epLockSt = await chrome.storage.local.get("batchRunning");
        var _epLock = _epLockSt.batchRunning;
        var _epLockAt = (typeof _epLock === "object" && _epLock) ? _epLock.startedAt : 0;
        if (_epLockAt && Date.now() - _epLockAt < BATCH_LOCK_TTL_MS) {
          sendResponse({ ok: false, error: "物件の一括検索の実行中です。終わってからもう一度お試しください。" });
          return;
        }
        var MAIN_PHP_URL = "https://www.realnetpro.com/main.php";

        // ── Step 1: リアプロ main.php タブを探す or 作成 ───────────────────────
        var _epAllTabs = await chrome.tabs.query({});

        // main.php 上のタブを優先（page-script.js が注入されているため）
        var _epMainTab = _epAllTabs
          .filter(function(t) { return t.url && t.url.startsWith(MAIN_PHP_URL); })
          .sort(function(a, b) { return (b.lastAccessed || 0) - (a.lastAccessed || 0); })[0];

        if (!_epMainTab) {
          // main.php 以外の realnetpro タブがあればそこへナビゲート
          var _epAnyReal = _epAllTabs.find(function(t) {
            return t.url && t.url.includes("realnetpro.com") && !t.url.includes("room_detail");
          });
          if (_epAnyReal) {
            await chrome.tabs.update(_epAnyReal.id, { url: MAIN_PHP_URL, active: false });
            _epMainTab = { id: _epAnyReal.id };
          } else {
            _epMainTab = await chrome.tabs.create({ url: MAIN_PHP_URL, active: false });
          }
          await _batchWaitForTabComplete(_epMainTab.id);
          // page-script.js が document_start → document_idle で注入されるまで待機
          await new Promise(function(r) { setTimeout(r, _settleMs(2500)); });
        }

        var _epListTabId = _epMainTab.id;

        // ── Step 2: page-script.js へ window.postMessage でフリーワード検索を指示 ──
        await chrome.scripting.executeScript({
          target: { tabId: _epListTabId },
          world: "MAIN",
          func: function(propName, roomNum) {
            window.__axlxEstimateSearchResult = undefined;
            window.postMessage({
              from: "axlx-realpro-freeword-search",
              propertyName: propName,
              roomNumber: roomNum,
            }, "*");
          },
          args: [_epPropName, _epRoomNum],
        });

        // ── Step 3: page-script.js が検索ボタンをクリックしたか確認（triggered フラグ, 最大6秒）
        var _epTriggered = false;
        for (var _ep1 = 0; _ep1 < 12; _ep1++) {
          await new Promise(function(r) { setTimeout(r, _pollMs(500)); });
          try {
            var _epTrigPoll = await chrome.scripting.executeScript({
              target: { tabId: _epListTabId },
              world: "MAIN",
              func: function() { return window.__axlxEstimateSearchResult; },
            });
            var _epTrigRes = _epTrigPoll && _epTrigPoll[0] && _epTrigPoll[0].result;
            if (_epTrigRes && _epTrigRes.triggered) { _epTriggered = true; break; }
            if (_epTrigRes && _epTrigRes.ok === false) {
              // page-script.js がエラーを設定した（フリーワード欄や検索ボタンが見つからない等）
              sendResponse({ ok: false, error: _epTrigRes.error || "フリーワード検索の起動に失敗しました" });
              return;
            }
          } catch (_) { /* ページ遷移中に executeScript が一時的に失敗することがある */ }
        }
        if (!_epTriggered) {
          sendResponse({ ok: false, error: "フリーワード検索が開始されませんでした（page-script.jsが応答しません。リアプロ main.php が開かれているか確認してください）" });
          return;
        }

        // ── Step 4: room_detail タブ監視 + 号室行の「詳細」ボタンクリック ─────────
        // DevTools確認済み（2026-08-11）:
        // 詳細ボタンは <a class="hide_text hide_detail" href="#" target="_blank">詳細</a>
        // → target="_blank" でブラウザが room_detail.php?id=...&gr=... を新タブで開く
        // → window.open は呼ばれないため URL は取得不可。chrome.tabs.onUpdated で捕捉する。
        var _epDetailTabId = null;
        var _epTabFound = false;
        var _epRoomNumEsc = _epRoomNum.replace(/号室?$/, "").trim()
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        var _epTabUpdatedL = function(tabId, changeInfo, tab) {
          if (_epTabFound) return;
          var url = (tab && tab.url) || (changeInfo && changeInfo.url) || "";
          if (url.includes("room_detail.php") && changeInfo.status === "complete") {
            _epTabFound = true;
            _epDetailTabId = tabId;
          }
        };
        chrome.tabs.onUpdated.addListener(_epTabUpdatedL);

        // ── Step 5: 号室に一致する行の「詳細」ボタンをクリック（最大25秒ポーリング）
        var _epClicked = false;
        for (var _ep2 = 0; _ep2 < 50 && !_epClicked; _ep2++) {
          await new Promise(function(r) { setTimeout(r, _pollMs(500)); });
          try {
            var _epClickRes = await chrome.scripting.executeScript({
              target: { tabId: _epListTabId },
              world: "MAIN",
              func: function(roomReStr) {
                var roomRe = new RegExp(roomReStr);
                var ROW_SELS = [
                  "table.result-list tbody tr",
                  "table.list tbody tr",
                  ".room-list tr",
                  "tbody tr",
                ];
                for (var sel of ROW_SELS) {
                  var rows = Array.from(document.querySelectorAll(sel));
                  for (var row of rows) {
                    if (!roomRe.test(row.innerText || row.textContent || "")) continue;
                    // class="hide_text hide_detail" target="_blank" のリンクをクリック
                    var detailLink = Array.from(row.querySelectorAll("a")).find(function(a) {
                      return (a.innerText || "").trim() === "詳細";
                    });
                    if (detailLink) {
                      detailLink.click();
                      return true;
                    }
                  }
                }
                return false;
              },
              args: ["(?<![0-9])" + _epRoomNumEsc + "(?![0-9])"],
            });
            _epClicked = !!(_epClickRes && _epClickRes[0] && _epClickRes[0].result);
          } catch (_) { /* ページ遷移中の一時エラーは無視 */ }
        }

        if (!_epClicked) {
          chrome.tabs.onUpdated.removeListener(_epTabUpdatedL);
          sendResponse({ ok: false, error: "号室「" + _epRoomNum + "」が検索結果に見つかりませんでした（物件名: " + _epPropName + "）" });
          return;
        }

        // room_detail タブが開いてロード完了するまで待つ（最大20秒）
        for (var _ep3 = 0; _ep3 < 40 && !_epDetailTabId; _ep3++) {
          await new Promise(function(r) { setTimeout(r, _pollMs(500)); });
        }
        chrome.tabs.onUpdated.removeListener(_epTabUpdatedL);

        if (!_epDetailTabId) {
          sendResponse({ ok: false, error: "詳細ページ（room_detail.php）が開きませんでした。リアプロにログインしているか確認してください。" });
          return;
        }
        await new Promise(function(r) { setTimeout(r, _settleMs(500)); });

        // ── Step 6: 「客付業者様へ」セクションの innerText を抽出 ────────────────
        // リアプロ詳細ページは page=1 と page=2 に分割されている場合がある。
        // まず現在のページ（page=1 相当）でセクションを探し、
        // 見つからなければ page=2 を fetch して探す。
        var _epExtract = await chrome.scripting.executeScript({
          target: { tabId: _epDetailTabId },
          world: "MAIN",
          func: function() {
            function extractBrokerSection(doc) {
              // 戦略1: 「客付業者」を含む見出し要素 → その親コンテナ
              var headings = Array.from(doc.querySelectorAll("h1,h2,h3,h4,th,dt,strong,b,td"));
              for (var h of headings) {
                var ht = (h.innerText || h.textContent || "").trim();
                if (!ht.includes("客付")) continue;
                var container = h.closest("section,article,table,dl,.block,.section,.card") || h.parentElement;
                if (!container) continue;
                var text = (container.innerText || "")
                  .replace(/[ \t]+/g, " ")
                  .replace(/\n{3,}/g, "\n\n")
                  .trim();
                if (text && text.length > 5) return text;
              }
              // 戦略2: 「客付業者」を含むテキストノードを持つ末端要素を収集
              var blocks = Array.from(doc.querySelectorAll("p,li,dd,span,div")).filter(function(el) {
                return el.children.length === 0 && (el.innerText || "").includes("客付");
              });
              if (blocks.length > 0) {
                return blocks.map(function(b) { return b.innerText.trim(); }).join("\n");
              }
              return null;
            }

            var text = extractBrokerSection(document);
            if (text) return { text: "【客付業者様へ】\n" + text, page2Url: null };

            // page=2 が必要な場合: URLを構築して返す（fetchはMAIN worldで実施）
            var currentUrl = location.href;
            var page2Url = currentUrl.includes("page=")
              ? currentUrl.replace(/page=\d+/, "page=2")
              : currentUrl + (currentUrl.includes("?") ? "&" : "?") + "page=2";
            return { text: null, page2Url: page2Url };
          },
        });

        var _epExtractRes = _epExtract && _epExtract[0] && _epExtract[0].result;
        var _epBrokerText = _epExtractRes && _epExtractRes.text;

        // page=1 で見つからなければ page=2 を fetch
        if (!_epBrokerText && _epExtractRes && _epExtractRes.page2Url) {
          var _epPage2 = await chrome.scripting.executeScript({
            target: { tabId: _epDetailTabId },
            world: "MAIN",
            func: function(url) {
              return fetch(url, { credentials: "include" }).then(function(r) { return r.text(); }).then(function(html) {
                var doc = new DOMParser().parseFromString(html, "text/html");
                var headings = Array.from(doc.querySelectorAll("h1,h2,h3,h4,th,dt,strong,b,td"));
                for (var h of headings) {
                  var ht = (h.innerText || h.textContent || "").trim();
                  if (!ht.includes("客付")) continue;
                  var container = h.closest("section,article,table,dl,.block,.section") || h.parentElement;
                  if (!container) continue;
                  var text = (container.innerText || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
                  if (text && text.length > 5) return text;
                }
                return null;
              }).catch(function() { return null; });
            },
            args: [_epExtractRes.page2Url],
          });
          var _epPage2Text = _epPage2 && _epPage2[0] && _epPage2[0].result;
          if (_epPage2Text) {
            _epBrokerText = "【客付業者様へ（詳細2ページ目）】\n" + _epPage2Text;
          }
        }

        // ── Step 7: 詳細タブを閉じる ─────────────────────────────────────────────
        // _epListTabId と同じタブになっていた場合（target="_blank"が効かなかった等）は閉じない
        if (_epDetailTabId !== _epListTabId) {
          await chrome.tabs.remove(_epDetailTabId).catch(function() {});
        }

        if (!_epBrokerText) {
          sendResponse({ ok: false, error: "詳細ページ（room_detail.php）に「客付業者様へ」セクションが見つかりませんでした。" });
          return;
        }

        // fromPopup の場合: supplementaryText を storage に保存し、見積書ページを開く
        if (msg.fromPopup) {
          await chrome.storage.local.set({ axlx_pending_supplementary: _epBrokerText, axlx_pending_supplementary_at: Date.now() });
          await chrome.tabs.create({ url: "https://sumora-ai-ui.vercel.app/estimate?pendingSupp=1", active: true });
        }

        sendResponse({ ok: true, text: _epBrokerText });
      } catch (err) {
        sendResponse({ ok: false, error: "エラー: " + String(err) });
      }
    })();
    return true; // async sendResponse
  }

  // ── ポップアップ経由で保存された supplementaryText を返す ────────────────
  if (msg.type === "axlx-get-pending-supplementary") {
    // 2026-09-25: webapp-bridge が6週間 SyntaxError で、ここは1回も呼ばれていなかった＝保存した補足情報が読まれずに残っている。
    //   直した後の最初の見積書の画面に何週間も前の物件の「客付業者様へ」が入らないよう、保存から10分以内の物だけ渡す
    //   （時刻の無い古い形も渡さない）。渡さなかった物も、渡した物も、ここで消す。
    chrome.storage.local.get(["axlx_pending_supplementary", "axlx_pending_supplementary_at"], function(result) {
      var text = result.axlx_pending_supplementary || null;
      var at = result.axlx_pending_supplementary_at || 0;
      var fresh = !!(text && at && Date.now() - at < 10 * 60 * 1000);
      if (text || at) chrome.storage.local.remove(["axlx_pending_supplementary", "axlx_pending_supplementary_at"]);
      sendResponse({ ok: fresh, text: fresh ? text : null });
    });
    return true; // async sendResponse
  }

  // ── WebApp から直接スクレイプ+比較トリガー ──────────────────────────────
  // WebApp の UI から「物件を比較」ボタンを押すと送られるメッセージ。
  // 既存の _webappAutofill でリアプロを検索条件付きで開いた後、
  // 全ページをスクレイプして /api/compare-properties に POST する。
  if (msg.type === "axlx-scrape-and-compare") {
    const { customerId, conditions } = msg;
    (async () => {
      try {
        var scrapedCount = await _runScrapeAndCompare(customerId, conditions);
        sendResponse({ ok: true, count: scrapedCount });
      } catch (e) {
        console.error("[axlx-scrape-and-compare] error:", e);
        sendResponse({ ok: false, error: String(e.message) });
      }
    })();
    return true;
  }

  return false;
});

// ===== 自動化バッチ検索 =====
const SUMORA_BATCH_API = "https://sumora-ai-ui.vercel.app";

// ── Supabase Realtime WebSocket（スマホ→拡張 リアルタイムコマンド配信）─────────────────
// スマホからボタンを押したとき、30秒ポーリングを待たずに即座に拡張に届けるための双方向チャンネル
var _SB_WS_URL       = "wss://wfwsmwxakhyxobytszoq.supabase.co/realtime/v1/websocket?apikey=sb_publishable_0MBDxmVGZHFnjWX79QzKlw_x6sT1w4N&vsn=1.0.0";
var _SB_CMD_CHANNEL  = "realtime:ext-commands";  // スマホ → 拡張（コマンド受信）
var _SB_RES_CHANNEL  = "realtime:ext-results";   // 拡張 → スマホ（結果配信）
var _sbWs            = null;
var _sbWsRef         = 0;
var _sbHbTimer       = null;
var _sbCmdJoined     = false;
var _sbResJoined     = false;

function _sbSend(obj) {
  if (_sbWs && _sbWs.readyState === WebSocket.OPEN) {
    try { _sbWs.send(JSON.stringify(obj)); } catch(_) { /* ignore */ }
  }
}

function _sbConnect() {
  if (_sbWs && (_sbWs.readyState === WebSocket.OPEN || _sbWs.readyState === WebSocket.CONNECTING)) return;
  _sbCmdJoined = false; _sbResJoined = false;
  try {
    _sbWs = new WebSocket(_SB_WS_URL);
    _sbWs.onopen = function() {
      console.log("[SB-RT] Supabase Realtime 接続");
      // ext-commands（受信）と ext-results（送信）の両チャンネルに参加
      _sbSend({ topic: _SB_CMD_CHANNEL, event: "phx_join", payload: { config: { broadcast: { ack: false, self: false } } }, ref: String(++_sbWsRef), join_ref: "cmd" });
      _sbSend({ topic: _SB_RES_CHANNEL, event: "phx_join", payload: { config: { broadcast: { ack: false, self: false } } }, ref: String(++_sbWsRef), join_ref: "res" });
      // ハートビート 25秒ごと（Supabase の 30秒タイムアウト前に送る + SW を起こし続ける）
      if (_sbHbTimer) clearInterval(_sbHbTimer);
      _sbHbTimer = setInterval(function() {
        _sbSend({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(++_sbWsRef) });
      }, 25000);
    };
    _sbWs.onmessage = function(ev) {
      try {
        var msg = JSON.parse(ev.data);
        // チャンネル参加確認
        if (msg.event === "phx_reply" && msg.payload && msg.payload.status === "ok") {
          if (msg.topic === _SB_CMD_CHANNEL) { _sbCmdJoined = true; console.log("[SB-RT] ext-commands 参加完了"); }
          if (msg.topic === _SB_RES_CHANNEL) { _sbResJoined = true; console.log("[SB-RT] ext-results 参加完了"); }
        }
        // スマホからのコマンドを受信 → 即時実行
        if (msg.topic === _SB_CMD_CHANNEL && msg.event === "broadcast" && msg.payload && msg.payload.event === "scrape_command") {
          _sbHandleCommand(msg.payload.payload || {});
        }
        // スマホのストップボタンからのストップ信号 → バッチループを中断するフラグをセット
        if (msg.topic === _SB_CMD_CHANNEL && msg.event === "broadcast" && msg.payload && msg.payload.event === "stop_command") {
          console.log("[SB-RT] stop_command 受信 → _batchShouldStop = true");
          _batchShouldStop = true; // Fix 2: 同期フラグを即時セット
          chrome.storage.local.set({ batchStopRequested: true });
        }
      } catch(_) { /* ignore */ }
    };
    _sbWs.onclose = function() {
      console.log("[SB-RT] 切断 → 8秒後に再接続");
      _sbCmdJoined = false; _sbResJoined = false;
      if (_sbHbTimer) { clearInterval(_sbHbTimer); _sbHbTimer = null; }
      _sbWs = null;
      setTimeout(_sbConnect, 8000);
    };
    _sbWs.onerror = function() {};
  } catch(e) {
    console.warn("[SB-RT] 接続失敗:", e.message);
    setTimeout(_sbConnect, 15000);
  }
}

// ── popup.js 経由の完全フロー共通実装（PC ボタン・スマホ WebSocket 両方から呼ぶ）──────
// underbar.js → popup.js → page-script.js というルートを通る。
// バッチパス（_webappAutofill → page-script.js 直接）とは異なり、
// Dijkstra 路線展開・エリアAPI自動判定・駅/区モード切替が popup.js 内で正しく動く。
async function _runScrapeAndCompare(customerId, conditions) {
  var _scIsWide   = !!(conditions.isWide || conditions.is_wide);
  var _scAreaMode = (conditions && conditions.area_mode) || null;
  var _scCustName = (conditions && conditions.customerName) || null;

  /**
   * 2026-11-11 竹内さん「普通モードにしているとき自動検索されないようにする。今勝手に自動検索が普通モードでもおきてしまったり」:
   *   ここにもモードの関所が無く、通常モードでも main.php へ飛ばして検索を始めていた
   *   （＝「なぜかトップページに戻る」の原因の1つ）。
   *   自動の道を開いているモード（自動・AIX）の時だけ動く。
   */
  if (_guideOnly()) {
    console.warn("[scrape-compare] 通常／スタッフモードのため検索しない（自動モードかAIXを選ぶと動きます）");
    return { ok: false, error: "guide_only" };
  }

  var fillDonePromise = _createFillDoneWaiter("realnetpro", customerId, _fillDoneTimeoutMs("realnetpro"));

  var _scAllTabs = await chrome.tabs.query({});
  var _scRealTab = _scAllTabs.find(function(t) { return t.url && t.url.startsWith("https://www.realnetpro.com"); });

  var _directOk = false;
  if (_scRealTab && customerId) {
    try {
      await chrome.tabs.update(_scRealTab.id, { active: true });
      // content.js に現在の顧客IDを通知（fill-done relay に customerId を付与するため）
      try { await chrome.tabs.sendMessage(_scRealTab.id, { type: "axlx-set-fill-customer", customerId: String(customerId) }); } catch(_) {}
      var _directResp = await new Promise(function(resolve) {
        chrome.tabs.sendMessage(_scRealTab.id, {
          type:         "axlx-switch-customer",
          customerId:   String(customerId),
          customerName: _scCustName,
          site:         "realpro",
          areaMode:     _scAreaMode,
          is_wide:      _scIsWide,
        }, function(r) {
          void chrome.runtime.lastError;
          resolve(r || { ok: false });
        });
      });
      _directOk = !!_directResp.ok;
      console.log("[scrape-compare] underbar直接通信:", JSON.stringify(_directResp));
    } catch(e) {
      console.log("[scrape-compare] underbar直接通信エラー:", e);
    }
  }

  if (!_directOk) {
    if (_scRealTab) {
      /**
       * 2026-11-11 竹内さん「画面検索中なぜかトップページに戻ったりして崩れてしまう」:
       *   旧は **必ず main.php（ホーム）へ飛ばして**から pendingPopupCmd で検索し直していた。
       *   検索の画面（method=estate）を開いている最中にこれが走ると、トップへ戻って崩れる。
       *   → すでに検索の画面らしいタブなら **移らない**（そのタブのまま pendingPopupCmd に任せる）。
       *   判定は URL だけで見る（サイトは触らない・読み込みもしない）。
       */
      var _u = String(_scRealTab.url || "");
      var _looksSearch = /[?&]display=building/.test(_u) || /[?&]method=estate/.test(_u);
      if (_looksSearch) {
        console.log("[scrape-compare] すでに検索の画面 → main.php へ移らない（そのまま引き継ぐ）");
      } else {
        console.log("[scrape-compare] フォールバック → main.phpへ:", _scRealTab.id);
        await chrome.tabs.update(_scRealTab.id, { url: "https://www.realnetpro.com/main.php", active: true });
        await _batchWaitForTabComplete(_scRealTab.id);
        await new Promise(function(r) { setTimeout(r, _settleMs(1500)); });
      }
    } else {
      console.log("[scrape-compare] リアプロタブなし → 新規作成");
      _scRealTab = await chrome.tabs.create({ url: "https://www.realnetpro.com/main.php", active: true });
      await _batchWaitForTabComplete(_scRealTab.id);
      await new Promise(function(r) { setTimeout(r, _settleMs(2000)); });
    }
    if (customerId) {
      await chrome.storage.session.set({
        pendingPopupCmd: {
          customerId:   String(customerId),
          customerName: _scCustName,
          site:         "realpro",
          areaMode:     _scAreaMode,
          is_wide:      _scIsWide,
        }
      });
      console.log("[scrape-compare] ✔ pendingPopupCmd設定 → underbarが引き継ぎ");
    }
  } else {
    console.log("[scrape-compare] ✔ underbar直接通信成功 → ページ更新なし");
  }

  return await _scrapeAndSendRealpro(fillDonePromise, customerId, _scCustName, conditions, null, false, null);
}

async function _sbHandleCommand(payload) {
  var customerId   = String(payload.customerId   || payload.customer_id   || "");
  var customerName = String(payload.customerName || payload.customer_name || "");
  var conditions   = payload.conditions || {};
  var commandId    = payload.commandId  || null;
  if (!customerId) return;

  // v2.5.77: 光って選択するモードの間は Realtime の検索コマンドも動かさない
  if (_guideOnly()) { console.log("[SB-RT] 光って選択するモードのため scrape_command を無視 (customerId=" + customerId + ")"); return; }
  // スタッフモード中は Realtime コマンドを無視（claimしないので別PC or DBポーリングが処理する）
  if (await _isStaffModeActive()) {
    console.log("[SB-RT] スタッフモード中 → scrape_command を無視 (customerId=" + customerId + ")");
    return;
  }

  // ★ 2026-11-20: この SW で一括が動いている間は、ロックの時刻が古くても受けない（二重に走らせない・止めた印を消さない）
  if (_batchLoopAlive || _manualBulkAlive) {
    console.log("[SB-RT] 一括が動いている → スキップ (customerId=" + customerId + ")");
    return;
  }
  // ★ 2.8.265: 手の一括の続きを待っている間（裏が立ち上がり直した直後）も受けない
  try {
    var _rtBq = await _bulkQueueLoad();
    if (_rtBq && !_rtBq.done && _rtBq.beatAt && Date.now() - _rtBq.beatAt < 20 * 60000) {
      console.log("[SB-RT] 手の一括の続きを待っている → スキップ (customerId=" + customerId + ")");
      return;
    }
  } catch (_) {}
  // batchRunning ロックチェック（二重実行防止）
  var stLock = await chrome.storage.local.get("batchRunning");
  var lock = stLock.batchRunning;
  if (lock) {
    var startedAt = (typeof lock === "object" && lock) ? lock.startedAt : 0;
    if (startedAt && Date.now() - startedAt < BATCH_LOCK_TTL_MS) {
      console.log("[SB-RT] batchRunning 中 → スキップ (customerId=" + customerId + ")");
      return;
    }
  }

  console.log("[SB-RT] scrape_command 受信 → popup.js完全フローで実行 customerId=" + customerId);
  // 前回ストップで残留したフラグをクリア（_runBatchSearch 経路と同様）
  _batchShouldStop = false;
  await chrome.storage.local.set({ batchStopRequested: false });
  await chrome.storage.local.set({ batchRunning: { running: true, startedAt: Date.now() }, batchCommandId: commandId });
  if (commandId) _updateBatchCommand(commandId, { status: "running" }).catch(function() {});
  // 2026-09-29 v2.5.40 見張り: この経路もロックを取るので「この SW で回が動いている」印を立てる（無いと止まりの見張りが「ロックだけ残っている」と誤る）
  _batchLoopAlive = true;
  _watchSet({ commandId: commandId ? String(commandId) : "realtime", batchStartedAt: Date.now(), customerId: customerId ? String(customerId) : null, customerName: customerName || null, site: "realnetpro", pass: null, waitingFor: "Realtime の検索（popup の流れ）" });

  try {
    // customerName を conditions に含める（_runScrapeAndCompare は conditions.customerName を参照）
    var mergedConditions = Object.assign({}, conditions, { customerName: customerName });
    await _runScrapeAndCompare(customerId, mergedConditions);
    if (commandId) _updateBatchCommand(commandId, { status: "done", completed_at: new Date().toISOString() }).catch(function() {});
    _sbBroadcastResult({ customerId: customerId, ok: true });
  } catch(e) {
    if (commandId) _updateBatchCommand(commandId, { status: "error", error_message: String(e) }).catch(function() {});
    _sbBroadcastResult({ customerId: customerId, ok: false, error: String(e).slice(0, 300) });
  } finally {
    _batchLoopAlive = false;
    _watchClear();
    await chrome.storage.local.set({ batchRunning: null, batchCommandId: null });
  }
}

function _sbBroadcastResult(result) {
  _sbSend({
    topic: _SB_RES_CHANNEL,
    event: "broadcast",
    payload: { type: "broadcast", event: "scrape_result", payload: result },
    ref: String(++_sbWsRef),
  });
  console.log("[SB-RT] 結果配信:", JSON.stringify(result));
}

// 起動時に Supabase Realtime へ接続
_sbConnect();

// ── 学習済みマップのキャッシュ付き取得（resolveConditionsLocal の learned パラメータ用）──
// popup.js の fetchLearnedMaps と同じ3エンドポイントを読む。失敗時は {}（静的マップのみで解決）。
var _learnedMapsCache = null;   // { wards, stations, lineOrder } または { __failed: true }
var _learnedMapsCacheAt = 0;    // epoch ms
var _LEARNED_MAPS_TTL_OK = 6 * 60 * 60 * 1000; // 成功キャッシュ: 6時間
var _LEARNED_MAPS_TTL_NG = 10 * 60 * 1000;     // 失敗キャッシュ: 10分（連続バッチで毎回タイムアウト待ちしない）

async function _getLearnedMapsCached() {
  var now = Date.now();
  if (_learnedMapsCache) {
    var ttl = _learnedMapsCache.__failed ? _LEARNED_MAPS_TTL_NG : _LEARNED_MAPS_TTL_OK;
    if (now - _learnedMapsCacheAt < ttl) {
      return _learnedMapsCache.__failed ? {} : _learnedMapsCache;
    }
  }
  try {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 6000);
    var results;
    try {
      results = await Promise.all([
        fetch(SUMORA_BATCH_API + "/api/region-map",    { cache: "no-store", signal: ctrl.signal }),
        fetch(SUMORA_BATCH_API + "/api/station-map",   { cache: "no-store", signal: ctrl.signal }),
        fetch(SUMORA_BATCH_API + "/api/line-stations", { cache: "no-store", signal: ctrl.signal }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    var wards = {}, stations = {}, lineOrder = {};
    if (results[0].ok) {
      var rd = await results[0].json();
      (rd.regions || []).forEach(function (r) { wards[r.token] = r.ward; });
    }
    if (results[1].ok) {
      var sd = await results[1].json();
      (sd.stations || []).forEach(function (s) {
        stations[s.token] = {
          ward: s.ward,
          realpro_lines: s.realpro_lines || [],
          itandi_lines: s.itandi_lines || [],
          reins_line: s.reins_line || null,
        };
      });
    }
    if (results[2].ok) {
      var ld = await results[2].json();
      lineOrder = ld.lines || {};
    }
    _learnedMapsCache = { wards: wards, stations: stations, lineOrder: lineOrder };
    _learnedMapsCacheAt = now;
    return _learnedMapsCache;
  } catch (e) {
    console.warn("[bg] 学習済みマップ取得失敗（静的マップのみでローカル解決）:", (e && e.message) || e);
    _learnedMapsCache = { __failed: true };
    _learnedMapsCacheAt = now;
    return {};
  }
}

// ── ローカル解決結果にAPI結果をマージ（配列はローカル優先の和集合・順序保持）──
function _mergeResolved(local, api) {
  api = api || {};
  function union(a, b) {
    var out = (a || []).slice();
    (b || []).forEach(function (v) { if (out.indexOf(v) === -1) out.push(v); });
    return out;
  }
  return {
    city_codes:        union(local.city_codes,        api.city_codes),
    route_ids:         union(local.route_ids,         api.route_ids),
    station_names:     union(local.station_names,     api.station_names),
    ward_names:        union(local.ward_names,        api.ward_names),
    itandi_line_names: union(local.itandi_line_names, api.itandi_line_names),
    reins_line_names:  union(local.reins_line_names,  api.reins_line_names),
    detail_ward: local.detail_ward || api.detail_ward || null,
    detail_area: local.detail_area || api.detail_area || null,
    // ローカルの unknown_tokens はAPIへの入力そのもの。残すと二重報告になるためAPIの最終判定を採用
    unknown_tokens: api.unknown_tokens || [],
    // 家賃・築年数は決定的な算術（wide時 +5000/+10000・+5年）。API側の再適用を無視して二重加算を防ぐ
    rent_max_resolved:     local.rent_max_resolved,
    building_age_resolved: local.building_age_resolved,
  };
}

// ── エリア条件解決のローカルファースト化 ─────────────────────────────────────
// Phase 1a: resolution-core.js の resolveConditionsLocal（popup.js と同一ロジック）で
//           ネットワークなしで解決。静的マップにあるトークン（大多数）はここで完結する。
// Phase 1b: 未解決トークンが残った場合のみ resolve-search-conditions API（DeepSeek）に
//           フォールバック。未解決分だけを投げるため、APIの応答がローカル解決分を潰さない。
// API 呼び出し条件: unknown_tokens あり、または エリア入力があるのにローカル結果が完全空。
// API 失敗時はローカル結果のまま続行（部分解決でも有効な条件）。
// 戻り値は resolve-search-conditions API と同形（呼び出し側のマージコードは変更不要）。
async function _resolveLocalFirst(baseConditions, isWide) {
  baseConditions = baseConditions || {};

  var desiredAreaFull = String(
    baseConditions.desired_area ||
    (baseConditions.areas && baseConditions.areas.length ? baseConditions.areas.join("・") : "") ||
    ""
  ).trim();
  var hasAreaInput = !!(
    desiredAreaFull ||
    (baseConditions.lines && baseConditions.lines.length) ||
    (baseConditions.stations && baseConditions.stations.length)
  );

  // Phase 1a: ローカル解決
  var local = null;
  try {
    var R = globalThis.SUMORA_RESOLUTION;
    if (R && typeof R.resolveConditionsLocal === "function") {
      var learned = await _getLearnedMapsCached(); // 失敗時 {}
      local = R.resolveConditionsLocal(baseConditions, { isWide: !!isWide, learned: learned }) || null;
      if (local) {
        console.log("[resolveLocalFirst] ローカル解決:", JSON.stringify({
          city_codes: local.city_codes,
          route_ids: local.route_ids,
          station_names: local.station_names,
          unknown_tokens: local.unknown_tokens,
        }));
      }
    }
  } catch (e) {
    console.warn("[resolveLocalFirst] ローカル解決エラー（APIフォールバックへ）:", e);
    local = null;
  }

  // resolution-core 未ロード等でローカル解決不能 → 従来どおりフルスコープでAPI
  if (!local) {
    if (!hasAreaInput) return {};
    try {
      var respFull = await fetch(SUMORA_BATCH_API + "/api/resolve-search-conditions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          desired_area: desiredAreaFull,
          lines: baseConditions.lines || [],
          stations: baseConditions.stations || [],
          is_wide: !!isWide,
          rent_max: baseConditions.rent_max || null,
          building_age: baseConditions.building_age || null,
        }),
        signal: AbortSignal.timeout(30000), // DeepSeekが最大20秒かかるため30秒
      });
      if (respFull.ok) return await respFull.json();
    } catch (e) {
      console.warn("[resolveLocalFirst] resolve-search-conditions 失敗（従来条件で続行）:", e);
    }
    return {};
  }

  // Phase 1b: APIフォールバック判定
  var unknownTokens = local.unknown_tokens || [];
  var localEmpty =
    !(local.city_codes && local.city_codes.length) &&
    !(local.route_ids && local.route_ids.length) &&
    !(local.station_names && local.station_names.length) &&
    !local.detail_ward;
  var needApi = unknownTokens.length > 0 || (hasAreaInput && localEmpty);
  if (!needApi) return local; // ハッピーパス: ネットワーク不要

  var resolved = local;
  try {
    var resolveResp = await fetch(SUMORA_BATCH_API + "/api/resolve-search-conditions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // 未解決トークンだけをAPIに投げる（全部未解決なら desired_area 全体）
        desired_area: unknownTokens.length ? unknownTokens.join("・") : desiredAreaFull,
        lines: [], stations: [], // 明示 lines/stations はローカルで処理済み
        is_wide: !!isWide,
        rent_max: baseConditions.rent_max || null,
        building_age: baseConditions.building_age || null,
      }),
      signal: AbortSignal.timeout(30000), // DeepSeekが最大20秒かかるため30秒
    });
    if (resolveResp.ok) resolved = _mergeResolved(local, await resolveResp.json());
  } catch (e) {
    console.warn("[resolveLocalFirst] APIフォールバック失敗（ローカル解決結果で続行）:", (e && e.message) || e);
  }
  return resolved;
}

// ── 修正10: automation API 共有シークレット ──────────────────────────────────
// chrome.storage.local の automationApiKey に設定した値を x-automation-key として送る。
// （拡張にはハードコード禁止のため、サービスワーカーコンソールで
//   chrome.storage.local.set({automationApiKey: "..."}) を一度実行して設定する）
async function _getAutomationKeyHeader() {
  try {
    var st = await chrome.storage.local.get("automationApiKey");
    return st.automationApiKey ? { "x-automation-key": st.automationApiKey } : {};
  } catch (e) {
    return {};
  }
}

// ── 検索の点検（2026-09-25 竹内「ブレインモードで物件自動検索や一括検索した際に、検索がちゃんとされていなかったら原因を見つけられるようにする」）──
// 1回の検索（お客様×サイト×パス）ごとに run_id を作り、/api/search-audits に started → finished を送る（search-audit.js の tracker）。
//   ・ブレインの時だけ（AxlxModeCore.behavior の searchAudit）。送信は5秒で切り、失敗しても検索は止めない
//   ・run_id は axlx-switch-customer で popup.js に渡し、popup が page-script に渡す conditions._audit_run_id に載る
//     → page-script が fill-done に audit（押せた・押せなかった駅・検索直前のフォームの読み戻し）を載せて返す → content.js が中継 → ここで足す
//   ・結果（ページ数・読んだ行数・送れる行数・0件の理由・件数表示の生の文字）は bulk-dl.js / itandi-bulk-dl.js の axlx-batch-customer-done で届く
//   ・一括検索は呼び出し元が _auditFinish を呼ぶ。個別の検索（popup が run_id を作った回）は結果が届いた時／レインズは fill-done の時に閉じる
var _auditTracker = (self.AxlxSearchAudit && self.AxlxSearchAudit.createTracker({
  extVersion: (function () { try { return chrome.runtime.getManifest().version; } catch (_) { return null; } })(),
})) || null;
// 個別の検索の閉じ忘れ（結果が届かない）を6分で閉じる
var AUDIT_SINGLE_CLOSE_MS = 6 * 60 * 1000;
var _auditSingleTimers = new Map();
/**
 * ★ 2026-11-19 悠馬さん「自動で止まっていないか／統括が正しく把握」:
 *   6分の閉じ処理は、終わりの合図（fill-done）も結果（batch-customer-done）も届かない時に動く。
 *   旧は error:null で閉じ、「ok（完走）」として統括に入っていた（平田さん 15:25 の回は送付 0 件なのに ok）。
 *   → 「合図が届かず閉じた」と分かる印（error_kind:idle_close）を付けて閉じる。
 */
function AUDIT_IDLE_CLOSE_EXTRA() {
  return { error: "idle_close: 終わりの合図（fill-done）が6分届かず閉じた", error_kind: "idle_close" };
}

// 今のモード → { enabled, mode }（mode は brain_normal / brain_staff / brain_aix）
function _auditState() {
  return new Promise(function (resolve) {
    try {
      var core = self.AxlxModeCore;
      var keys = (core && core.STORAGE_KEYS) || ["staffMode", "staffModeAt", "aixMode", "brainMode"];
      chrome.storage.local.get(keys, function (raw) {
        if (!core || !_auditTracker) { resolve({ enabled: false, mode: null }); return; }
        var st = core.readState(raw || {}, Date.now());
        var b = core.behavior(st.mode, st.brain);
        resolve({ enabled: !!b.searchAudit, mode: self.AxlxSearchAudit.modeLabel(st) });
      });
    } catch (_) { resolve({ enabled: false, mode: null }); }
  });
}

// 一括検索の1回を始める（ブレインでなければ null＝何も送らない）
async function _auditBegin(ctx) {
  try {
    var st = await _auditState();
    if (!st.enabled) return null;
    var run = _auditTracker.begin(Object.assign({}, ctx, { mode: st.mode }));
    if (run) _auditCloseHumanSearchRuns(run.site, run.run_id);
    return run ? { runId: run.run_id, trigger: run.trigger, commandId: run.command_id } : null;
  } catch (e) {
    console.warn("[search-audit] begin 失敗（検索は続ける）:", e && e.message);
    return null;
  }
}

// その回に「入れようとした条件」を足す（popup を通らない経路＝executeScript の代わり・レインズ）
function _auditPostIntended(auditRun, site, conds) {
  if (!auditRun || !self.AxlxSearchAudit) return;
  var A = self.AxlxSearchAudit;
  var run = _auditTracker.get(auditRun.runId);
  A.post({ phase: "started", brain: true, run_id: auditRun.runId, site: A.siteKey(site), mode: run && run.mode, trigger: auditRun.trigger, intended: A.pickIntended(conds) });
}

function _auditStep(runId, k, d) {
  try {
    if (_auditTracker && runId) {
      _auditTracker.step(runId, k, d);
      if (_auditTracker.flushSoon) _auditTracker.flushSoon(runId, 3000);
    }
  } catch (_) {}
}

/** 次の回が始まったら、同じサイトで開いたままの「人が押した検索」の回を区切りとして閉じる（6分の idle_close を待たない） */
function _auditCloseHumanSearchRuns(site, exceptRid) {
  try {
    if (!_auditTracker || !_auditTracker.openHumanSearchRuns) return;
    _auditTracker.openHumanSearchRuns(site, exceptRid).forEach(function (rid) {
      _auditStep(rid, "human_search_superseded", "次の回が始まった → 人が押した検索の回を区切りとして閉じる");
      _auditFinish(rid, {});
    });
  } catch (_) {}
}

/** 開いている人の回（single/local）。site を渡すとそのサイトだけ（"realpro"/"itandi"）。無ければ null */
function _openHumanRun(site) {
  var hit = null;
  try {
    if (!_auditTracker || !_auditTracker._runs) return null;
    _auditTracker._runs.forEach(function (r) {
      if (!r || r.finished) return;
      if (r.trigger !== "single" && r.trigger !== "local") return;
      if (site && r.site && r.site !== site) return;
      if (!hit || r.started_at > hit.started_at) hit = r;
    });
  } catch (_) {}
  return hit;
}

/**
 * ★ 2026-11-19 (2.8.128) 竹内さん「連続検索として抜けている所を徹底的に」:
 *   個別（single/local）の点検は、最後の fill 進捗から6分で idle_close に閉じる。
 *   しかし PDF の送付は1件約21秒（20件で7分）かかり、送付中は fill 進捗が出ない → **健全に送付中でも6分で idle_close に閉じ**、
 *   後から届く結果（件数・ページ）の行き先が無くなって統括に「止まった」と見えていた。
 *   → 一覧側の送付の進み（axlx-batch-progress）が来るたびに、そのお客さんの閉じ待ちを張り直す（元から閉じ待ちが無い回には触らない）。
 */
function _auditTouchIdleTimer(customerId, msgSite) {
  try {
    if (!_auditTracker || !customerId) return;
    var run = _auditTracker.findOpen(String(customerId), msgSite === "itandi" ? "itandi" : "realpro");
    if (!run || !(run.trigger === "single" || run.trigger === "local")) return;
    var rid = run.run_id;
    var prev = _auditSingleTimers.get(rid);
    if (!prev) return;
    clearTimeout(prev);
    _auditSingleTimers.set(rid, setTimeout(function () { _auditSingleTimers.delete(rid); _auditFinish(rid, AUDIT_IDLE_CLOSE_EXTRA()); }, AUDIT_SINGLE_CLOSE_MS));
  } catch (_) {}
}

function _auditFinish(runId, extra) {
  try {
    if (!_auditTracker || !runId) return;
    var t = _auditSingleTimers.get(runId);
    if (t) { clearTimeout(t); _auditSingleTimers.delete(runId); }
    var x = extra || {};
    try {
      var _A0 = self.AxlxSearchAudit;
      if (_A0 && _A0.softenIdleClose) {
        var _sf = _A0.softenIdleClose(_auditTracker.get(runId), x);
        if (_sf.soft) { _auditTracker.step(runId, "human_search_idle", _sf.note); x = _sf.extra; }
      }
    } catch (_) {}
    if (x.error && x.error.message) x = Object.assign({}, x, { error: x.error.message });
    if (x.error && String(x.error) === "__BATCH_STOPPED__") x = Object.assign({}, x, { error_kind: "stopped" });
    // 2.8.125 前客の条件を外し切れず中止した回（page-script の fill-done error 頭 "leftover_stuck:"）は種類を付けて点検で数えられるように
    if (x.error && !x.error_kind && /leftover_stuck:/.test(String(x.error))) x = Object.assign({}, x, { error_kind: "leftover_stuck" });
    _auditTracker.finish(runId, x);
  } catch (e) { console.warn("[search-audit] finish 失敗:", e && e.message); }
}

/**
 * ★ 2026-11-16 統括Pro「stepsが届いていない」:
 *   fill-done 前の途中段を open run に足す（止まっても none を減らす）。
 */
async function _auditOnFillProgress(msg) {
  try {
    if (!_auditTracker || !msg) return;
    var st = await _auditState();
    if (!st.enabled) return;
    var _rid = msg.runId || null;
    var run = _rid ? _auditTracker.get(_rid) : null;
    if (!run && !_rid) {
      run = _auditTracker.findOpen(msg.customerId || null, msg.site || "realpro");
      if (run) _rid = run.run_id;
    }
    /**
     * ★ 2.8.265 DB 実測: 一括の回（bulk_manual）が steps 0 のまま started で残っていた（#1629 ほか 2.8.253 以降の全件）。
     *   画面が裏の知らない番号を付けてくると、別の local の回を作って段がそちらへ流れ、DB の行には1段も届かなかった。
     *   → 番号が知らない物でも、同じお客さん・サイトで開いている一括の回があればそこへ足す。
     */
    if (!run && _rid && msg.customerId != null) {
      var _openBulk = _auditTracker.findOpen(msg.customerId, msg.site || "realpro");
      if (_openBulk && _openBulk.trigger && _openBulk.trigger !== "single" && _openBulk.trigger !== "local") {
        run = _openBulk;
        _rid = _openBulk.run_id;
      }
    }
    if (!run) {
      var _hadPopupRunId = !!_rid;
      if (!_rid) _rid = "local_" + Date.now().toString(36);
      run = _auditTracker.begin({
        run_id: _rid, site: msg.site || "realpro", customer_id: msg.customerId,
        trigger: _hadPopupRunId ? "single" : "local", mode: st.mode, post_started: false,
      });
    }
    // ★ 2026-11-18 F18: popup single 等が途中で止まった場合に progress ごとに idle クローズタイマーを張り直す
    if (run && (run.trigger === "single" || run.trigger === "local")) {
      try {
        var _prevSt = _auditSingleTimers.get(_rid);
        if (_prevSt) clearTimeout(_prevSt);
        var _tProg = setTimeout(function () { _auditSingleTimers.delete(_rid); _auditFinish(_rid, AUDIT_IDLE_CLOSE_EXTRA()); }, AUDIT_SINGLE_CLOSE_MS);
        _auditSingleTimers.set(_rid, _tProg);
      } catch (_) {}
    }
    if (run && !run.human_search) _auditCloseHumanSearchRuns(run.site, _rid);
    if (_auditTracker.attachProgress) _auditTracker.attachProgress(_rid, msg.steps || []);
  } catch (e) {
    try { console.warn("[search-audit] fill-progress 失敗:", e && e.message); } catch (_) {}
  }
}

// fill-done に載ってきた audit を足す。知らない run_id（popup の個別の検索が作った回）はここで記録を作る
async function _auditOnFillDone(msg, sender) {
  try {
    if (!_auditTracker || !msg) return;
    /**
     * 2026-11-13 竹内さん「まだ自動モードで地域などの部分おせていない」:
     *   ⚠ 旧は `if (!msg.runId) return;` で、**run_id が無い回は段を1つも記録しなかった**
     *     （実測 7日で259回が「最後の段: none」）。
     *   → page-script が `local_` の番号を付けてくるので、**その番号でも記録する**。
     *     run_id は「点検の行を1つに束ねる」ための物なので、無ければ**その場の番号**で代用する。
     */
    var _rid = msg.runId || (msg.audit && msg.audit.run_id) || ("local_" + Date.now().toString(36));
    var run = _auditTracker.get(_rid);
    // ★ 2.8.265: 知らない番号でも、同じお客さん・サイトで開いている一括の回があればそこへ足す（_auditOnFillProgress と同じ）
    if (!run && msg.customerId != null) {
      var _openBulkD = _auditTracker.findOpen(msg.customerId, msg.site || "realpro");
      if (_openBulkD && _openBulkD.trigger && _openBulkD.trigger !== "single" && _openBulkD.trigger !== "local") {
        run = _openBulkD;
        _rid = _openBulkD.run_id;
      }
    }
    if (!run) {
      var st = await _auditState();
      if (!st.enabled) return;
      // popup が started を送り済み（post_started:false）
      // 2026-09-27: 広げてかどうかは popup の started が正（is_wide を入れている）。ここで既定の false を持つと finished が
      //   is_wide=false で上書きし、広げての個別の検索が「ピンポイント」と記録されていた（自動で広げる連鎖が誤って動く）
      //   → 覚え書き（popup の _auditTag が残す）から読み、分からなければ null（finished で送らない＝started の値のまま）
      var _sm = await _searchModeFor(msg.customerId, msg.site);
      run = _auditTracker.begin({
        run_id: _rid, site: msg.site, customer_id: msg.customerId,
        trigger: msg.runId ? "single" : "local", mode: st.mode, post_started: false,
        is_wide: _sm ? _sm === "widen" : null,
      });
      var timer = setTimeout(function () { _auditSingleTimers.delete(_rid); _auditFinish(_rid, AUDIT_IDLE_CLOSE_EXTRA()); }, AUDIT_SINGLE_CLOSE_MS);
      _auditSingleTimers.set(_rid, timer);
    }
    var _pageErr = msg.pageError || msg.error || null;
    _auditTracker.attachFill(_rid, { audit: msg.audit || null, error: _pageErr });
    if (!run.human_search) _auditCloseHumanSearchRuns(run.site, _rid);
    // 2026-09-29 見張り（C1・C2）: ここまで来た回はブレインモード（点検の記録がある回）だけ。待たない
    _watchAfterFill(msg, run, sender);
    /**
     * ★ 2026-11-15 **実測で見つけた「完走率が低い」本当の原因**:
     *
     *   ⚠ `brain_normal / single` が **完走20回・止まり385回**（止まった回にも人の操作が 1016手 入っている）。
     *     `brain_staff / single` も 完走11・止まり188。
     *     統括はこれを見て「完走率8%・検索が押せていない」と判断していたが、
     *     **実際は人が最後まで操作して検索を押していた**（`filled.ops` が35〜53手）。
     *
     *   なぜ閉じないか: `finished` を送るのは
     *     ① 一括の結果が届いた時（`_auditOnBatchDone`・`trigger === "single"`）
     *     ② 失敗した時（`_pageErr`）
     *     ③ レインズ（結果の取り込みが無い）
     *   の3つだけ。**通常/スタッフモードの人の検索は①②③のどれにも当たらない**ので、
     *   `started` のまま20分残り、見回り（`sweepSearchAudits`）に `abandoned` にされていた。
     *   → **止まっていないのに止まったと記録されていた**（統括の判断が狂う最大の原因）。
     *
     *   → 人の検索（`brain_normal` / `brain_staff`）は**結果の取り込みが無い**ので、
     *     `fill-done` が届いた時点で閉じる（理由も段に残す）。
     *     ⚠ 自動（`brain_aix`）は今まで通り結果を待つ（勝手に閉じない）。
     */
    /**
     * ★ 2026-11-22 2.8.185 audit#1584 実測 → ★ 2.8.186 修正:
     *   brain_staff は **スタッフ選択だけ**でも検索後に AD並び替え→PDF押しがある
     *   （mode-core: staff → autoSend）。旧は `_autoModeChosen`（自動/AIXのみ）で
     *   早期クローズを止めていたため、スタッフ単独では human_search_done で閉じ、
     *   並べ替え印（dl:sort_* / search_to_sort / list_flow）が監査に残らなかった。
     *   → 自動／AIX／スタッフのときは閉じない（結果・並び替えを待つ）。
     */
    var _humanRun = run.mode === "brain_normal" || run.mode === "brain_staff";
    if (_humanRun && _keepAuditOpenAfterFill()) _humanRun = false;
    if (!_pageErr && _humanRun && (run.trigger === "single" || run.trigger === "local")) {
      _auditStep(_rid, "human_search_done", "人が押した検索（結果の取り込みは無い）→ ここで閉じる");
      _auditFinish(_rid, {});
      return;
    }
    // レインズは結果の読み取り（一括送信）が無いので fill-done で閉じる。個別の検索で失敗した時もここで閉じる
    if (run.site === "reins" || ((run.trigger === "single" || run.trigger === "local") && _pageErr)) _auditFinish(_rid, {});
  } catch (e) { console.warn("[search-audit] fill-done の記録に失敗:", e && e.message); }
}

// bulk-dl.js / itandi-bulk-dl.js の結果を、そのお客様のまだ閉じていない回に足す
function _auditOnBatchDone(customerId, propertyCount, audit) {
  try {
    if (!_auditTracker) return;
    var site = audit && audit.site ? audit.site : null;
    var run = _auditTracker.findOpen(customerId != null ? String(customerId) : null, site);
    if (!run) return;
    var res = Object.assign({}, audit || {});
    delete res.site;
    if (propertyCount != null) res.property_count = propertyCount;
    _auditTracker.attachResult(run.run_id, res);
    if (run.trigger === "single") _auditFinish(run.run_id, {});
  } catch (e) { console.warn("[search-audit] 結果の記録に失敗:", e && e.message); }
}

// そのお客様のまだ閉じていない回の run_id（_scrapeAndSendRealpro から印を付ける時）
function _auditOpenRunId(customerId, site) {
  try {
    var run = _auditTracker && _auditTracker.findOpen(customerId != null ? String(customerId) : null, site || null);
    return run ? run.run_id : null;
  } catch (_) { return null; }
}

// ── 修正4: 検索完了シグナル（fill-done）待機インフラ ─────────────────────────
// page-script.js / itandi-page-script.js が検索実行後に postMessage する
// 'aixlinx-fill-done' を content script が axlx-fill-done として中継してくる。
// スクレイプ側は autofill 発火「前」に _createFillDoneWaiter() で Promise を
// 作成しておき、シグナル受信（true）またはタイムアウト（false）を待つ。
var _fillDoneWaiters = [];

// Fix 2: モジュールレベルの同期ストップフラグ。
// chrome.storage.local.get の非同期ラグなしに即座に参照できる。
// stop_command (Realtime WebSocket) と axlx-force-stop-batch (window.postMessage 経由)
// の両方で true にセットする。バッチ開始時に false へリセットする。
var _batchShouldStop = false;
// 2.8.128 busy_other_customer で断られて最後にやり直し済みのお客さん（一括ごとに作り直す）
var _busyRetried = new Set();

// resolve 値は { timedOut: boolean, error: string|null } に統一。
// error は page-script.js が fill-done に載せたエラー内容（フォールバック検索は実行済み）。
// 2026-09-18 竹内（一括検索で違うお客さんの条件が送られるバグ）:
//   タイムアウトで捨てた待ちの顧客 ID を覚えておき、**遅れて届いたシグナル**を無視する。
//   これが無いと「顧客Aの待ちがタイムアウト → 次へ → 顧客Aの fill-done が遅れて到着 →
//   顧客Bの待ちを解決 → まだ検索中の画面を顧客Bとしてスクレイプ」が起きる
var _abandonedFillDoneIds = new Map(); // customerId -> 捨てた時刻(ms)
var ABANDONED_FILL_DONE_TTL_MS = 10 * 60 * 1000;

function _sweepAbandonedFillDoneIds() {
  var now = Date.now();
  _abandonedFillDoneIds.forEach(function (at, id) {
    if (now - at > ABANDONED_FILL_DONE_TTL_MS) _abandonedFillDoneIds.delete(id);
  });
}

// 2026-09-30 v2.5.43 同時の回（同じお客様のリアプロと ITANDI が並んで走る）: 捨てた記録はお客様×サイト（鍵 "id|site"）。
//   旧はお客様だけだったので、ITANDI の待ちを捨てるとリアプロの fill-done まで「遅れて届いた」と無視された
function _abandonKey(customerId, site) { return String(customerId) + "|" + (site || ""); }
function _markFillDoneAbandoned(customerId, site) {
  if (!customerId) return;
  _abandonedFillDoneIds.set(_abandonKey(customerId, site), Date.now());
  _sweepAbandonedFillDoneIds(); // 無限に溜めない
}

/**
 * 捨てた記録を消す（その顧客をもう一度検索し直す時に、遅延シグナル扱いのまま詰まらないように）。
 * 一括検索は1人につき1回 _createFillDoneWaiter を作るので、作る時に必ず消す。
 */
function _clearFillDoneAbandoned(customerId, site) {
  if (customerId) _abandonedFillDoneIds.delete(_abandonKey(customerId, site));
}

// その合図のサイトで捨てたお客様の ID（サイトの分からない記録・合図は両方に効かせる＝取り違えない側）
function _abandonedIdsFor(site) {
  var out = new Set();
  _abandonedFillDoneIds.forEach(function (_at, key) {
    var i = key.lastIndexOf("|");
    var id = i >= 0 ? key.slice(0, i) : key, s = i >= 0 ? key.slice(i + 1) : "";
    if (!site || !s || s === site) out.add(id);
  });
  return out;
}

function _notifyFillDone(site, customerId, error) {
  _sweepAbandonedFillDoneIds(); // 期限切れの記録を落としてから判定に渡す
  // 誰の分かの判定（捨てた顧客の遅延シグナルの無視も含む）は fill-done-match.js（純関数・テストあり）に1本化
  var sel = self.AxlxFillDoneMatch.selectWaiters(
    _fillDoneWaiters,
    { site: site || null, customerId: customerId || null },
    _abandonedIdsFor(site || null)
  );
  if (!sel.resolve.length) {
    console.warn("[fill-done] 解決しない（" + sel.reason + "） customerId=" + customerId + " site=" + site
      + " 待ち=" + _fillDoneWaiters.map(function (w) { return w.customerId || "(id無)"; }).join(","));
    return;
  }
  sel.resolve.forEach(function (w) {
    clearTimeout(w.timer);
    try { if (w.stopInterval) clearInterval(w.stopInterval); } catch (_) {}
    w.resolve({ timedOut: false, error: error || null });
  });
  _fillDoneWaiters = _fillDoneWaiters.filter(function (w) { return sel.resolve.indexOf(w) < 0; });
}

// fill-done（自動入力完了の合図）を待つ上限。page-script 側のウォッチドッグより5秒長くする
// itandi は路線ごとに駅リストが切り替わり、「電車1本」の沿線全駅選択（13路線）で時間がかかるため150秒＋5秒（2026-09-12 竹内）
// 2026-09-14 竹内「時間かかっても大丈夫」: page-script のウォッチドッグ 240秒＋5秒
// 2026-11-10 v2.5.96 竹内さん「駅も一気に選択してしまう・上下の時間もはやすぎる」: 駅は1つ 320〜900ms にしたので、
//   沿線の全駅（40〜120駅）を選ぶと 40〜110秒かかる。リアプロも 90秒では足りないため 240秒にする（itandi と同値）
// 2026-11-10 v2.6.14 竹内さん「人間のように」で全操作を人の速度にした結果、245秒でも足りなくなった
//   （条件を1つずつ選ぶ・カーソルを動かす・迷う・たまに手が止まる）。**人が作業する時間**に合わせて 15分にする。
//   ⚠ 止まったまま15分待つのは長いので、page-script 側の見張り（無進捗の検出）で先に止める（下の _stallWatch）
// ★ 2026-11-18 竹内さん「タイムアウトがボトルネック／かなり長い時間・15分など」:
//   旧 905秒≈15分でも9区＋間取りリトライで足りない → 両サイト 30分。進捗で更に延長。
var FILL_DONE_TIMEOUT_MS = { itandi: 1800000, realnetpro: 1800000 };
function _fillDoneTimeoutMs(site) {
  return FILL_DONE_TIMEOUT_MS[site] || 900000; // 既定も15分（旧90秒は短すぎ）
}

function _createFillDoneWaiter(site, customerId, timeoutMs) {
  // 2026-09-18: この顧客を新しく待ち始める＝前回「捨てた」記録は用済み（再検索が詰まらないように消す）
  _clearFillDoneAbandoned(customerId, site);
  try { _clearEarlyBatchDone(customerId, site === "itandi" ? "itandi" : "realnetpro"); } catch (_) {} // 新しい回の始まり＝前の回の「先に届いた完了」は用済み
  return new Promise(function (resolve) {
    var entry = { site: site || null, customerId: customerId || null, resolve: resolve, timer: null };
    // Fix 3: _batchShouldStop を 500ms ごとにポーリングし、true になったら即解決する。
    // これにより 90秒ブロッキングが最大 500ms 遅延に短縮される。
    var stopInterval = setInterval(function () {
      if (!_batchShouldStop) return;
      clearInterval(stopInterval);
      clearTimeout(entry.timer);
      var idx = _fillDoneWaiters.indexOf(entry);
      if (idx >= 0) _fillDoneWaiters.splice(idx, 1);
      console.log("[fill-done-waiter] _batchShouldStop 検知 → stopped:true で解決");
      resolve({ timedOut: false, stopped: true, error: null });
    }, 500);
    entry.stopInterval = stopInterval; // 合図で解く時にも止める（残ると後のお客さんの「止める」で空の解決を呼ぶ）
    var onTimeout = function (extra) {
      clearInterval(stopInterval);
      clearTimeout(entry.timer);
      var idx = _fillDoneWaiters.indexOf(entry);
      if (idx >= 0) _fillDoneWaiters.splice(idx, 1);
      // 2026-09-18: 捨てたことを覚えておく。後から届くこの顧客の fill-done で
      //   次の顧客の待ちが解決される（＝違うお客さんの条件で送られる）のを防ぐ
      _markFillDoneAbandoned(entry.customerId, entry.site);
      console.warn("[fill-done-waiter] タイムアウト customerId=" + entry.customerId + " site=" + entry.site + (extra ? "（" + extra + "）" : ""));
      // 2026-09-29 v2.5.40 本当の時間切れの時だけ画面を撮る（検索しないと決めて閉じた時＝extra ありは撮らない）
      if (!extra) _snapOnEvent("fill_timeout", "検索の完了の合図（fill-done）が来ない customer=" + entry.customerId + " site=" + entry.site);
      /**
       * ★ 2026-11-17 連携: fill-done 無しで捨てる前に、開いている点検を finish する。
       *   旧は catch 任せ → _batchAudit が無い／拡張落ちで started のまま → sweep が
       *   abandoned + steps空（stalled:realpro:none）にしていた。
       */
      try {
        var _toRun = _auditTracker && _auditTracker.findOpen
          ? _auditTracker.findOpen(entry.customerId, entry.site || "realpro")
          : null;
        if (_toRun && _toRun.run_id) {
          _auditTracker.step(_toRun.run_id, "fill_timeout", extra ? String(extra).slice(0, 80) : "fill-done未着");
          _auditFinish(_toRun.run_id, {
            error: extra ? String(extra) : "fill-done timeout",
            error_kind: extra ? "cancelled" : "fill_timeout",
          });
        }
      } catch (_) {}
      resolve({ timedOut: true, error: null, cancelled: !!extra });
    };
    entry.timer = setTimeout(onTimeout, timeoutMs || FILL_DONE_TIMEOUT_MS.realnetpro || 900000);
    /**
     * ★ 2026-11-19 竹内さん「タイムアウトでボトルネックとなっている部分を取り除いていく」（audit #1493）:
     *   入力の初めに1回だけ「前に出す」を試し、それでも見えない（最小化・別のデスクトップ・画面ロック）と
     *   ページのタイマーが止められて入力が進まないまま 30分の待ち切れまで待っていた（1864秒・fill_timeout）。
     *   → 進捗が2分無い間だけ1分ごとにタブが見えているかを確かめ、見えなければウィンドウを戻す。
     *     4回続けて見えないままなら、理由を付けて待ちを閉じる（約6分・進捗がある間は何もしない）。
     */
    var _hidLastProg = Date.now(), _hidN = 0, _hidBusy = false;
    var _hidWatch = setInterval(function () {
      if (_fillDoneWaiters.indexOf(entry) < 0) { clearInterval(_hidWatch); return; }
      if (_hidBusy || Date.now() - _hidLastProg < 120000) return;
      _hidBusy = true;
      _fillTabHiddenCheck(entry).then(function (r) {
        _hidBusy = false;
        if (_fillDoneWaiters.indexOf(entry) < 0) { clearInterval(_hidWatch); return; }
        if (!r || !r.hidden) { _hidN = 0; return; }
        _hidN++;
        var _hidRun = null;
        try {
          _hidRun = _auditTracker && _auditTracker.findOpen
            ? _auditTracker.findOpen(entry.customerId, entry.site === "itandi" ? "itandi" : "realpro")
            : null;
        } catch (_) { _hidRun = null; }
        var _hidRid = _hidRun && _hidRun.run_id;
        var _hidSec = Math.round((Date.now() - _hidLastProg) / 1000);
        _auditStep(_hidRid, "tab_hidden_stall", _hidN + "回目: タブが見えないまま進捗" + _hidSec + "秒無し→ウィンドウを戻す");
        _restoreWindowForTab(r.tabId, _hidRid, entry.site === "itandi" ? "ITANDI: " : "リアプロ: ").catch(function () {});
        if (_hidN >= 4) {
          clearInterval(_hidWatch);
          onTimeout("AXLX_TAB_HIDDEN: ウィンドウが隠れていて入力が進みません（最小化・別のデスクトップ・画面ロック）。画面を前に出してからもう一度");
        }
      }, function () { _hidBusy = false; });
    }, 60000);
    // 2026-09-27 v2.5.32: タブを読み直して1回やり直す時は待ちを始めから数え直す（_restartFillDoneWaiter）／
    //   検索しないと決めた時（タブが応答しない・地域が決まらない）は待たずに閉じる（_endFillDoneWaiter）
    entry.restart = function () {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(onTimeout, timeoutMs || FILL_DONE_TIMEOUT_MS.realnetpro || 900000);
      _hidLastProg = Date.now();
      _hidN = 0;
    };
    entry.end = function (why) { onTimeout(why || "検索しない"); };
    _fillDoneWaiters.push(entry);
  });
}
/** 待っているお客さんのタブ（無ければそのサイトの応答するタブ）が全部 hidden か。{ hidden, tabId } or null */
async function _fillTabHiddenCheck(entry) {
  var isIt = entry && entry.site === "itandi";
  var tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: isIt ? ["*://itandibb.com/*", "*://*.itandibb.com/*"] : ["*://realnetpro.com/*", "*://*.realnetpro.com/*"] });
  } catch (_) { tabs = []; }
  if (!tabs || !tabs.length) return null;
  var probes = [];
  for (var i = 0; i < tabs.length && i < 4; i++) {
    var p = null;
    try { p = isIt ? await _probeItandiTab(tabs[i].id) : await _probeRealproTab(tabs[i].id); } catch (_) { p = null; }
    if (p && p.pong) probes.push({ tabId: tabs[i].id, p: p });
  }
  var mine = probes.filter(function (x) { return x.p.fillCustomerId && String(x.p.fillCustomerId) === String(entry.customerId); });
  var cand = mine.length ? mine : probes;
  if (!cand.length) return null;
  return { hidden: cand.every(function (x) { return x.p.vis === "hidden"; }), tabId: cand[0].tabId };
}
function _findFillDoneWaiter(site, customerId) {
  for (var i = 0; i < _fillDoneWaiters.length; i++) {
    var w = _fillDoneWaiters[i];
    if (String(w.customerId) === String(customerId) && (!site || !w.site || w.site === site)) return w;
  }
  return null;
}
function _restartFillDoneWaiter(site, customerId) { var w = _findFillDoneWaiter(site, customerId); if (w && w.restart) w.restart(); }
function _endFillDoneWaiter(site, customerId, why) { var w = _findFillDoneWaiter(site, customerId); if (w && w.end) w.end(why); }

// ── 全ページ送信完了（axlx-batch-customer-done）待機インフラ ─────────────────────────
// bulk-dl.js が tryNext→全ページ完了時に chrome.runtime.sendMessage で通知する。
// _scrapeAndSendRealpro はこの Promise が解決するまで次顧客への移行を待つ。
var _batchCustomerDoneWaiters = [];
/**
 * 送付途中の hold（axlx_pipeline_send_hold）の番号。15分を過ぎた物・時刻の無い旧形式（文字だけ）は無いものとする。
 *   ★ 2026-11-20: 旧は storage.local に期限無しで残り、ブラウザを開き直しても後のお客さんが全員 SEND_HOLD で飛ばされ得た。
 *   anyAge=true は「完了合図で落とす」時用（古くても番号が合えば落とす）。
 */
function _sendHoldCid(v, anyAge) {
  try {
    if (!v) return null;
    if (typeof v === "string") return anyAge ? v : null;
    if (!v.cid) return null;
    if (!anyAge && (!v.at || Date.now() - Number(v.at) > 15 * 60 * 1000)) return null;
    return String(v.cid);
  } catch (_) { return null; }
}
// 待ちが解けた／切れたお客さんの番号（遅れて届く前のお客さんの合図を、次の人の待ちに当てないため・1時間）
var _finishedCids = new Map();
function _markFinishedCid(cid) {
  if (!cid) return;
  try {
    var now = Date.now();
    _finishedCids.set(String(cid), now);
    _finishedCids.forEach(function (at, k) { if (now - at > 3600000) _finishedCids.delete(k); });
  } catch (_) {}
}
function _isRecentlyFinishedCid(cid) {
  try {
    if (!cid) return false;
    var at = _finishedCids.get(String(cid));
    if (!at || Date.now() - at > 3600000) return false;
    for (var i = 0; i < _batchCustomerDoneWaiters.length; i++) {
      if (_batchCustomerDoneWaiters[i].customerId && String(_batchCustomerDoneWaiters[i].customerId) === String(cid)) return false;
    }
    return true;
  } catch (_) { return false; }
}

// 2026-09-30 v2.5.43 同時の回（リアプロと ITANDI が同じお客様で並んで走る）: 待ち手はサイトも持ち、合図の送り主のタブの URL（site）で当てる。
//   site が分からない合図（旧の経路）は今までどおりお客様 ID だけで当てる（待ちが1本の時）
function _waiterSiteMatch(w, site) { return !site || !w.site || String(w.site) === String(site); }
function _notifyBatchCustomerDone(customerId, propertyCount, audit, site, skippedRun) {
  var target = null;
  // 厳密一致優先
  if (customerId) {
    for (var _bdi = 0; _bdi < _batchCustomerDoneWaiters.length; _bdi++) {
      var _bdw = _batchCustomerDoneWaiters[_bdi];
      if (_bdw.customerId && String(_bdw.customerId) === String(customerId) && _waiterSiteMatch(_bdw, site)) { target = _bdw; break; }
    }
  } else {
    for (var _bdi2 = 0; _bdi2 < _batchCustomerDoneWaiters.length; _bdi2++) {
      var _bdw2 = _batchCustomerDoneWaiters[_bdi2];
      if (!_bdw2.customerId) { target = _bdw2; break; }
    }
  }
  if (!target) {
    /**
     * ★ 2026-11-19 (2.8.127) 竹内さん「次のお客さんに移る場面のところで固まってしまった」:
     *   番号が合わない（押している間に画面側でお客さんが選び直された・番号が取れなかった）時、
     *   旧は何もせず、待ちが20分（送付が進んだ後は45分）切れるまで次へ進まなかった。
     *   → そのサイトで待っている回が**1本だけ**なら、それが終わった回なので解く（番号のずれは記録に残す）。
     *   2本以上ある時は取り違えを避けて今まで通り何もしない。
     */
    var _only = [];
    for (var _oi = 0; _oi < _batchCustomerDoneWaiters.length; _oi++) {
      if (_waiterSiteMatch(_batchCustomerDoneWaiters[_oi], site)) _only.push(_batchCustomerDoneWaiters[_oi]);
    }
    /**
     * ★ 2026-11-20 竹内さん「前のお客さんと今検索しているお客さんの把握」:
     *   待ちが切れて次へ進んだ前のお客さんの遅れた合図が、次のお客さんの待ちを解いていた（次の人は送らずに完了扱い）。
     *   → 合図の番号が「もう終わった／待ちが切れたお客さん」なら、1本だけでも解かない。
     */
    if (_only.length === 1 && customerId && (skippedRun || _isRecentlyFinishedCid(customerId))) {
      console.warn('[AX] _notifyBatchCustomerDone: 終わった前のお客さんの遅れた合図 → 次のお客さんの待ちは解かない 合図=' + customerId + ' 待ち=' + _only[0].customerId);
      try { _snapOnEvent("batch_done_late_prev", "前のお客さん " + customerId + " の遅れた完了合図を、待ち " + _only[0].customerId + " に当てなかった"); } catch (_) {}
      return;
    }
    if (_only.length === 1) {
      target = _only[0];
      console.warn('[AX] _notifyBatchCustomerDone: 番号が合わないが待ちが1本だけ → 解く 合図=' + customerId + ' 待ち=' + target.customerId + ' ' + (site || ""));
      try { _snapOnEvent("batch_done_cid_mismatch", "完了合図の番号 " + customerId + " が待ち " + target.customerId + " と違うが、待ちが1本なので解いた"); } catch (_) {}
    }
  }
  if (!target) {
    console.warn('[AX] _notifyBatchCustomerDone: no waiter matched for', customerId, site || "");
    try { _snapOnEvent("batch_done_no_waiter", "完了合図 " + customerId + " に合う待ちが無い（待ち " + _batchCustomerDoneWaiters.length + "本）"); } catch (_) {}
    // 待ち手がまだ無い（fill-done 待ち→送付待ちの切替の隙間）なら覚えておき、後から作る待ち手がすぐ受け取る（2.8.128）
    // 「押さずに終わった」合図（skipped）は覚えない＝同じお客さんの次の回（駅のパス等）を先回りで終わらせない（2026-11-20）
    try { if (customerId && !skippedRun && _batchCustomerDoneWaiters.length === 0) _rememberEarlyBatchDone(customerId, site, propertyCount, audit); } catch (_) {}
    return;  // resolve しない・タイムアウト自然消化
  }
  clearInterval(target.stopInterval);
  clearTimeout(target.timer);
  var _bdIdx = _batchCustomerDoneWaiters.indexOf(target);
  if (_bdIdx >= 0) _batchCustomerDoneWaiters.splice(_bdIdx, 1);
  _markFinishedCid(target.customerId);
  // 2026-09-30 v2.5.42 ITANDI の「条件が効いていない形で止めた」（audit.guard）を待ち手に渡す（_scrapeAndSendRealpro → 1回だけ入れ直す）
  target.resolve({ ok: true, propertyCount: propertyCount != null ? propertyCount : null, guard: (audit && audit.guard_stopped && audit.guard) ? audit.guard : null });
}

/**
 * ★ 2026-11-16 竹内さん「完了してから次のお客さんに移ることができるように」:
 *   一連ロック（axlx_pipeline_job）を storage＋popup メモリの両方から外す。
 *   完了直後に次客 switch が来る競合・fill/batch 失敗でロックが残る抜けを止める。
 *   customerId を渡すと「その客のロックだけ」外す（次客が既に始まっていたら触らない）。
 */
function _releasePipelineLock(reason, customerId) {
  return new Promise(function (resolve) {
    var done = false;
    var finish = function () {
      if (done) return;
      done = true;
      resolve();
    };
    var _cid = customerId != null ? String(customerId) : null;
    var _notify = function () {
      console.log("[AX] 一連ロック解除(bg): " + (reason || "") + (_cid ? " cid=" + _cid : ""));
      var payload = { type: "axlx-pipeline-clear", reason: reason || "release", customerId: _cid };
      try {
        chrome.runtime.sendMessage(payload, function () { void chrome.runtime.lastError; });
      } catch (_) {}
      try {
        chrome.tabs.query({}, function (tabs) {
          var left = 1;
          var tick = function () { if (--left <= 0) finish(); };
          (tabs || []).forEach(function (t) {
            if (!t || !t.id || !t.url) return;
            if (!/realnetpro\.com|itandibb\.com|system\.reins\.jp/.test(String(t.url))) return;
            left++;
            try {
              chrome.tabs.sendMessage(t.id, payload, function () {
                void chrome.runtime.lastError;
                tick();
              });
            } catch (_) { tick(); }
          });
          tick();
        });
      } catch (_) { finish(); }
    };
    try {
      chrome.storage.local.get("axlx_pipeline_job", function (st) {
        void chrome.runtime.lastError;
        var job = st && st.axlx_pipeline_job;
        var shouldRemove = !job || !_cid || String(job.customerId) === _cid;
        if (shouldRemove) {
          chrome.storage.local.remove("axlx_pipeline_job", function () {
            void chrome.runtime.lastError;
            _notify();
          });
        } else {
          console.log("[AX] 一連ロック storage 解除スキップ（別客進行中）: 進行=" + (job.name || job.customerId) + " / 対象=" + _cid);
          _notify();
        }
      });
    } catch (_) { finish(); }
    // storage コールバックが来ない時の保険
    setTimeout(finish, 800);
  });
}

/**
 * ★ 2026-11-18 平田・search_audits 1482: batch_timeout（5分無進捗）が送付途中の一連を壊した。
 *   竹内さん「タイムアウトも完成度高ければする必要ない／1人のお客さんは物件送るまで」。
 *   → 無進捗の定義だけにするが、**進捗の合図が一度でも来た後**は待ち上限を延ばす（送付中の誤切り上げ防止）。
 */
// ★ 2026-11-18 竹内さん「タイムアウトがボトルネック／かなり長い・15分など」: 初回20分／進捗後45分無進捗のみ。
var BATCH_IDLE_MS = 1200000; // 初回・合図前の無進捗上限（20分）
var BATCH_IDLE_ACTIVE_MS = 2700000; // 送付・ページ送り中（ハートビート後）の無進捗上限（45分）

function _extendFillDoneWaitersOnProgress(customerId, site, why) {
  var siteKey = site === "itandi" ? "itandi" : site === "reins" ? "reins" : "realnetpro";
  for (var i = 0; i < _fillDoneWaiters.length; i++) {
    var w = _fillDoneWaiters[i];
    if (customerId && w.customerId && String(w.customerId) !== String(customerId)) continue;
    if (site && w.site && w.site !== siteKey && w.site !== site) continue;
    if (w.restart) w.restart();
  }
  _watchProgress(why || "fill途中", siteKey);
}

/**
 * ★ 2026-11-19 (2.8.128) 竹内さん「ちゃんと改善されたのか／徹底的に」:
 *   実測（search_audits 1530・1535・1538）: 検索ボタンを押した後に fill-done の合図が届かず idle_close になっても、
 *   リアプロの一覧では PDF の送付（axlx-batch-progress）は普通に始まっていた。
 *   旧は「fill-done が来ない」だけで最大30分（既定）待ち → 次のお客さんへ進めない／進んでも「検索完了シグナルが届きません」で失敗扱い。
 *   ・一覧側から「この客の送付が進んでいる／終わった」合図が来た＝検索は終わっている → 待っている fill-done を解く（_impliedFillDone）
 *   ・完了の合図が、待ち手が出来る前に来た時（fill-done 待ち → 送付待ちの切替の隙間）は覚えておき、後から作る待ち手がすぐ受け取る
 */
var _earlyBatchDone = []; // { customerId, site, propertyCount, guard, at }
var EARLY_BATCH_DONE_TTL_MS = 3 * 60 * 1000;
function _rememberEarlyBatchDone(customerId, site, propertyCount, audit) {
  var now = Date.now();
  _earlyBatchDone = _earlyBatchDone.filter(function (e) { return now - e.at < EARLY_BATCH_DONE_TTL_MS; });
  _earlyBatchDone.push({ customerId: customerId ? String(customerId) : null, site: site || null, propertyCount: propertyCount != null ? propertyCount : null, guard: (audit && audit.guard_stopped && audit.guard) ? audit.guard : null, at: now });
}
function _takeEarlyBatchDone(customerId, site) {
  var now = Date.now();
  for (var i = 0; i < _earlyBatchDone.length; i++) {
    var e = _earlyBatchDone[i];
    if (now - e.at >= EARLY_BATCH_DONE_TTL_MS) continue;
    if (!customerId || !e.customerId || String(e.customerId) !== String(customerId)) continue;
    if (site && e.site && String(e.site) !== String(site)) continue;
    _earlyBatchDone.splice(i, 1);
    return e;
  }
  return null;
}
function _clearEarlyBatchDone(customerId, site) {
  if (!customerId) return;
  _earlyBatchDone = _earlyBatchDone.filter(function (e) {
    return !(e.customerId && String(e.customerId) === String(customerId) && (!site || !e.site || String(e.site) === String(site)));
  });
}
/** 一覧側の送付の合図から、待っている fill-done を解く。番号が合う待ち、または番号が無い時に待ちがそのサイトで1本だけの時に限る（取り違えない） */
function _impliedFillDone(customerId, site, why) {
  try {
    var siteKey = site === "itandi" ? "itandi" : site === "reins" ? "reins" : "realnetpro";
    var cands = _fillDoneWaiters.filter(function (w) { return !w.site || w.site === siteKey || w.site === site; });
    var hit = null;
    if (customerId) {
      hit = cands.filter(function (w) { return w.customerId && String(w.customerId) === String(customerId); })[0] || null;
      // 番号が違う待ちしか無い時は何もしない（前のお客さんの遅れた合図で次のお客さんを解かない）
    } else if (cands.length === 1) {
      hit = cands[0];
    }
    if (!hit) return false;
    clearTimeout(hit.timer);
    try { _notifyFillDone(hit.site || siteKey, hit.customerId, null); } catch (_) { return false; }
    try {
      var rid = _auditOpenRunId(String(hit.customerId), hit.site === "itandi" ? "itandi" : "realpro");
      if (rid) _auditStep(rid, "fill_done_implied", String(why || "送付の合図").slice(0, 80) + "（fill-doneは届かなかったが一覧で送付が進んでいるので完了とみなす）");
    } catch (_) {}
    console.warn("[fill-done] 届かなかったが一覧で送付が進んでいる → 完了とみなす customer=" + hit.customerId + " " + (why || ""));
    return true;
  } catch (_) { return false; }
}

function _createBatchCustomerDoneWaiter(customerId, timeoutMs, site) {
  var _early = _takeEarlyBatchDone(customerId, site);
  if (_early) {
    try { _snapOnEvent("batch_done_early_taken", "完了の合図が待ち手より先に届いていた customer=" + customerId); } catch (_) {}
    return Promise.resolve({ ok: true, propertyCount: _early.propertyCount, guard: _early.guard });
  }
  return new Promise(function(resolve) {
    var baseMs = timeoutMs || BATCH_IDLE_MS;
    var entry = { customerId: customerId || null, site: site || null, resolve: resolve, timer: null, stopInterval: null, timeoutMs: baseMs, sawProgress: false };
    var _idleMs = function() {
      return entry.sawProgress ? Math.max(baseMs, BATCH_IDLE_ACTIVE_MS) : baseMs;
    };
    var _expire = function() {
      clearInterval(entry.stopInterval);
      var idx = _batchCustomerDoneWaiters.indexOf(entry);
      if (idx >= 0) _batchCustomerDoneWaiters.splice(idx, 1);
      _markFinishedCid(entry.customerId);
      var lim = Math.round(_idleMs() / 1000);
      console.warn("[batch-done-waiter] " + lim + "秒（無進捗）タイムアウト customer=" + entry.customerId + (entry.site ? " site=" + entry.site : "") + (entry.sawProgress ? "（送付進捗あり）" : ""));
      _snapOnEvent("waiter_timeout", "全ページの送信の終わりの合図が " + lim + "秒来ない customer=" + entry.customerId + (entry.site ? " site=" + entry.site : ""));
      // ★ 2026-11-18: timedOut でも sawProgress を渡し、呼び出し元が「送付途中切り上げ」と「起動前停止」を分ける
      resolve({ timedOut: true, sawProgress: !!entry.sawProgress, idleMs: _idleMs(), sentCount: entry.sentCount || 0 });
    };
    // 「固定5分」→「無進捗5分」に変更:
    // 多ページの全ページ送信は5分を超えることがあり、固定タイムアウトのままだと
    // 送信中に次顧客の autofill が始まり検索リロードで送信が破壊されていた
    // （1顧客だけなら誰もページを触らないため完走する＝複数顧客のみ失敗する根本原因）。
    // bulk-dl.js / itandi-bulk-dl.js が送る axlx-batch-progress を受けるたびに延長する。
    entry.resetTimer = function(markProgress) {
      if (markProgress) entry.sawProgress = true;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(_expire, _idleMs());
    };
    entry.stopInterval = setInterval(function() {
      if (!_batchShouldStop) return;
      clearInterval(entry.stopInterval);
      clearTimeout(entry.timer);
      var idx = _batchCustomerDoneWaiters.indexOf(entry);
      if (idx >= 0) _batchCustomerDoneWaiters.splice(idx, 1);
      console.log("[batch-done-waiter] _batchShouldStop 検知 → stopped:true で解決");
      resolve({ stopped: true });
    }, 500);
    entry.resetTimer();
    _batchCustomerDoneWaiters.push(entry);
  });
}

// ── 全ページ送信の進捗ハートビート受信 → 該当waiterのタイムアウトを延長 ──
function _notifyBatchProgress(customerId, site, sentCount) {
  var targets = [];
  if (customerId) {
    for (var _bpi = 0; _bpi < _batchCustomerDoneWaiters.length; _bpi++) {
      var _bpw = _batchCustomerDoneWaiters[_bpi];
      if (_bpw.customerId && String(_bpw.customerId) === String(customerId) && _waiterSiteMatch(_bpw, site)) targets.push(_bpw);
    }
  }
  // customerId null / 不一致でも最古のwaiterにフォールバック（顧客は直列処理のため安全）
  //   2026-09-30 v2.5.43 同時の回で site が分からない時は両方を延ばす（違う方を切らせない側）
  if (!targets.length && _batchCustomerDoneWaiters.length) targets = _batchCustomerDoneWaiters.length === 1 ? [_batchCustomerDoneWaiters[0]] : _batchCustomerDoneWaiters.slice();
  targets.forEach(function (t) {
    // ★ 2026-11-18: 送付済み件数を控える（batch_timeout 時に「0件」と言わず部分送付として扱うため）
    if (sentCount > 0 && sentCount > (t.sentCount || 0)) t.sentCount = sentCount;
    if (t.resetTimer) t.resetTimer(true);
  });
  _watchProgress("送信の進み", site || (targets[0] && targets[0].site) || null);
}

// ── 2026-09-29 v2.5.40 一括の見張り・心拍・画面の写真 ─────────────────────────────
// 竹内「ブレインのAIX検索モードが隼斗さんで止まってしまっている。なぜ固まっているのか」
//   「拡張ツールでひらいているページの画面をみて判断できる事もできるのか？ …画面開いているのも目で見ることができるのが理想」
// ・見張り（_batchWatch）: 一括の回の今（誰・どのサイト・何を待っているか・最後の合図・最後に進んだ時刻）。
//   進むたびに（入力を始めた・fill-done・送信の進み・送信の終わり）時刻を新しくし、ロック（batchRunning）も1分に1回延ばす
//   （1人の送信が15分を超えてもロックの TTL で別の回が並んで走らないように。止まった時は延ばさない＝上限は1回の検索の見張り）
// ・1回の検索の上限（_startPassGuard・snapshot-core PASS_DEADLINE_MS）: 過ぎたら理由を付けて投げ、次のお客様へ進む
// ・心拍と頼まれた写真: アラーム sumora-snap-poll（1分）→ /api/extension-snapshots?poll=1（版・モード・実行中の回・許可の有無）
//   ※ pending（sumora-batch-poll）はロック中は最初で止まり、モードでも絞られる＝止まっている時ほど届かないので別にした
// ・止まりの写真: 一括が動いていて6分進みが無い／fill-done・送信の終わりの待ちの時間切れ／1回の検索の上限 → 撮る（上限: 1日20回・同じきっかけ3分に1回）
// ・撮る物: ページの文字（件数・ページ・モーダル・帯・フォームの値）＋拡張の状態＋ログの末尾80行＋（許可があれば）画面の写真
//   サイトへのアクセスは増えない（読み込み直し・クリックはしない）
var _batchLoopAlive = false;
// 手動の一括（axlx-manual-bulk-search）が動いている間 true（Realtime・アラームが二重に始めない）
var _manualBulkAlive = false;

/**
 * ★ 2.8.265 竹内さん「ここでとまった／なぜ次のお客さんのところに移らないのか／止まったら次に移る部分の把握」:
 *   旧は一括のループがメッセージの受け手の中の使い捨ての関数で、メモリにしか無かった。
 *   Chrome が裏（service worker）を止める／途中の await が返らないと、ループごと消えて次のお客さんへ進めなかった。
 *   → ループを関数にして、どこまで進んだか（axlx_bulk_queue）を storage.session に残し、
 *     止まった時は「済んだ客の次」から同じ関数でやり直せる形にした（_bulkKick・SW 起動時の再開・画面からの見張り）。
 *   o: { site, ids, isWide, startIndex, resume, why }
 */
async function _manualBulkRun(o) {
  var _bulkSite = o.site;
  var _bulkIds = Array.isArray(o.ids) ? o.ids : [];
  var _bulkIsWide = !!o.isWide;
  var _startIndex = Math.max(0, Number(o.startIndex) || 0);
  var _resume = !!o.resume;
  var _myGen = ++_manualBulkGen;
  _manualBulkAlive = true;
  try {
    if (!_resume) {
      // 前回バッチのストップ残留をクリア（即解決を防ぐ）
      _batchShouldStop = false;
      try { await chrome.storage.local.set({ batchStopRequested: false }); } catch(_) {}
    } else {
      try {
        var _stopSt = await chrome.storage.local.get("batchStopRequested");
        if (_stopSt && _stopSt.batchStopRequested) { console.log("[manual-bulk-search] 再開しない（ストップ指示あり）"); _bulkQueueSave({ done: true, why: "stop_before_resume" }); return; }
      } catch (_) {}
    }
    // 2026-09-29 見張り: 前の回の「止める」は持ち越さない
    _watchStop = null;
    _watchSkipped = [];
    _busyRetried = new Set(); // 2.8.128 busy_other_customer のやり直し済みは一括ごとに作り直す
    /** ★ 2.8.214: 古い page-script のまま自動しない（再読込して版を合わせる）＋束も強制取込 */
    if (!_resume) try {
      var _pf = await _ensureRealproPageFresh("manual_bulk");
      console.log("[manual-bulk-search] page-fresh", _pf);
    } catch (_) {}
    try { await _refreshLearnedBundleQueued(true); } catch (_) {}
    var _bulkRes = await _fetchCustomerListWithRetry("https://sumora-ai-ui.vercel.app/api/property-customers", "manual-bulk");
    if (!_bulkRes.ok) throw new Error("顧客データ取得失敗");
    var _bulkAll = await _bulkRes.json();
    var _bulkTargets = _bulkIds
      .map(function(id) { return _bulkAll.find(function(c) { return String(c.id) === String(id); }); })
      .filter(Boolean);
    _bulkQueueSave({ site: _bulkSite, ids: _bulkTargets.map(function (c) { return String(c.id); }), names: _bulkTargets.map(function (c) { return String((c && c.customer_name) || "?"); }), isWide: _bulkIsWide, index: _startIndex, stage: "pre", done: false, startedAt: Date.now(), sentCids: _resume && _bulkQueue && Array.isArray(_bulkQueue.sentCids) ? _bulkQueue.sentCids : [] });
    console.log("[manual-bulk-search] ▶ " + (_resume ? "再開(" + (o.why || "") + ") " + (_startIndex + 1) + "人目から " : "") + "site=" + _bulkSite + " mode=" + (_bulkIsWide ? "wide" : "pinpoint") + " 対象=" + _bulkTargets.length + "人");
    /** ★ 2.8.217: 一括の誰・何件・次客を枠へ（把握） */
    var _bulkNames = _bulkTargets.map(function (c) { return String((c && c.customer_name) || "?"); });
    if (!_resume) try {
      await _withTimeout(_publishBulkGrasp({
        total: _bulkTargets.length,
        index: 0,
        currentName: "",
        nextName: _bulkNames[0] || "",
        names: _bulkNames,
        waitingFor: "一括開始",
      }), 8000, "publish_start");
    } catch (_) {}
    /**
     * 2026-11-11 竹内さん「また時間はランダム性をちゃんと徹底する人間のうごきを」:
     *   一括検索でお客様から次のお客様へ移る間。**長さの決まりは auto-run.js の1か所**（bulkCustomerGapMs）に寄せた
     *   （background 側で一様乱数を書かない＝そろわない・2か所で別々に持たない）。8〜25秒・6回に1回ほど40〜95秒の一息。
     */
    var _bulkGapMs = function () {
      try {
        if (self.AxlxAutoRun && self.AxlxAutoRun.bulkCustomerGapMs) return self.AxlxAutoRun.bulkCustomerGapMs();
      } catch (_) {}
      var H = self.AxlxHumanWait;
      return H && H.logNormalDelay ? H.logNormalDelay(14000, 0.45) : 14000;
    };
    for (var _bi = _startIndex; _bi < _bulkTargets.length; _bi++) {
      var _bc = _bulkTargets[_bi];
      if (_myGen !== _manualBulkGen) { console.warn("[manual-bulk-search] 新しいループに引き継いだ → 古いループは抜ける gen=" + _myGen); return; }
      _bulkQueueSave({ ids: _bulkTargets.map(function (c) { return String(c.id); }), index: _bi, cid: String(_bc && _bc.id), stage: "pre" });
      _bulkPhaseSet("publish_pre", 15000, { index: _bi, total: _bulkTargets.length, cid: String(_bc && _bc.id), name: String((_bc && _bc.customer_name) || ""), nextName: _bulkNames[_bi + 1] || "" });
      try {
        var _g0 = (self.AxlxBulkPanelGrasp && self.AxlxBulkPanelGrasp.bulkGraspFromQueue)
          ? self.AxlxBulkPanelGrasp.bulkGraspFromQueue(_bulkNames, _bi)
          : { total: _bulkTargets.length, index: _bi + 1, currentName: _bulkNames[_bi], nextName: _bulkNames[_bi + 1] || "" };
        _g0.currentId = _bc && _bc.id != null ? String(_bc.id) : "";
        _g0.nextId = _bulkTargets[_bi + 1] && _bulkTargets[_bi + 1].id != null ? String(_bulkTargets[_bi + 1].id) : "";
        _g0.names = _bulkNames;
        /** ★ 2.8.222: 一括の各客開始時に「次の動き」を明示（1人目=入れ／2人目以降=外してから入れ） */
        _g0.nextMove = _bi === 0 ? "条件を1つずつ入れる" : "前客を外してから入れる";
        _g0.waitingFor = null;
        await _withTimeout(_publishBulkGrasp(_g0), 8000, "publish_pre");
      } catch (_) {}
      // 2.8.125 案B: 最後のお客さんは送付後の外しを待たずに戻す（_scrapeAndSendRealpro が見る）
      try { self._axlxLastCustomerId = (_bi === _bulkTargets.length - 1 && _bc && _bc.id != null) ? String(_bc.id) : null; } catch (_) {}
      /**
       * 2026-11-11 竹内さん「休憩の間もちゃんといれる。90分働いたら休憩があるのが普通なので休憩の間もいれるように。人間がおこなっているから」:
       *   一括検索でも、働き続けたら休む（自動モードと同じ決まり）。
       *   ・短い休憩 12〜30秒（作業20分以上で 8%）
       *   ・長い休憩 60〜180秒（作業120分以上で 18%）
       *   ・**90分続けて動いたら必ず休む**（この時は 60〜180秒・人と同じ「一区切り」）
       *   休憩の後は数え直す。
       */
      if (self.AxlxHumanWait) {
        var _worked = _manualBulkWorkedSince || Date.now();
        if (!_manualBulkWorkedSince) _manualBulkWorkedSince = _worked;
        var _restMs = 0, _restKind = null;
        try {
          if (self.AxlxAutoRun && self.AxlxAutoRun.continuousRestDue && self.AxlxAutoRun.continuousRestDue(_worked, Date.now())) {
            _restMs = 60000 + Math.floor(Math.random() * 120000); // 90分続いた → 1〜3分
            _restKind = "90分の一区切り";
          } else if (self.AxlxHumanWait.restDue) {
            var _rd = self.AxlxHumanWait.restDue(_worked, Date.now());
            if (_rd.rest) { _restMs = _rd.ms; _restKind = _rd.kind === "long" ? "長め" : "短め"; }
          }
        } catch (_) {}
        if (_restMs > 0) {
          console.log("[manual-bulk-search] 休憩（" + _restKind + " " + Math.round(_restMs / 1000) + "秒）をはさみます");
          /**
           * 2026-11-11 竹内さん「AIXの部分に休憩時間等もちゃんと書いといて。人間が動いているように見たらわかるように」:
           *   休憩の間は、リアプロ／ITANDI の画面の枠に「☕ 休憩中（あとN秒）」と出す（黙って止まらない）。
           */
          try {
            var _tabsForNote = await chrome.tabs.query({ url: ["https://www.realnetpro.com/*", "https://itandibb.com/*"] });
            _tabsForNote.forEach(function (t) {
              try { chrome.tabs.sendMessage(t.id, { type: "axlx-work-note", text: "☕ 休憩中（" + _restKind + "）", untilMs: Date.now() + _restMs }, function () { void chrome.runtime.lastError; }); } catch (_) {}
            });
          } catch (_) {}
          _bulkPhaseSet("rest", _restMs, {});
          await new Promise(function (r) { setTimeout(r, _restMs); });
          _manualBulkWorkedSince = Date.now(); // 休んだら数え直す
          try {
            var _tabsEnd = await chrome.tabs.query({ url: ["https://www.realnetpro.com/*", "https://itandibb.com/*"] });
            _tabsEnd.forEach(function (t) { try { chrome.tabs.sendMessage(t.id, { type: "axlx-work-note-clear" }, function () { void chrome.runtime.lastError; }); } catch (_) {} });
          } catch (_) {}
          if (_batchShouldStop) { console.log("[manual-bulk-search] ストップ要求（休憩の後） → 中断"); break; }
        }
      }
      // 2人目からは「前のお客様の結果を見てから次を開く」間を置く
      if (_bi > 0) {
        var _gap = _bulkGapMs(_bi);
        /**
         * 2026-11-11 竹内さん「昼休みなら昼休みと人間のようにするかたちで」:
         *   昼（JST 12:00〜13:00）に当たったら、その間は動かずに「🍱 昼休み（13:00まで）」と枠に出す。
         *   昼休みの後は、次のお客様までの間も改めて取る。
         */
        var _lunchMs = 0;
        try {
          var _j = new Date(Date.now() + 9 * 3600 * 1000);
          var _mins = _j.getUTCHours() * 60 + _j.getUTCMinutes();
          if (_mins >= 12 * 60 && _mins < 13 * 60) _lunchMs = (13 * 60 - _mins) * 60 * 1000 - _j.getUTCSeconds() * 1000;
        } catch (_) {}
        if (_lunchMs > 0) {
          console.log("[manual-bulk-search] 🍱 昼休み（13:00まで " + Math.round(_lunchMs / 60000) + "分）");
          try {
            var _tabsLunch = await chrome.tabs.query({ url: ["https://www.realnetpro.com/*", "https://itandibb.com/*"] });
            _tabsLunch.forEach(function (t) { try { chrome.tabs.sendMessage(t.id, { type: "axlx-work-note", text: "🍱 昼休み（13:00まで）", untilMs: Date.now() + _lunchMs }, function () { void chrome.runtime.lastError; }); } catch (_) {} });
          } catch (_) {}
          _bulkPhaseSet("lunch", _lunchMs, {});
          await new Promise(function (r) { setTimeout(r, _lunchMs); });
          _manualBulkWorkedSince = Date.now();
          try {
            var _tabsLunchEnd = await chrome.tabs.query({ url: ["https://www.realnetpro.com/*", "https://itandibb.com/*"] });
            _tabsLunchEnd.forEach(function (t) { try { chrome.tabs.sendMessage(t.id, { type: "axlx-work-note-clear" }, function () { void chrome.runtime.lastError; }); } catch (_) {} });
          } catch (_) {}
          if (_batchShouldStop) { console.log("[manual-bulk-search] ストップ要求（昼休みの後） → 中断"); break; }
        }
        console.log("[manual-bulk-search] 次のお客様まで " + Math.round(_gap / 1000) + "秒（人の間）");
        try {
          var _tabsGap = await chrome.tabs.query({ url: ["https://www.realnetpro.com/*", "https://itandibb.com/*"] });
          _tabsGap.forEach(function (t) { try { chrome.tabs.sendMessage(t.id, { type: "axlx-work-note", text: "⏳ 次のお客様まで", untilMs: Date.now() + _gap }, function () { void chrome.runtime.lastError; }); } catch (_) {} });
        } catch (_) {}
        _bulkPhaseSet("gap", _gap, {});
        await new Promise(function (r) { setTimeout(r, _gap); });
        if (_myGen !== _manualBulkGen) return;
        if (_batchShouldStop) { console.log("[manual-bulk-search] ストップ要求（間の間） → 中断"); break; }
      }
      // 2026-09-29 見張り: ログイン切れ・サイトのエラーで見張りが止めたら、次のお客様から見送る（知らせはサーバーの1通だけ）
      if (_watchSkipSite(_bc, _bulkSite)) continue;
      console.log("[manual-bulk-search] (" + (_bi+1) + "/" + _bulkTargets.length + ") " + _bc.customer_name);
      // 検索の点検: この1人の記録を始める（ブレインの時だけ）
      _bulkQueueSave({ index: _bi, cid: String(_bc.id), stage: "running" });
      var _bulkAudit = await _auditBegin({
        site: _bulkSite, customer_id: _bc.id, customer: _bc, trigger: "bulk_manual",
        is_wide: _bulkIsWide, area_mode: _bc.area_mode || null,
      });
      try {
        // fill-done ウェイターを autofill 発火「前」に生成（先着シグナルを取りこぼさないため）
        var _bulkFillDone = (_bulkSite === "realnetpro" || _bulkSite === "itandi")
          ? _createFillDoneWaiter(_bulkSite, String(_bc.id), _fillDoneTimeoutMs(_bulkSite))
          : null;
        // 2026-09-25 竹内「更新日も拡張ツールと連動」: 一括検索も更新日で絞る（旧は渡しておらず、すべて表示で検索していた）。
        //   決まりは個別検索（preloadAdjForm）と同じ: 手で決めた値 → 送った日と確認した日の新しい方から 1/3/7/14（初めては絞らない）
        var _bulkRpDays = self.AxlxRpUpdateDays ? self.AxlxRpUpdateDays.effectiveRpUpdateDays(_bc, Date.now()) : null;
        // 2026-11-10 手の一括でも ITANDI は ITANDI の手の指定（itandi_update_days）→ 無ければリアプロと同じ線で数える。
        //   旧は ITANDI の回にもリアプロの手の指定をそのまま渡していた（DB_STRUCTURE.md の「混ざっている所 2」）
        var _bulkItDays = null;
        try {
          if (self.AxlxRpUpdateDays && self.AxlxRpUpdateDays.effectiveRpUpdateDays) {
            _bulkItDays = self.AxlxRpUpdateDays.effectiveRpUpdateDays(Object.assign({}, _bc, { rp_update_days: _bc.itandi_update_days }), Date.now());
          }
        } catch (_) { _bulkItDays = null; }
        console.log("[manual-bulk-search] 更新日=" + (_bulkRpDays ? _bulkRpDays + "日以内" : "指定なし") + (String(_bulkSite) === "itandi" ? "／ITANDI=" + (_bulkItDays ? _bulkItDays + "日以内" : "指定なし") : "") + " (" + _bc.customer_name + ")");
        _bulkPhaseRunId = _bulkAudit ? _bulkAudit.runId : null;
        _bulkPhaseSet("autofill", 300000, { runId: _bulkPhaseRunId });
        var _bulkConds = await _batchAutofill(_bc, _bulkSite, _bulkIsWide, { rp_update_days: _bulkRpDays, itandi_update_days: _bulkItDays }, _bulkAudit);
        // 2026-09-18 竹内「一括検索したお客さんも項目のところに日付と一括検索した日にちをいれる」:
        //   個別検索（popup.js）は search_history を書いていたが、一括検索は1行も書いていなかった。
        //   同じ関数（search-history.js）で記録し、顧客リストの RP/IT/RE グリッドが一括の分も埋まるようにする
        // fill-done → axlx-batch-customer-done を待ってから次顧客へ（混線防止）
        // reins は bulk-dl.js 自動送信なし → ウェイターなしでスキップ
        if (_bulkFillDone) {
          var _bulkNextNm = _bulkNames[_bi + 1] || "";
          await _scrapeAndSendRealpro(
            _bulkFillDone,
            String(_bc.id),
            _bc.customer_name || null,
            _bulkConds || {},
            _bulkSite === "itandi" ? "itandi" : "リアプロ",
            false,
            _bulkAudit ? _bulkAudit.runId : null,
            {
              currentName: _bc.customer_name || "",
              nextName: _bulkNextNm,
              index: _bi + 1,
              total: _bulkTargets.length,
            }
          );
          _bulkQueueSave({ index: _bi, cid: String(_bc.id), stage: "done", sentCids: _bulkSentCidsWith(String(_bc.id)) });
          if (_myGen !== _manualBulkGen) return;
          _bulkPhaseSet("publish_done", 15000, {});
          /** ★ 2.8.222: 完了直後にパネル把握を「次は外す」へ更新（次客 autofill 前） */
          try {
            await _withTimeout(_publishBulkGrasp({
              total: _bulkTargets.length,
              index: _bi + 1,
              currentName: _bc.customer_name || "",
              currentId: _bc && _bc.id != null ? String(_bc.id) : "",
              nextName: _bulkNextNm,
              nextId: _bulkTargets[_bi + 1] && _bulkTargets[_bi + 1].id != null ? String(_bulkTargets[_bi + 1].id) : "",
              names: _bulkNames,
              nextMove: _bulkNextNm ? "前客の選択を1つずつ外す" : "一括完了",
              waitingFor: _bulkNextNm ? "次客へ渡す" : "一括完了",
            }), 8000, "publish_done");
          } catch (_) {}
          /**
           * 2026-11-11 竹内さん「ちゃんと自動検索のときのように人間の動き徹底されるか確認おねがい」→「（資料を見る間も）いれる」:
           *   自動モード（bulk-dl.js の _lookAtDocThenGo）は送った後に 👀 資料を見る間（中央値3.5秒・1.8〜13秒・たまに長く）を置く。
           *   一括検索（この経路）は送ったらすぐ次のお客様へ移っていたので、同じ間をここにも入れる（送った資料を人が見る形）。
           */
          var _lookMs = 3500;
          try {
            if (self.AxlxAutoRun && self.AxlxAutoRun.lookAtDocMs) _lookMs = self.AxlxAutoRun.lookAtDocMs();
            else {
              var _H = self.AxlxHumanWait;
              if (_H && _H.logNormalDelay) _lookMs = _H.logNormalDelay(3500, 0.4);
            }
          } catch (_) { _lookMs = 3500; }
          if (_lookMs < 1800) _lookMs = 1800;
          if (_lookMs > 13000) _lookMs = 13000;
          console.log("[manual-bulk-search] 👀 資料を見る間 " + Math.round(_lookMs / 1000) + "秒（" + (_bc.customer_name || "") + "）");
          _bulkPhaseSet("look", _lookMs, {});
          await new Promise(function (r) { setTimeout(r, _lookMs); });
          if (_batchShouldStop) { console.log("[manual-bulk-search] ストップ要求（資料を見る間） → 中断"); break; }
        }
        // 2026-09-27 v2.5.32: 記録は検索を押せた後（失敗して投げた回は記録しない）
        _recordBulkSearch(_bc, _bulkSite, _bulkIsWide);
        // レインズは fill-done で閉じる（_auditOnFillDone）
        if (_bulkAudit && _bulkSite !== "reins") _auditFinish(_bulkAudit.runId, {});
      } catch (_be) {
        // ★ 2.8.128 busy_other_customer（前のお客さんの入力中で断られた）: 一括は止めず、最後にもう1回だけやり直す（2回目も断られたらこの客だけ飛ばす）
        var _bulkBd = null;
        try {
          _bulkBd = self.AxlxCustomerHandoff ? self.AxlxCustomerHandoff.busyRetryDecision(_be && _be.message, _bc && _bc.id, _busyRetried) : null;
          if (_bulkBd === "retry") {
            _bulkTargets.push(_bc);
            if (_bulkAudit) _auditStep(_bulkAudit.runId, "busy_retry_queued", "前客の入力中で断られた→一括の最後にもう1回だけやり直す");
          } else if (_bulkBd === "give_up") {
            if (_bulkAudit) _auditStep(_bulkAudit.runId, "busy_give_up", "2回目も前客の入力中で断られた→このお客さんだけ飛ばす");
          }
        } catch (_) { _bulkBd = null; }
        _bulkQueueSave({ index: _bi, cid: String(_bc.id), stage: "done" });
        if (_bulkAudit) _auditFinish(_bulkAudit.runId, { error: _be });
        if (_be && _be.message === "__BATCH_STOPPED__") {
          console.log("[manual-bulk-search] ストップ要求 → 中断");
          break;
        }
        console.error("[manual-bulk-search] 顧客エラー:", _bc.customer_name, _be.message || _be);
        if (_bulkAudit) await _watchOnPassError(_bulkSite, _bc.id, null, _bulkAudit.runId, _be);
        if (self.AxlxSnapshotCore && self.AxlxSnapshotCore.watchStopApplies(_watchStop, _bulkSite, Date.now())) continue; // 知らせは見張りの1通だけ
        // 例外スキップ時も必ず1件アナウンス（4人検索→4人分アナウンス要件）
        // 2026-09-25 竹内（検索の点検）: 例外は「0件」ではない（検索できていない）→「⚠ 検索できなかった」に分ける
        if (_bc.customer_name && _bulkBd !== "retry") {
          var _bulkSiteLabel = _bulkSite === "itandi" ? "itandi" : _bulkSite === "reins" ? "レインズ" : "リアプロ";
          fetch(SUMORA_BATCH_API + "/api/notify-group", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: (self.AxlxBatchGuard && self.AxlxBatchGuard.failureNotice({ customerName: _bc.customer_name, siteLabel: _bulkSiteLabel, error: _be })) || ("⚠【検索できなかった】" + _bc.customer_name + "さんの" + _bulkSiteLabel + "検索ができませんでした（0件とは限りません）"), group_key: "pickup_group_id" })
          }).catch(function() {});
        }
      }
      if (_bi < _bulkTargets.length - 1) {
        // 完了確認後のインターバル（6〜12秒）
        var _ivMs = 6000 + Math.floor(Math.random() * 6000);
        _bulkPhaseSet("interval", _ivMs, {});
        await new Promise(function(r) { setTimeout(r, _ivMs); });
      }
    }
    console.log("[manual-bulk-search] ✔ 完了");
  } catch (_be2) {
    console.error("[manual-bulk-search] エラー:", _be2.message || _be2);
  } finally {
    if (_myGen === _manualBulkGen) {
      _manualBulkAlive = false;
      _bulkPhase = null;
      _bulkQueueSave({ done: true });
      try { await _withTimeout(_publishBulkGrasp(null), 8000, "publish_end"); } catch (_) {}
    }
  }
}

/**
 * ★ 2.8.265: 一括の「いまどの段か」と「どこまで済んだか」。
 *   _bulkPhase … 段（publish_pre／rest／lunch／gap／autofill／wait_fill_done／wait_batch_done／post_send_clear／
 *                release_lock／publish_done／look／interval）と、その段の上限（until）
 *   axlx_bulk_queue（storage.session）… 対象の番号・いま何人目・その客の段（pre／running／done）。SW が止められても残る
 */
var _manualBulkGen = 0;
var _bulkPhase = null;
var _bulkPhaseRunId = null;
var _bulkQueue = null;
var _bulkKickAt = 0;
var BULK_PHASE_GRACE_MS = 60000;
// 上限を過ぎたら次へ進めてよい段（入力・送付の最中ではない段）。入力・送付の待ちは各自の時間切れ（20〜45分）に任せる
var BULK_KICKABLE_PHASES = { publish_pre: 1, rest: 1, lunch: 1, gap: 1, publish_done: 1, look: 1, interval: 1, post_send_clear: 1, release_lock: 1 };
var BULK_PHASE_JA = {
  publish_pre: "次のお客さんの準備", rest: "休憩", lunch: "昼休み", gap: "次のお客さんまでの間",
  autofill: "条件を入れる", wait_fill_done: "検索完了を待つ", wait_batch_done: "物件の送付を待つ",
  post_send_clear: "送付後に前客の選択を外す", release_lock: "次客へ渡す", publish_done: "次客へ渡す",
  look: "資料を見る間", interval: "次のお客さんまでの間",
};

function _withTimeout(p, ms, label) {
  return Promise.race([
    Promise.resolve(p),
    new Promise(function (resolve) {
      setTimeout(function () {
        console.warn("[bulk] 待ちの上限で先へ進む: " + (label || "") + " " + ms + "ms");
        resolve({ __timeout: true, label: label || null });
      }, ms);
    }),
  ]);
}

function _bulkQueueSave(patch) {
  try {
    _bulkQueue = Object.assign({}, _bulkQueue || {}, patch || {}, { beatAt: Date.now() });
    chrome.storage.session.set({ axlx_bulk_queue: _bulkQueue }).catch(function () {});
  } catch (_) {}
}
/**
 * ★ 2.8.266 竹内さん「ちゃんと外すして新しいお客さんの条件入れることができるようになっているか」:
 *   裏は送付完了の後に一連の鍵（axlx_pipeline_job）を消すが、パネルの延長（_axPipelineTouch）が前客の鍵を丸ごと書き戻すと、
 *   次の客は「前のお客さんの一連が進行中」と見て最大10分待ち、見送られていた（AXLX_OTHER_FILL_RUNNING）。
 *   → この一括で送付完了まで済んだお客さん（sentCids）の鍵は古い鍵として外す。送付途中で切れた回は sentCids に入れない（上書きしない決まりは残す）。
 */
function _bulkSentCidsWith(cid) {
  var a = (_bulkQueue && Array.isArray(_bulkQueue.sentCids)) ? _bulkQueue.sentCids.slice() : [];
  if (cid && a.indexOf(String(cid)) < 0) a.push(String(cid));
  return a.slice(-100);
}
/** 残っている鍵が、この一括で送付完了まで済んだ別のお客さんの物なら、その番号（外してよい）。違えば null */
function _bulkStaleLockCid(lockJob, nextCid) {
  try {
    if (!lockJob || lockJob.customerId == null) return null;
    var lc = String(lockJob.customerId);
    if (nextCid != null && lc === String(nextCid)) return null;
    var q = _bulkQueue;
    if (!q || q.done || !Array.isArray(q.sentCids)) return null;
    return q.sentCids.indexOf(lc) >= 0 ? lc : null;
  } catch (_) { return null; }
}
async function _bulkQueueLoad() {
  if (_bulkQueue) return _bulkQueue;
  try {
    var st = await chrome.storage.session.get("axlx_bulk_queue");
    _bulkQueue = (st && st.axlx_bulk_queue) || null;
  } catch (_) { _bulkQueue = null; }
  return _bulkQueue;
}

function _bulkPhaseSet(phase, maxMs, extra) {
  try {
    var prev = _bulkPhase || {};
    var p = Object.assign({
      index: prev.index, total: prev.total, cid: prev.cid, name: prev.name, nextName: prev.nextName,
    }, extra || {}, {
      phase: String(phase),
      at: Date.now(),
      maxMs: Math.max(1000, Number(maxMs) || 60000),
      gen: _manualBulkGen,
      owner: _manualBulkAlive ? "manual" : (_batchLoopAlive ? "queue" : "other"),
    });
    p.until = p.at + p.maxMs;
    delete p.runId;
    _bulkPhase = p;
    try { chrome.storage.session.set({ axlx_bulk_phase: p }).catch(function () {}); } catch (_) {}
    if (_bulkQueue && !_bulkQueue.done) _bulkQueueSave({});
    var rid = (extra && extra.runId) || _bulkPhaseRunId;
    if (rid) {
      _auditStep(rid, "bulk_phase", (String(phase) + " 上限" + Math.round(p.maxMs / 1000) + "秒 " + (p.index != null ? (p.index + 1) + "/" + (p.total || "?") : "")).slice(0, 80));
      try { if (_auditTracker && _auditTracker.flush) _auditTracker.flush(rid); } catch (_) {}
    }
  } catch (_) {}
}

/** 段が上限＋1分を過ぎているか（入力・送付の最中は数えない） */
function _bulkPhaseStuck(p) {
  if (!p || !p.until) return false;
  if (!BULK_KICKABLE_PHASES[p.phase]) return false;
  return Date.now() - p.until > BULK_PHASE_GRACE_MS;
}

/**
 * 止まった一括を「済んだ客の次」から続ける（同じ関数を新しい世代で回す・古いループは世代で抜ける）。
 *   stage=done → 次の客から／pre（まだ入力を始めていない）→ その客から／running → 画面が送付完了を知らせた時だけ次の客から
 */
async function _bulkKick(why, opt) {
  var o = opt || {};
  if (Date.now() - _bulkKickAt < 20000) return { ok: false, reason: "recent_kick" };
  var q = await _bulkQueueLoad();
  if (!q || q.done || !Array.isArray(q.ids) || !q.ids.length) return { ok: false, reason: "no_queue" };
  var idx = Number(q.index) || 0;
  var start;
  if (q.stage === "done") start = idx + 1;
  else if (q.stage === "pre") start = idx;
  else if (o.doneCid && q.cid && String(o.doneCid) === String(q.cid)) start = idx + 1;
  // 送付後の外し・ロック解除の段＝その客の送付は済んでいる
  else if (_bulkPhase && (_bulkPhase.phase === "post_send_clear" || _bulkPhase.phase === "release_lock") && q.cid && _bulkPhase.cid && String(_bulkPhase.cid) === String(q.cid)) start = idx + 1;
  else return { ok: false, reason: "running_not_done", stage: q.stage, cid: q.cid || null };
  _bulkKickAt = Date.now();
  var msg = "一括が止まっていた（" + why + "・段=" + ((_bulkPhase && _bulkPhase.phase) || q.stage) + "）→ " + (start + 1) + "人目から続ける";
  console.warn("[bulk] " + msg);
  try { if (_bulkPhaseRunId) _auditStep(_bulkPhaseRunId, "bulk_kick", msg.slice(0, 80)); } catch (_) {}
  if (start >= q.ids.length) {
    _bulkQueueSave({ done: true, why: "kick_end" });
    _manualBulkGen++;
    _manualBulkAlive = false;
    _bulkPhase = null;
    try { await _withTimeout(_publishBulkGrasp(null), 8000, "publish_kick_end"); } catch (_) {}
    return { ok: true, ended: true };
  }
  if (q.stage !== "done") _bulkQueueSave({ stage: "done" });
  _manualBulkRun({ site: q.site, ids: q.ids, isWide: q.isWide, startIndex: start, resume: true, why: why });
  return { ok: true, startIndex: start, total: q.ids.length };
}

/**
 * ★ 2.8.265: 一括が動いている間は 20秒ごとに拡張の API を呼んで裏（service worker）を止めさせない。
 *   旧は「次のお客様まで」の間（8〜95秒）・休憩（最大3分）に出来事が無く、Chrome が裏を止めるとループごと消えていた。
 *   同じ見回りで「段が上限を過ぎて動かない」を見つけたら次へ進める。
 */
try {
  setInterval(function () {
    try {
      if (!(_manualBulkAlive || _batchLoopAlive)) return;
      try { chrome.runtime.getPlatformInfo(function () { void chrome.runtime.lastError; }); } catch (_) {}
      if (_manualBulkAlive && _bulkQueue && !_bulkQueue.done) _bulkQueueSave({});
      var p = _bulkPhase;
      if (_manualBulkAlive && p && p.owner === "manual" && _bulkPhaseStuck(p)) {
        _bulkKick("stuck:" + p.phase).catch(function () {});
      }
    } catch (_) {}
  }, 20000);
} catch (_) {}

/**
 * ★ 2.8.265: 裏が止められて立ち上がり直した時、一括の続きがあれば続ける。
 *   入力・送付の最中（running）に止められた時は、画面の送付完了の知らせ（batch-done／axlx-bulk-kick）を待ってから次の客へ。
 */
try {
  setTimeout(function () {
    (async function () {
      try {
        if (_manualBulkAlive || _batchLoopAlive) return;
        var q = await _bulkQueueLoad();
        if (!q || q.done) return;
        if (!q.beatAt || Date.now() - q.beatAt > 20 * 60000) { _bulkQueueSave({ done: true, why: "stale_on_start" }); return; }
        if (q.stage === "running") {
          console.warn("[bulk] 裏が立ち上がり直した（" + (Number(q.index) + 1) + "人目の入力・送付中）→ 画面の送付完了を待って続ける");
          return;
        }
        await _bulkKick("sw_restart");
      } catch (e) { console.warn("[bulk] 再開の確かめ失敗", e && e.message); }
    })();
  }, 3000);
} catch (_) {}

// 画面（bulk-dl の送付後の見張り）からの問い合わせ: いまどの段か／止まっていたら進める
chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (!msg || (msg.type !== "axlx-bulk-status" && msg.type !== "axlx-bulk-kick")) return false;
  (async function () {
    try {
      var q = await _bulkQueueLoad();
      var p = _bulkPhase;
      if (msg.type === "axlx-bulk-status") {
        sendResponse({
          ok: true,
          alive: !!_manualBulkAlive,
          queue: q ? { done: !!q.done, index: q.index, total: Array.isArray(q.ids) ? q.ids.length : 0, cid: q.cid || null, stage: q.stage || null, beatAt: q.beatAt || 0 } : null,
          phase: p ? { phase: p.phase, ja: BULK_PHASE_JA[p.phase] || p.phase, at: p.at, until: p.until, cid: p.cid || null, index: p.index, total: p.total, nextName: p.nextName || "" } : null,
          stuck: !!(p && _bulkPhaseStuck(p)),
          now: Date.now(),
        });
        return;
      }
      // axlx-bulk-kick
      var doneCid = msg.cid != null ? String(msg.cid) : null;
      if (_manualBulkAlive && p && !_bulkPhaseStuck(p)) {
        // 送付完了を待っている段で、その客の完了を画面が知らせ済み → 合図が届いていない。番号が合う待ちだけ解く
        if (p.phase === "wait_batch_done" && doneCid && p.cid && String(p.cid) === doneCid) {
          var hasWaiter = _batchCustomerDoneWaiters.some(function (w) { return w.customerId && String(w.customerId) === doneCid; });
          if (hasWaiter) {
            console.warn("[bulk] 画面は送付完了済み・裏はまだ待っていた → 待ちを解く cid=" + doneCid);
            try { if (_bulkPhaseRunId) _auditStep(_bulkPhaseRunId, "bulk_done_resend", "画面の送付完了が裏に届いていなかった→待ちを解いた"); } catch (_) {}
            _notifyBatchCustomerDone(doneCid, msg.propertyCount != null ? msg.propertyCount : null, null, "realnetpro", false);
            sendResponse({ ok: true, resent: true });
            return;
          }
        }
        sendResponse({ ok: false, reason: "alive", phase: p.phase });
        return;
      }
      var r = await _bulkKick(String(msg.why || "page_watch").slice(0, 40), { doneCid: doneCid });
      sendResponse(r);
    } catch (e) {
      try { sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 80) }); } catch (_) {}
    }
  })();
  return true;
});
var _batchWatch = null;
var _watchSavedAt = 0;
var _lockRefreshedAt = 0;
var _heartbeatAt = 0; // 2026-09-30 v2.5.44 命令の心拍（_watchProgress）
var _runStateAt = 0;
var _passGuardSeq = 0;
var _snapBusy = false;
var _snapStallKeys = [];
var _snapInstallIdCache = null;

function _extVersion() {
  try { return chrome.runtime.getManifest().version; } catch (_) { return null; }
}

/**
 * ★ 2.8.214: 自動が古い page-script のまま動く穴（拡張再読込してもタブが古い MAIN）を塞ぐ。
 *   リアプロタブの __axlxPageVer と manifest 版が違う／無い → タブを1回読み直して合わせる。
 */
async function _ensureRealproPageFresh(why) {
  var want = _extVersion();
  try {
    var tabs = await chrome.tabs.query({ url: ["https://www.realnetpro.com/*", "https://realnetpro.com/*"] });
    var tab = (tabs || []).filter(function (t) { return t && t.id && t.active; })[0] || (tabs || [])[0];
    if (!tab || !tab.id) {
      console.warn("[page-fresh] リアプロタブなし（" + String(why || "") + "）");
      return { ok: false, reason: "no_tab", want: want };
    }
    var readVer = async function () {
      try {
        var r = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: function () {
            try { return window.__axlxPageVer || null; } catch (_) { return null; }
          },
        });
        return (r && r[0] && r[0].result) || null;
      } catch (_) { return null; }
    };
    var got = await readVer();
    if (want && got && String(got) === String(want)) {
      return { ok: true, got: got, want: want, reloaded: false };
    }
    console.warn("[page-fresh] 版ずれ page=" + got + " ext=" + want + " → タブ再読込（" + String(why || "") + "）");
    try { await chrome.tabs.reload(tab.id); } catch (_) {}
    await new Promise(function (r) { setTimeout(r, 2800); });
    got = await readVer();
    var ok = !!(want && got && String(got) === String(want));
    return { ok: ok, got: got, want: want, reloaded: true, reason: ok ? "reloaded_ok" : "still_stale" };
  } catch (e) {
    return { ok: false, reason: "error:" + String(e && e.message || e).slice(0, 40), want: want };
  }
}

async function _snapInstallId() {
  if (_snapInstallIdCache) return _snapInstallIdCache;
  try {
    var st = await chrome.storage.local.get("snapInstallId");
    if (st && st.snapInstallId) { _snapInstallIdCache = st.snapInstallId; return _snapInstallIdCache; }
    var id = (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID() : ("ext-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));
    await chrome.storage.local.set({ snapInstallId: id });
    _snapInstallIdCache = id;
    return id;
  } catch (_) { return null; }
}

function _setRunState(running) {
  _runStateAt = Date.now();
  var w = _batchWatch || {};
  try {
    chrome.storage.session.set({
      axlx_run_state: running
        ? { running: true, at: _runStateAt, customerName: w.customerName || null, site: w.site || null }
        : { running: false, at: _runStateAt },
    }).catch(function () {});
  } catch (_) {}
}

function _persistWatch(force) {
  var now = Date.now();
  if (!force && now - _watchSavedAt < 20000) return;
  _watchSavedAt = now;
  try { chrome.storage.session.set({ batchWatch: _batchWatch }).catch(function () {}); } catch (_) {}
}

// 2026-09-30 v2.5.43 同時の回（リアプロと ITANDI が同じお客様で並んで走る）: 見張りは本（サイト）ごとに _batchWatch.lanes[site] に持つ。
//   site を渡した更新は、その本があればその本だけを直し、上の段は2本のまとめ（parallel-sites.js summarizeLanes: 待っている物は2本分・
//   最後に進んだ時刻は終わっていない本の一番古い物＝片方が進んでも止まっている方を隠さない）。本が無い（順の回）時は今まで通り上の段を直す
function _watchLane(site) {
  return (site && _batchWatch && _batchWatch.lanes && _batchWatch.lanes[site]) || null;
}
function _watchSummarize(now) {
  var P = self.AxlxParallelSites;
  if (P && _batchWatch && _batchWatch.lanes) P.summarizeLanes(_batchWatch, now);
}
function _watchSet(patch, site) {
  var lane = _watchLane(site);
  if (lane) {
    var nowL = Date.now();
    Object.assign(lane, patch || {});
    lane.lastProgressAt = nowL;
    _watchSummarize(nowL);
    _persistWatch(true);
    return;
  }
  var prev = _batchWatch || {};
  var next = Object.assign({}, prev, patch || {});
  next.lastProgressAt = Date.now();
  _batchWatch = next;
  _watchSummarize(next.lastProgressAt);
  _persistWatch(true);
  if (prev.customerId !== next.customerId || prev.site !== next.site || !prev.commandId) _setRunState(true);
}

function _watchProgress(what, site) {
  if (!_batchWatch || !_batchLoopAlive) return;
  var now = Date.now();
  var lane = _watchLane(site);
  if (lane) {
    lane.lastProgressAt = now;
    if (what) lane.lastEvent = what;
  } else {
    _batchWatch.lastProgressAt = now;
  }
  _watchSummarize(now);
  if (what) _batchWatch.lastEvent = what + (lane ? "（" + site + "）" : "");
  _persistWatch(false);
  if (now - _lockRefreshedAt > 60000) {
    _lockRefreshedAt = now;
    try { chrome.storage.local.set({ batchRunning: { running: true, startedAt: now } }).catch(function () {}); } catch (_) {}
  }
  // 2026-09-30 v2.5.44 心拍: 動いている命令の picked_up_at をサーバーで新しくする（10分おき）。/api/automation/pending の
  //   「running のまま30分で pending に戻す」見張りに、動いている長い命令（1人で ITANDI 2パス等）を戻させない（別の PC の二重の検索を防ぐ）。
  //   サーバーへの1通だけ・サイトへのアクセスは増えない
  if (_batchWatch.commandId && now - _heartbeatAt > 10 * 60000) {
    _heartbeatAt = now;
    try { _updateBatchCommand(_batchWatch.commandId, { heartbeat: true }); } catch (_) {}
  }
  if (now - _runStateAt > 5 * 60000) _setRunState(true); // 帯の「一括検索中」が15分で古く見えないように
}

function _watchClear() {
  _batchWatch = null;
  _persistWatch(true);
  _setRunState(false);
  try { _publishBulkGrasp(null); } catch (_) {}
}

/**
 * ★ 2.8.217 竹内さん「誰を一括で検索するのか／合計何件／次のお客さん／把握できているか」を枠に出す:
 *   session + タブへ配信。null で消す。
 */
async function _publishBulkGrasp(g) {
  var payload = null;
  if (g && Number(g.total) > 0) {
    payload = {
      at: Date.now(),
      total: Math.floor(Number(g.total)),
      index: Math.max(0, Math.floor(Number(g.index) || 0)),
      currentName: String(g.currentName || ""),
      currentId: g.currentId != null ? String(g.currentId) : "",
      nextName: String(g.nextName || ""),
      nextId: g.nextId != null ? String(g.nextId) : "",
      names: Array.isArray(g.names) ? g.names.slice(0, 40).map(function (n) { return String(n || ""); }) : [],
      waitingFor: g.waitingFor ? String(g.waitingFor).slice(0, 40) : null,
      nextMove: g.nextMove ? String(g.nextMove).slice(0, 40) : (g.waitingFor ? String(g.waitingFor).slice(0, 40) : null),
      graspOk: !!(g.currentName || Number(g.index) === 0) && Number(g.total) > 0,
    };
  }
  try {
    if (payload) await chrome.storage.session.set({ axlx_bulk_grasp: payload });
    else await chrome.storage.session.remove("axlx_bulk_grasp");
  } catch (_) {}
  try {
    var tabs = await chrome.tabs.query({ url: ["https://www.realnetpro.com/*", "https://itandibb.com/*"] });
    for (var ti = 0; ti < tabs.length; ti++) {
      try {
        await chrome.tabs.sendMessage(tabs[ti].id, { type: "axlx-bulk-grasp", grasp: payload });
      } catch (_) {}
    }
  } catch (_) {}
}

// 送信の終わりの待ちを置き去りにする（見張りの時間切れの時だけ）。stopped で解く＝遅れて動いても知らせ・件数を書かない
function _abandonBatchCustomerDoneWaiter(customerId, site) {
  for (var i = 0; i < _batchCustomerDoneWaiters.length; i++) {
    var w = _batchCustomerDoneWaiters[i];
    if (w.customerId && String(w.customerId) === String(customerId) && _waiterSiteMatch(w, site)) {
      clearInterval(w.stopInterval);
      clearTimeout(w.timer);
      _batchCustomerDoneWaiters.splice(i, 1);
      w.resolve({ stopped: true, abandoned: true });
      return true;
    }
  }
  return false;
}

// 1回の検索（お客様×サイト×パス）の見張り。race(p) は上限を過ぎたら「見張りの時間切れ: …」で投げる
// 2026-09-30 v2.5.43 ctx.lane=true（同時の回）: この回の見張りは _batchWatch.lanes[ctx.site] に置き、時間切れもその本だけを見る（もう片方の本は止めない）
function _startPassGuard(ctx) {
  var SC = self.AxlxSnapshotCore;
  var id = ++_passGuardSeq;
  var limit = SC ? SC.passDeadlineMs(ctx.site) : 20 * 60 * 1000;
  var laneSite = ctx.lane ? ctx.site : null;
  var base = Object.assign({}, ctx, { guardId: id, passStartedAt: Date.now(), waitingFor: "条件の入力（タブの確かめ・popup）", lastEvent: null });
  delete base.lane;
  if (laneSite && _batchWatch) {
    _batchWatch.lanes = _batchWatch.lanes || {};
    _batchWatch.lanes[laneSite] = Object.assign({}, base, { lastProgressAt: Date.now(), done: false });
    _watchSet({}, laneSite);
  } else {
    laneSite = null;
    _watchSet(base);
  }
  var done = false;
  var fired = false;
  var rejectFn = null;
  var expired = new Promise(function (_resolve, reject) { rejectFn = reject; });
  expired.catch(function () {}); // race が拾わなかった時に「未処理の失敗」を出さない
  // この回の見張り（同時の回はその本を上に重ねた物）。別の回に替わっていれば null
  function _mine() {
    if (!_batchWatch) return null;
    if (laneSite) {
      var l = _watchLane(laneSite);
      return l && l.guardId === id ? self.AxlxParallelSites.laneView(_batchWatch, laneSite) : null;
    }
    return _batchWatch.guardId === id ? _batchWatch : null;
  }
  function fire(phaseNote) {
    var mine = _mine();
    if (done || fired || !mine) return;
    fired = true;
    var why = (SC ? SC.describeStall(mine, Date.now(), "pass_deadline") : "見張りの時間切れ") + (phaseNote ? "・" + phaseNote : "");
    console.error("[batch-watch] " + why + " → この回を閉じて次のお客様へ");
    _snapOnEvent("pass_deadline", why);
    // 置き去りの待ちを解く（遅れて届く合図で次のお客様の待ちが解けない・古い回が知らせを送らないように）
    try { _endFillDoneWaiter(ctx.site, ctx.customerId, "見張りの時間切れ"); } catch (_) {}
    try { _abandonBatchCustomerDoneWaiter(ctx.customerId, ctx.site); } catch (_) {}
    var err = new Error(why);
    err.passDeadline = true;
    rejectFn(err);
  }
  // ★ 2026-11-18 竹内さん「完成度高ければタイムアウト不要」: 上限に達しても**直近10分以内に進みの合図がある**間は切らず5分ずつ延ばす
  //   （送付中・ページ送り中を一律の上限で壊さない）。ただし無限には延ばさない（硬上限＝上限の2倍・止まっていれば従来通り切る）。
  var PASS_PROGRESS_FRESH_MS = 10 * 60 * 1000;
  var PASS_EXTEND_STEP_MS = 5 * 60 * 1000;
  var passStartedAt = Date.now();
  function _armPassTimer(ms) {
    return setTimeout(function () {
      var mine = _mine();
      var now = Date.now();
      var lp = mine && mine.lastProgressAt ? mine.lastProgressAt : 0;
      if (mine && !done && lp && now - lp < PASS_PROGRESS_FRESH_MS && now - passStartedAt < limit * 2) {
        console.warn("[batch-watch] 上限到達だが進捗あり（" + Math.round((now - lp) / 1000) + "秒前）→ " + (PASS_EXTEND_STEP_MS / 60000) + "分延長 customer=" + ctx.customerId + " site=" + ctx.site);
        timer = _armPassTimer(PASS_EXTEND_STEP_MS);
        return;
      }
      fire(null);
    }, ms);
  }
  var timer = _armPassTimer(limit);
  return {
    // phaseMs: その段だけの上限（条件の入力の段は進みの合図が無くロックが延びないので、ロックの15分より短く切る）
    race: function (p, phaseMs) {
      if (!phaseMs) return Promise.race([p, expired]);
      // ★ 2026-11-18 竹内さん「進捗ありは切らない」: 段の上限に達しても直近3分以内に進みの合図（入力の心拍など）があれば1分ずつ延ばす
      //   （硬上限＝この回の上限 limit。合図が無い＝本当に止まっている時だけ従来どおり切る）
      var pt = null;
      var _armPhase = function (ms) {
        pt = setTimeout(function () {
          var m = _mine();
          var lp = m && m.lastProgressAt ? m.lastProgressAt : 0;
          if (m && !done && !fired && lp && Date.now() - lp < 3 * 60 * 1000 && Date.now() - passStartedAt < limit) {
            console.warn("[batch-watch] 条件の入力の段の上限だが進捗あり（" + Math.round((Date.now() - lp) / 1000) + "秒前）→ 1分延長 customer=" + ctx.customerId + " site=" + ctx.site);
            _armPhase(60 * 1000);
            return;
          }
          fire("条件の入力の段が" + Math.round(phaseMs / 60000) + "分を超えた");
        }, ms);
      };
      _armPhase(phaseMs);
      var clear = function () { clearTimeout(pt); };
      Promise.resolve(p).then(clear, clear);
      return Promise.race([p, expired]);
    },
    done: function () {
      done = true; clearTimeout(timer);
      var l = laneSite ? _watchLane(laneSite) : null;
      if (l && l.guardId === id) { l.done = true; _watchSummarize(Date.now()); _persistWatch(false); }
    },
  };
}
// 条件の入力の段（_batchAutofill: タブの確かめ・popup への受け渡し・入力を始めた合図）の上限。ふだんは1〜2分
// ★ 2026-11-18: 入力段の8分はボトルネック → 20分（進捗延長と併用）
var PASS_AUTOFILL_PHASE_MS = 20 * 60 * 1000;

// 撮影の許可（<all_urls>・optional_host_permissions）があるか
async function _snapCanCapture() {
  try { return await chrome.permissions.contains({ origins: ["<all_urls>"] }); } catch (_) { return false; }
}

async function _snapModeKey() {
  try {
    var core = self.AxlxModeCore;
    var raw = await chrome.storage.local.get(["staffMode", "staffModeAt", "aixMode", "autoModeAt", "brainMode"]);
    var st = core ? (core.effectiveState || core.readState)(raw, Date.now()) : { mode: "normal", brain: !!raw.brainMode };
    return self.AxlxSnapshotCore ? self.AxlxSnapshotCore.modeKey(st) : st.mode;
  } catch (_) { return null; }
}

async function _snapHeaders() {
  return Object.assign({ "Content-Type": "application/json" }, await _getAutomationKeyHeader());
}

// きっかけの時に撮る（待たない・失敗しても何も止めない）
function _snapOnEvent(trigger, why) {
  try {
    _takeSnapshot(trigger, { why: why || null }).catch(function (e) { console.warn("[snap] 撮れなかった:", e && e.message); });
  } catch (_) {}
}

// ── 見張り（2026-09-29 竹内「拡張ツールでひらいているページの画面をみて判断できる事もできるのか？」・サーバー app/lib/screen-watch*.ts）──
// 要所: C1 条件を入れた後（fill-done・ブレインモードの時だけ）／C2 検索結果（C1 の約4秒後にそのタブのページの文字）／1回の検索が失敗した時（ページの文字＋失敗の文）。
//   C3 回の終わり・C4 止まりの写真はサーバーだけ（拡張は何も足さない）。
// ・待たない（C1・C2）／失敗しても検索は止めない／サイトへのアクセスは増えない（content script の文字を読むだけ・読み込み直し・クリックなし）
// ・サーバーの答えが stop_site（ログイン切れ・サイトのエラー＝決定論の硬い判定）の時だけ _watchStop を立て、
//   一括の繰り返しは次のお客様の境目でそのサイトの残りを見送る（1人ずつの失敗の知らせは出さない・知らせはサーバーの1通だけ）
var WATCH_RESULTS_DELAY_MS = 4000;
var _watchStop = null;
var _watchSkipped = [];

async function _watchCheckpoint(checkpoint, ctx) {
  try {
    var SC = self.AxlxSnapshotCore;
    if (!SC || !ctx || !ctx.runId) return null;
    var dom = null, domErr = null;
    if (ctx.tabId != null) { var d = await _snapDom(ctx.tabId); dom = d.dom; domErr = d.error; }
    var A = self.AxlxSearchAudit;
    var body = SC.watchBody(checkpoint, {
      runId: ctx.runId, commandId: ctx.commandId, customerId: ctx.customerId, site: ctx.site, installId: await _snapInstallId(), extVersion: _extVersion(),
      domError: domErr, filled: ctx.filled && A ? A.clampAudit(ctx.filled) : null, error: ctx.error ? ((ctx.error && ctx.error.message) || String(ctx.error)) : null,
    }, dom);
    var res = await fetch(SUMORA_BATCH_API + "/api/screen-watch", {
      method: "POST", headers: await _snapHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(ctx.timeoutMs || 8000),
    });
    var json = await res.json().catch(function () { return null; });
    if (!json || !json.ok) return null;
    if (json.label && json.label !== "normal") console.warn("[watch] " + checkpoint + " " + (ctx.site || "") + ": " + json.label + "（" + (json.reason || "") + "）→ " + json.action);
    var stop = SC.watchStopFrom(json, Date.now());
    if (stop) {
      _watchStop = stop;
      console.error("[watch] 見張りが止めた: " + stop.site + " の残りの回は次のお客様の境目で見送る（" + stop.reason + "）");
    }
    return json;
  } catch (e) {
    console.warn("[watch] 見張りに送れなかった（検索は続ける）:", e && e.message);
    return null;
  }
}

// fill-done の後（C1 はすぐ・C2 は約4秒後にそのタブの文字）。待たない
function _watchAfterFill(msg, run, sender) {
  try {
    var tabId = sender && sender.tab ? sender.tab.id : null;
    var base = { runId: msg.runId, site: run.site, customerId: run.property_customer_id, commandId: run.command_id };
    var err = msg.pageError || msg.error || null;
    _watchCheckpoint("filled", Object.assign({}, base, { filled: msg.audit || null, error: err }));
    if (tabId != null && !err) setTimeout(function () { _watchCheckpoint("results", Object.assign({}, base, { tabId: tabId })); }, WATCH_RESULTS_DELAY_MS);
  } catch (_) {}
}

// 1回の検索が失敗した時（一括の catch）: そのサイトのタブの文字と失敗の文で見張りに聞く（最長8秒待つ＝次のお客様の前に止める印が立つように）
async function _watchOnPassError(site, customerId, commandId, runId, err) {
  try {
    var SC = self.AxlxSnapshotCore;
    if (!SC || !runId) return null;
    var picked = SC.pickTabs(await chrome.tabs.query({}));
    var want = SC.siteOfUrl(site === "realnetpro" ? "https://www.realnetpro.com/" : site === "itandi" ? "https://itandibb.com/" : "https://system.reins.jp/");
    var hit = picked.filter(function (p) { return p.site === want; })[0];
    return await _watchCheckpoint("results", { runId: runId, site: site, customerId: customerId, commandId: commandId, tabId: hit ? hit.tab.id : null, error: err, timeoutMs: 8000 });
  } catch (_) { return null; }
}

// 次のお客様の境目: 見張りが止めたサイトなら見送る（true）
function _watchSkipSite(customer, site) {
  var SC = self.AxlxSnapshotCore;
  if (!SC || !SC.watchStopApplies(_watchStop, site, Date.now())) return false;
  _watchSkipped.push((customer && (customer.customer_name || customer.id)) + "/" + site);
  console.warn("[watch] 見送り: " + ((customer && customer.customer_name) || "?") + "さん・" + site + "（" + (_watchStop && _watchStop.reason) + "）");
  return true;
}

async function _snapDom(tabId) {
  try {
    var r = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "axlx-snap-dom" }, { frameId: 0 }),
      new Promise(function (res) { setTimeout(function () { res({ ok: false, error: "3秒で応答なし" }); }, 3000); }),
    ]);
    return r && r.ok ? { dom: r.dom, error: null } : { dom: null, error: (r && r.error) || "応答なし" };
  } catch (e) {
    return { dom: null, error: String((e && e.message) || e).slice(0, 200) };
  }
}

// 撮った PNG/JPEG の dataURL → 幅1280以下の JPEG（base64）。大きすぎる時は画質・幅を下げて1回やり直す
// 2026-09-29 見張り: 拡張の要素（帯・一括DLの帯・点数の札＝お客様の名前が出る所・dom.mask_rects）を塗ってから JPEG にする（保存する写真も同じ物・帯の文は band_text に文字で残る）
async function _snapShrink(dataUrl, dom) {
  var SC = self.AxlxSnapshotCore;
  var blob = await (await fetch(dataUrl)).blob();
  var bmp = await createImageBitmap(blob);
  var tries = [{ w: SC.IMAGE_MAX_WIDTH, q: 0.6 }, { w: 960, q: 0.45 }];
  for (var i = 0; i < tries.length; i++) {
    var sz = SC.scaledSize(bmp.width, bmp.height, tries[i].w);
    var cv = new OffscreenCanvas(sz.w, sz.h);
    var ctx2d = cv.getContext("2d");
    ctx2d.drawImage(bmp, 0, 0, sz.w, sz.h);
    var masks = SC.maskRectsScaled(dom && dom.mask_rects, dom && dom.viewport, sz.w, sz.h);
    if (masks.length) { ctx2d.fillStyle = "#222"; for (var mi = 0; mi < masks.length; mi++) ctx2d.fillRect(masks[mi].x, masks[mi].y, masks[mi].w, masks[mi].h); }
    var out = await cv.convertToBlob({ type: "image/jpeg", quality: tries[i].q });
    if (out.size <= SC.IMAGE_MAX_BYTES || i === tries.length - 1) {
      var u8 = new Uint8Array(await out.arrayBuffer());
      if (u8.length > SC.IMAGE_MAX_BYTES) return { b64: null, error: "縮めても大きすぎる（" + u8.length + "B）" };
      return { b64: SC.bytesToBase64(u8), error: null, w: sz.w, h: sz.h };
    }
  }
  return { b64: null, error: "縮められない" };
}

async function _takeSnapshot(trigger, ctx) {
  var SC = self.AxlxSnapshotCore;
  if (!SC) return { ok: false, reason: "no_core" };
  if (_snapBusy) return { ok: false, reason: "busy" };
  _snapBusy = true;
  try {
    var now = Date.now();
    var hist = await chrome.storage.local.get(["snapRateHist", "snapAllowActivate", "deviceLabel"]);
    var gate = SC.rateGate(hist.snapRateHist, trigger, now);
    if (!gate.ok) { console.log("[snap] 撮らない（" + gate.reason + "） trigger=" + trigger); return { ok: false, reason: gate.reason }; }
    await chrome.storage.local.set({ snapRateHist: gate.hist });
    var canCapture = await _snapCanCapture();
    var staff = await _isStaffModeActive();
    var picked = SC.pickTabs(await chrome.tabs.query({}));
    var w = _batchWatch ? Object.assign({}, _batchWatch) : null;
    // 1) ページの文字（タブを動かす前に・裏のタブでも取れる）
    var tabsOut = [];
    for (var i = 0; i < picked.length; i++) {
      var t = picked[i].tab;
      var d = await _snapDom(t.id);
      var win = null;
      try { win = await chrome.windows.get(t.windowId); } catch (_) {}
      tabsOut.push({
        site: picked[i].site, tab_id: t.id, url: String(t.url || "").slice(0, 500), title: String(t.title || "").slice(0, 120),
        active: !!t.active, visibility: d.dom ? d.dom.visibility : null, window_state: win ? win.state : null,
        activated_for_capture: false, image_index: null, image_error: null, dom: d.dom, dom_error: d.error,
        _win: win,
      });
    }
    // 2) 画面の写真（許可がある時だけ・1枚ずつ 0.6秒あける）
    var images = [];
    var imageBytes = 0;
    for (var j = 0; j < tabsOut.length; j++) {
      var to = tabsOut[j];
      var plan = SC.capturePlan({ active: to.active }, to._win, { canCapture: canCapture, staffMode: staff, allowActivate: hist.snapAllowActivate !== false });
      delete to._win;
      if (plan.how === "none") { to.image_error = plan.reason; continue; }
      var prevActive = null;
      try {
        if (plan.how === "activate") {
          var act = await chrome.tabs.query({ active: true, windowId: picked[j].tab.windowId });
          prevActive = act && act[0] ? act[0].id : null;
          await chrome.tabs.update(to.tab_id, { active: true });
          to.activated_for_capture = true;
          await new Promise(function (r) { setTimeout(r, SC.CAPTURE_SETTLE_MS); });
        }
        // ★ 録画（_capturePaced 直列700ms）と競合しないよう見張り写真も同じ直列化経路へ
        var dataUrl = await _capturePaced(picked[j].tab.windowId);
        var sh = await _snapShrink(dataUrl, to.dom);
        // 塗る位置が読めた写真だけ「塗った」（ページの文字が取れずに位置が分からない写真は見張りの DeepSeek に渡さない）
        to.mask_applied = !!(to.dom && Array.isArray(to.dom.mask_rects) && to.dom.viewport);
        var shBytes = sh.b64 ? Math.floor(sh.b64.length * 3 / 4) : 0;
        if (sh.b64 && imageBytes + shBytes > SC.TOTAL_IMAGE_MAX_BYTES) to.image_error = "写真の合計の上限（" + SC.TOTAL_IMAGE_MAX_BYTES + "B）";
        else if (sh.b64) { imageBytes += shBytes; to.image_index = images.length; images.push({ site: to.site, content_type: "image/jpeg", b64: sh.b64 }); }
        else to.image_error = sh.error;
      } catch (e) {
        to.image_error = String((e && e.message) || e).slice(0, 200);
      } finally {
        if (prevActive != null && prevActive !== to.tab_id) { try { await chrome.tabs.update(prevActive, { active: true }); } catch (_) {} }
      }
      if (j < tabsOut.length - 1) await new Promise(function (r) { setTimeout(r, SC.CAPTURE_GAP_MS); });
    }
    // 塗る位置・画面の大きさはサーバーに送らない（写真の中で使い終わった・タブの文字の上限 6000 字に収める）
    for (var mr = 0; mr < tabsOut.length; mr++) if (tabsOut[mr].dom) { delete tabsOut[mr].dom.mask_rects; delete tabsOut[mr].dom.viewport; }
    var band = null;
    for (var b = 0; b < tabsOut.length; b++) if (tabsOut[b].dom && tabsOut[b].dom.band_text) { band = tabsOut[b].dom.band_text; break; }
    var lockSt = await chrome.storage.local.get(["batchRunning", "batchCommandId"]);
    var body = {
      action: "result",
      install_id: await _snapInstallId(),
      device_label: hist.deviceLabel || null,
      ext_version: _extVersion(),
      mode: await _snapModeKey(),
      trigger: trigger,
      request_id: (ctx && ctx.requestId) || null,
      batch_command_id: (w && w.commandId) || lockSt.batchCommandId || null,
      audit_run_id: (w && w.runId) || null,
      property_customer_id: (w && w.customerId) || null,
      band_text: band,
      can_capture: canCapture,
      tabs: tabsOut,
      images: images,
      stall: {
        why: (ctx && ctx.why) || null,
        watch: w,
        batch_running: lockSt.batchRunning || null,
        loop_alive: _batchLoopAlive,
        staff_mode: staff,
      },
      log_tail: SC.trimLog(_extLogRing, SC.LOG_MAX),
    };
    var res = await fetch(SUMORA_BATCH_API + "/api/extension-snapshots", {
      method: "POST", headers: await _snapHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    var json = null;
    try { json = await res.json(); } catch (_) {}
    if (!res.ok || !json || !json.ok) {
      console.warn("[snap] 送れなかった HTTP " + res.status + " " + (json && json.error ? json.error : ""));
      return { ok: false, reason: "http_" + res.status };
    }
    console.log("[snap] 画面を送った trigger=" + trigger + " id=" + json.id + " 写真 " + images.length + "枚・タブ " + tabsOut.length);
    return { ok: true, id: json.id };
  } finally {
    _snapBusy = false;
  }
}

// 1分ごと: 止まりの見張り → 心拍と頼まれた写真
async function _snapPollTick() {
  var SC = self.AxlxSnapshotCore;
  if (!SC) return;
  var now = Date.now();
  var lockSt = await chrome.storage.local.get(["batchRunning", "batchCommandId"]);
  var lock = lockSt.batchRunning;
  var lockFresh = !!(lock && typeof lock === "object" && lock.startedAt && now - lock.startedAt < BATCH_LOCK_TTL_MS);
  // 止まりの見張り（ロックの判定・pending の取りに行きとは別。ロックがあっても見る）
  if (lockFresh) {
    var w = _batchWatch;
    if (!_batchLoopAlive) {
      // この SW では一括が動いていないのにロックだけ新しい＝SW が作り直されて回が消えた（ロックは TTL で外れる）
      var sw = await chrome.storage.session.get("batchWatch");
      w = w || (sw && sw.batchWatch) || null;
      var orphanKey = "orphan|" + (lockSt.batchCommandId || "-");
      if (_snapStallKeys.indexOf(orphanKey) < 0) {
        _snapStallKeys.push(orphanKey);
        console.warn("[batch-watch] ロックだけ残っている（この SW に一括の回が無い）command=" + (lockSt.batchCommandId || "?") + " ・" + SC.describeStall(w, now, "stall"));
        _snapOnEvent("stall", "ロックだけ残っている（SW の作り直し等で一括の回が消えた）: " + SC.describeStall(w, now, "stall"));
      }
    } else if (w) {
      // 2026-09-30 v2.5.43 同時の回は本（サイト）ごとに見る（片方が進んでいても止まっている方を撮る）。順の回は [w] のまま
      var _views = self.AxlxParallelSites ? self.AxlxParallelSites.activeLaneViews(w) : [w];
      for (var _vi = 0; _vi < _views.length; _vi++) {
        var wv = _views[_vi];
        var key = SC.stallKey(wv);
        var dec = SC.shouldSnapStall({ running: true, lastProgressAt: wv.lastProgressAt, key: key, snappedKeys: _snapStallKeys }, now);
        if (dec.snap) {
          _snapStallKeys.push(key);
          var why = SC.describeStall(wv, now, "stall");
          console.warn("[batch-watch] " + why);
          _snapOnEvent("stall", why);
          break; // 撮るのは1回（写真は両方のタブを撮る）
        }
      }
    }
    if (_snapStallKeys.length > 20) _snapStallKeys = _snapStallKeys.slice(-20);
  }
  // 心拍（版・モード・実行中の回）と、頼まれた写真
  var installId = await _snapInstallId();
  if (!installId) return;
  var misc = await chrome.storage.local.get(["deviceLabel"]);
  var ww = _batchWatch || {};
  var hb = SC.heartbeatState({
    extVersion: _extVersion(), mode: await _snapModeKey(), deviceLabel: misc.deviceLabel || null,
    batchRunning: lockFresh, batchCommandId: lockSt.batchCommandId || null, batchStartedAt: ww.batchStartedAt || null,
    lastProgressAt: ww.lastProgressAt || null, customerId: ww.customerId || null, site: ww.site || null, waitingFor: ww.waitingFor || null,
    canCapture: await _snapCanCapture(), staffMode: await _isStaffModeActive(),
  });
  var res = await fetch(SUMORA_BATCH_API + "/api/extension-snapshots?poll=1&install_id=" + encodeURIComponent(installId), {
    cache: "no-store",
    headers: Object.assign({ "x-snap-state": encodeURIComponent(JSON.stringify(hb)) }, await _getAutomationKeyHeader()),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return;
  var json = await res.json().catch(function () { return null; });
  var reqs = json && Array.isArray(json.requests) ? json.requests : [];
  if (reqs.length && reqs[0] && reqs[0].id != null) {
    console.log("[snap] 画面の写真を頼まれた request=" + reqs[0].id);
    await _takeSnapshot("request", { requestId: reqs[0].id, why: "AIXツールから頼まれた" });
  }
}

chrome.alarms.get("sumora-snap-poll", function (existing) {
  if (!existing) chrome.alarms.create("sumora-snap-poll", { periodInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name !== "sumora-snap-poll") return;
  _snapPollTick().catch(function (e) { console.warn("[snap] poll error (transient):", e && e.message); });
});

// 帯（score-overlay）の「最終の条件 hh:mm」: popup が条件（axlx_score_data）を書いた時刻を別の鍵に残す（popup の4か所を触らない）
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "session" || !changes.axlx_score_data || !changes.axlx_score_data.newValue) return;
  try {
    var v = changes.axlx_score_data.newValue;
    chrome.storage.session.set({ axlx_score_meta: { at: Date.now(), customer_id: v.property_customer_id || null } }).catch(function () {});
  } catch (_) {}
});

// content script からの fill-done 中継を受信
// Fix 5: underbar.js が中継する Web アプリのストップボタン信号を受信する
chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (msg && msg.type === "axlx-force-stop-batch") {
    console.log("[batch] axlx-force-stop-batch 受信 → _batchShouldStop = true");
    _batchShouldStop = true; // Fix 2: 同期フラグを即時セット
    chrome.storage.local.set({ batchStopRequested: true });
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

// 2026-09-27 v2.5.32 page-script が条件の入力を始めた合図（content.js が中継）。一括検索の _batchAutofill が待つ
var _fillStartWaiters = [];
function _createFillStartWaiter(customerId, timeoutMs) {
  var entry = { customerId: customerId ? String(customerId) : null, resolve: null, timer: null };
  var p = new Promise(function (resolve) {
    entry.resolve = resolve;
    entry.timer = setTimeout(function () {
      var i = _fillStartWaiters.indexOf(entry);
      if (i >= 0) _fillStartWaiters.splice(i, 1);
      resolve(false);
    }, timeoutMs || 25000);
  });
  _fillStartWaiters.push(entry);
  return p;
}
chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (!msg || msg.type !== "axlx-fill-started") return false;
  var cid = msg.customerId ? String(msg.customerId) : null;
  // ID の付いていない合図（手動の入力等）は、待ちが1つだけの時にだけ当てる（取り違えない）
  var hit = _fillStartWaiters.filter(function (w) { return cid ? w.customerId === cid : _fillStartWaiters.length === 1; });
  hit.forEach(function (w) {
    clearTimeout(w.timer);
    var i = _fillStartWaiters.indexOf(w);
    if (i >= 0) _fillStartWaiters.splice(i, 1);
    w.resolve(true);
  });
  _watchProgress("入力を始めた", msg.site === "itandi" ? "itandi" : "realnetpro");
  sendResponse({ ok: true });
  return true;
});

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (msg && msg.type === "axlx-fill-done") {
    if (msg.error) {
      console.warn("[fill-done] 受信 site=" + (msg.site || "unknown") + " error=" + msg.error);
    } else {
      console.log("[fill-done] 受信 site=" + (msg.site || "unknown"));
    }
    _watchProgress("fill-done" + (msg.error ? "（エラー）" : ""), msg.site === "itandi" ? "itandi" : msg.site === "reins" ? "reins" : "realnetpro");
    /**
     * ★ 2026-11-18 竹内さん「お客さん検索中や選択中上書きしないように ちゃんと１人のお客さん完了してから次のお客さんに移るように」:
     *   旧は関所の止まり（gate）を全部「このお客様は飛ばして次へ」にしていた。
     *   ⚠ 人が引き取った（human_takeover）／別のお客さんの入力中に来た（busy_other_customer）時に次へ進むと、
     *     人が操作している画面・入力途中の画面を次のお客さんで上書きする（平田→大村 audit 1488→1489）。
     *   → この2つは一括を止める（次のお客さんへ進まない）。再開は人が一括をもう一度始める。
     */
    if (msg.gateKind && self.AxlxCustomerHandoff && self.AxlxCustomerHandoff.gateHoldsBatch(msg.gateKind)) {
      console.warn("[batch] 一括を止める（次のお客さんへ進まない）: " + msg.gateKind + " customerId=" + (msg.customerId || ""));
      _batchShouldStop = true;
      _watchProgress("一括を止めた（" + msg.gateKind + "・次のお客さんへ進まない）", msg.site === "itandi" ? "itandi" : "realnetpro");
    }
    // 検索の点検: page-script の audit（押せた・押せなかった駅・検索直前のフォームの読み戻し）をその回に足す（ブレインの時だけ）
    /**
     * 2026-11-13 竹内さん「まだ自動モードで地域などの部分おせていない、ここ録画しているので」:
     *   ⚠ 旧は `if (msg.runId)` だったので、**run_id が無い回は段（steps）を1つも記録しなかった**。
     *     実測: 7日で **259回が `stalled:realpro:none`（最後の段: none）**。
     *     ＝「どこで止まったか」が一切分からず、地域が押せていない事も見えなかった。
     *   → run_id が無くても**記録する**（page-script が `local_` の番号を付けてくる）。
     */
    if (msg.audit || msg.runId) _auditOnFillDone(msg, _sender);
    // レインズは待ち（_createFillDoneWaiter）を作らないので解決しない（点検の記録だけ）
    if (msg.site !== "reins") _notifyFillDone(msg.site || null, msg.customerId || null, msg.error || null);
    /**
     * ★ 2026-11-17: 自動で入力が終わっても、learn_reflect_ok が無いなら needs_auto を残す。
     *   旧は fill-done だけで下ろし → aim無・screen=0 のまま「改善済み」扱いになる抜け。
     */
    try {
      if (!msg.error && _autoModeOn) {
        var _refOk = false;
        var _flowReady = false;
        try {
          var _ast = (msg.audit && Array.isArray(msg.audit.steps)) ? msg.audit.steps : [];
          for (var _ai = 0; _ai < _ast.length; _ai++) {
            var _ak = typeof _ast[_ai] === "string" ? _ast[_ai] : String((_ast[_ai] && _ast[_ai].k) || "");
            var _ad = typeof _ast[_ai] === "object" && _ast[_ai] ? String(_ast[_ai].d || "") : "";
            if (/learn_reflect_ok/.test(_ak) || /束反映OK/.test(_ad)) { _refOk = true; }
            if (/learn_flow_reflect_ok/.test(_ak) || /流れ反映OK/.test(_ad)) { _refOk = true; }
            if (/flow_done_ready_next/.test(_ak) || /ready_next=Y/.test(_ad) || /次客へ渡してよい/.test(_ad)) {
              _flowReady = true;
            }
          }
        } catch (_) {}
        /**
         * ★ 2026-11-17 F45: 一連完了→次客へ渡してよい印を bg でも把握する。
         *   page の完了台帳と揃えて、handoff 材料に series_done を残す。
         */
        try {
          var _flowRid = msg.runId
            || (msg.audit && (msg.audit.run_id || msg.audit.local_run_id))
            || null;
          if (_flowReady && _flowRid) {
            _auditStep(_flowRid, "series_done", "一連完了→次客へ渡してよい");
            _auditStep(_flowRid, "flow_handoff_ok", "完了理解台帳 ready_next");
            /**
             * ★ 2.8.235 竹内さん「一連と次客へ連続で／把握弱い所を改善」:
             *   DB実測: series_done=4 なのに loop_advance=1。fill-done経路が series_done だけ残し、
             *   いま客・次客・次の動き・ループ完了→次へ が欠ける抜けを塞ぐ。
             */
            try {
              var _fn = String(msg.customerName || msg.customer_name || "").slice(0, 20);
              var _fc = String(msg.customerId || "").slice(0, 8);
              _auditStep(
                _flowRid,
                "loop_advance",
                ("fill一連完了→次へ いま=" + (_fn || _fc || "-")).slice(0, 120),
              );
              _auditStep(
                _flowRid,
                "loop_who_grasp",
                "いま客=" + (_fn || _fc || "-") + " 次客=（一括から取得） fill一連",
              );
              _auditStep(
                _flowRid,
                "next_customer_grasp",
                "いま=" + (_fn || _fc || "-") + " fill一連→次客把握",
              );
              _auditStep(
                _flowRid,
                "next_move_grasp",
                "次の動き=前客の選択を1つずつ外す（または物件取得続き） fill一連",
              );
            } catch (_) {}
          } else if (!msg.error && _flowRid) {
            _auditStep(_flowRid, "flow_handoff_gap", "fill-done成功だが ready_next 無し");
          }
        } catch (_) {}
        if (_refOk) {
          chrome.storage.local.set({
            axlx_learn_needs_auto: false,
            axlx_learn_auto_confirmed_at: Date.now(),
            axlx_learn_auto_linked: true,
          });
        } else {
          chrome.storage.local.set({
            axlx_learn_needs_auto: true,
            axlx_learn_auto_reflect_miss_at: Date.now(),
            axlx_learn_auto_linked: false,
          });
          try { console.warn("[learn] 自動完了だが learn_reflect_ok 無し → needs_auto 維持（連動未完了）"); } catch (_) {}
        }
      }
    } catch (_) {}
    sendResponse({ ok: true });
    return true;
  }
  /** ★ 2026-11-16 統括Pro: fill途中の段 → steps到達 */
  if (msg && msg.type === "axlx-fill-progress") {
    try { _auditOnFillProgress(msg); } catch (_) {}
    var _fpSite = _siteOfSender(_sender, msg) || (msg.site === "itandi" ? "itandi" : "realnetpro");
    try {
      var _why = "fill途中";
      if (msg.conditionsReady) _why = "fill途中（条件完了寄り）";
      else if (msg.opsCount != null && msg.opsCount > 0) _why = "fill途中（ops=" + msg.opsCount + "）";
      _extendFillDoneWaitersOnProgress(msg.customerId || null, _fpSite, _why);
    } catch (_) {}
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  // 2026-09-30 v2.5.43 合図の送り主のタブ（realnetpro／itandi）＝どの待ち手・どの見張りの1本か（同時の回で取り違えない）
  var _msgSite = _siteOfSender(_sender, msg);
  if (msg && msg.type === "axlx-batch-customer-done") {
    // 送付途中タイムアウトで残した hold は完了合図で必ず落とす
    try {
      chrome.storage.local.get("axlx_pipeline_send_hold", function (st) {
        var h = _sendHoldCid(st && st.axlx_pipeline_send_hold, true);
        if (h && msg.customerId != null && String(h) === String(msg.customerId)) {
          chrome.storage.local.remove("axlx_pipeline_send_hold");
        }
      });
    } catch (_) {}
    // _scrapeAndSendRealpro の待機を解除して次顧客へ進む（propertyCount: 0 なら0件確定）
    // 検索の点検: ページ数・読んだ行数・送れる行数・0件の理由・件数表示の生の文字をその回に足す（待ちを解く前に＝閉じる前に届くように）
    _auditOnBatchDone(msg.customerId || null, msg.propertyCount != null ? msg.propertyCount : null, msg.audit || null);
    // 2026-09-29 v2.5.41 送付済みで飛ばした数（0件の知らせを「新しい物件なし」に言い分ける）
    if (msg.customerId != null) _lastSentSkipped[_sentSkipKey(msg.customerId, _msgSite)] = (msg.audit && msg.audit.sent_skipped) || 0;
    try { _impliedFillDone(msg.customerId || null, _msgSite, "全ページ送信の完了合図"); } catch (_) {}
    _notifyBatchCustomerDone(msg.customerId || null, msg.propertyCount != null ? msg.propertyCount : null, msg.audit || null, _msgSite, !!msg.skipped);
    _watchProgress("送信の終わり", _msgSite);
    // ★ 2026-11-16: 一連ロック解除（popup が次客を入れてよい合図）
    //   ⚠ fire-and-forget だと次客 switch より解除が遅れる → await は呼び出し側（_scrapeAndSendRealpro）でも行う
    try { _releasePipelineLock("batch-customer-done", msg.customerId || null); } catch (_) {}
    /**
     * ★ 2.8.265: 送付完了の合図が来た時、一括のループが裏で消えていた（SW が止められた）なら、
     *   その客が控えの「いまの客」と同じ時だけ、次の客から続ける。
     */
    try {
      if (!_manualBulkAlive && !_batchLoopAlive && msg.customerId != null) {
        _bulkKick("batch_done_no_loop", { doneCid: String(msg.customerId) }).catch(function () {});
      }
    } catch (_) {}
    // Webアプリへの進捗通知は _runBatchSearch の顧客ループ完了後に一元化（リアプロ/itandi/レインズ全サイト対応）
  }
  if (msg && msg.type === "axlx-batch-progress") {
    // 全ページ送信の進捗ハートビート → 無進捗タイムアウトをリセット（次顧客への早すぎる移行を防ぐ）
    try { _impliedFillDone(msg.customerId || null, _msgSite, "送付の進み"); } catch (_) {}
    try { _auditTouchIdleTimer(msg.customerId || null, _msgSite); } catch (_) {}
    _notifyBatchProgress(msg.customerId || null, _msgSite, msg.sentCount > 0 ? msg.sentCount : 0);
  }
  /**
   * ★ 2.8.186: bulk-dl の並べ替え／一覧照会印を、batch-done を待たず監査へ即載せ。
   *   旧は sessionStorage timings → axlx-batch-customer-done だけ。途中で止まると印0。
   *   window._axlxAuditStep は定義されておらず死んでいた。
   */
  if (msg && msg.type === "axlx-audit-live-step") {
    try {
      var _liveK = String(msg.k || "").slice(0, 48);
      if (!_liveK) return false;
      // ★ 2026-11-22: page: は page-script の即flush印。dl: 以外だけ dl: を付ける
      if (!/^(dl:|page:)/.test(_liveK)) _liveK = "dl:" + _liveK;
      var _liveRid = null;
      if (msg.customerId != null && _auditTracker && _auditTracker.findOpen) {
        var _liveRun = _auditTracker.findOpen(String(msg.customerId), _msgSite === "realnetpro" ? "realpro" : _msgSite);
        if (_liveRun) _liveRid = _liveRun.run_id || _liveRun.runId || null;
      }
      if (!_liveRid) {
        var _openH = _openHumanRun(_msgSite === "realnetpro" ? "realpro" : _msgSite);
        if (_openH) _liveRid = _openH.run_id || _openH.runId || null;
      }
      if (_liveRid) _auditStep(_liveRid, _liveK, msg.d == null ? null : String(msg.d).slice(0, 80));
    } catch (_) {}
    return false;
  }
  return false;
});
// 合図の送り主のタブの URL → realnetpro／itandi／reins（無ければ audit.site（realpro→realnetpro）→ null）
function _siteOfSender(sender, msg) {
  var P = self.AxlxParallelSites;
  var s = P && sender && sender.tab ? P.siteOfSenderUrl(sender.tab.url) : null;
  if (s) return s;
  var a = msg && msg.audit && msg.audit.site ? String(msg.audit.site) : (msg && msg.site ? String(msg.site) : null);
  if (a === "realpro" || a === "realnetpro") return "realnetpro";
  if (a === "itandi") return "itandi";
  if (a === "reins") return "reins";
  return null;
}
// 送付済みで飛ばした数の鍵（お客様×サイト。サイトが分からない時はお客様だけ）
function _sentSkipKey(customerId, site) { return String(customerId) + (site ? "|" + site : ""); }

// ── 2026-09-30 v2.5.42 ITANDI: 資料を開く前の見分け（itandi-bulk-dl → ここ → 止める／進む）──
// 竹内「ITANDI で条件指定ちゃんとできていなければ件数多すぎるバグ（3000件以上の表示など）される可能性ある…」:
//   一括の回（_runBatchSearch が今の ITANDI のお客様の条件を _itandiGuardCtx に置く）だけ判定する。手動の検索・別のお客様の合図は進む
var _itandiGuardCtx = null; // { customerId, cond: {rent_max, floor_plan, desired_area, area_mode}, isWide, attempt, runId }
chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (!msg || msg.type !== "axlx-itandi-precheck") return false;
  var G = self.AxlxItandiGuard;
  var ctx = _itandiGuardCtx;
  if (!G || !ctx || msg.customerId == null || String(ctx.customerId) !== String(msg.customerId)) {
    sendResponse({ action: "proceed", why: !ctx ? "no_batch" : "other_customer" });
    return false;
  }
  var ev = G.evaluate({ rows: msg.rows || [], count: msg.count || null, cond: ctx.cond, isWide: ctx.isWide });
  var guard = { suspect: ev.suspect, reasons: ev.reasons, judged: ev.judged, outside: ev.outside, count: ev.count, count_text: msg.count && msg.count.text ? String(msg.count.text).slice(0, 80) : null, rows_total: msg.rows_total || null, samples: ev.samples, attempt: ctx.attempt };
  ctx.last = guard;
  if (ctx.runId) _auditStep(ctx.runId, "itandi_precheck", (ev.suspect ? "条件が効いていない形: " + G.reasonsJa(ev.reasons) : "問題なし") + "（読めた行 " + ev.judged + "・外 " + ev.outside.any + (ev.count != null ? "・件数 " + ev.count : "") + "・" + (ctx.attempt + 1) + "回目）");
  console.log("[batch] ITANDI の見分け（" + (ctx.attempt + 1) + "回目）: " + (ev.suspect ? "止める " + G.reasonsJa(ev.reasons) : "進む") + " 行=" + ev.judged + " 外=" + ev.outside.any + " 件数=" + ev.count);
  sendResponse({ action: ev.suspect ? "stop" : "proceed", guard: guard });
  return false;
});

// リアプロ PDF 手動一括DL: btn.click() の代わりにメッセージ経由でDL → Adobe自動起動を防ぐ
chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (msg && msg.type === "axlx-download-realpro-pdf" && msg.url) {
    chrome.downloads.download({
      url: msg.url,
      conflictAction: "uniquify",
      saveAs: false,
    }).catch(function (e) { console.warn("[AXLX BG] リアプロPDF手動DL失敗:", e.message); });
    sendResponse({ ok: true });
  }
  return false;
});

// ── 修正1: リアプロ物件データを compare-properties API の形式へ変換 ──────────
// bulk-dl.js のスクレイパは name/access/move_in/detail_url で返すが、
// API は building_name/station_info/available_date/url を期待する。
// この不一致のままだとAIプロンプトが「【undefined】」・LINE文面が賃料/間取り欠落になる。
// （itandi 経路は元から正しい形式のため変換不要）
function _normalizeRealproProperties(properties) {
  return (properties || []).map(function (p) {
    return {
      building_name:  p.building_name || p.name || "",
      room_number:    p.room_number || p.room || undefined,
      rent:           p.rent !== undefined ? p.rent : null,
      management_fee: p.management_fee || undefined,
      floor_plan:     p.floor_plan || undefined,
      area:           p.area || undefined,
      address:        p.address || undefined,
      station_info:   p.station_info || p.access || undefined,
      available_date: p.available_date || p.move_in || undefined,
      url:            p.url || p.detail_url || p.pdf_url || undefined,
    };
  });
}

// alarmが既に存在する場合は再作成しない（Service Worker再起動時の重複防止）
chrome.alarms.get("sumora-batch-poll", function(existing) {
  if (!existing) {
    chrome.alarms.create("sumora-batch-poll", { periodInMinutes: 0.5 });
  }
});

// 修正2: SW再起動・拡張更新時に batchRunning ロックを必ずリセット
// （SWクラッシュでロックが残ると全自動化が無音で永久停止するため）
function _resetBatchLock() {
  try {
    chrome.storage.local.set({ batchRunning: null, batchCommandId: null });
  } catch (e) { /* ignore */ }
}
chrome.runtime.onStartup.addListener(_resetBatchLock);
chrome.runtime.onInstalled.addListener(_resetBatchLock);

var BATCH_LOCK_TTL_MS = 15 * 60 * 1000; // 修正2: ロックTTL 15分

// ── スタッフモード ─────────────────────────────────────────────────────────
// スタッフが手動で拡張を使う間、自動化コマンドを無視するモード（PCごと・chrome.storage.local）。
// _pollAndRunBatch の fetch 前（= claim 前）でチェックするため、コマンドは pending のまま残り、
// 30秒以内に別PC（自動化PC）が自動的に拾う。自動化全体は止まらない。
// 消し忘れ防止のため2時間で自動OFF（TTL方式・batchRunning と同型）。
var STAFF_MODE_TTL_MS = 2 * 60 * 60 * 1000; // 2時間で自動解除

async function _isStaffModeActive() {
  try {
    var st = await chrome.storage.local.get(["staffMode", "staffModeAt"]);
    if (!st.staffMode) return false;
    var at = st.staffModeAt || 0;
    if (at && Date.now() - at > STAFF_MODE_TTL_MS) {
      // TTL失効 → 自動OFF（storage.onChanged 経由でバッジ・popup UIも同期される）
      await chrome.storage.local.set({ staffMode: false, staffModeAt: null });
      return false;
    }
    return true;
  } catch (e) {
    return false; // 読み取り失敗時は通常モード扱い（自動化を止めない）
  }
}

// ── AIXモード（2026-09-12 竹内方針）──────────────────────────────────────
// ONの間このPCは、AIXで「物件ピックアップした／物件オススメ／物件を探す」の指示が出たお客さんの
// 自動検索コマンド（automation_commands.payload.source="aix"）も claim する（pending API に ?aix=1）。
// OFFのPCは AIX 由来コマンドを claim しない＝AIXモードのPCだけが AIX に連動して動く。スタッフモードとは排他（popup 側で制御）。
async function _isAixModeActive() {
  try {
    var st = await chrome.storage.local.get(["aixMode"]);
    return !!st.aixMode;
  } catch (e) {
    return false;
  }
}

// バッジ（2026-09-25: 組み合わせは AxlxModeCore.badge の1か所。スタッフ「手動」／ブレイン×スタッフ「手脳」／AIX「AIX」／
//   ブレイン×AIX「脳」（旧「ブレイン」と同じ）／ブレイン×通常「脳通」／通常 なし）。on はスタッフが有効か（TTL 込み）
function _updateStaffModeBadge(on) {
  try {
    chrome.storage.local.get(["staffMode", "staffModeAt", "aixMode", "autoModeAt", "brainMode"]).then(function(st) {
      var core = self.AxlxModeCore;
      // 2026-11-10 自動モード: 選んだ印（autoModeAt）があり、aix と読める時だけ「自動」のバッジ（v2.5.77 の「出さない」をやめる）
      var readMode = core ? core.effectiveState(st || {}, Date.now()).mode : ((st && st.aixMode) ? "aix" : "normal");
      var mode = on ? "staff" : readMode;
      var b = core ? core.badge(mode, !!(st && st.brainMode)) : { text: on ? "手動" : "", color: "#16a34a" };
      chrome.action.setBadgeText({ text: b.text });
      if (b.text) chrome.action.setBadgeBackgroundColor({ color: b.color });
    }).catch(function() { /* ignore */ });
  } catch (e) { /* ignore */ }
}

// popup のトグル操作・TTL自動解除をバッジに即時反映
chrome.storage.onChanged.addListener(function(changes, area) {
  if (area === "local" && (changes.staffMode || changes.aixMode || changes.autoModeAt || changes.brainMode)) {
    _isStaffModeActive().then(_updateStaffModeBadge);
    /**
     * ★ 2026-11-15: 自動モードに切り替えた瞬間も最新の学びを取り込む。
     *   ⚠ 指示を拾う前に切り替えただけの時も、束が古いと動き方が古いままになる。
     */
    try {
      var core = self.AxlxModeCore;
      if (!core) return;
      chrome.storage.local.get(["staffMode", "staffModeAt", "aixMode", "autoModeAt", "brainMode"]).then(function (st) {
        var m = (core.effectiveState || core.readState)(st || {}, Date.now()).mode;
        if (m === core.AUTO_MODE || (!!core.AI_MODE && m === core.AI_MODE)) {
          _refreshLearnedBundleQueued(true).catch(function () {});
        }
      });
    } catch (_) {}
  }
});

// SW起動時にバッジを復元（TTL失効チェック込み）
_isStaffModeActive().then(_updateStaffModeBadge);

chrome.alarms.onAlarm.addListener(async function(alarm) {
  if (alarm.name !== "sumora-batch-poll") return;
  /**
   * ★ 2026-11-20: ロックの時刻は進み（_watchProgress）でしか延びない。引き継ぎ待ち・裏のタブ・長い休憩の間に 15分を過ぎると、
   *   旧はアラームが「古いロック」と見て2本目の一括を始め、共有の印（止める・やり直し済み）を初期化していた。
   *   → この SW で一括が生きている間はロックを延ばして終わる（SW が死んだ後の取り残しだけ上書きする）。
   */
  if (_manualBulkAlive) return;
  // ★ 2.8.265: 裏が立ち上がり直した直後（手の一括の控えがまだ新しい＝続きを待っている）は、定時の一括を割り込ませない
  try {
    var _bq = await _bulkQueueLoad();
    if (_bq && !_bq.done && _bq.beatAt && Date.now() - _bq.beatAt < 20 * 60000) return;
  } catch (_) {}
  // 1時間まったく進んでいない一括は「生きている」と見なさない（待ちが全部切れても戻らない時の最後の逃げ道）
  var _loopStale = false;
  try { _loopStale = !!(_batchWatch && _batchWatch.lastProgressAt && Date.now() - _batchWatch.lastProgressAt > 60 * 60000); } catch (_) {}
  if (_batchLoopAlive && !_loopStale) {
    try { await chrome.storage.local.set({ batchRunning: { running: true, startedAt: Date.now() } }); } catch (_) {}
    return;
  }
  var st = await chrome.storage.local.get("batchRunning");
  var lock = st.batchRunning;
  if (lock) {
    // 修正2: TTL方式 — {running:true, startedAt} 形式で15分未満なら実行中とみなす。
    // 旧boolean形式（startedAt無し）や15分超過は古いロックとして上書き実行する。
    var startedAt = (typeof lock === "object" && lock) ? lock.startedAt : 0;
    if (startedAt && Date.now() - startedAt < BATCH_LOCK_TTL_MS) return;
    console.warn("[batch] 古い batchRunning ロックを検出 → 上書き実行:", JSON.stringify(lock));
  }
  await _pollAndRunBatch();
});

// 2026-09-25: webapp-bridge の文法の誤りを直して、ウェブアプリの poll-now（キューに入れた直後の「すぐ拾って」）が
//   6週間ぶりに届くようになった。アラーム・poll-now はどちらも「ロックが無い」を見てから pending を取りに行き、
//   ロックは取った後で書くので、同じ PC で間を置かずに2回呼ばれると別々のコマンドを2本同時に走らせうる
//   （例: itandi とレインズのボタンを続けて押す）。拾っている最中（ロックを書くまで）は2本目を始めない。
var _pollClaimInFlight = false;
// 2026-11-10 自動モードの回の間隔（対数正規・12操作ごとに休憩）。1つの回の中で持ち回る
var _autoPacer = null;
// 自動モードで回している時の「続けて動き始めた時刻」（90分で小休憩）。0＝回していない
var _autoWorkedSince = 0;
// 2026-11-11 竹内さん「90分働いたら休憩があるのが普通」: 手の一括検索（AIXモードの帯）で働き続けた時間（休憩で数え直す）
var _manualBulkWorkedSince = 0;
var _autoModeOn = false;

/**
 * 2026-11-10 自動モードの勤務時間のゲート（auto-run.js の workGate）。
 *   JST 9:00〜21:00 の間だけ・12:00〜13:00 は休憩・土日は動かない・90分続いたら小休憩。
 *   自動モードで拾った時に1回見る（開いていなければ指示を拾わない＝サーバーの pending は残る）。
 *   戻り値: { open, reason, resumeAt }
 */
function _autoWorkGate() {
  var A = self.AxlxAutoRun;
  if (!A || !A.workGate) return { open: true, reason: null, resumeAt: null };
  var g = A.workGate(Date.now());
  if (!g.open) return g;
  // 90分続けて動いていたら小休憩（休憩の後は数え直し）
  if (_autoWorkedSince && A.continuousRestDue(_autoWorkedSince, Date.now())) {
    var t = Date.now() + (A.WORK_REST_MS || 600000);
    console.log("[batch] 自動モード: 90分続いたので小休憩（" + new Date(t).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) + " まで）");
    _autoWorkedSince = 0;
    return { open: false, reason: "continuous_rest", resumeAt: t };
  }
  if (!_autoWorkedSince) _autoWorkedSince = Date.now();
  return { open: true, reason: null, resumeAt: null };
}

async function _pollAndRunBatch() {
  if (_pollClaimInFlight) {
    console.log("[batch] 別の呼び出しが pending を拾っている最中 → 今回は見送り（次のアラームで拾う）");
    return;
  }
  _pollClaimInFlight = true;
  try {
    // スタッフモード中は pending をclaimしない（fetch前に離脱）。
    // コマンドは pending のまま残り、次の30秒ポーリングで別PCが拾うため自動化は継続する。
    if (await _isStaffModeActive()) {
      return;
    }
    // 修正9: pending ポーリングに10秒タイムアウト / 修正10: 共有シークレットヘッダー
    // 2026-09-25: どの出どころを拾うかは AxlxModeCore.behavior の1か所から読む（claimCommands / claimAix / claimBrainCommands）。
    //   AIXモードのPCだけが AIX 由来（source=aix・auto_schedule）を受け取る（?aix=1）。
    //   竹内「チェックした物の一括検索。拡張ツールでブレインモードに選択していたら連動して検索。ブレインモードのみで連動」:
    //   ブレインが ON の PC（スタッフ以外）だけがウェブの AIXツールの一括検索（source=web_brain）を受け取る（?brain=1）
    // 2026-11-10 v2.5.94: autoModeAt（自動モードを選んだ印）も読む。
    //   旧はここで読んでおらず、effectiveState が「選んだ印が無い」と見て mode=normal に落とし、
    //   自動モードを選んでいても claimCommands=false で指示を一切拾えなかった（＝自動が来ない原因）
    var _modeRaw = await chrome.storage.local.get(["staffMode", "staffModeAt", "aixMode", "autoModeAt", "brainMode"]);
    var _core = self.AxlxModeCore;
    // v2.5.77: 光って選択するモード（GUIDE_ONLY）の間は effectiveBehavior が受け取りを全部 false にする＝サーバーに取りに行かない
    var _modeSt = _core ? (_core.effectiveState || _core.readState)(_modeRaw, Date.now()) : { mode: "normal", brain: !!_modeRaw.brainMode };
    var _bh = _core ? (_core.effectiveBehavior || _core.behavior)(_modeSt.mode, _modeSt.brain) : { claimCommands: false, claimAix: false, claimBrainCommands: false };
    if (!_bh.claimCommands) return;
    // 2026-11-10 自動モードの勤務時間のゲート（JST 9〜21時・12〜13時は休憩・土日なし・90分で小休憩）。
    //   開いていない時は指示を拾わない（pending のまま残る＝時間内に別の PC か次の見回りが拾う）。サイトへのアクセスは増えない
    _autoModeOn = (_modeSt.mode === (_core && _core.AUTO_MODE ? _core.AUTO_MODE : "aix"));
    if (_autoModeOn) {
      var _wg = _autoWorkGate();
      if (!_wg.open) {
        try { await chrome.storage.local.set({ autoWorkGate: { open: false, reason: _wg.reason, resumeAt: _wg.resumeAt, at: Date.now() } }); } catch (_) {}
        console.log("[batch] 自動モードの勤務時間の外（" + _wg.reason + "）→ 今回は拾わない");
        return;
      }
      try { await chrome.storage.local.set({ autoWorkGate: { open: true, reason: null, resumeAt: null, at: Date.now() } }); } catch (_) {}
      /**
       * ★ 2026-11-15 竹内さん「録画から画像学習したのを自動に動き方を学ばせるだけなのになぜ止まる」:
       *   ⚠ 実測: 束に画面位置 n≥3 が33欄あっても `read_count=0`（拡張が取っていない）。
       *     学習→束までは動くのに、**自動が指示を拾う直前に最新の学びを取り直していなかった**
       *     （5分ポーリング任せ＝手が止まる原因）。
       *   → **自動が指示を拾う前に必ず最新の束を取り込む**（force）。
       *     失敗しても検索は止めない（古い束のまま動く方が、何もしないよりマシ）。
       */
      /**
       * ★ 2026-11-17 統括Pro「学習しても自動が強化されない」:
       *   旧は指示拾いのたびに force 取込 → read_count が水増し（実測120）し、
       *   「読んだ」だけで改善済みに見えた。改善→自動の切れ目が測れなくなる。
       *   → needs_auto／screen空／版不明の時だけ force。それ以外は軽い版確認。
       */
      try {
        await _learnRefreshForAutofill();
      } catch (_) { /* 学びが取れなくても指示は拾う */ }
    }
    var _qs = [];
    if (_bh.claimAix) _qs.push("aix=1");
    if (_bh.claimBrainCommands) _qs.push("brain=1");
    // v2.5.48: リアプロのタブがログインの画面等（main.php が1つも無い）なら rp=0 → サーバーがリアプロを含む手の命令を少しの間ほかの PC に譲る
    //   （2026-09-30 YUMA の手の命令が2回ともログイン切れの PC に渡って AXLX_TAB_DEAD）。タブを読むだけ・サイトには触らない
    /**
     * 2026-11-12 竹内さん「今リアプロスタンバイしていない時も勝手に自動検索おこなわれていないか？」:
     *   調べたら**動いていた**（26時間で121件・その120件が `AXLX_NO_TAB: realnetpro のタブが開いていません`
     *   で約60秒おきに失敗し続けていた）。
     *   原因は2つ: ① 拡張の `realproReady` が「タブが無い」時 **null** を返していて、呼ぶ側は
     *   `=== false` の時だけ rp=0 を付けるので**何も付かなかった**（＝リアプロを使えない PC が拾っていた）。
     *   ② サーバー側の `deferForRealproNotReady` は **web_brain だけ**を見ていて、
     *   **自動便（auto_schedule）は rp=0 でも渡していた**。
     *   → ①は batch-guard.js で false に（修正済み）。②はここで **リアプロを含む命令は rp=0 の PC に渡さない**
     *     ようにサーバーを直した（app/lib/automation-sources.ts）。
     *   この PC でリアプロを使えない時は、そもそも自動の回を**拾わない**ようにもする（二重の歯止め）。
     */
    var _tabsNow = [];
    try { _tabsNow = await chrome.tabs.query({}); } catch (_) {}
    var _rpReady = null;
    try {
      if (self.AxlxBatchGuard && self.AxlxBatchGuard.realproReady) _rpReady = self.AxlxBatchGuard.realproReady(_tabsNow);
    } catch (_) {}
    if (_rpReady === false) {
      _qs.push("rp=0");
      /**
       * 2026-11-12: リアプロを使えない PC は、**リアプロを含む自動便は拾わない**。
       *   ⚠ 拾わないだけで命令は消さない（pending のまま＝リアプロを開いている別の PC が拾う）。
       *   ITANDI だけの命令は今まで通り拾う。
       */
      if (_autoModeOn) {
        console.log("[batch] 自動モードだがリアプロのタブが無い → リアプロを含む指示は拾わない（pending のまま・別の PC が拾う）");
        try { await chrome.storage.local.set({ autoWorkGate: { open: false, reason: "no_realpro_tab", resumeAt: null, at: Date.now() } }); } catch (_) {}
        return;
      }
    }
    // 2026-09-30 v2.5.42 竹内「お客さん毎に…次のお客さんに移る等の動きで。また動き方もロボットみたいじゃなくて人間のように」:
    //   1人1コマンド（AIXツールの一括検索・午前の便）は、前の人を終えてから人がお客様を開き直す間（auto-run.js nextCommandGapMs）を置いてから拾う。
    //   ⚠ /pending は取った時点で running にする（claim）ので、間は取りに行く**前**に見る（コマンドは pending のまま＝他の PC が拾ってもよい）。
    //   10分より先の値（時計のずれ・古い値）は信じない。サイトへのアクセスは増えない
    var _gapSt = await chrome.storage.local.get(["batchNextNotBefore"]);
    var _nb = Number(_gapSt && _gapSt.batchNextNotBefore) || 0;
    if (_nb > Date.now() && _nb - Date.now() < 10 * 60 * 1000) {
      console.log("[batch] 前のお客様からの間（あと " + Math.round((_nb - Date.now()) / 1000) + "秒）→ 次の見回りで拾う");
      return;
    }
    /**
     * ★ 2.8.141 実測（search_audits 1545/1546）: 人が始めた自動検索の7秒後に自動便を拾い、同じタブで2本が重なって両方止まった。
     *   → 人の回が開いている間・ページで入力が進んでいる間は拾わない（pending のまま次の見回りで拾う）。
     */
    if (self.AxlxBatchGuard && self.AxlxBatchGuard.claimBlockedByHumanRun) {
      var _humanRun = _openHumanRun(null);
      var _rpProbe = null;
      if (!_humanRun) {
        try {
          var _rpTab = self.AxlxBatchGuard.pickRealproTab(_tabsNow);
          if (_rpTab && _rpTab.id != null) _rpProbe = await _probeRealproTab(_rpTab.id);
        } catch (_) { _rpProbe = null; }
      }
      var _claimBlock = self.AxlxBatchGuard.claimBlockedByHumanRun(_humanRun, _rpProbe);
      if (_claimBlock) {
        console.log("[batch] " + self.AxlxBatchGuard.reasonJa(_claimBlock) + " → 今は指示を拾わない（pending のまま）"
          + (_humanRun ? " customer=" + String(_humanRun.property_customer_id || "-").slice(0, 8) : ""));
        return;
      }
    }
    // 2026-09-29 v2.5.40: 拾った拡張の版と PC を渡す（サーバーが claim した行に残す＝「どの版が拾った・見送ったか」を DB で見分ける。
    //   9/29 16:32 の午後の便の見送りは v2.5.38 より前の拡張だったが、版の記録が search_audits にしか無く後から推すしかなかった）
    var res = await fetch(SUMORA_BATCH_API + "/api/automation/pending" + (_qs.length ? "?" + _qs.join("&") : ""), {
      cache: "no-store",
      headers: Object.assign({ "x-ext-version": _extVersion() || "", "x-ext-install": (await _snapInstallId()) || "" }, await _getAutomationKeyHeader()),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      // 修正: pending API のHTTPエラーを無音スキップせず可視化する
      // （SUPABASE_SERVICE_ROLE_KEY 未設定による全500がデバッグ不能だった）
      console.warn("[batch] pending API HTTP " + res.status);
      try {
        await chrome.storage.local.set({ lastPollError: { status: res.status, at: Date.now() } });
      } catch (e2) { /* ignore */ }
      return;
    }
    try { await chrome.storage.local.set({ lastPollError: null }); } catch (e2) { /* ignore */ }
    var json = await res.json();
    // 2026-10-02 v2.5.69: サーバーの一時停止（automation_settings.paused）を覚える＝popup の帯に「⏸ 自動の物件検索は一時停止中」を出す（新しい口は作らない）
    try { await chrome.storage.local.set({ autoSearchPaused: !!(json && json.paused), autoSearchPausedAt: Date.now() }); } catch (e3) { /* ignore */ }
    if (!json.command) return;
    var cmd = json.command;
    // 2026-09-24 竹内「ブレインモードにしているのに 11:00 の自動モードが連動していた。ブレインモードならブレインモードのままで、
    //   AIX モード（自動便）は連動されない」: ブレインモード中は時刻起動の自動便（auto_schedule）を実行しない。
    //   pending のまま残すと後でモードを戻した時に古い便が走るので、見送りとして閉じる（画面の履歴に理由が残る）
    // 2026-09-25: ブレインが独立の切り替えになった後も同じ（AxlxModeCore.behavior の runAutoSchedule = AIX かつ ブレインOFF）。
    //   自動便は ?aix=1 の PC（AIX連動）にしか届かないので、ここに来るのは ブレイン×AIX の時だけ（旧「ブレイン」と同じ動き）。
    // 2026-09-29 竹内「ブレインの AIX モードで午前11時頃と午後17時頃の一括検索が行われていない」: 9/28・9/29 の午前の便（38・39人）が全部ここで見送りになっていた。
    //   今は runAutoSchedule（mode-core）が false の時だけ見送る＝ブレイン×AIX でも走る
    if (cmd.command_type !== "stop_all" && cmd.payload && cmd.payload.source === "auto_schedule" && _bh.runAutoSchedule === false) {
      console.log("[batch] ブレインモード中 → 自動便を見送り: " + cmd.id);
      // 2026-09-29 v2.5.40: 見送った拡張の版も書く（今の版ではここに来ない＝この文が出たら古い版が動いている）
      await _updateBatchCommand(cmd.id, { status: "cancelled", error_message: "ブレインモード中のため自動便（AIX連動）は実行しない（拡張 v" + (_extVersion() || "?") + "）", completed_at: new Date().toISOString() });
      return;
    }
    // Fix 6: stop_all は batchRunning ロック中でも即時にフラグをセットする。
    // 既存の _runBatchSearch 冒頭でも処理されるが、ここで先行してフラグを立てることで
    // 実行中バッチへのシグナル到達を早める。
    if (cmd.command_type === "stop_all") {
      console.log("[batch] Fix6: stop_all を pending から検出 → _batchShouldStop = true");
      _batchShouldStop = true;
      await chrome.storage.local.set({ batchStopRequested: true });
      // ロック中の場合はコマンドを完了扱いにして終了（_runBatchSearch を呼ばない）
      var lockSt = await chrome.storage.local.get("batchRunning");
      if (lockSt.batchRunning) {
        await _updateBatchCommand(cmd.id, { status: "done", completed_at: new Date().toISOString() });
        return;
      }
    }
    // 修正④b: コマンド受信時にポップアップを開き、スタッフに実行中を通知する。
    // chrome.action.openPopup() は Chrome 127 未満またはユーザージェスチャなし環境で失敗するため
    // try/catch でラップし、失敗時は赤バッジ '!' を 10秒表示してアイコンクリックを促す。
    // popup.js が chrome.storage.session で読むため session に書く。
    // customerId は customer_ids の先頭要素（ポップアップで顧客を自動選択するため）。
    try {
      await chrome.storage.session.set({
        pendingPopupCmd: {
          id: cmd.id,
          command_type: cmd.command_type,
          customerId: (cmd.customer_ids && cmd.customer_ids.length > 0) ? cmd.customer_ids[0] : null,
        }
      });
    } catch (_sessionErr) { /* session storage 非対応環境では無視 */ }
    try {
      await chrome.action.openPopup();
    } catch (_openPopupErr) {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });
      setTimeout(function() { chrome.action.setBadgeText({ text: '' }); }, 10000);
    }
    // 修正2: ロックを {running, startedAt} 形式で保存（TTL判定用）
    await chrome.storage.local.set({
      batchRunning: { running: true, startedAt: Date.now() },
      batchCommandId: cmd.id,
    });
    // ロックを書いたので、ここから先の2本目はロックで止まる（_pollClaimInFlight は拾う間だけ）
    _pollClaimInFlight = false;
    // 2026-09-29 v2.5.40 見張り: この SW で一括の回が動いている印（止まりの写真・ロックの延長・帯の「一括検索中」）
    _batchLoopAlive = true;
    _watchSet({ commandId: String(cmd.id), batchStartedAt: Date.now(), customerId: null, customerName: null, site: null, pass: null, waitingFor: "お客様の読み込み" });
    try {
      await _runBatchSearch(cmd);
    } catch (e) {
      await _updateBatchCommand(cmd.id, { status: "error", error_message: String(e) });
    } finally {
      _searchOverrideLink = null; // 2026-09-27 上書きの回の印はこのコマンドの間だけ（止めた・失敗した時も消す）
      _batchLoopAlive = false;
      _watchClear(); // 2026-09-29 v2.5.40 見張りを消す＝帯は「待機中」・止まりの写真も撮らない
      // 2026-09-27 自動便の指定（午後の便の1ページ・更新順等）もこのコマンドの間だけ（後の手動の検索に残さない）
      try { if (self.AxlxAutoRun) await chrome.storage.local.remove(self.AxlxAutoRun.STORAGE_KEY); } catch (_) {}
      // 2026-09-30 v2.5.42 1人1コマンドの回（AIXツールの一括検索・午前の便）の後は、次のお客様を拾うまで人の間を置く（上の _gapSt）
      var _nextGap = null;
      try {
        var _src = cmd.payload && cmd.payload.source;
        if (cmd.command_type !== "stop_all" && (_src === "web_brain" || _src === "auto_schedule") && (cmd.customer_ids || []).length === 1 && self.AxlxAutoRun && self.AxlxAutoRun.nextCommandGapMs) {
          _nextGap = self.AxlxAutoRun.nextCommandGapMs();
          console.log("[batch] 次のお客様まで " + Math.round(_nextGap / 1000) + "秒の間");
        }
      } catch (_) {}
      await chrome.storage.local.set({ batchRunning: null, batchCommandId: null, batchNextNotBefore: _nextGap ? Date.now() + _nextGap : 0 });
    }
  } catch (e) {
    // MV3 Service Worker起動直後の一時的なfetch失敗は無視（次の30秒ポーリングで自動回復）
    console.warn("[batch] poll error (transient):", e.message || e);
  } finally {
    _pollClaimInFlight = false;
  }
}

async function _runBatchSearch(command) {
  // v2.5.77: 光って選択するモードの間は一括検索のコマンドを動かさない（受け取りも止めている・二重の歯止め）。止めるコマンドだけ通す
  if (_guideOnly() && command && command.command_type !== "stop_all") {
    console.warn("[batch] 光って選択するモードのため一括検索のコマンドを動かさない id=" + command.id);
    try { await _updateBatchCommand(command.id, { status: "cancelled", error_message: "guide_only（拡張は光って選択するモード）", completed_at: new Date().toISOString() }); } catch (_) {}
    return;
  }
  // ── stop_all: スマホのストップボタンから DB 経由で届いたストップコマンド ──
  if (command.command_type === "stop_all") {
    console.log("[batch] stop_all コマンド受信 → バッチを中断");
    _batchShouldStop = true; // Fix 2: 同期フラグも立てる
    await chrome.storage.local.set({ batchStopRequested: true });
    await _updateBatchCommand(command.id, { status: "done", completed_at: new Date().toISOString() });
    return;
  }

  // バッチ開始時にストップフラグをクリア（前回の残留を防ぐ）
  _batchShouldStop = false; // Fix 2: 同期フラグもリセット
  await chrome.storage.local.set({ batchStopRequested: false });
  // 2026-09-29 見張り: 前の回の「止める」は持ち越さない（まだログインが切れていれば、この回の最初の検索でまた見張りが止める）
  _watchStop = null;
  _watchSkipped = [];
  /** ★ 2.8.214: AIX／自動便も古い page-script のまま動かさない */
  try {
    var _pfB = await _ensureRealproPageFresh("batch_cmd");
    console.log("[batch] page-fresh", _pfB);
  } catch (_) {}
  try { await _refreshLearnedBundleQueued(true); } catch (_) {}

  // ── scrape_and_compare: WebApp（リアプロボタン）からのスクレイプ比較依頼 ────
  if (command.command_type === "scrape_and_compare") {
    await _updateBatchCommand(command.id, { status: "running" });
    try {
      var payload = command.payload || {};
      await _scrapeAndCompareForCustomer({
        customer_id: payload.customer_id,
        customer_name: payload.customer_name,
        is_wide: payload.is_wide || false,
        conditions: payload.conditions || {},
      });
      await _updateBatchCommand(command.id, { status: "done", completed_at: new Date().toISOString() });
    } catch (scrapeErr) {
      await _updateBatchCommand(command.id, { status: "error", error_message: String(scrapeErr) });
    }
    return;
  }

  // ── property_scrape: 指定顧客の物件をスクレイプして比較API に渡す ──────────
  if (command.command_type === "property_scrape") {
    await _updateBatchCommand(command.id, { status: "running" });
    try {
      var scrapeCustomersRes = await _fetchCustomerListWithRetry(SUMORA_BATCH_API + "/api/property-customers", "scrape");
      if (!scrapeCustomersRes.ok) throw new Error("顧客データ取得失敗");
      var scrapeAllCustomers = await scrapeCustomersRes.json();
      var scrapeCustomer = Array.isArray(scrapeAllCustomers) && command.customer_ids && command.customer_ids.length > 0
        ? scrapeAllCustomers.find(function (c) { return command.customer_ids.indexOf(String(c.id)) !== -1; })
        : null;
      if (!scrapeCustomer) throw new Error("対象顧客が見つかりません (customer_ids=" + (command.customer_ids || []).join(",") + ")");
      await _scrapeAndCompareForCustomer(scrapeCustomer);
      await _updateBatchCommand(command.id, { status: "done", completed_at: new Date().toISOString() });
    } catch (scrapeErr) {
      await _updateBatchCommand(command.id, { status: "error", error_message: String(scrapeErr) });
    }
    return;
  }

  // ── 通常バッチ検索（既存処理）────────────────────────────────────────────
  var customersRes = await _fetchCustomerListWithRetry(SUMORA_BATCH_API + "/api/property-customers", "batch");
  if (!customersRes.ok) throw new Error("顧客データ取得失敗");
  var allCustomers = await customersRes.json();

  var targets;
  if (command.customer_ids && command.customer_ids.length > 0) {
    targets = allCustomers.filter(function(c) {
      return command.customer_ids.indexOf(String(c.id)) !== -1;
    });
  } else {
    var threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    var now = Date.now();
    targets = allCustomers.filter(function(c) {
      if (c.status === "new_inquiry") return true;
      if (c.status === "hot") return true;
      if (c.status === "property_search") {
        if (!c.last_property_sent_at) return true;
        return now - new Date(c.last_property_sent_at).getTime() > threeDaysMs;
      }
      return false;
    });
  }

  // 2026-09-30 v2.5.42 竹内「リアプロと itandi、お客さんそれぞれ同時に完了するようにする。YUMA ならリアプロと itandi 完了して、次のお客さんに移る」:
  //   1コマンドに両サイトがある時（自動便・AIXツールの一括検索の「リアプロ＋itandi」）は、お客様1人ずつ リアプロ → ITANDI の順に終えてから次のお客様へ
  //   （下の二重ループ＝お客様 → サイト。サイトごとに全員を回さない）。並びはここ1か所（auto-run.js orderSites）
  var sites = (self.AxlxAutoRun && self.AxlxAutoRun.orderSites) ? self.AxlxAutoRun.orderSites(command.sites || ["reins"]) : (command.sites || ["reins"]);
  // 修正5: is_wide をキュー経路（trigger API → payload.is_wide）から伝搬
  var batchIsWide = !!(command.is_wide || (command.payload && command.payload.is_wide));
  // 2026-09-19 竹内「毎日11:00に…／17:00に今日出た新規物件を…（更新順・1ページだけ）」:
  //   時刻起動の自動便（/api/cron/auto-property-search が積む payload.source="auto_schedule"）だけ、
  //   更新日・並び順・ページ数を payload の指定で上書きする。手動の一括検索は今までどおり。
  var autoSched = (command.payload && command.payload.source === "auto_schedule") ? command.payload : null;
  if (autoSched) {
    console.log("[batch] 自動便 mode=" + autoSched.mode + " 更新日=" + autoSched.rp_update_days + " 並び=" + autoSched.sort + " ページ上限=" + autoSched.max_pages + " サイト=" + sites.join(","));
  }
  // 2026-09-27 竹内「ITANDI もおねがい」: 自動便の指定（popup・bulk-dl・itandi-bulk-dl へ storage で渡す）とサイトの飛ばし・間（auto-run.js）
  var _AR = self.AxlxAutoRun || null;
  var _autoOpts = (_AR && autoSched) ? _AR.optsFromPayload(autoSched) : null;
  try { if (_AR) await chrome.storage.local.remove(_AR.STORAGE_KEY); } catch (_) {}
  var _arMem = null; // 2026-09-30 v2.5.43 自動便の指定・止める線の写し（同時の回はサイトごとに by_site へ）
  var _autoSkipped = []; // ITANDI のタブが無くて飛ばしたお客様
  var _siteAttempts = 0; // 実際に回したお客様×サイトの数（全部失敗の判定に使う）
  // 2026-09-25 竹内「更新日も拡張ツールと連動」: payload の rp_update_days は出どころを問わず使う（_buildBatchConditions）。
  //   AIXツールの一括検索（web_brain）はサーバーが1人ごとに計算して積む（rp-update-days.ts）。並び順・ページ数は自動便だけ
  var cmdPayload = command.payload || null;
  var isWebBrain = !!(cmdPayload && cmdPayload.source === "web_brain");
  if (isWebBrain) {
    console.log("[batch] AIXツールの一括検索（ブレイン）: 更新日=" + (cmdPayload.rp_update_days || "指定なし") + " 広げて=" + batchIsWide);
    // 2026-09-27 竹内「まずピンポイント検索して、なければ広げて検索する」: サーバー（search-widen-chain）が積んだ「自動で広げて」の回
    if (cmdPayload.chain) console.log("[batch] 🔎 ピンポイントで通す物件が " + cmdPayload.chain.pass_count + " 件（" + (cmdPayload.chain.kind === "new" ? "新規は" + cmdPayload.chain.threshold + "件未満" : "新着・追加は0件") + "）→ 自動で広げて検索（1回だけ）");
  }
  // 2026-09-27 竹内「『大正駅で検索する』なら駅は大正駅だけで検索…拡張ツールの一時調整の部分で合わせる形」:
  //   AIXツールのメモ欄の検索の指示（payload.search_override）は web_brain の回だけ・この回だけお客様の写しに重ねる
  //   （お客様の登録の条件・拡張に保存した一時調整は書き換えない。popup には axlx-switch-customer の searchOverride で渡す＝_batchAutofill）
  //   v2.5.37: AIX の検索（source=aix）にも重ねる＝ブレインが「今回だけ」と決めたお客様の言い直し（登録の条件は直さない回）
  var searchOverride = (cmdPayload && self.AxlxSearchOverride && self.AxlxSearchOverride.sourceAllows(cmdPayload.source)) ? self.AxlxSearchOverride.sanitize(cmdPayload.search_override) : null;
  if (searchOverride) console.log("[batch] AIXツールのメモの一時調整（この回だけ）: " + self.AxlxSearchOverride.describe(searchOverride));
  // 2026-09-27 案A: この回の merge-pdfs に search_command_id を付ける（判定も上書きで）。上書きの無いコマンドは付けない
  _searchOverrideLink = searchOverride ? { commandId: String(command.id), customerIds: targets.map(function (c) { return String(c.id); }) } : null;
  await _updateBatchCommand(command.id, {
    status: "running",
    total_customers: targets.length,
    processed_customers: 0
  });
  /** ★ 2.8.217: キュー一括の誰・何件・次客を枠へ */
  var _qNames = targets.map(function (c) { return String((c && c.customer_name) || "?"); });
  try {
    await _publishBulkGrasp({
      total: targets.length,
      index: 0,
      currentName: "",
      nextName: _qNames[0] || "",
      names: _qNames,
      waitingFor: "一括開始",
    });
  } catch (_) {}

  var batchErrors = []; // 修正12: サイト別の失敗を集約してサーバーへ可視化する
  _busyRetried = new Set(); // 2.8.128 busy_other_customer で断られたお客さんを最後に1回だけやり直す（一括ごと）

  // 2026-09-30 v2.5.43 1人×1サイトの回（地域→駅の2パスを含む）。順の回も同時の回もここを通る（var はこの関数の中だけ＝2本が並んでも混ざらない）。
  //   laneMode=true の時は見張り（_batchWatch.lanes[site]）・待ち手・時間切れがこのサイトだけで閉じる（片方の失敗がもう片方を止めない）
  //   返り: { cancelled }（止める要求＝呼び出し元が命令を cancelled にする）／{ skipped }（見張りが止めたサイト）
  async function _runSiteLane(customer, batchSite, laneMode, laneNote) {
    // 2026-09-29 見張り: ログイン切れ・サイトのエラーで見張りが止めたサイトは、次のお客様の境目から見送る（1人ずつの失敗の知らせは出さない）
    if (_watchSkipSite(customer, batchSite)) return { skipped: true };
    _siteAttempts++;
    // area_mode='both': 地域（ward）と駅（station）を別々に2回検索・送信
    var areaModePasses = (customer.area_mode === 'both') ? ['ward', 'station'] : [null];
    // B3修正: both顧客は各パスの0件通知を抑制し、ループ後に合計0件なら1回だけ通知する
    var _isMultiPass = areaModePasses.length > 1;
    var _totalPassCount = 0;
    var _passFailed = 0; // 2026-09-25: 失敗・5分の待ち切れのパスの数（全部だめなら「0件」ではなく「検索できなかった」と送る）
    var _passCountUnknown = 0; // 2026-09-27 v2.5.30: 件数の分からない完了（送信エラー等）のパスの数
    var _searchRecorded = false; // 2026-09-27 v2.5.32: 検索日の記録は検索を押せた回だけ（お客様×サイトで1回）
    for (var k = 0; k < areaModePasses.length; k++) {
      if (k > 0) {
        // 地域→駅の切り替えインターバル（5〜10秒）
        var _betweenModeDelay = 5000 + Math.floor(Math.random() * 5000);
        console.log("[batch] both顧客: 地域→駅 切り替え待機 " + _betweenModeDelay + "ms");
        await new Promise(function(r) { setTimeout(r, _betweenModeDelay); });
      }
      var effectiveCustomer = areaModePasses[k]
        ? Object.assign({}, customer, { area_mode: areaModePasses[k] })
        : customer;
      // 2026-09-29 v2.5.41 更新日の計画（payload.update_days_plan・前回の検索から空いた時間を覆う所まで広げた値）をこのお客様の分に写す。
      //   計画の無い命令は元の payload のまま（今までどおり）
      var _custPayload = (_AR && _AR.payloadForCustomer) ? _AR.payloadForCustomer(cmdPayload, effectiveCustomer.id) : cmdPayload;
      if (_custPayload && _custPayload._update_days) console.log("[batch] 更新日の計画: " + (_custPayload._update_days.days ? _custPayload._update_days.days + "日以内" : "指定なし") + (_custPayload._update_days.widened ? "（前回の検索から" + _custPayload._update_days.gap_hours + "時間・広げた）" : "") + " customer=" + effectiveCustomer.id);
      // 2026-09-29 v2.5.41 竹内「一度送ったことがある物件はダウンロードもしないように」: このお客様の送付済みの部屋を読んでおく（スタッフモードは読まない＝選ばない物を作らない）
      await _loadSentRooms(effectiveCustomer.id, batchSite);
      // 2026-09-30 v2.5.44 お客様ごとの計画（plan_by_customer[id]: 状態・並び・止める線・ページ）
      if (_custPayload && _custPayload._plan) console.log("[batch] 計画: " + (_custPayload._plan.state || "-") + " 並び=" + (_custPayload._plan.sort || "-") + " 止める線=" + _custPayload._plan.stop_at_last + " ページ=" + (_custPayload._plan.max_pages || "-") + " customer=" + effectiveCustomer.id);
      // 検索の点検: この1回（お客様×サイト×パス）の記録を始める（ブレインの時だけ・それ以外は null）
      var _batchAudit = await _auditBegin({
        site: batchSite, customer_id: effectiveCustomer.id, customer: effectiveCustomer,
        trigger: isWebBrain ? "web_brain" : "bulk_queue", command_id: command.id,
        is_wide: batchIsWide, area_mode: effectiveCustomer.area_mode || null, pass: areaModePasses[k] || null,
        search_override: searchOverride, // 2026-09-27 どの上書きで検索したか（点検に残す）
      });
      // 2026-09-30 v2.5.43 同時か順か（その理由）を点検の段に残す
      if (_batchAudit && laneNote) _auditStep(_batchAudit.runId, "lane_mode", laneNote);
      // 2026-09-29 v2.5.40 見張り: この1回（お客様×サイト×パス）の上限（AxlxSnapshotCore.PASS_DEADLINE_MS）を過ぎたら
      //   「見張りの時間切れ」で投げて下の catch に入れ（点検・命令の error_message・★物件出し★の失敗の知らせに理由が残る）、次のお客様へ進む
      var _passGuard = _startPassGuard({
        lane: laneMode, commandId: String(command.id), customerId: String(effectiveCustomer.id), customerName: effectiveCustomer.customer_name || null,
        site: batchSite, pass: areaModePasses[k] || null, runId: _batchAudit ? _batchAudit.runId : null,
      });
      try {
        // 修正4: fill-done ウェイターを autofill 発火「前」に作成しておく
        // モーダル操作/ページロードで60秒を超えることがあるため リアプロ90秒・itandi245秒（FILL_DONE_TIMEOUT_MS）
        // customerId を渡して他顧客の遅延 fill-done が誤解決しないよう保護する
        // 自動便の指定をこのお客様×サイトに付けて置く（popup の経路でも bulk-dl・itandi-bulk-dl がページ数・並びを守る）
        // 2026-09-30 v2.5.43 更新日順の一覧で「前回の検索より古い行」で止める線（このお客様×サイトの前回の検索・サーバーの update_days_plan.last_by_site）も載せる。
        //   自動便でない回（web_brain）でも線がある時は置く（ページ数・並びの指定は無い＝bulk-dl は今まで通り）。広げての回・一時調整の回は線を置かない（前回と条件が違う）
        //   同時の回は2本が同じ鍵に書くので、サイトごとに by_site へ並べる（_arMem＝この SW の中の写し・読み直して書く間に片方を消さない）
        //   2026-09-30 v2.5.44 計画が stop_at_last:false の人（新規・条件の言い直し）は last_by_site があっても線を置かない（auto-run.js stopLineAllowed）
        var _uoLast = (!batchIsWide && !searchOverride && self.AxlxUpdateOrderStop && cmdPayload && cmdPayload.update_days_plan && cmdPayload.update_days_plan.by_customer
          && (!_AR || !_AR.stopLineAllowed || _AR.stopLineAllowed(_custPayload)))
          ? self.AxlxUpdateOrderStop.lastSearchFor(cmdPayload.update_days_plan.by_customer[String(effectiveCustomer.id)], batchSite) : null;
        var _arOptsNow = _AR ? (_AR.optsFromPayload(_custPayload) || _autoOpts || (_uoLast ? {} : null)) : null;
        if (_AR && _arOptsNow) {
          _arMem = _AR.withSite(_arMem, _AR.record(effectiveCustomer.id, batchSite, _arOptsNow, Date.now(), { last_search_at: _uoLast }));
          var _arSet = {}; _arSet[_AR.STORAGE_KEY] = _arMem;
          try { await chrome.storage.local.set(_arSet); } catch (_) {}
          if (_uoLast) console.log("[batch] 更新日順なら前回の検索（" + String(_uoLast).slice(0, 16).replace("T", " ") + "）より古い行で止める customer=" + effectiveCustomer.id + " site=" + batchSite);
        }
        var fillDoneP = (batchSite === "itandi" || batchSite === "realnetpro")
          ? _createFillDoneWaiter(batchSite, String(effectiveCustomer.id), _fillDoneTimeoutMs(batchSite))
          : null;
        // _batchAutofill は解決済み条件（itandi_lines 等を含む）を返す
        var resolvedBatchConds = await _passGuard.race(_batchAutofill(effectiveCustomer, batchSite, batchIsWide, _custPayload, _batchAudit), PASS_AUTOFILL_PHASE_MS);
        _watchSet({ waitingFor: batchSite === "reins" ? "レインズの入力" : "検索の完了（fill-done）と全ページの送信" }, batchSite);
        // AIXツールの一括検索も検索日を記録する（拡張の手動の一括と同じ・顧客リストの RP/IT/RE のグリッドが埋まる）
        // 2026-09-27 v2.5.32 竹内「重い順から治す」④: 記録は検索が終わってから（下・失敗した回は記録しない。旧はここで記録し、90秒の時間切れでも「検索した日」が付いた）
        var _passCount = 0;
        if (batchSite === "itandi") {
          // itandi の場合: リアプロと同じく fill-done + batch-customer-done を待つ形に統一
          // itandi-bulk-dl.js の autoSendAllPages が axlx-batch-customer-done シグナルを送信する
          // 2026-09-30 v2.5.42 資料を開く前の見分け（itandi-guard.js）に、このお客様の条件を渡す（一括の回だけ）
          _itandiGuardCtx = {
            customerId: String(effectiveCustomer.id), isWide: batchIsWide, attempt: 0, runId: _batchAudit ? _batchAudit.runId : null,
            cond: { rent_max: effectiveCustomer.rent_max, floor_plan: effectiveCustomer.floor_plan, desired_area: effectiveCustomer.desired_area, area_mode: effectiveCustomer.area_mode },
          };
          _passCount = await _passGuard.race(_scrapeAndSendRealpro(
            fillDoneP,
            String(effectiveCustomer.id),
            effectiveCustomer.customer_name || null,
            resolvedBatchConds || _buildBatchConditions(effectiveCustomer, batchIsWide, _custPayload),
            "itandi",
            _isMultiPass,  // suppressZeroNotify: both顧客は呼び出し元が集計して1回通知
            _batchAudit ? _batchAudit.runId : null,
            self._axlxQueueLoopMeta || null
          ));
          /** ★ 2.8.222: ITANDI 完了直後もパネル把握を「次は外す」へ */
          try {
            var _qlmIt = self._axlxQueueLoopMeta || null;
            if (_qlmIt) {
              await _publishBulkGrasp({
                total: _qlmIt.total,
                index: _qlmIt.index,
                currentName: _qlmIt.currentName || "",
                nextName: _qlmIt.nextName || "",
                names: _qNames,
                nextMove: _qlmIt.nextName ? "前客の選択を1つずつ外す" : "一括完了",
                waitingFor: _qlmIt.nextName ? "次客へ渡す" : "一括完了",
              });
            }
          } catch (_) {}
          // 2026-09-30 v2.5.42 竹内「ITANDI 検索ちゃんとできていなければ、そこ修正するか、修正効かなければ…」:
          //   条件が効いていない形で止めた（資料は1件も開いていない）→ 人が結果を見直す間を置いて、1回だけ条件を入れ直す（連続の再試行はしない）。
          //   直ればそのまま続ける・直らなければこのお客様の ITANDI は見送り＋★物件出し★に1行。原因の分け方はサーバーの点検（itandi_guard:<原因>:<直った/直らない>）
          if (_scrapeOutcomeFor("itandi").guard && _scrapeOutcomeFor("itandi").guard.suspect) {
            _passCount = await _passGuard.race(_itandiGuardRetry({
              customer: effectiveCustomer, isWide: batchIsWide, payload: _custPayload, audit: _batchAudit, first: _scrapeOutcomeFor("itandi").guard, suppressZero: _isMultiPass,
            }));
          }
          _itandiGuardCtx = null;
        } else if (batchSite === "realnetpro") {
          // 修正7: 通常バッチのリアプロ分岐にもスクレイプ→AI比較→LINE送信を追加
          // （従来は autofill + 3秒 sleep のみで結果がどこにも届かなかった）
          _passCount = await _passGuard.race(_scrapeAndSendRealpro(
            fillDoneP,
            String(effectiveCustomer.id),
            effectiveCustomer.customer_name || null,
            resolvedBatchConds || _buildBatchConditions(effectiveCustomer, batchIsWide, _custPayload),
            null,         // siteLabel → "リアプロ" (default)
            _isMultiPass,  // suppressZeroNotify: both顧客は呼び出し元が集計して1回通知
            _batchAudit ? _batchAudit.runId : null,
            self._axlxQueueLoopMeta || null
          ));
          /** ★ 2.8.222: キュー完了直後もパネル把握を「次は外す」へ */
          try {
            var _qlm = self._axlxQueueLoopMeta || null;
            if (_qlm) {
              await _publishBulkGrasp({
                total: _qlm.total,
                index: _qlm.index,
                currentName: _qlm.currentName || "",
                nextName: _qlm.nextName || "",
                names: _qNames,
                nextMove: _qlm.nextName ? "前客の選択を1つずつ外す" : "一括完了",
                waitingFor: _qlm.nextName ? "次客へ渡す" : "一括完了",
              });
            }
          } catch (_) {}
        } else {
          await new Promise(function(r) { setTimeout(r, 2000 + Math.floor(Math.random() * 2000)); });
        }
        _totalPassCount += (_passCount || 0);
        // ここまで来た＝検索を押せた（fill-done を受け取った）。お客様×サイトで1回だけ記録（地域→駅の2パスは先に成功した方で）
        if (isWebBrain && !_searchRecorded) { _searchRecorded = true; _recordBulkSearch(customer, batchSite, batchIsWide); }
        if ((batchSite === "itandi" || batchSite === "realnetpro") && _scrapeOutcomeFor(batchSite).timedOut) _passFailed++;
        // 2026-09-27 v2.5.30: 件数の分からない完了（送信エラー等）は「0件」の集計に入れない
        if ((batchSite === "itandi" || batchSite === "realnetpro") && _scrapeOutcomeFor(batchSite).countUnknown) _passCountUnknown++;
        // レインズは fill-done で閉じる（_auditOnFillDone）。ここで閉じるのはリアプロ・itandi
        if (_batchAudit && batchSite !== "reins") _auditFinish(_batchAudit.runId, {});
        _passGuard.done();
      } catch (e) {
        _passGuard.done();
        _itandiGuardCtx = null; // 2026-09-30 v2.5.42 見分けの条件はこの回だけ（失敗した回の後の手の検索に残さない）
        // ★ 失敗パスでも一連ロックを外す（次客へ移れるように。scrape 内で外済みなら二重で無害）
        try { await _releasePipelineLock("pass_error", effectiveCustomer && effectiveCustomer.id); } catch (_) {}
        _passFailed++;
        // ★ 2.8.128 busy_other_customer（前のお客さんの入力中で断られた）: 一括は止めず、そのお客さんを最後にもう1回だけやり直す
        //   （始める前に前のお客さんの入力が終わるまで待つ＝上限10分）。2回目も断られたら、そのお客さんだけ飛ばして点検に残す。「検索できなかった」の知らせは最終的に諦める時だけ。
        var _bd = null;
        try {
          _bd = self.AxlxCustomerHandoff ? self.AxlxCustomerHandoff.busyRetryDecision(e && e.message, effectiveCustomer.id, _busyRetried) : null;
          if (_bd === "retry") {
            var _again = targets.filter(function (t) { return String(t.id) === String(effectiveCustomer.id); })[0];
            if (_again) targets.push(_again);
            if (_batchAudit) _auditStep(_batchAudit.runId, "busy_retry_queued", "前客の入力中で断られた→一括の最後にもう1回だけやり直す");
          } else if (_bd === "give_up") {
            if (_batchAudit) _auditStep(_batchAudit.runId, "busy_give_up", "2回目も前客の入力中で断られた→このお客さんだけ飛ばす");
          }
        } catch (_) { _bd = null; }
        if (_batchAudit) _auditFinish(_batchAudit.runId, (e && e.passDeadline) ? { error: e, error_kind: "pass_deadline" } : { error: e });
        // Fix 3/4: __BATCH_STOPPED__ は正常なキャンセルなので re-throw して全ループを抜ける
        if (e && e.message === "__BATCH_STOPPED__") {
          console.log("[batch] __BATCH_STOPPED__ 受信 → バッチ中断（" + batchSite + "）");
          return { cancelled: true };
        }
        console.error("[batch] error:", effectiveCustomer.id, batchSite, areaModePasses[k] || "auto", e);
        // 2026-09-29 見張り: 失敗した時の画面（ログインの画面・メンテナンス等）を見張りに聞く（最長8秒）。止める答えなら知らせはサーバーの1通だけ
        if (_batchAudit) await _watchOnPassError(batchSite, effectiveCustomer.id, command.id, _batchAudit.runId, e);
        var _watchStopped = !!(self.AxlxSnapshotCore && self.AxlxSnapshotCore.watchStopApplies(_watchStop, batchSite, Date.now()));
        // 2026-09-27 v2.5.32 竹内「重い順から治す」④: 1パスの回の失敗（fill-done の時間切れ・タブが応答しない・地域が決まらない・例外）を
        //   ピックアップ用グループに1回知らせる（旧は何も送らず、命令が error で閉じるだけ）。地域→駅の2パスは下の集計が1回知らせる。
        //   5分の待ち切れは _scrapeAndSendRealpro が知らせる（投げないのでここには来ない＝2回言わない）
        if (!_isMultiPass && self.AxlxBatchGuard && !_watchStopped && _bd !== "retry") {
          var _failText = self.AxlxBatchGuard.failureNotice({
            customerName: customer.customer_name,
            siteLabel: batchSite === "itandi" ? "itandi" : batchSite === "reins" ? "レインズ" : "リアプロ",
            error: e,
          });
          if (_failText) {
            fetch(SUMORA_BATCH_API + "/api/notify-group", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: _failText, group_key: "pickup_group_id" })
            }).catch(function() {});
          }
        }
        batchErrors.push(effectiveCustomer.id + "/" + batchSite + "/" + (areaModePasses[k] || "auto") + ": " + ((e && e.message) || e));
      }
    }
    // B3修正: area_mode='both' で全パス合計0件の場合のみ1回だけ通知（重複送信防止）
    if (_isMultiPass && _totalPassCount === 0 && _passCountUnknown === 0 && customer.customer_name) {
      var _bothSiteLabel = batchSite === "itandi" ? "itandi" : "リアプロ";
      // 2026-09-25: 全パスが失敗・待ち切れなら「0件」ではなく「検索できなかった」（0件とは限らない）
      var _bothText = _passFailed >= areaModePasses.length
        ? "⚠【検索できなかった】" + customer.customer_name + "さんの" + _bothSiteLabel + "検索が途中で止まりました（0件とは限りません）"
        : "🔍【物件0件】" + customer.customer_name + "さんの" + _bothSiteLabel + "検索が0件でした";
      fetch(SUMORA_BATCH_API + "/api/notify-group", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: _bothText, group_key: "pickup_group_id" })
      }).catch(function() {});
    }
    return { cancelled: false };
  }


  for (var i = 0; i < targets.length; i++) {
    // ストップフラグをチェック（同期フラグを優先、フォールバックで storage も確認）
    if (_batchShouldStop) {
      console.log("[batch] ストップ要求を検知（同期）→ バッチ中断 (処理済み:", i, "/ 全体:", targets.length, ")");
      await _updateBatchCommand(command.id, { status: "cancelled", completed_at: new Date().toISOString() });
      return;
    }
    var _stopSt = await chrome.storage.local.get("batchStopRequested");
    if (_stopSt.batchStopRequested) {
      console.log("[batch] ストップ要求を検知（storage）→ バッチ中断 (処理済み:", i, "/ 全体:", targets.length, ")");
      await _updateBatchCommand(command.id, { status: "cancelled", completed_at: new Date().toISOString() });
      return;
    }
    var customer = searchOverride ? self.AxlxSearchOverride.applyToCustomer(targets[i], searchOverride) : targets[i];
    try {
      var _qg = (self.AxlxBulkPanelGrasp && self.AxlxBulkPanelGrasp.bulkGraspFromQueue)
        ? self.AxlxBulkPanelGrasp.bulkGraspFromQueue(_qNames, i)
        : { total: targets.length, index: i + 1, currentName: _qNames[i], nextName: _qNames[i + 1] || "" };
      _qg.currentId = customer && customer.id != null ? String(customer.id) : "";
      _qg.nextId = targets[i + 1] && targets[i + 1].id != null ? String(targets[i + 1].id) : "";
      _qg.names = _qNames;
      /** ★ 2.8.222: キュー一括も「次の動き」を明示（1人目=入れ／2人目以降=外してから入れ） */
      _qg.nextMove = i === 0 ? "条件を1つずつ入れる" : "前客を外してから入れる";
      _qg.waitingFor = null;
      await _publishBulkGrasp(_qg);
    } catch (_) {}
    /** ★ 2.8.222: _runSiteLane 内 scrape が series_done 後に loop_advance できるよう次客を載せる */
    try {
      self._axlxQueueLoopMeta = {
        currentName: customer.customer_name || "",
        nextName: _qNames[i + 1] || "",
        index: i + 1,
        total: targets.length,
      };
    } catch (_) { try { self._axlxQueueLoopMeta = null; } catch (__) {} }
    // 2.8.125 案B: 最後のお客さんは送付後の外しを待たずに戻す（_scrapeAndSendRealpro が見る）
    try { self._axlxLastCustomerId = (i === targets.length - 1 && customer && customer.id != null) ? String(customer.id) : null; } catch (_) {}
    // 長い一括（午後の便で何人も・リアプロ＋ITANDI）でロックの15分を超えて別のコマンドが並んで走らないよう、お客様ごとに印を新しくする
    try { await chrome.storage.local.set({ batchRunning: { running: true, startedAt: Date.now() } }); } catch (_) {}
    // 自動便: ITANDI のタブが開いていない PC は ITANDI を飛ばす（タブを新しく開かない・失敗と数えない）。お客様ごとに見直す（途中で閉じた・開いた）
    var custSites = sites;
    if (autoSched && _AR) {
      var _sitePlan = _AR.planSites(sites, { isAuto: true, hasItandiTab: _AR.hasItandiTab(await chrome.tabs.query({})) });
      custSites = _sitePlan.sites;
      if (_sitePlan.skipped.length) {
        _autoSkipped.push(String(customer.id));
        console.log("[batch] 自動便: ITANDI のタブが開いていない → ITANDI を飛ばす customer=" + customer.id);
      }
    }
    // 2026-09-30 v2.5.43 竹内「拡張ツールはリアプロと ITANDI を開いているので、同時に動かす形でも大丈夫ならそれで行う」:
    //   このお客様にリアプロと ITANDI の両方がある時、同時に動かせるかを拡張が確かめる（parallel-sites.js decideParallel:
    //   2つのタブが別々の窓・どちらも前面・窓が最小化でない・見えている（visibilityState）・1秒のタイマーが1.5秒以内に戻る）。
    //   満たす時だけ2本（リアプロ・数秒〜十数秒ずらして ITANDI）を並べて走らせ、両方終わる（時間切れ・見送りも）のを待ってから次のお客様へ。
    //   満たさない時は v2.5.42 の順（リアプロ → 人の間 → ITANDI）。理由はログと点検の段（lane_mode）に残す。サイトへのアクセスの数は同じ
    var _lanePlan = await _decideLanes(custSites);
    var _laneNote = self.AxlxParallelSites ? self.AxlxParallelSites.describeDecision(_lanePlan) : null;
    if (_lanePlan.reason !== "single_site") console.log("[batch] " + (_laneNote || _lanePlan.reason) + " customer=" + customer.id);
    if (_lanePlan.parallel) {
      // 上の段は「誰の回か」だけ（帯・心拍）。本ごとの見張りは _startPassGuard（lane）が lanes[site] に置く
      _watchSet({ customerId: String(customer.id), customerName: customer.customer_name || null, site: "realnetpro", pass: null, runId: null, guardId: null, waitingFor: "リアプロ・ITANDI を同時に" });
      _batchWatch.lanes = {};
    } else if (_batchWatch) {
      delete _batchWatch.lanes;
    }
    if (_lanePlan.parallel) {
      var _laneRes = await _runLanesParallel(customer, _runSiteLane, _laneNote);
      if (_laneRes.cancelled || _batchShouldStop) {
        await _updateBatchCommand(command.id, { status: "cancelled", completed_at: new Date().toISOString() });
        return;
      }
      _laneRes.errors.forEach(function (x) { batchErrors.push(x); });
      if (_batchWatch) delete _batchWatch.lanes;
    } else {
      for (var j = 0; j < custSites.length; j++) {
        // Fix 4: サイト間でも同期フラグを確認し、ストップ要求があれば即中断する
        if (_batchShouldStop) {
          console.log("[batch] Fix4: _batchShouldStop 検知 (j=" + j + ") → バッチ中断");
          await _updateBatchCommand(command.id, { status: "cancelled", completed_at: new Date().toISOString() });
          return;
        }
        var batchSite = custSites[j];
        var _stopApplies = !!(self.AxlxSnapshotCore && self.AxlxSnapshotCore.watchStopApplies(_watchStop, batchSite, Date.now()));
        // 2026-09-27 竹内「同じお客様のリアプロと ITANDI は続けて走る…間を人の動きのようにばらつかせる」
        // 2026-09-30 v2.5.42 自動便だけでなく AIXツールの一括検索（1人にリアプロ＋itandi）も同じ間（人が次のサイトのタブに移って見る間・毎回ちがう）
        //   見張りが止めたサイト（見送り）の前には間を置かない（旧と同じ）
        if (j > 0 && _AR && !_stopApplies) {
          var _siteGap = _AR.siteGapMs();
          console.log("[batch] 同じお客様の次のサイト（" + batchSite + "）まで " + _siteGap + "ms");
          await new Promise(function(r) { setTimeout(r, _siteGap); });
          if (_batchShouldStop) {
            await _updateBatchCommand(command.id, { status: "cancelled", completed_at: new Date().toISOString() });
            return;
          }
        }
        var _seqRes = await _runSiteLane(customer, batchSite, false, custSites.length > 1 ? _laneNote : null);
        if (_seqRes && _seqRes.cancelled) {
          await _updateBatchCommand(command.id, { status: "cancelled", completed_at: new Date().toISOString() });
          return;
        }
      }
    }
    await _updateBatchCommand(command.id, { processed_customers: i + 1 });
    // Webアプリタブに顧客完了を通知（リアプロ/itandi/レインズ全サイト対応・バッチ進捗カウンター更新）
    try {
      var _webTabs = await chrome.tabs.query({ url: ["https://sumora-ai-ui.vercel.app/*", "http://localhost:3000/*"] });
      for (var _wi = 0; _wi < _webTabs.length; _wi++) {
        try { await chrome.tabs.sendMessage(_webTabs[_wi].id, { type: "axlx-batch-customer-done" }); } catch (_ignore) {}
      }
    } catch (_ignore) {}
    // 次顧客がいる場合のみ: 人間らしい間隔（3〜8秒ランダム）を挿入
    if (i < targets.length - 1) {
      // 自動便（午後の便は1コマンドで何人も）は人が次のお客様に移る間（多くは15〜60秒・時々一息）。手動の一括は今までどおり
      // 2026-11-10: 自動モードの回は対数正規のペーサー（human-wait.js の createPacer・12操作ごとに休憩）を混ぜる＝等間隔にしない
      var _interCustomerDelay = (autoSched && _AR) ? _AR.customerGapMs() : 3000 + Math.floor(Math.random() * 5000);
      if (_autoModeOn && self.AxlxHumanWait && self.AxlxHumanWait.createPacer) {
        var _pc = _autoPacer || (_autoPacer = self.AxlxHumanWait.createPacer({ baseMs: 900, breakEvery: 12, breakMs: 8000 }));
        var _pcr = _pc.next();
        _interCustomerDelay = Math.max(_interCustomerDelay, _pcr.ms) + (_pcr.isBreak ? _pcr.ms : 0);
        if (_pcr.isBreak) console.log("[batch] 自動モード: 12操作ごとの小休憩をはさむ");
      }
      // 2026-11-10 v2.5.98 竹内さん「人間なので休憩するときもある」:
      //   お客様の区切りで、作業の続き具合から**抽選**して休む（決まった回数ごとではない）。
      //   短い休憩 12〜30秒（20分以上の作業で 8%）／長い休憩 60〜180秒（120分以上で 18%）。
      //   休憩の後は数え直す（人と同じで、休んだらまた最初から）。
      if (_autoModeOn && self.AxlxHumanWait && self.AxlxHumanWait.restDue) {
        var _rest = self.AxlxHumanWait.restDue(_autoWorkedSince || 0, Date.now());
        if (_rest.rest) {
          _interCustomerDelay += _rest.ms;
          _autoWorkedSince = Date.now() + _rest.ms; // 休憩が終わった時点から数え直す
          console.log("[batch] 自動モード: 人の休憩（" + (_rest.kind === "long" ? "長め" : "短め") + " " + Math.round(_rest.ms / 1000) + "秒）をはさむ");
          _watchSet({ waitingFor: "休憩中（" + Math.round(_rest.ms / 1000) + "秒）" });
        }
      }
      console.log("[batch] 次顧客まで待機 " + _interCustomerDelay + "ms");
      _watchSet({ waitingFor: "次のお客様までの間（" + Math.round(_interCustomerDelay / 1000) + "秒）" });
      await new Promise(function(r) { setTimeout(r, _interCustomerDelay); });
    }
  }

  // 修正12: 全件失敗なら status:'error'、一部失敗でも error_message に記録して可視化
  var totalAttempts = _siteAttempts;
  if (batchErrors.length > 0 && batchErrors.length >= totalAttempts && totalAttempts > 0) {
    await _updateBatchCommand(command.id, {
      status: "error",
      error_message: batchErrors.join(" | ").slice(0, 1900),
      completed_at: new Date().toISOString()
    });
    return;
  }
  var doneUpdates = {
    status: "done",
    completed_at: new Date().toISOString()
  };
  if (batchErrors.length > 0) {
    doneUpdates.error_message = "一部失敗: " + batchErrors.join(" | ").slice(0, 1800);
  }
  // 自動便で ITANDI を飛ばした時は記録に残す（失敗ではない）
  var _skipNote = _AR ? _AR.skippedNote(_autoSkipped) : null;
  if (_skipNote) doneUpdates.error_message = (doneUpdates.error_message ? doneUpdates.error_message + " / " : "") + _skipNote;
  // 見張りが止めたサイトで見送ったお客様（失敗ではない・知らせはサーバーの1通）
  if (_watchSkipped.length) doneUpdates.error_message = ((doneUpdates.error_message ? doneUpdates.error_message + " / " : "") + "見張りで見送り（" + (_watchStop ? _watchStop.reason : "") + "）: " + _watchSkipped.join("・")).slice(0, 1900);
  await _updateBatchCommand(command.id, doneUpdates);
}

/**
 * 2026-09-29 v2.5.41 竹内「一度送ったことがある物件はダウンロードもしないようにすれば更に問題なく物件検索できる。人間の動きのように」:
 *   一括検索の1人ごとに、そのお客様に送付済みの部屋（建物名＋号室）を読んで chrome.storage.session に置く。
 *   bulk-dl.js・itandi-bulk-dl.js が一覧で同じ部屋を選ばない（＝資料をダウンロードしない）。
 *   スタッフモードの時は空（スタッフが選んで送る時は1件も減らさない・merge-pdfs と同じ）。読めない時も空＝今まで通り全部選ぶ（検索は止めない）
 */
var _lastSentSkipped = {};
// 2026-09-30 v2.5.43 site を渡すとそのサイトの飛ばした数だけ数え直す（同時の回でもう片方の数を消さない）
async function _loadSentRooms(customerId, site) {
  if (customerId != null) { _lastSentSkipped[String(customerId)] = 0; if (site) _lastSentSkipped[_sentSkipKey(customerId, site)] = 0; }
  var SK = self.AxlxSentSkip;
  if (!SK || customerId == null) return;
  var rec = { customerId: String(customerId), rooms: [], at: Date.now() };
  try {
    if (await isStaffModeOn()) { rec.staff = true; }
    else {
      var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (_) {} }, 6000) : null;
      var headers = await _getAutomationKeyHeader();
      var res = await fetch(SUMORA_BATCH_API + "/api/automation/sent-rooms?customer_id=" + encodeURIComponent(String(customerId)), { headers: headers, signal: ctrl ? ctrl.signal : undefined });
      if (timer) clearTimeout(timer);
      var j = res.ok ? await res.json() : null;
      if (j && Array.isArray(j.rooms)) rec.rooms = j.rooms.slice(0, 3000);
      console.log("[batch] 送付済みの部屋: " + rec.rooms.length + "件（一覧で選ばない・号室の無い送付 " + ((j && j.without_room) || 0) + "件は飛ばさない） customer=" + customerId);
    }
  } catch (e) {
    console.warn("[batch] 送付済みの部屋を読めない（全部選ぶ＝今まで通り）:", e && e.message);
  }
  try { var o = {}; o[SK.STORAGE_KEY] = rec; await chrome.storage.session.set(o); } catch (_) {}
}

/**
 * 2026-09-18 竹内「一括検索したお客さんも項目のところに日付と一括検索した日にちをいれる」:
 *   一括検索でも検索日を記録する（個別検索と同じ search-history.js を使う＝四者同名）。
 *   検索そのものは止めない（記録の失敗はログだけ）。
 */
function _recordBulkSearch(customer, site, isWide) {
  var H = self.AxlxSearchHistory;
  if (!H || !customer || customer.id == null) return;
  H.recordSearch({ customer: customer, site: site, isWide: !!isWide })
    .then(function (r) {
      if (r && r.ok) {
        console.log("[manual-bulk-search] 検索日を記録: " + customer.customer_name + " " + H.historyKey(site, isWide));
      } else {
        console.warn("[manual-bulk-search] 検索日の記録に失敗:", r && r.reason);
      }
    }, function (e) { console.warn("[manual-bulk-search] 検索日の記録に失敗:", e && e.message); });
}

async function _batchAutofill(customer, site, isWide, opts, auditRun) { // opts: コマンドの payload か手動の一括の { rp_update_days }（_buildBatchConditions）
  try { await _learnRefreshForAutofill(); } catch (_) { /* 束が取れなくても入力は続ける */ }
  // auditRun: 検索の点検の { runId, trigger, commandId }（ブレインの時だけ・無ければ null）。popup に渡し、popup を通らない経路では conditions に載せる
  // 2026-11-10 ITANDI の検索は ITANDI の更新日（payload.itandi_update_days）を使う。
  //   読む側（itandi-page-script.js・itandi-guide-plan.js・itandi-update-days.js）は今まで通り cond.rp_update_days を読むので、
  //   ここで ITANDI の値の位置に写す（リアプロ・レインズと混ざらない・キーが無い命令は今まで通りリアプロの値に落ちる）
  if (site === "itandi" && self.AxlxAutoRun && self.AxlxAutoRun.optsForSite) {
    opts = self.AxlxAutoRun.optsForSite(opts, site);
  }
  var siteUrlPrefixes = {
    reins: "https://system.reins.jp",
    itandi: "https://itandibb.com",
    realnetpro: "https://www.realnetpro.com"
  };
  var siteUrls = {
    reins: "https://system.reins.jp/main/PF08/SA08I010.aspx",
    itandi: "https://itandibb.com/rent_rooms/list",
    realnetpro: "https://www.realnetpro.com/main.php"
  };
  var prefix = siteUrlPrefixes[site];
  if (!prefix) return;
  // 2026-09-27 この回がピンポイントか広げてか（送信の callMergeApi が merge-pdfs の search_mode に付ける）
  await _rememberSearchMode(customer && customer.id, site, isWide);

  var allTabs = await chrome.tabs.query({});
  // 2026-09-27 v2.5.32: リアプロは main.php のタブを先に選ぶ（content.js・page-script.js が入るのは main.php だけ。
  //   旧は URL の前方一致の最初のタブ＝ログインの画面や別のページのタブを掴むと、popup は答えてもページが動かず90秒で時間切れ）
  // v2.5.45: ITANDI は検索の一覧（/rent_rooms/list）のタブを先に選ぶ（旧は最初の itandibb.com のタブ＝物件の詳細の画面でも使っていた）
  var existing = (site === "realnetpro" && self.AxlxBatchGuard)
    ? self.AxlxBatchGuard.pickRealproTab(allTabs)
    : (site === "itandi" && self.AxlxBatchGuard && self.AxlxBatchGuard.pickItandiTab)
      ? self.AxlxBatchGuard.pickItandiTab(allTabs)
      : allTabs.find(function(t) { return t.url && t.url.startsWith(prefix); });
  var tab = existing;
  if (!tab) {
    // 2026-11-10 v2.6.23 竹内さん「リアプロやITANDIを勝手に開くのではなくて、開いている状態のところを確認してそこから行う」:
    //   旧はタブが無ければ **勝手に新しいタブを開いて検索**していた。
    //   新は開かない＝このサイトは飛ばす（理由を点検に残す）。人が開いているタブの中でだけ動く。
    console.warn("[batchAutofill] " + site + " のタブが開いていない → 勝手に開かない（このサイトは飛ばす）");
    _auditStep(auditRun && auditRun.runId, "no_tab", site + " のタブが開いていないため開かずに飛ばした（人が開いてから再実行）");
    throw new Error("AXLX_NO_TAB: " + site + " のタブが開いていません（勝手に開かない決まり・人が開いてから実行してください）");
  }
  // 2026-09-27 v2.5.32 竹内「重い順から治す」①: 拡張の読み直し・ログインのし直しの後の動かないタブをそのまま使わない（だめなら開き直す・それでもだめなら検索しない）
  if (site === "realnetpro") tab = await _ensureRealproTab(tab, auditRun, null, customer && customer.id);
  // v2.5.45 ITANDI も同じ: 一覧の画面でない・拡張の読み直しの後で中身が答えないタブは一覧を1回開き直す。それでもだめならこのサイトを飛ばす（理由を残す）
  if (site === "itandi") tab = await _ensureItandiTab(tab, auditRun, customer && customer.id);

  /**
   * ★ 2026-11-15 竹内さん「物件探しの条件を、検索の直前に読み直す件」（依頼2-1・2-2）
   *
   *   ⚠ 背景: 会話からお客様の最新の条件を判断して `property_customers` を更新する流れを Claude が作った。
   *     だが拡張が**古い条件のまま検索**すると、更新が物件出しに効かない。
   *   → **自動検索・AIX モードは、お客様ごとに検索を始める直前に `/api/property-customers` から読み直す**。
   *     ⚠ キャッシュした条件で回さない（`cache: "no-store"`）。
   *   → `updated_at` が**前の検索より新しければ**「条件が変わった」印を画面に出す。
   *
   *   ⚠ 読めなかった時は**今までの条件で続行**する（検索を止めない・理由を残す）。
   *   ⚠ 手動の一括検索でも同じ（人が押した時こそ最新の条件で動くべき）。
   */
  var customer = await _refreshCustomerBeforeSearch(customer, site);
  var conds = _buildBatchConditions(customer, isWide, opts);
  // 2026-09-27 AIXツールのメモの検索の指示（web_brain の回だけ）。customer は呼び出し元で重ね済み（_runBatchSearch）、
  //   popup はお客様の登録の条件から欄を作り直すので、同じ上書きを searchOverride で渡して一時調整の欄に入れさせる（pass は area_mode）
  var _searchOverride = (opts && self.AxlxSearchOverride && self.AxlxSearchOverride.sourceAllows(opts.source)) ? self.AxlxSearchOverride.sanitize(opts.search_override) : null;
  // 検索の点検: page-script が fill-done に audit を載せて返す印（popup を通らない経路でも同じ run に届くように）
  if (auditRun) conds._audit_run_id = auditRun.runId;
  // 2026-09-27 自動便の指定を popup にも渡す（旧は popup の経路に届かず、午後の便でも更新日＝人ごと・AD 順・3ページだった）
  var _autoRunMsg = (self.AxlxAutoRun && opts) ? self.AxlxAutoRun.optsFromPayload(opts) : null;

  // ── itandi 専用: 路線名・エリア名を itandi-page-script.js が使うキー形式に変換 ──
  // itandi-page-script.js は cond.itandi_lines と cond.ward_names を参照する。
  // _buildBatchConditions は cond.lines（リアプロ形式）と cond.areas を返すため変換が必要。
  // 修正: areas に駅名が入る場合（desired_area="鶴橋"など）、ward_names として使うのではなく
  //       _resolveLocalFirst で itandi_lines に変換する必要があるため、常に解決を試みる。
  if (site === "itandi") {
    var hasItandiAreaInput = (conds.areas && conds.areas.length) || (conds.lines && conds.lines.length) || (conds.stations && conds.stations.length);
    if (hasItandiAreaInput) {
      try {
        var resolvedItandi = await _resolveLocalFirst(conds, isWide);
        if (resolvedItandi.itandi_line_names && resolvedItandi.itandi_line_names.length) {
          // 路線解決成功 → 路線・駅モード優先（ward_namesは使わない）
          conds.itandi_lines = resolvedItandi.itandi_line_names;
          if (resolvedItandi.station_names && resolvedItandi.station_names.length) {
            conds.station_names = resolvedItandi.station_names;
          }
          conds.ward_names = null; // 路線モード時は所在地フィルターを無効化
        } else {
          // 路線未解決 → 所在地モード（区・市区町村ベース）
          if (resolvedItandi.ward_names && resolvedItandi.ward_names.length) {
            conds.ward_names = resolvedItandi.ward_names;
          } else if (conds.areas && conds.areas.length) {
            conds.ward_names = conds.areas;
          }
          if (resolvedItandi.detail_ward && (!conds.ward_names || !conds.ward_names.length)) {
            conds.ward_names = [resolvedItandi.detail_ward];
          }
        }
      } catch (e) {
        console.warn("[batchAutofill] itandi resolve失敗（デフォルト条件で続行）:", e.message || e);
        // フォールバック: areas をそのまま ward_names として使用
        if (conds.areas && conds.areas.length) {
          conds.ward_names = conds.areas;
        }
      }
    } else if (conds.areas && conds.areas.length) {
      conds.ward_names = conds.areas;
    }
    // 2026-09-29 v2.5.39 通勤の到達時間で駅を選ぶ（駅＋路線を足し、所在地は使わない）
    if (conds.area_mode !== "ward") _applyCommuteReach(conds, "itandi");
  }

  if (site === "realnetpro") {
    // popup.js 経由で完全条件構築（Dijkstra路線展開・API判定含む）を実行する
    // 個別検索（axlx-webapp-search）と同一フロー: chrome.tabs.sendMessage → underbar.js → popup.js → page-script.js
    // ★ switch-customer を先に送り、resolveLocalFirst はその後実行（フォーム入力を即時開始させるため）
    // 2026-09-27 v2.5.32 竹内「重い順から治す」:
    //   ① 入力を始めた合図（page-script の fill-started）が来ない・switch-customer が届かない時は、タブを読み直して1回だけやり直す
    //      （旧は合図を見ず、ページが動かないまま90秒の fill-done 待ちで時間切れ＝点検 24・26）
    //   ② 代わりの直接入力は、先に地域を決め、地域が空なら検索しない（旧は地域を決める前に条件を渡していた＝区のお客様は場所なしの全件検索の恐れ）
    var _G = self.AxlxBatchGuard;
    var _cidStr = String(customer.id);
    var _runId = auditRun && auditRun.runId;
    var _sendSwitch = function () {
      return new Promise(function(resolve) {
        chrome.tabs.sendMessage(tab.id, {
          type:         "axlx-switch-customer",
          customerId:   _cidStr,
          customerName: customer.customer_name || null,
          site:         "realpro",
          areaMode:     customer.area_mode || null,
          is_wide:      isWide,
          auto_send_all: false,
          // 検索の点検（ブレインの時だけ）: popup が同じ run_id で started（入れようとした条件）を送り、page-script に渡す
          auditRunId:   auditRun ? auditRun.runId : null,
          trigger:      auditRun ? auditRun.trigger : null,
          commandId:    auditRun ? auditRun.commandId : null,
          searchOverride: _searchOverride, // 2026-09-27 その回だけの一時調整（無ければ null）
          autoRun:      _autoRunMsg,     // 2026-09-27 自動便の指定（午後の便の更新日・更新順・ページ数。自動便でなければ null）
        }, function(resp) {
          if (chrome.runtime.lastError) {
            console.warn("[batchAutofill] realnetpro axlx-switch-customer error:", chrome.runtime.lastError.message);
            resolve({ ok: false, why: String(chrome.runtime.lastError.message || "lastError").slice(0, 120), busyCustomerId: null }); return;
          }
          resolve({
            ok: !!(resp && resp.ok),
            why: resp && resp.ok ? null : ("popup: " + ((resp && resp.reason) || "ok=false")),
            busyCustomerId: resp && resp.busyCustomerId ? String(resp.busyCustomerId) : null,
          });
        });
      });
    };
    /**
     * ★ 2026-11-18 竹内さん「お客さん検索中や選択中上書きしないように ちゃんと１人のお客さん完了してから次のお客さんに移るように」:
     *   旧は読み直しの前だけ fillRunning を見ていた（最初の1回目は見ずに次のお客さんを送っていた）。
     *   → 送る前に必ずタブを見て、別のお客さんの入力が進んでいる間は待つ。待ちきれなければ見送る（上書きしない）。
     */
    var _H = self.AxlxCustomerHandoff;
    var _waitT0 = Date.now();
    var _waitNoted = false;
    var _prevSendNoted = false;
    for (;;) {
      var _pv = await _probeRealproTab(tab.id);
      var _hd = _H ? _H.tabHandoffDecision(_pv, _cidStr, Date.now() - _waitT0) : "go";
      /**
       * ★ 2026-11-18 竹内さん「ほかのお客さんの情報が上書きされたりしてしまう」（17:39 平田さんの単発の入力中に Tatsuki さんの一括が入った）:
       *   入力が終わっていても、別のお客さんの一連（検索〜送付）のロックが残っている間は待つ（送付の途中を上書きしない）。
       */
      if (_hd === "go") {
        var _lockJob = null;
        try {
          var _lk = await chrome.storage.local.get("axlx_pipeline_job");
          _lockJob = _lk && _lk.axlx_pipeline_job;
        } catch (_) { _lockJob = null; }
        var _lockOther = !!(_lockJob && _lockJob.customerId && String(_lockJob.customerId) !== String(_cidStr)
          && _pipelineJobLive(_lockJob));
        var _staleLockCid = _lockOther ? _bulkStaleLockCid(_lockJob, _cidStr) : null;
        if (_staleLockCid) {
          _auditStep(_runId, "stale_prev_lock_dropped", "前客 " + _staleLockCid.slice(0, 8) + " は送付完了済み→残っていた鍵を外して進む");
          try { await _withTimeout(_releasePipelineLock("bulk_stale_prev_lock", _staleLockCid), 3000, "stale_prev_lock"); } catch (_) {}
          _lockOther = false;
        }
        if (_lockOther) {
          _hd = (Date.now() - _waitT0) < (_H ? _H.OTHER_FILL_WAIT_MS : 10 * 60 * 1000) ? "wait" : "give_up";
          _pv = Object.assign({}, _pv, { fillCustomerId: _lockJob.customerId });
        }
      }
      /**
       * ★ 2026-11-19 #1530/#1531 竹内さん「連続でお客さん検索する際に…止まらないようにする」:
       *   前客の「入力」が終わっても、検索を押した後の一覧の取得・送付がまだ（前客の点検の回が開いている）なら待つ。
       *   旧は入力が終わった所で次客へ進み、前客の送付は次客の回と照らされて断られていた（owner_mismatch×2→前客は6分で idle_close）。
       */
      if (_hd === "go") {
        try {
          var _ps = await chrome.storage.session.get("axlx_pending_auto_send");
          var _pa = _ps && _ps.axlx_pending_auto_send;
          var _paCid = _pa && _pa.customerId ? String(_pa.customerId) : null;
          if (_paCid && _paCid !== _cidStr && Date.now() - Number(_pa.ts || 0) < 10 * 60 * 1000
            && _auditTracker && _auditTracker.findOpen && _auditTracker.findOpen(_paCid, "realpro")) {
            _hd = (Date.now() - _waitT0) < (_H ? _H.OTHER_FILL_WAIT_MS : 10 * 60 * 1000) ? "wait" : "go";
            _pv = Object.assign({}, _pv, { fillCustomerId: _paCid });
            if (_hd === "wait" && !_prevSendNoted) {
              _prevSendNoted = true;
              _auditStep(_runId, "wait_prev_send", "前客 " + _paCid.slice(0, 8) + " の検索後の取得・送付が終わるまで待つ");
            }
          }
        } catch (_) {}
      }
      if (_pv && _pv.fillCustomerId && String(_pv.fillCustomerId) !== _cidStr) {
        try { _watchSet({ prevCustomerId: String(_pv.fillCustomerId) }, "realnetpro"); } catch (_) {}
      }
      if (_hd === "go") {
        if (_waitNoted) _auditStep(_runId, "wait_prev_customer_done", Math.round((Date.now() - _waitT0) / 1000) + "秒待って前客の入力が終わった");
        try { _watchSet({ prevCustomerId: null }, "realnetpro"); } catch (_) {}
        break;
      }
      if (_hd === "give_up") {
        try { _watchSet({ prevCustomerId: null }, "realnetpro"); } catch (_) {}
        _auditStep(_runId, "wait_prev_customer_give_up", "前客の入力が終わらない cid=" + String(_pv.fillCustomerId || "").slice(0, 8));
        _endFillDoneWaiter("realnetpro", _cidStr, "別客の入力が進行中");
        throw new Error("AXLX_OTHER_FILL_RUNNING: 前のお客さんの条件入力が終わらないため、上書きせず見送ります");
      }
      if (_batchShouldStop) throw new Error("__BATCH_STOPPED__");
      if (!_waitNoted) {
        _waitNoted = true;
        _auditStep(_runId, "wait_prev_customer", "前客の入力中→終わるまで待つ cid=" + String(_pv.fillCustomerId || "").slice(0, 8));
        _watchSet({ waitingFor: "前のお客さんの入力が終わるのを待っています" }, "realnetpro");
      }
      await new Promise(function (r) { setTimeout(r, 2000); });
    }
    // 前に残った「検索した印」を捨て、このお客さんの入力が始まった印を先に置く（入力が始まるまでの間に前の一覧を押させない）
    try {
      await chrome.storage.session.remove(["axlx_pending_auto_send", "axlx_auto_next_page"]);
      await chrome.storage.session.set({ axlx_fill_busy: { at: Date.now(), customerId: _cidStr, why: "batch_customer_start" } });
    } catch (_) {}
    var _startTimeout = _G ? _G.FILL_START_TIMEOUT_MS : 25000;
    var _started = false;
    var _lastKnownRealproUrl = "";
    try {
      var _t0 = await chrome.tabs.get(tab.id);
      _lastKnownRealproUrl = String((_t0 && (_t0.url || _t0.pendingUrl)) || "");
    } catch (_) { _lastKnownRealproUrl = ""; }
    for (var _attempt = 0; _attempt < 2 && !_started; _attempt++) {
      if (_attempt > 0) {
        /**
         * ★ 2026-11-17 次客バグ根本: no_fill_start のたびに tab_reload すると、
         *   別客の fill 中／同客の fill が既に走っているのにページを壊す（DB実測多数）。
         *   → 先に fillRunning を見て、同客なら reload せず続行／別客なら更新しない。
         */
        var _probeBeforeReload = await _probeRealproTab(tab.id);
        if (_probeBeforeReload && _probeBeforeReload.url) _lastKnownRealproUrl = _probeBeforeReload.url;
        if (_probeBeforeReload.fillRunning) {
          if (_probeBeforeReload.fillCustomerId && String(_probeBeforeReload.fillCustomerId) === String(_cidStr)) {
            _auditStep(_runId, "fill_started_inferred", "同客fillRunning→読み直さず続行");
            _started = true;
            break;
          }
          if (_probeBeforeReload.fillCustomerId && String(_probeBeforeReload.fillCustomerId) !== String(_cidStr)) {
            _auditStep(_runId, "reload_skip_other_fill", "別客fill中→強制更新しない cid=" + String(_probeBeforeReload.fillCustomerId).slice(0, 8));
            _endFillDoneWaiter("realnetpro", _cidStr, "別客の入力が進行中");
            throw new Error("AXLX_OTHER_FILL_RUNNING: 別のお客さんの条件入力中のため、ページを更新せず見送ります");
          }
          /**
           * ★ 2026-11-19 (2.8.126) audit 1533→1535（画面更新されて止まった）:
           *   入力中だが**誰の入力か分からない**（番号なし＝人の手動の単発）。旧は上の2つに当たらず読み直しへ進み、
           *   人の入力を壊した。自分の入力は番号付きで始まるので、番号なしの入力中は別の入力＝読み直さず見送る。
           */
          if (!_probeBeforeReload.fillCustomerId) {
            _auditStep(_runId, "reload_skip_unknown_fill", "番号なしのfill中（人の単発など）→強制更新しない");
            _endFillDoneWaiter("realnetpro", _cidStr, "別の入力が進行中");
            throw new Error("AXLX_OTHER_FILL_RUNNING: 別の入力（お客さん不明）が進行中のため、ページを更新せず見送ります");
          }
        }
        /**
         * ★ 2.8.252 audit#1616: message channel closed の直後に page_script_dead 扱いで
         *   裸 main.php へ飛ばすと検索結果も入力中も消える。通路切れは再送が先。
         */
        if (_G && _G.isSwitchChannelError && _G.isSwitchChannelError(_lastWhy)) {
          _auditStep(_runId, "switch_channel_retry", "通路切れ→ページ壊さず再送 " + String(_lastWhy || "").slice(0, 40));
          await new Promise(function (r) { setTimeout(r, 900); });
          _restartFillDoneWaiter("realnetpro", _cidStr);
        } else {
          // 1回だけやり直す: タブを開き直し・fill-done の待ちを数え直してから
          tab = await _ensureRealproTab(
            tab,
            auditRun,
            _lastWhy && /^popup|Receiving end|Could not establish|message channel|asynchronous response/i.test(_lastWhy)
              ? "content_script_dead"
              : "page_script_dead",
            _cidStr,
            _lastKnownRealproUrl,
          );
          _restartFillDoneWaiter("realnetpro", _cidStr);
        }
      }
      // content.js に現在の顧客IDを事前通知（fill-done relay に customerId を付与するため）
      try { await chrome.tabs.sendMessage(tab.id, { type: "axlx-set-fill-customer", customerId: _cidStr }); } catch(_) {}
      /**
       * ★ 2026-11-17: 新客の検索開始時に送る相手（storage）もその客へ揃える。
       *   popup が一連ロック中に次客を選んでいた／未開の時でも、物件保存が前客のままになる抜けを止める。
       */
      try {
        await chrome.storage.local.set({
          current_customer_id: _cidStr,
          current_customer_name: (customer && customer.customer_name) || null,
        });
      } catch (_) {}
      // ★ 2.8.202: 客ごとの思考（決定論）→ 動き計画
      try { await _refreshCustomerThink(customer, auditRun); } catch (_) {}
      // ★ 2.8.126: このラン（お客さん）のマウスの動き計画をAPIから（失敗・遅い時は何もしない）
      try { await _refreshMotionPlan(); } catch (_) {}
      var _startP = _createFillStartWaiter(_cidStr, _startTimeout);
      var _sw = await _sendSwitch();
      // ★ 前客完了直後の競合: popup が pipeline_busy で拒否したら強制解除して1回だけ再送
      //   ⚠ 前客が送付途中（axlx_pipeline_send_hold）の時は強制解除しない＝bulk を壊さない
      if (!_sw.ok && /pipeline_busy/.test(String(_sw.why || ""))) {
        var _sendHold = null;
        try {
          var _hSt = await chrome.storage.local.get("axlx_pipeline_send_hold");
          _sendHold = _sendHoldCid(_hSt && _hSt.axlx_pipeline_send_hold);
        } catch (_) {}
        if (_sendHold) {
          _auditStep(_runId, "pipeline_busy_send_hold", "前客送付途中 cid=" + String(_sendHold).slice(0, 8));
          throw new Error("AXLX_PIPELINE_SEND_HOLD: 前のお客さんの送付が完了していません（batch_timeout・進捗あり）");
        }
        /**
         * ★ 2026-11-18 竹内さん「ほかのお客さんの情報が上書きされたりしてしまう」:
         *   旧はここで別のお客さんのロックを強制解除して再送していた（人が押した単発の入力・送付を上書きした）。
         *   → storage にまだ別のお客さんのロックがあれば解除しない（見送る）。無い時（popup のメモリだけ残り）だけ再送。
         */
        var _busyJob = null;
        try {
          var _bj = await chrome.storage.local.get("axlx_pipeline_job");
          _busyJob = _bj && _bj.axlx_pipeline_job;
        } catch (_) { _busyJob = null; }
        if (_busyJob && _busyJob.customerId && String(_busyJob.customerId) !== String(_cidStr)
            && _pipelineJobLive(_busyJob)) {
          _auditStep(_runId, "pipeline_busy_other", "別客の一連が進行中→上書きせず見送り cid=" + String(_busyJob.customerId).slice(0, 8));
          _endFillDoneWaiter("realnetpro", _cidStr, "別客の一連が進行中");
          throw new Error("AXLX_OTHER_FILL_RUNNING: 別のお客さんの検索〜送付が進行中のため、上書きせず見送ります");
        }
        console.warn("[batchAutofill] realnetpro: pipeline_busy（storage は空）→ 再送（" + (_attempt + 1) + "回目）");
        await new Promise(function (r) { setTimeout(r, 250); });
        _sw = await _sendSwitch();
      }
      var _lastWhy = _sw.why;
      if (_sw.ok) {
        _started = await _startP;
        if (!_started) {
          // fill-started を取りこぼしても、ページ上で同客 fill が走っていれば開始扱い
          try {
            var _probeMiss = await _probeRealproTab(tab.id);
            if (_probeMiss.fillRunning && _probeMiss.fillCustomerId && String(_probeMiss.fillCustomerId) === String(_cidStr)) {
              _auditStep(_runId, "fill_started_inferred", "fill-started未着だが同客fillRunning");
              _started = true;
            }
          } catch (_) {}
        }
        if (!_started) {
          _lastWhy = "fill-started が " + Math.round(_startTimeout / 1000) + "秒来ない";
          console.warn("[batchAutofill] realnetpro: popup は応答したがページが入力を始めない（" + (_attempt + 1) + "回目）");
          _auditStep(_runId, "no_fill_start", (_attempt + 1) + "回目: " + _lastWhy);
        }
      } else {
        _auditStep(_runId, "switch_fail", (_attempt + 1) + "回目: " + (_sw.why || "未応答"));
      }
    }
    if (!_started && _sw && _sw.ok) {
      // popup には届くのにページが2回とも入力を始めない → 検索しない（90秒待たない）
      _endFillDoneWaiter("realnetpro", _cidStr, "入力が始まらない");
      throw new Error("AXLX_NO_FILL_START: リアプロのページが条件の入力を始めませんでした（読み直して1回やり直しても）");
    }
    if (!_started) {
      // フォールバック: underbar.js / popup.js 未応答（読み直した後も）→ 先に地域を決めてから直接 fill
      console.warn("[batchAutofill] realnetpro: axlx-switch-customer 未応答 → 地域を決めてから直接入力");
      _auditStep(_runId, "popup_fallback", "switch-customer 未応答 → 直接入力（" + (_lastWhy || "未応答") + "）");
      await _applyRealproResolved(conds, isWide);
      var _gate = _G ? _G.locationGate(conds) : { ok: true, mode: "unknown" };
      _auditPostIntended(auditRun, site, conds);
      if (!_gate.ok) {
        _auditStep(_runId, "no_location", "希望エリア「" + (customer.desired_area || "") + "」から地域を決められない → 検索しない");
        _endFillDoneWaiter("realnetpro", _cidStr, "地域なし");
        throw new Error("AXLX_NO_LOCATION: 希望エリアから地域を決められないため検索しません（全件検索の防止）");
      }
      var _fbStartP = _createFillStartWaiter(_cidStr, _startTimeout);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        // ★ 2026-11-20: お客さんの番号を付けて渡す（番号無しだと完了の合図が誰の物か分からず、前客の断りも効かない）。
        //   「入力を始めた」合図は page-script が断るかを決めた後に番号付きで出す
        func: function(c, cid) {
          window.postMessage({ from: "aixlinx-fill", conditions: c, customerId: cid || null }, "*");
        },
        args: [conds, _cidStr || null]
      });
      if (!(await _fbStartP)) {
        _endFillDoneWaiter("realnetpro", _cidStr, "直接入力も始まらない");
        throw new Error("AXLX_NO_FILL_START: リアプロのページが条件の入力を始めませんでした（直接入力でも）");
      }
    } else {
      // switch-customer 送信後に _resolveLocalFirst を実行（_scrapeAndSendRealpro 用の条件補完）
      // フォーム入力はすでに popup.js 側で開始済みのため、ここでのAPI呼び出しが遅延しても問題なし
      await _applyRealproResolved(conds, isWide);
    }
  } else if (site === "itandi") {
    // popup.js 経由で完全条件構築（ITANDI_LINE_MAP_FILL・Dijkstra路線展開含む）を実行する
    // リアプロと同一フロー: chrome.tabs.sendMessage → underbar.js → popup.js → itandi-page-script.js
    // itandi-content.js に現在の顧客IDを事前通知（fill-done relay に customerId を付与するため）
    // v2.5.48: itandi-bulk-dl.js もこの合図を受け、自動の送信は「この入力を始めさせたお客様」で送る（popup の今の選択を後から読まない・名前も渡す）
    try { await chrome.tabs.sendMessage(tab.id, { type: "axlx-set-fill-customer", customerId: String(customer.id), customerName: customer.customer_name || null }); } catch(_) {}
    // ★ 2026-11-17: 新客開始時に送る相手 storage を揃える（リアプロと同じ・物件が前客に付く抜け防止）
    try {
      await chrome.storage.local.set({
        current_customer_id: String(customer.id),
        current_customer_name: customer.customer_name || null,
      });
    } catch (_) {}
    var _sendItandiSwitch = function () {
      return new Promise(function(resolve) {
        chrome.tabs.sendMessage(tab.id, {
          type:          "axlx-switch-customer",
          customerId:    String(customer.id),
          customerName:  customer.customer_name || null,
          site:          "itandi",
          areaMode:      customer.area_mode || null,
          is_wide:       isWide,
          auto_send_all: false,
          auditRunId:    auditRun ? auditRun.runId : null,
          trigger:       auditRun ? auditRun.trigger : null,
          commandId:     auditRun ? auditRun.commandId : null,
          searchOverride: _searchOverride, // 2026-09-27 その回だけの一時調整（無ければ null）
          autoRun:       _autoRunMsg,     // 2026-09-27 自動便の指定（自動便でなければ null）
        }, function(resp) {
          if (chrome.runtime.lastError) {
            console.warn("[batchAutofill] itandi axlx-switch-customer error:", chrome.runtime.lastError.message);
            resolve({ ok: false, why: String(chrome.runtime.lastError.message || "lastError").slice(0, 120), busyCustomerId: null }); return;
          }
          resolve({
            ok: !!(resp && resp.ok),
            why: resp && resp.ok ? null : ("popup: " + ((resp && resp.reason) || "ok=false")),
            busyCustomerId: resp && resp.busyCustomerId ? String(resp.busyCustomerId) : null,
          });
        });
      });
    };
    var _itSw = await _sendItandiSwitch();
    if (!_itSw.ok && /pipeline_busy/.test(String(_itSw.why || ""))) {
      var _itSendHold = null;
      try {
        var _itHSt = await chrome.storage.local.get("axlx_pipeline_send_hold");
        _itSendHold = _sendHoldCid(_itHSt && _itHSt.axlx_pipeline_send_hold);
      } catch (_) {}
      if (_itSendHold) {
        throw new Error("AXLX_PIPELINE_SEND_HOLD: 前のお客さんの送付が完了していません（batch_timeout・進捗あり）");
      }
      // ★ 2026-11-18: リアプロと同じく、別のお客さんのロックが残っている間は強制解除しない（上書きしない）
      var _itBusyJob = null;
      try {
        var _itBj = await chrome.storage.local.get("axlx_pipeline_job");
        _itBusyJob = _itBj && _itBj.axlx_pipeline_job;
      } catch (_) { _itBusyJob = null; }
      if (_itBusyJob && _itBusyJob.customerId && String(_itBusyJob.customerId) !== String(customer && customer.id)
          && _pipelineJobLive(_itBusyJob)) {
        throw new Error("AXLX_OTHER_FILL_RUNNING: 別のお客さんの検索〜送付が進行中のため、上書きせず見送ります");
      }
      console.warn("[batchAutofill] itandi: pipeline_busy（storage は空）→ 再送");
      await new Promise(function (r) { setTimeout(r, 250); });
      _itSw = await _sendItandiSwitch();
    }
    var batchItandiSwitched = !!(_itSw && _itSw.ok);
    if (!batchItandiSwitched) {
      // フォールバック: underbar.js / popup.js 未応答 → 解決済み条件で直接 fill
      console.warn("[batchAutofill] itandi: axlx-switch-customer 未応答 → direct fallback");
      _auditStep(auditRun && auditRun.runId, "popup_fallback", "switch-customer 未応答 → 直接入力");
      _auditPostIntended(auditRun, site, conds);
      var itandiFbSent = await new Promise(function(resolve) {
        chrome.tabs.sendMessage(tab.id, { type: "axlx-itandi-autofill", conditions: conds }, function(resp) {
          resolve(!chrome.runtime.lastError && !!(resp && resp.ok));
        });
      });
      if (!itandiFbSent) {
        console.warn("[batchAutofill] itandi sendMessage未確認, executeScript fallback");
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: function(c) {
            window.postMessage({ from: "axlx-itandi-autofill-initiated" }, "*");
            window.postMessage({ from: "axlx-itandi-fill-exec", conditions: c }, "*");
          },
          args: [conds]
        });
      }
    }
  } else {
    // reins
    _auditPostIntended(auditRun, site, conds);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: function(c) { window.dispatchEvent(new CustomEvent("axlx-reins-fill", { detail: c })); },
      args: [conds]
    });
  }
  // 解決済み条件を返す（呼び出し元でスクレイプ+比較に再利用できるようにする）
  return conds;
}

// リアプロの場所（区のコード・路線・駅・詳細の区）を決めて conds に入れる（旧は _batchAutofill の中にあった物を1つに）。
//   2026-09-27 v2.5.32: 直接入力の経路はこれを「条件をページへ渡す前」に呼ぶ（地域が空なら locationGate で検索しない）
async function _applyRealproResolved(conds, isWide) {
  if (!((conds.areas && conds.areas.length) || (conds.lines && conds.lines.length) || (conds.stations && conds.stations.length))) return conds;
  try {
    var r = await _resolveLocalFirst(conds, isWide);
    if (r.city_codes && r.city_codes.length) conds.city_codes = r.city_codes;
    if (r.route_ids && r.route_ids.length) conds.route_ids = r.route_ids;
    if (r.station_names && r.station_names.length) conds.station_names = r.station_names;
    if (r.detail_ward) conds.detail_ward = r.detail_ward;
  } catch (e) {
    console.warn("[batchAutofill] realnetpro resolve失敗（デフォルト条件で続行）:", e.message || e);
  }
  _applyCommuteReach(conds, "realpro");
  return conds;
}

// 2026-09-29 v2.5.39 直接入力の経路（popup が応答しない時の代わり）でも通勤の到達時間で駅を選ぶ（popup.js planCommuteReachFor と同じ決め方）。
//   通勤の列（commute_station・commute_minutes）と希望エリアの文から、目的の駅に N 分以内（乗り換え1回まで）で着く駅を拡張の辞書の駅名で足し、
//   リアプロは駅の沿線（route_ids）・itandi は路線（itandi_lines）も足す。手で駅を指定した条件（stations）は広げない。読めない時は何もしない
function _applyCommuteReach(conds, site) {
  try {
    var T = self.AxlxOsakaTransit, Rc = self.AxlxCommuteReach, R = globalThis.SUMORA_RESOLUTION;
    if (!T || !Rc || !R || !conds) return null;
    if (conds.stations && conds.stations.length) return null;
    var plan = Rc.planCommuteReach(
      { commute_station: conds.commute_station || null, commute_minutes: conds.commute_minutes || null, desired_area: conds.desired_area || (conds.areas || []).join("・") },
      T,
      { extLinesOf: function (w) { return R.STATION_LINE_MAP[w] || null; }, lineOrderOf: function (l) { return R.LINE_STATION_ORDER[l] || []; } }
    );
    if (!plan) return null;
    conds.commute = Rc.reachAudit(plan);
    if (!plan.extStations.length) { console.log("[bg] 通勤の条件はあるが駅は広げない(" + site + "): " + Rc.reachSummary(plan)); return plan; }
    var st = (conds.station_names || []).slice();
    plan.extStations.forEach(function (s) { if (st.indexOf(s) < 0) st.push(s); });
    conds.station_names = st;
    if (site === "realpro") {
      var rid = (conds.route_ids || []).slice();
      plan.lines.forEach(function (l) { var r = R.lineNameToRouteId(l); if (r && rid.indexOf(r) < 0) rid.push(r); });
      conds.route_ids = rid;
    } else if (site === "itandi") {
      var il = (conds.itandi_lines || []).slice();
      plan.lines.forEach(function (l) {
        var v = R.ITANDI_LINE_MAP_FILL[l];
        (Array.isArray(v) ? v : (v ? [v] : [])).forEach(function (m) { if (il.indexOf(m) < 0) il.push(m); });
      });
      conds.itandi_lines = il;
      conds.ward_names = null; // 路線・駅で検索（所在地は使わない）
    }
    console.log("[bg] 通勤の到達時間で駅を選択(" + site + "): " + Rc.reachSummary(plan));
    return plan;
  } catch (e) {
    console.warn("[bg] 通勤の到達時間の読み取りに失敗（続行）:", (e && e.message) || e);
    return null;
  }
}

// 3つ目の引数 opts はコマンドの payload（または手動の一括検索の { rp_update_days }）。
//   rp_update_days … 出どころを問わず使う（2026-09-25 竹内「更新日も拡張ツールと連動」・web_brain／手動の一括／自動便）
//   sort / max_pages … 自動便（source="auto_schedule"）だけ（手動の一括検索は今までどおり）
//   2026-09-30 v2.5.44 sort / max_pages は auto-run.js optsFromPayload の1か所から（お客様ごとの計画 plan_by_customer[id]・広げての続きの上の sort・max_pages も）。
//     手動の一括検索・AIXツールの一括検索（sort も max_pages も無い）は今まで通り null
/**
 * ★ 2026-11-16 録画: 自動で「敷金・礼金なし」が外れていた。
 *   `_buildBatchConditions` が shikirei_free を送っていなかった（popup の adj 経路だけ付いていた）。
 *   → 顧客メモ／要望文から希望を拾って条件に載せる。
 */
function _detectShikireiFlag(c) {
  try {
    if (!c) return false;
    if (c.shikirei_free === true || c.shikirei_free === "true" || c.shikirei_free === 1) return true;
    if (c.prefer_no_shikirei === true || c.prefer_no_shikirei === "true") return true;
    var text = [
      c.preferences, c.ng_points, c.other_requests, c.property_memo, c.notes,
      c.additional_conditions, c.raw_format_text, c.condition_summary,
    ].filter(Boolean).join(" ");
    return /敷礼なし|敷金[・･]?礼金なし|敷金礼金0|敷金0礼金0|敷0礼0|敷礼0|初期費用.*抑/.test(text);
  } catch (_) { return false; }
}

function _buildBatchConditions(c, isWide, opts) {
  var _arOpts = (self.AxlxAutoRun && opts) ? self.AxlxAutoRun.optsFromPayload(opts) : null;
  var _rpDays = opts && opts.rp_update_days != null ? (Number(opts.rp_update_days) || null) : null;
  // desired_area (文字列) → areas (配列) 変換
  var areaArr = [];
  if (c.areas && c.areas.length) {
    areaArr = c.areas;
  } else if (c.desired_area) {
    areaArr = c.desired_area.split(/[・、,]+/).map(function(s) { return s.trim(); }).filter(Boolean);
  }
  /**
   * ★ 2026-11-15 竹内さん「物件探しの条件を、検索の直前に読み直す件」（依頼2-3）
   *   「検索の条件に、次の2つも並べる: その他の要望（other_requests を「・」で区切った1つずつ）／必須・できれば（requirement_strength）」
   *
   *   ⚠ `other_requests` は**文字列**（例:「ペット可・2階以上・角部屋」）で来る事も、
   *     **配列**で来る事もある（サーバーの形が1つに決まっていない）。
   *   → どちらでも**1つずつの配列**にする（`・` `、` `,` で区切る・空は捨てる・上限12個）。
   *     ⚠ 検索の欄（page-script）はこの配列を「その他の要望」として使う。
   *       ⚠ 使えるかは page-script 側の対応次第（未対応でも**捨てない**＝`other_requests_list` として残す）。
   */
  var otherList = (function () {
    try {
      var v = c.other_requests;
      if (v == null) return [];
      var arr = Array.isArray(v) ? v : String(v).split(/[・、,／\/]+/);
      return arr.map(function (x) { return String(x == null ? "" : x).trim(); })
        .filter(function (x) { return !!x; })
        .filter(function (x, i, a) { return a.indexOf(x) === i; })   // 重複を消す
        .slice(0, 12);
    } catch (_) { return []; }
  })();
  return {
    is_wide: !!isWide, // 修正5: page-script 側の広ロジック（間取り拡張等）に伝搬
    // 2026-09-29 v2.5.39 通勤の到達時間で駅を選ぶ材料（_applyCommuteReach が読む。page-script は使わない）
    commute_station: c.commute_station || null,
    commute_minutes: c.commute_minutes || null,
    desired_area: c.desired_area || null,
    area_mode: (c.area_mode === 'both') ? null : (c.area_mode || null), // 'both'はnull(自動判定)にフォールバック
    rent_max: c.rent_max || null,
    requirement_strength: c.requirement_strength || null, // v2.5.79 広げて検索でも家賃の上限を上げない「必ず」の印（resolution-core）
    /**
     * ★ 2026-11-15 依頼2-3: その他の要望を**1つずつの配列**で渡す（検索の条件に並べる）。
     *   ⚠ `other_requests`（元の文字列）も残す（page-script が今まで通り読めるように）。
     */
    other_requests: c.other_requests || null,
    other_requests_list: otherList,
    rent_min: c.rent_min_search || c.rent_min || null, // 2026-10-02 ⑫ 書いた下限・無ければ上限から出したおおよその下限（サーバーの rent_min_search）
    walk_minutes: c.walk_minutes || null,
    building_age: c.building_age || null,
    floor_plan: c.floor_plan || null,
    areas: areaArr,
    lines: c.lines || [],
    stations: c.stations || [],
    prefecture: c.prefecture || null,
    city: c.city || null,
    // 2026-09-19 竹内: 自動便だけ更新日・並び順・ページ数を指定する（手動の一括検索は null＝今までどおり）
    //   更新日は page-script.js が select[name="update_date"] に入れる（個別検索と同じ欄）
    //   v2.5.34: ITANDI の直接入力の経路でも同じ値を itandi-page-script.js が「募集条件更新 N日以内」の欄に打つ（null＝空のまま）
    rp_update_days: _rpDays,
    sort_order: _arOpts ? (_arOpts.sort || null) : null,
    max_pages: _arOpts ? (_arOpts.max_pages || null) : null,
    /**
     * ★ 2026-11-16: 自動バッチでも敷礼なしを載せる（旧は欠落 → 画面で未チェック）。
     */
    shikirei_free: _detectShikireiFlag(c),
    prefer_no_shikirei: _detectShikireiFlag(c),
    pet_ok: !!(c.pet === true || c.pet === "true" || c.pet === 1),
    structure_types: (function () {
      try {
        if (Array.isArray(c.structure_types)) return c.structure_types;
        if (typeof c.structure_types === "string" && c.structure_types.trim()) {
          return c.structure_types.split(/[,、・\/\.\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
        }
      } catch (_) {}
      return [];
    })(),
  };
}

/**
 * ★ 2026-11-15 竹内さん「物件探しの条件を、検索の直前に読み直す件」（依頼2）
 *
 *   ⚠ 背景: 会話からお客様の最新の条件を判断して `property_customers` を更新する流れを Claude が作った。
 *     だが拡張が**古い条件のまま検索**すると、更新が物件出しに効かない。
 *   → 検索を始める直前に、その人の行だけ読み直す（`?id=<id>` が使えるならそれ・無ければ一覧から拾う）。
 *
 *   何をするか:
 *     ① `cache: "no-store"` で読み直す（キャッシュを使わない）
 *     ② `updated_at` が**前の検索より新しければ**「条件が変わった」印を画面に出す
 *        （`_nudge` があればそこに・無ければ console）
 *     ③ 読めなければ**今までの条件で続行**（検索を止めない・理由を残す）
 *
 *   ⚠ 返すのは**顧客オブジェクト**（読めなければ元の物をそのまま返す）。
 *   ⚠ 条件の中身（賃料・エリア等）はサーバーが作った物をそのまま使う（拡張で作り直さない）。
 *
 * @param {object|null} c いま使っている顧客
 * @param {string} site サイト名（印を出す時の文言用）
 * @returns {Promise<object|null>} 読み直した顧客（失敗時は元の物）
 */
/**
 * ★ 2026-11-20 竹内さん「連続でお客さんちゃんと検索できるように」:
 *   顧客一覧（/api/property-customers）は1回失敗すると一括・バッチ全体が「顧客データ取得失敗」で止まっていた
 *   （Vercel の起き上がり・DB が一瞬重い時）。→ 最大3回・間を空けて取り直す。待ちは1回 25 秒まで。
 *   ⚠ 4xx（要求の誤り）は取り直さない。
 */
/** 一連ロック（axlx_pipeline_job）が生きているか。popup.js の _axPipelineExpired と同じ決まり（最後の進みから12分・開始から30分で必ず切れる） */
function _pipelineJobLive(job) {
  if (!job) return false;
  var st = Number(job.startedAt || 0);
  var last = Math.max(st, Number(job.touchedAt || 0));
  var now = Date.now();
  return now - last < 12 * 60 * 1000 && now - st < 30 * 60 * 1000;
}

async function _fetchCustomerListWithRetry(url, tag) {
  var lastErr = null;
  for (var _t = 1; _t <= 3; _t++) {
    try {
      var _opt = { cache: "no-store" };
      try { if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) _opt.signal = AbortSignal.timeout(25000); } catch (_) {}
      var r = await fetch(url, _opt);
      if (r.ok) {
        if (_t > 1) console.log("[customers] " + (tag || "") + " " + _t + "回目で取れました");
        return r;
      }
      lastErr = new Error("顧客データ取得失敗（HTTP " + r.status + "）");
      if (r.status >= 400 && r.status < 500) break;
    } catch (e) {
      lastErr = e;
    }
    console.warn("[customers] " + (tag || "") + " 顧客一覧の取得 " + _t + "回目失敗 → " + (_t < 3 ? "取り直します" : "あきらめます"), String(lastErr && lastErr.message || lastErr));
    if (_t < 3) await new Promise(function (res) { setTimeout(res, _t === 1 ? 2500 : 6000); });
  }
  throw (lastErr instanceof Error) ? lastErr : new Error("顧客データ取得失敗");
}

async function _refreshCustomerBeforeSearch(c, site) {
  try {
    if (!c || c.id == null) return c;
    var id = String(c.id);
    var url = "https://sumora-ai-ui.vercel.app/api/property-customers?id=" + encodeURIComponent(id) + "&fresh=" + Date.now();
    var res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12000) });
    if (!res.ok) {
      console.warn("[customer] 条件を読み直せませんでした（HTTP " + res.status + "）→ 今までの条件で検索します");
      return c;
    }
    var j = await res.json();
    /**
     * ⚠ API の返す形が「配列」「{customer}」「1件そのもの」のどれでも動くようにする。
     */
    var fresh = null;
    if (Array.isArray(j)) fresh = j.find(function (x) { return x && String(x.id) === id; }) || null;
    else if (j && Array.isArray(j.customers)) fresh = j.customers.find(function (x) { return x && String(x.id) === id; }) || null;
    else if (j && j.customer && String(j.customer.id) === id) fresh = j.customer;
    else if (j && String(j.id) === id) fresh = j;
    if (!fresh) {
      console.warn("[customer] 読み直した中にこのお客様が居ません → 今までの条件で検索します");
      return c;
    }

    /**
     * ② `updated_at` が前より新しければ「条件が変わった」印を出す。
     *   ⚠ 時刻の形が複数ある（ISO・数値）ので `Date.parse` で寄せる。読めなければ印を出さない（誤報しない）。
     */
    var before = Date.parse(String(c.updated_at || "")) || 0;
    var after = Date.parse(String(fresh.updated_at || "")) || 0;
    if (after && before && after > before) {
      var msg = "🔔 条件が変わりました（" + (c.name || fresh.name || "このお客様") + "）→ 新しい条件で検索します";
      console.log("[customer] " + msg + "（" + String(c.updated_at) + " → " + String(fresh.updated_at) + "）");
      try { if (typeof _nudge === "function") _nudge(msg); } catch (_) {}
      /**
       * 点検にも残す（後から「その時 条件が変わっていたか」を確かめられる）。
       *   ⚠ 前後の時刻だけ（条件の中身は入れない）。
       */
      try {
        if (typeof _axlxWorkNote === "function") _axlxWorkNote(msg, Date.now() + 8000);
      } catch (_) {}
    }

    // ③ 新しい条件を返す（読めなかった項目は元の値で埋める＝急に条件が消えないように）
    var merged = {};
    var k;
    for (k in c) { if (Object.prototype.hasOwnProperty.call(c, k)) merged[k] = c[k]; }
    for (k in fresh) { if (Object.prototype.hasOwnProperty.call(fresh, k) && fresh[k] != null) merged[k] = fresh[k]; }
    return merged;
  } catch (e) {
    console.warn("[customer] 条件の読み直しで例外 → 今までの条件で検索します:", (e && e.message) || e);
    return c;
  }
}

function _batchWaitForTabComplete(tabId) {  return new Promise(function(resolve) {
    var resolved = false;
    var listener = function(id, info) {
      if (id === tabId && info.status === "complete" && !resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(function() {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener); // リスナーリーク防止
        resolve();
      }
    }, 15000);
  });
}

// content script 生存確認 ping。応答があれば true、受け手不在・タイムアウト時は false。
// orphaned content.js（拡張リロード後に切断された古い content script）は応答できないため、
// これが「ナビゲーション省略しても安全か」の判定シグナルになる。
async function _pingTab(tabId, timeoutMs) {
  timeoutMs = timeoutMs || 800;
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; resolve(false); } }, timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, { type: "axlx-ping" }, function (resp) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) { resolve(false); return; }
        // 2026-09-27 v2.5.32: リアプロの content.js は ok しか返していなかった（pong だけ見ていて、いつも「応答なし」だった）
        resolve(!!(resp && (resp.pong || resp.ok)));
      });
    } catch (e) {
      if (!done) { done = true; clearTimeout(timer); resolve(false); }
    }
  });
}

// 2026-09-27 v2.5.32 竹内「重い順から治す」: 一括検索の前にリアプロのタブが動くかを確かめる（batch-guard.js realproTabPlan に渡す形）。
//   url: タブの場所／pong: content.js が答えたか／page: page-script.js が答えたか（古い content.js は page を返さない＝null）
async function _probeRealproTab(tabId) {
  var url = "";
  try { var t = await chrome.tabs.get(tabId); url = (t && (t.url || t.pendingUrl)) || ""; } catch (_) { return { url: "", pong: false, page: null, gone: true }; }
  var resp = await new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; resolve(null); } }, 1500);
    try {
      chrome.tabs.sendMessage(tabId, { type: "axlx-ping" }, function (r) {
        if (done) return;
        done = true; clearTimeout(timer);
        if (chrome.runtime.lastError) { resolve({ err: chrome.runtime.lastError.message || "lastError" }); return; }
        resolve(r || null);
      });
    } catch (e) { if (!done) { done = true; clearTimeout(timer); resolve({ err: (e && e.message) || String(e) }); } }
  });
  var pong = !!(resp && !resp.err && (resp.pong || resp.ok));
  return {
    url: url,
    pong: pong,
    page: pong && typeof resp.page === "boolean" ? resp.page : null,
    vis: pong && typeof resp.vis === "string" ? resp.vis : null,
    fillRunning: pong && !!resp.fillRunning,
    fillCustomerId: pong && resp.fillCustomerId ? String(resp.fillCustomerId) : null,
    err: resp && resp.err ? String(resp.err).slice(0, 120) : null,
  };
}

// 背面（hidden）のリアプロのタブを、そのウィンドウの中で前に出す（ウィンドウの前後・最小化は触らない）。
//   2026-09-27 点検 26: 背面のタブは入力に約10分かかり、fill-done の90秒を過ぎてから物件が届いた
// 2026-11-10 v2.5.95 竹内さん「検索できなかったと出た」: ウィンドウが最小化・隠れていると、ページの側のタイマーが
//   止められて入力が進まず、90秒で fill-done が来ない（search_audits cause=error:realpro:fill_timeout / steps=tab_hidden）。
//   前に出しても見えていない時だけ、そのウィンドウを「元の大きさに戻して前に出す」（人が窓を開くのと同じ）。
//   元に戻せなければ今まで通り理由を点検に残して先へ進む（検索はしない・止まらない）
async function _restoreWindowForTab(tabId, runId, siteLabel) {
  try {
    var t = await chrome.tabs.get(tabId);
    if (!t || t.windowId == null) return false;
    var w = await chrome.windows.get(t.windowId);
    if (w && w.state === "minimized") {
      await chrome.windows.update(t.windowId, { state: "normal" });
      _auditStep(runId, "window_restore", (siteLabel || "") + "最小化されていたウィンドウを元に戻した");
    }
    await chrome.windows.update(t.windowId, { focused: true });
    await new Promise(function (r) { setTimeout(r, _settleMs(700)); });
    return true;
  } catch (e) {
    console.warn("[batchAutofill] ウィンドウを戻せない:", e && e.message);
    _auditStep(runId, "window_restore_fail", (siteLabel || "") + String((e && e.message) || e).slice(0, 120));
    return false;
  }
}

async function _bringRealproTabFront(tab, runId, vis) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
    _auditStep(runId, "tab_front", "背面のタブ（" + vis + "）を前に出した");
    await new Promise(function (r) { setTimeout(r, _settleMs(600)); });
    var p = await _probeRealproTab(tab.id);
    if (p.vis === "hidden") {
      _auditStep(runId, "tab_hidden", "前に出しても見えていない（ウィンドウが最小化・隠れている可能性）");
      await _restoreWindowForTab(tab.id, runId, "リアプロ: ");
      var p2 = await _probeRealproTab(tab.id);
      if (p2.vis && p2.vis !== "hidden") _auditStep(runId, "tab_front", "ウィンドウを戻して見えるようになった（" + p2.vis + "）");
    }
  } catch (e) { console.warn("[batchAutofill] タブを前に出せない:", e && e.message); }
}

// 使える状態のリアプロのタブを返す（だめなら読み直して1回だけ確かめ直す）。それでもだめなら投げる（検索しない）
async function _ensureRealproTab(tab, auditRun, why, customerId, lastKnownUrl) {
  var G = self.AxlxBatchGuard;
  var runId = auditRun && auditRun.runId;
  var probe = await _probeRealproTab(tab.id);
  // ★ 2.8.252: probe.url 空のときは直前の main.php URL を引き継ぐ（#1616 no_url→裸遷移を止める）
  if ((!probe.url || !/^https:\/\/(?:www\.)?realnetpro\.com\/main\.php/.test(probe.url)) && lastKnownUrl) {
    probe.lastKnownUrl = String(lastKnownUrl);
  }
  var plan = G ? G.realproTabPlan(probe) : { action: probe.pong ? "use" : "reload", reason: probe.pong ? "alive" : "content_script_dead" };
  if (plan.action === "use" && !why) {
    if (plan.front) await _bringRealproTabFront(tab, runId, probe.vis);
    return tab;
  }
  /**
   * ★ 2.8.141（search_audits 1545）: content.js は答えたのにページが 0.7秒で答えない時は、入力中で忙しいだけのことがある。
   *   旧はすぐ読み直した＝人の自動検索の入力中の画面ごと消し得た。→ 2回まで確かめ直し、それでも答えず人の回が進行中なら読み直さずに見送る。
   */
  if (!why && plan.reason === "page_script_dead" && probe.pong) {
    for (var _rp = 0; _rp < 2; _rp++) {
      await new Promise(function (r) { setTimeout(r, 1200); });
      var _pr = await _probeRealproTab(tab.id);
      var _pl = G ? G.realproTabPlan(_pr) : { action: _pr.pong ? "use" : "reload" };
      if (_pl.action === "use") {
        _auditStep(runId, "tab_check", "ページの答えが遅かっただけ（読み直さない）");
        if (_pl.front) await _bringRealproTabFront(tab, runId, _pr.vis);
        return tab;
      }
      probe = _pr;
    }
    if (G && G.holdReloadForBusyPage && G.holdReloadForBusyPage(probe, _openHumanRun("realpro"))) {
      _auditStep(runId, "tab_reload_hold", "人の自動検索が進行中でページが忙しい → 読み直さずに見送る");
      if (customerId != null) { try { _endFillDoneWaiter("realnetpro", String(customerId), "人の自動検索が進行中"); } catch (_) {} }
      throw new Error("AXLX_OTHER_FILL_RUNNING: 人が始めた自動検索が進行中のため、ページを読み直さず見送ります");
    }
  }
  var reason = why || plan.reason;
  /**
   * 2026-11-16 竹内さん「自動モード途中でページ更新されてトップページに戻ってしまう」:
   *   旧は常に裸の main.php へ `tabs.update` → 検索中でもホーム（トピックス）へ戻って崩れた。
   *   DB実測 05:19 UTC: no_fill_start → tab_reload「ページの入力の仕組みが応答しない」→ トップ。
   *   → main.php* なら **同じ URL を reload**（method=estate 等を残す）。ログイン切れ等だけ裸へ。
   * ★ 2.8.252 #1616: url空でも navigate せず reload（lastKnown優先）。
   */
  if ((!probe.url || !probe.url.length) && lastKnownUrl) probe.lastKnownUrl = String(lastKnownUrl);
  var recover = G && G.realproRecoverNav
    ? G.realproRecoverNav(probe)
    : { method: "reload", url: lastKnownUrl || "https://www.realnetpro.com/main.php", keepSearch: false };
  var howJa = recover.method === "reload"
    ? (recover.keepSearch
      ? "同じ検索画面を読み直し（トップへ戻さない）"
      : (recover.soft ? "URL不明→main.phpを読み直し（裸ナビしない）" : "同じ main.php を読み直し（トップへ飛ばさない）"))
    : "main.php へ移る";
  console.warn("[batchAutofill] リアプロのタブを読み直します: " + reason + "／" + howJa + (probe.err ? "（" + probe.err + "）" : "") + " url=" + String(probe.url || recover.url || "").slice(0, 80));
  _auditStep(runId, "tab_reload", (G ? G.reasonJa(reason) : reason) + "／" + howJa + (probe.err ? " / " + probe.err : ""));
  if (probe.gone) {
    tab = await chrome.tabs.create({ url: recover.url || "https://www.realnetpro.com/main.php", active: false });
  } else if (recover.method === "reload") {
    try {
      if (recover.soft && recover.url && (!probe.url || !/^https:\/\/(?:www\.)?realnetpro\.com\/main\.php/.test(probe.url))) {
        await chrome.tabs.update(tab.id, { url: recover.url });
      } else {
        await chrome.tabs.reload(tab.id);
      }
    } catch (e) {
      console.warn("[batchAutofill] tabs.reload 失敗 → URL維持で update:", e && e.message);
      await chrome.tabs.update(tab.id, { url: recover.url || String(probe.url) || "https://www.realnetpro.com/main.php" });
    }
  } else {
    await chrome.tabs.update(tab.id, { url: recover.url || "https://www.realnetpro.com/main.php" });
  }
  await _batchWaitForTabComplete(tab.id);
  await new Promise(function (r) { setTimeout(r, _settleMs(1800)); });
  var probe2 = await _probeRealproTab(tab.id);
  var plan2 = G ? G.realproTabPlan(probe2) : { action: probe2.pong ? "use" : "reload", reason: "content_script_dead" };
  _auditStep(runId, "tab_check", plan2.action === "use" ? "読み直して応答あり" : "読み直しても " + (G ? G.reasonJa(plan2.reason) : plan2.reason) + " url=" + String(probe2.url).slice(0, 60));
  if (plan2.action !== "use") {
    // ログインが切れていると main.php がログインの画面等に移る（url が main.php でない）
    // v2.5.48: 待ち手（fill-done）を今閉じる（ITANDI と同じ）。旧は飛ばした約90秒後に「fill-done-waiter タイムアウト」が出て
    //   画面の写真を撮り、そのたびにタブを切り替えていた（2026-09-30 YUMA・ログイン切れの PC）
    if (customerId != null) { try { _endFillDoneWaiter("realnetpro", String(customerId), "リアプロのタブが検索の画面でない"); } catch (_) {} }
    throw new Error("AXLX_TAB_DEAD: リアプロのタブが応答しません（読み直しても・" + (G ? G.reasonJa(plan2.reason) : plan2.reason) + "）");
  }
  if (plan2.front) await _bringRealproTabFront(tab, runId, probe2.vis);
  return tab;
}

// v2.5.45 ITANDI のタブを確かめる（itandi-content.js の axlx-ping）。{ url, pong, list, err, gone }
async function _probeItandiTab(tabId) {
  var url = "";
  try { var t = await chrome.tabs.get(tabId); url = (t && (t.url || t.pendingUrl)) || ""; } catch (e) { return { url: "", pong: false, list: null, err: "tab_gone", gone: true }; }
  var resp = await new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; resolve(null); } }, 1500);
    try {
      chrome.tabs.sendMessage(tabId, { type: "axlx-ping" }, function (r) {
        if (done) return;
        done = true; clearTimeout(timer);
        if (chrome.runtime.lastError) { resolve({ err: chrome.runtime.lastError.message || "lastError" }); return; }
        resolve(r || null);
      });
    } catch (e) { if (!done) { done = true; clearTimeout(timer); resolve({ err: (e && e.message) || String(e) }); } }
  });
  var pong = !!(resp && !resp.err && resp.pong);
  return { url: url, pong: pong, list: pong && typeof resp.list === "boolean" ? resp.list : null, vis: pong && typeof resp.vis === "string" ? resp.vis : null, err: resp && resp.err ? String(resp.err).slice(0, 120) : null };
}

// v2.5.48 背面（hidden）の ITANDI のタブを、そのウィンドウの中で前に出す（ウィンドウの前後・最小化は触らない・リアプロの _bringRealproTabFront と同じ）。
//   2026-09-30 YUMA（順の回・lane_mode「タブが無い（itandi）」）: 背面のまま資料を3件取った所で「物件資料出力」の窓が開いたまま止まり、5分無進捗で終わった。
//   同時の回は2つの窓でどちらも前面の時だけ（parallel-sites.js）なので、ここで前に出すのは順の回（リアプロは終わっている）
async function _bringItandiTabFront(tab, runId, vis) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
    _auditStep(runId, "tab_front", "ITANDI: 背面のタブ（" + vis + "）を前に出した");
    await new Promise(function (r) { setTimeout(r, _settleMs(600)); });
    var p = await _probeItandiTab(tab.id);
    if (p.vis === "hidden") {
      _auditStep(runId, "tab_hidden", "ITANDI: 前に出しても見えていない（ウィンドウが最小化・隠れている可能性）");
      // 2026-11-10 v2.5.95: 最小化なら元に戻して前に出す（リアプロと同じ）
      await _restoreWindowForTab(tab.id, runId, "ITANDI: ");
      var p2 = await _probeItandiTab(tab.id);
      if (p2.vis && p2.vis !== "hidden") _auditStep(runId, "tab_front", "ITANDI: ウィンドウを戻して見えるようになった（" + p2.vis + "）");
    }
  } catch (e) { console.warn("[batchAutofill] ITANDI のタブを前に出せない:", e && e.message); }
}

// 使える状態の ITANDI のタブを返す。だめなら一覧（/rent_rooms/list）を1回だけ開き直す（人がブックマークから一覧を開く形・読み直しを連打しない）。
//   それでもだめ（ログインの画面に移る等）なら投げる → このお客様の ITANDI だけ飛ばし、失敗の知らせと点検に理由が残る
async function _ensureItandiTab(tab, auditRun, customerId) {
  var G = self.AxlxBatchGuard;
  if (!G || !G.itandiTabPlan) return tab;
  var runId = auditRun && auditRun.runId;
  var probe = await _probeItandiTab(tab.id);
  var plan = G.itandiTabPlan(probe);
  if (plan.action === "use") {
    if (plan.front) await _bringItandiTabFront(tab, runId, probe.vis);
    return tab;
  }
  console.warn("[batchAutofill] ITANDI のタブを一覧に戻します: " + G.reasonJa(plan.reason) + (probe.err ? "（" + probe.err + "）" : "") + " url=" + String(probe.url).slice(0, 80));
  _auditStep(runId, "tab_reload", "ITANDI: " + G.reasonJa(plan.reason) + (probe.err ? " / " + probe.err : ""));
  if (probe.gone) {
    tab = await chrome.tabs.create({ url: "https://itandibb.com/rent_rooms/list", active: false });
  } else {
    await chrome.tabs.update(tab.id, { url: "https://itandibb.com/rent_rooms/list" });
  }
  await _batchWaitForTabComplete(tab.id);
  await new Promise(function (r) { setTimeout(r, _settleMs(2200)); });
  var probe2 = await _probeItandiTab(tab.id);
  var plan2 = G.itandiTabPlan(probe2);
  _auditStep(runId, "tab_check", plan2.action === "use" ? "ITANDI: 一覧を開き直して応答あり" : "ITANDI: 開き直しても " + G.reasonJa(plan2.reason) + " url=" + String(probe2.url).slice(0, 60));
  if (plan2.action !== "use") {
    // 待ち手（fill-done）を今閉じる（245秒の時間切れ・その写真を出さない）
    if (customerId != null) { try { _endFillDoneWaiter("itandi", String(customerId), "ITANDI のタブが検索の画面でない"); } catch (_) {} }
    throw new Error("AXLX_TAB_DEAD: ITANDI のタブが検索の画面になりません（開き直しても・" + G.reasonJa(plan2.reason) + "）");
  }
  if (plan2.front) await _bringItandiTabFront(tab, runId, probe2.vis);
  return tab;
}

async function _webappAutofill(site, conditions) {
  console.log("[webapp-autofill] ▶ 開始 site=" + site);
  try { await _learnRefreshForAutofill(); } catch (_) {}
  var siteUrlPrefixes = {
    realnetpro: "https://www.realnetpro.com",
    itandi:     "https://itandibb.com",
    reins:      "https://system.reins.jp"
  };
  var siteUrls = {
    realnetpro: "https://www.realnetpro.com/main.php",
    itandi:     "https://itandibb.com/rent_rooms/list",
    reins:      "https://system.reins.jp/main/PF08/SA08I010.aspx"
  };
  var prefix = siteUrlPrefixes[site];
  if (!prefix) { console.warn("[webapp-autofill] 不明なsite:", site); return; }

  var allTabs = await chrome.tabs.query({});
  var existing = allTabs.find(function(t) { return t.url && t.url.startsWith(prefix); });
  // 修正: リアプロは content.js/page-script.js が main.php* にしか注入されない。
  // ログイン画面等 main.php 以外のタブを掴むと条件送信が無音消失するため、
  // main.php タブを優先し、無ければ既存タブを main.php へナビゲートしてから使う。
  if (site === "realnetpro") {
    var mainTab = allTabs.find(function(t) { return t.url && t.url.includes("realnetpro.com/main.php"); });
    var targetRealTab = mainTab || existing;
    if (targetRealTab) {
      /**
       * 2026-11-16 竹内さん「自動途中でトップに戻る」:
       *   旧は**毎回**裸の main.php へ飛ばしていた → 検索中にホームへ戻って崩れた。
       *   → すでに検索の画面（estate/building）なら **同じ URL を reload**（トップへ戻さない）。
       *     フォーム折りたたみは page-script 側の「検索条件を表示」で展開する。
       *   main.php 以外だけ裸の main.php へ移る。
       */
      var _tu = String(targetRealTab.url || "");
      var _onMain = /realnetpro\.com\/main\.php/.test(_tu);
      var _onSearch = /[?&](?:method=estate|display=building)/.test(_tu);
      if (_onMain && _onSearch) {
        console.log("[webapp-autofill] 検索画面のまま読み直し（トップへ戻さない）", targetRealTab.id, _tu.slice(0, 80));
        try { await chrome.tabs.reload(targetRealTab.id); } catch (_) {
          await chrome.tabs.update(targetRealTab.id, { url: _tu, active: true });
        }
        await chrome.tabs.update(targetRealTab.id, { active: true });
        await _batchWaitForTabComplete(targetRealTab.id);
        await new Promise(function(r) { setTimeout(r, 1800 + Math.floor(Math.random() * 900)); });
      } else if (_onMain) {
        // ホーム（裸 main.php）でもフォームクリーンのために同じ URL を reload（クエリを捨てない）
        console.log("[webapp-autofill] main.php を読み直し（裸へ飛ばさない）", targetRealTab.id);
        try { await chrome.tabs.reload(targetRealTab.id); } catch (_) {
          await chrome.tabs.update(targetRealTab.id, { url: _tu || siteUrls.realnetpro, active: true });
        }
        await chrome.tabs.update(targetRealTab.id, { active: true });
        await _batchWaitForTabComplete(targetRealTab.id);
        await new Promise(function(r) { setTimeout(r, 1800 + Math.floor(Math.random() * 900)); });
      } else {
        console.log("[webapp-autofill] → main.php にナビゲート（main.php以外から）", targetRealTab.id);
        await chrome.tabs.update(targetRealTab.id, { url: siteUrls.realnetpro, active: true });
        await _batchWaitForTabComplete(targetRealTab.id);
        await new Promise(function(r) { setTimeout(r, 1800 + Math.floor(Math.random() * 900)); });
      }
      existing = targetRealTab;
    }
  }
  var tab = existing;
  if (!tab) {
    // タブが存在しない: 新規作成してフォアグラウンドで開く
    tab = await chrome.tabs.create({ url: siteUrls[site], active: true });
    await _batchWaitForTabComplete(tab.id);
    await new Promise(function(r) { setTimeout(r, 1800 + Math.floor(Math.random() * 900)); });
  } else if (site !== "realnetpro") {
    // タブが存在する: フォアグラウンドに切り替え（realnetpro は上でナビゲート・待機済み）
    // ping が通れば content script は生きているので待機を 1500ms → 300ms に短縮
    await chrome.tabs.update(tab.id, { active: true });
    var alive2 = await _pingTab(tab.id, 800);
    await new Promise(function(r) { setTimeout(r, _settleMs(alive2 ? 300 : 1500)); });
  }

  // 修正: タブ準備後にURLを再取得して検証する。
  // リアプロは未ログインだと main.php がログイン画面（別URL）へリダイレクトされ、
  // content.js（main.php* 限定注入）も page-script.js も不在になり、
  // sendMessage / executeScript とも無音失敗して「条件が反映されない」原因になっていた。
  try {
    tab = await chrome.tabs.get(tab.id);
  } catch (tabErr) {
    throw new Error("autofill failed (" + site + "): タブが閉じられました");
  }
  if (site === "realnetpro" && !(tab.url && tab.url.includes("realnetpro.com/main.php"))) {
    throw new Error(
      "リアプロが未ログインです（main.php 以外へリダイレクト）。実行PCのChromeでリアプロにログインしてから再実行してください (現URL: " +
      (tab.url || "不明") + ")"
    );
  }

  // sendMessage 優先（executeScript の world:"MAIN" はホスト権限エラーが出やすいため）
  console.log("[webapp-autofill] ▶ tab確定 id=" + tab.id + " url=" + tab.url);
  var msgType = site === "realnetpro" ? "axlx-realnetpro-autofill"
              : site === "reins"      ? "axlx-reins-autofill"
              :                        "axlx-itandi-autofill";
  // 修正: リダイレクト直後は content script のリスナー登録が間に合わないことがあるため
  // 1回で諦めず 1.5秒間隔で最大3回リトライする
  var sent = false;
  for (var sendAttempt = 0; sendAttempt < 3 && !sent; sendAttempt++) {
    if (sendAttempt > 0) {
      await new Promise(function(r) { setTimeout(r, 1200 + Math.floor(Math.random() * 800)); });
      console.warn("[webapp-autofill] sendMessage retry " + sendAttempt + " for " + site);
    }
    sent = await new Promise(function(resolve) {
      chrome.tabs.sendMessage(tab.id, { type: msgType, conditions: conditions }, function(resp) {
        if (chrome.runtime.lastError) {
          console.warn("[webapp-autofill] attempt" + sendAttempt + " lastError:", chrome.runtime.lastError.message);
          resolve(false); return;
        }
        console.log("[webapp-autofill] ✔ sendMessage成功 attempt=" + sendAttempt);
        resolve(true);
      });
    });
  }

  if (!sent) {
    // 修正: リアプロは page-script.js を content.js が注入する構造のため、
    // content.js 不在タブへの executeScript(postMessage) は受け手ゼロで無音消失する。
    // フォールバックせず原因が分かるメッセージで throw する。
    if (site === "realnetpro") {
      throw new Error(
        "autofill failed (realnetpro): content.js が3回とも応答しませんでした。" +
        "リアプロタブの再読み込み、または拡張の再読み込みを試してください (URL: " + (tab.url || "不明") + ")"
      );
    }
    // itandi / reins は従来どおり executeScript にフォールバック
    // 修正: フォールバックも失敗したら throw して呼び出し元が status:'error' を記録できるようにする
    console.warn("[webapp-autofill] sendMessage failed, fallback to executeScript for", site);
    try {
      var evName = site === "reins" ? "axlx-reins-fill" : "axlx-itandi-fill";
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: function(name, c) { window.dispatchEvent(new CustomEvent(name, { detail: c })); },
        args: [evName, conditions]
      });
    } catch (fallbackErr) {
      throw new Error("autofill failed (" + site + "): sendMessage失敗 + executeScriptフォールバック失敗: " +
        ((fallbackErr && fallbackErr.message) || fallbackErr));
    }
  }
}

async function _updateBatchCommand(id, updates) {
  try {
    // 修正9: 10秒タイムアウト / 修正10: 共有シークレットヘッダー
    var keyHeader = await _getAutomationKeyHeader();
    var resp = await fetch(SUMORA_BATCH_API + "/api/automation/update", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, keyHeader),
      body: JSON.stringify(Object.assign({ id: id }, updates)),
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) {
      var txt = "";
      try { txt = await resp.text(); } catch (_) {}
      console.error("[batch] update HTTP error", resp.status, txt);
    }
  } catch (e) {
    console.error("[batch] update error:", e);
  }
}

// ===== スクレイピング支援関数 =====

// リアプロのタブに axlx-scrape-realpro メッセージを送り、物件配列を受け取る
// 修正12: 応答不能（content script不在・拡張リロード等）は {error: message} を返し、
// 「0件」と「スクレイプ失敗」を区別できるようにする
async function _scrapeRealproPage(tabId) {
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(tabId, { type: "axlx-scrape-realpro" }, function (resp) {
      if (chrome.runtime.lastError || !resp) {
        var errMsg = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "no response";
        console.warn("[scrape] _scrapeRealproPage: no response from tab " + tabId + " (" + errMsg + ")");
        resolve({ error: errMsg });
        return;
      }
      resolve(resp.properties || []);
    });
  });
}

// 「次へ」ボタンをクリック。クリックできた場合は true を返す
async function _clickNextPage(tabId) {
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(tabId, { type: "axlx-click-next-page" }, function (resp) {
      if (chrome.runtime.lastError || !resp) { resolve(false); return; }
      resolve(resp.clicked === true);
    });
  });
}

// 最大 maxPages ページを巡回してすべての物件データを収集する
async function _scrapeAllRealproPages(tabId) {
  var allProperties = [];
  var maxPages = 10; // リアプロは通常 1〜3 ページ。安全マージンで 10 ページ上限
  for (var page = 0; page < maxPages; page++) {
    var props = await _scrapeRealproPage(tabId);
    // 修正12: スクレイプ失敗（error オブジェクト）と0件を区別する
    if (props && props.error) {
      if (page === 0) {
        throw new Error("リアプロスクレイプ失敗: " + props.error);
      }
      console.warn("[scrape] page " + (page + 1) + " scrape error: " + props.error + " → 打ち切り");
      break;
    }
    console.log("[scrape] page " + (page + 1) + ": " + props.length + "件");
    if (props.length === 0) break; // ページに物件がない = 終了
    allProperties = allProperties.concat(props);
    var hasNext = await _clickNextPage(tabId);
    if (!hasNext) break;
    // 次ページ読み込みを待つ
    await new Promise(function (r) { setTimeout(r, _settleMs(2000)); });
  }
  return allProperties;
}

// スクレイプ結果を /api/compare-properties に POST する
async function _sendPropertiesToBackend(properties, customerId, conditions, customerName, site) {
  var body = { properties: properties, customerId: customerId, conditions: conditions };
  if (customerName) body.customerName = customerName;
  if (site) body.site = site;
  // 修正9: サーバー側 maxDuration=120 と整合させ120秒に延長（途中Abort→再送によるLINE二重送信リスクを減らす）
  var resp = await fetch(SUMORA_BATCH_API + "/api/compare-properties", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
  });
  if (!resp.ok) {
    var errText = await resp.text().catch(function () { return ""; });
    throw new Error("compare-properties API error HTTP " + resp.status + ": " + errText.slice(0, 120));
  }
  return resp.json();
}

// 1顧客分のスクレイプ+比較を実行する（scrape_and_compare / property_scrape 共用）
// 両形式に対応:
//   新形式: { customer_id, customer_name, is_wide, conditions }  ← scrape_and_compare
//   旧形式: フル顧客オブジェクト { id, rent_max, ... }           ← property_scrape
async function _scrapeAndCompareForCustomer(customer) {
  var customerId = customer.customer_id || customer.id;
  var customerName = customer.customer_name;
  var isWide = customer.is_wide || false;

  // conditions: 新形式は customer.conditions、旧形式は _buildBatchConditions で構築
  var baseConditions = customer.conditions
    ? customer.conditions
    : _buildBatchConditions(customer);

  // Phase 1: エリア→駅名・路線・区コードの解決（ローカルファースト）
  // 1a: resolveConditionsLocal（popup.jsと同一ロジック・ネットワーク不要）で解決し、
  // 1b: 未解決トークンが残った場合のみ resolve-search-conditions API にフォールバックする。
  // 静的マップで解決できる大多数のケースでは 30秒の DeepSeek 往復が丸ごと消える。
  var resolved = await _resolveLocalFirst(baseConditions, isWide);

  // Phase 2: 解決済み条件をマージしてリアプロを開き条件入力・検索
  // resolve結果が空配列の場合も従来条件を残す（length チェック）
  var mergedStations  = (resolved.station_names && resolved.station_names.length) ? resolved.station_names : (baseConditions.station_names || []);
  var mergedRoutes    = (resolved.route_ids && resolved.route_ids.length)         ? resolved.route_ids     : (baseConditions.route_ids     || []);
  var mergedCityCodes = (resolved.city_codes && resolved.city_codes.length)       ? resolved.city_codes    : (baseConditions.city_codes    || []);
  // 複数区顧客の暫定策: detail_ward は最初の1区しか返らないため、
  // city_codes が2つ以上ある場合は null にして従来の直接チェックボックス法を使う
  var mergedDetailWard = (mergedCityCodes.length >= 2) ? null : (resolved.detail_ward || null);
  var mergedConditions = Object.assign({}, baseConditions, {
    station_names: mergedStations,
    route_ids:     mergedRoutes,
    city_codes:    mergedCityCodes,
    detail_ward:   mergedDetailWard,                  // 所在地モーダル法で必要（例: "大阪市西淀川区"）
    detail_area:   resolved.detail_area || baseConditions.detail_area || null, // 町字ピンポイント選択用
    // itandi / レインズ用路線名もマージ（payload事前解決 or 拡張側resolveのどちらでも揃うように）
    itandi_line_names: (resolved.itandi_line_names && resolved.itandi_line_names.length)
      ? resolved.itandi_line_names : (baseConditions.itandi_line_names || []),
    reins_line_names:  (resolved.reins_line_names && resolved.reins_line_names.length)
      ? resolved.reins_line_names  : (baseConditions.reins_line_names  || []),
    unknown_tokens: (resolved.unknown_tokens && resolved.unknown_tokens.length)
      ? resolved.unknown_tokens : (baseConditions.unknown_tokens || []),
    is_wide:       isWide,
    rent_max:      resolved.rent_max_resolved     || baseConditions.rent_max     || null,
    building_age:  resolved.building_age_resolved || baseConditions.building_age || null,
  });

  // 修正: サイレント全件検索の防止。
  // エリア入力（desired_area / lines / stations）があるのに、resolve後も
  // 駅・路線・区コード・区名がすべて空 = 条件解決失敗。このまま検索すると
  // エリア条件ゼロの全件検索が黙って実行され、無関係物件がAI比較→LINE送信される。
  // 誤送信を防ぐため error として明示的に終了する。
  var hasAreaInput = !!(
    (baseConditions.desired_area && String(baseConditions.desired_area).trim()) ||
    (baseConditions.lines && baseConditions.lines.length) ||
    (baseConditions.stations && baseConditions.stations.length)
  );
  // page-script.js の area_mode suppression と同じロジックでチェックする（guard が suppression後の実態を見るため）
  // 'both' は _buildBatchConditions で null に変換済みのため ここには届かないが念のため null と同等扱い
  var _am = mergedConditions.area_mode;
  var hasAreaResolved = (_am === "ward")
    ? (mergedCityCodes.length > 0 || !!mergedDetailWard)
    : (_am === "station")
      ? (mergedStations.length > 0 || mergedRoutes.length > 0)
      : (mergedStations.length > 0 || mergedRoutes.length > 0 ||
         mergedCityCodes.length > 0 || !!mergedDetailWard); // null/auto/'both'は両方チェック
  if (hasAreaInput && !hasAreaResolved) {
    var utList = (mergedConditions.unknown_tokens || []).join(", ");
    // 検索の点検: 場所が作れず検索をやめた回も記録する（AREA_UNRESOLVED の材料）
    var _naAudit = await _auditBegin({ site: "realnetpro", customer_id: customerId, customer: customer.conditions ? null : customer, trigger: "scrape_compare", is_wide: isWide, area_mode: _am || null, intended: mergedConditions });
    if (_naAudit) _auditFinish(_naAudit.runId, { error: "エリア条件を解決できませんでした（条件なし全件検索を防ぐため中止）", error_kind: "no_area" });
    throw new Error(
      "エリア条件を解決できませんでした（条件なし全件検索を防ぐため中止）。" +
      "desired_area=\"" + (baseConditions.desired_area || "") + "\"" +
      (utList ? " / unknown_tokens: " + utList : " / resolve-search-conditions が空応答")
    );
  }

  // Phase 3〜6: fill-done 待機 → スクレイプ → AI比較+LINE送信
  // 修正4: 固定8秒待ちを廃止。ウェイターは autofill 発火「前」に作成する
  // 検索の点検（ブレインの時だけ）: popup を通らない経路なので、入れようとした条件はここで送り、run_id を conditions に載せる
  var _scAudit = await _auditBegin({
    site: "realnetpro", customer_id: customerId, customer: customer.conditions ? null : customer, trigger: "scrape_compare",
    is_wide: isWide, area_mode: mergedConditions.area_mode || null,
  });
  if (_scAudit) { mergedConditions._audit_run_id = _scAudit.runId; _auditPostIntended(_scAudit, "realnetpro", mergedConditions); }
  var fillDonePromise = _createFillDoneWaiter("realnetpro", customerId, _fillDoneTimeoutMs("realnetpro"));
  try {
    await _webappAutofill("realnetpro", mergedConditions);
    await _scrapeAndSendRealpro(fillDonePromise, customerId, customerName, mergedConditions, null, false, _scAudit ? _scAudit.runId : null);
    if (_scAudit) _auditFinish(_scAudit.runId, {});
  } catch (e) {
    if (_scAudit) _auditFinish(_scAudit.runId, { error: e });
    throw e;
  }
}

// ── リアプロの fill-done 待機 → bulk-dl.js 全ページ送信完了待機 ──
// bulk-dl.js の autoSendAllPages が全ページ送信後に axlx-batch-customer-done を送る。
// background.js はその完了を待ってから次顧客へ移る（ページ競合を防ぐ）。
// suppressZeroNotify=true のとき 0件 LINE通知をスキップし、呼び出し元が集計して1回だけ通知する
// （area_mode='both' の2パス重複通知防止用）
// 2026-09-25: 直前の1回が「5分の待ち切れ」だったか（both の集計で「0件」と「検索できなかった」を分けるため）
/**
 * ★ 2026-11-19 (2.8.126) 竹内さん「動き方もAPIで決めていたら良いのでは」「APIこっちからも作れるように」:
 *   お客さん（ラン）の入力を始める直前に `GET /api/motion-plan` を取り、`axlx_motion_plan` に置く。
 *   → content.js が MAIN world の window.__axlxMotionPlan へ中継 → pointer-ui.js が persona を作り直す（plan_id が変われば新しい個性）。
 *   ・fail-open: 取れない／遅い（1.5秒）／plan:null／止め印 `axlx_motion_plan_off=true` なら何もしない（ローカルの seed で同等に動く）。
 *   ・入力開始を待たせない（最大1.5秒）。DB は使わない軽い API。
 */
async function _refreshMotionPlan() {
  try {
    var _off = await chrome.storage.local.get("axlx_motion_plan_off");
    if (_off && _off.axlx_motion_plan_off === true) return null;
    var _res = await fetch(SUMORA_BATCH_API + "/api/motion-plan", { cache: "no-store", signal: AbortSignal.timeout(1500) });
    if (!_res || !_res.ok) return null;
    var _j = await _res.json();
    var _plan = _j && _j.plan;
    if (!_plan || _plan.v !== 1 || !_plan.plan_id || !_plan.expires_at) return null;
    await chrome.storage.local.set({ axlx_motion_plan: _plan });
    return _plan;
  } catch (_) {
    return null;
  }
}
/**
 * ★ 2.8.202 統括Pro: 新規客ごとの思考（決定論・費用0）。
 *   LLMの統括Proは客ごとにはまだ呼ばない（1客で効果測定してから）。
 *   ここでは場所モード・前客の外し・手順書版ずれを客ごとに決めて監査に残す。
 *   fail-open: API失敗時は拡張内の写しで決める。
 */
async function _refreshCustomerThink(customer, auditRun) {
  var think = null;
  var prevCid = "";
  var prevWant = "";
  var seenRv = "";
  var codeRv = "";
  try {
    var st = await chrome.storage.local.get([
      "axlx_last_filled_cid_mirror",
      "axlx_last_want_mode",
      "axlx_playbook_seen_rv",
      "axlx_playbook_code_rv",
    ]);
    prevCid = String((st && st.axlx_last_filled_cid_mirror) || "");
    prevWant = String((st && st.axlx_last_want_mode) || "");
    seenRv = String((st && st.axlx_playbook_seen_rv) || "");
    codeRv = String((st && st.axlx_playbook_code_rv) || "");
  } catch (_) {}
  var body = {
    customer_id: customer && customer.id,
    area_mode: customer && customer.area_mode,
    desired_area: customer && customer.desired_area,
    prev_cid: prevCid || null,
    prev_want_mode: prevWant || null,
    playbook_seen_rv: seenRv || null,
    code_playbook_rv: codeRv || null,
  };
  try {
    var res = await fetch(SUMORA_BATCH_API + "/api/customer-search-think", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
    if (res && res.ok) {
      var j = await res.json();
      if (j && j.ok && j.think) think = j.think;
    }
  } catch (_) {}
  if (!think && self.AxlxCustomerSearchThink && self.AxlxCustomerSearchThink.thinkCustomerSearch) {
    try {
      think = self.AxlxCustomerSearchThink.thinkCustomerSearch({
        customerId: body.customer_id,
        areaMode: body.area_mode,
        desiredArea: body.desired_area,
        prevCid: body.prev_cid,
        prevWantMode: body.prev_want_mode,
        playbookSeenRv: body.playbook_seen_rv,
        codePlaybookRv: body.code_playbook_rv,
      });
    } catch (_) { think = null; }
  }
  /** ★ 2.8.205: 失敗でも必ず印（DBで customer_think=0 の穴＝呼び忘れ／失敗で stamp 無し） */
  if (!think) {
    try {
      var rid0 = auditRun && auditRun.runId;
      if (rid0) _auditStep(rid0, "customer_think", "見送り=思考なし（API/写し失敗）→次はlocal写しを確認");
    } catch (_) {}
    return null;
  }
  try {
    await chrome.storage.local.set({ axlx_customer_think: { at: Date.now(), think: think, cid: body.customer_id } });
  } catch (_) {}
  try {
    var rid = auditRun && auditRun.runId;
    if (rid) _auditStep(rid, "customer_think", String(think.summary || "").slice(0, 180));
  } catch (_) {}
  return think;
}
/**
 * 送付後の外し（案B）をリアプロのタブへ頼む。**投げない**（失敗・時間切れ・off・タブなしはログだけで {ok:false|skipped} を返す）。
 *   page-script は MAIN world（content.js の中継は編集しない決まりのため chrome.runtime では受けられない）→
 *   chrome.scripting.executeScript({world:"MAIN"}) でページ側の公開関数 window.__axlxPostSendClearP() を呼ぶ（Promise を待てる）。
 *   ページ側は fail-open（例外・120秒でも結果を返す・入力中は何もしない）。ここの待ちは最大125秒。
 */
/**
 * ★ 2.8.203: runId を明示渡し（findOpen が閉じ済みだと印が消えていた＝DB実測 post_send=0件の穴）。
 *   見送り・失敗でも必ず監査段を残す。
 */
async function _postSendClearRealpro(customerId, auditRunId) {
  var _t0 = Date.now();
  var _stamp = function (note) {
    try {
      var _rid = auditRunId || _auditOpenRunId(String(customerId), "realpro");
      if (_rid) _auditStep(_rid, "post_send_clear", String(note || "").slice(0, 120));
    } catch (_) {}
  };
  try {
    var _off = await chrome.storage.local.get("axlx_post_send_clear_off");
    if (_off && _off.axlx_post_send_clear_off === true) {
      console.log("[post-send-clear] off フラグ → 実行しない");
      _stamp("見送り=off");
      return { skipped: "off" };
    }
    var _tabs = await chrome.tabs.query({ url: ["https://www.realnetpro.com/*"] });
    var _tab = (_tabs || []).filter(function (t) { return t && t.id && t.active; })[0] || (_tabs || [])[0];
    if (!_tab || !_tab.id) {
      console.log("[post-send-clear] リアプロのタブなし → 何もしない");
      _stamp("見送り=no_tab");
      return { skipped: "no_tab" };
    }
    var _exec = chrome.scripting.executeScript({
      target: { tabId: _tab.id },
      world: "MAIN",
      func: function () {
        try {
          if (typeof window.__axlxPostSendClearP === "function") return window.__axlxPostSendClearP();
        } catch (e) { return { ok: false, why: "exception:" + String(e && e.message || e).slice(0, 60) }; }
        return { ok: false, why: "no_page_fn" };
      },
    });
    var _to = new Promise(function (resolve) { setTimeout(function () { resolve("__timeout__"); }, 125000); });
    var _r = await Promise.race([_exec, _to]);
    var _res = (_r && _r !== "__timeout__" && _r[0] && _r[0].result) || null;
    var _note = _r === "__timeout__" ? "125秒待ち切れ（次客へ進む）" : (_res ? ("ok=" + !!_res.ok + " 残=" + (_res.left == null ? "-" : _res.left) + (_res.why ? " " + _res.why : "") + (_res.skipped ? " 見送り=" + _res.skipped : "")) : "応答なし");
    console.log("[post-send-clear] " + _note + " " + Math.round((Date.now() - _t0) / 1000) + "秒 customer=" + customerId);
    _stamp(_note);
    return _res || { ok: false, why: _note };
  } catch (e) {
    console.warn("[post-send-clear] 失敗（非致命・次客へ進む）:", e && e.message ? e.message : e);
    _stamp("error:" + String(e && e.message || e).slice(0, 60));
    return { ok: false, why: "error" };
  }
}
var _scrapeLastOutcome = { timedOut: false };
// 2026-09-30 v2.5.43 同時の回: 直前の1回の結果はサイトごと（realnetpro／itandi）。_scrapeLastOutcome は最後に終わった物（旧の読み手のため残す）
var _scrapeOutcomeBySite = {};
function _scrapeOutcomeFor(site) { return _scrapeOutcomeBySite[site] || _scrapeLastOutcome; }
async function _scrapeAndSendRealpro(fillDonePromise, customerId, customerName, conditions, siteLabel, suppressZeroNotify, auditRunId, loopMeta) {
  var _site = siteLabel || "リアプロ";
  var _siteKey = siteLabel === "itandi" ? "itandi" : "realnetpro";
  var _runId = auditRunId || null;
  if (_manualBulkAlive) _bulkPhaseSet("wait_fill_done", _fillDoneTimeoutMs(_siteKey) + 60000, { cid: String(customerId) });
  // fill-done を待つ（検索実行完了シグナル）
  var fillDone = fillDonePromise ? await fillDonePromise : null;
  if (fillDone && fillDone.stopped) {
    try { await _releasePipelineLock("batch_stopped", customerId); } catch (_) {}
    throw new Error("__BATCH_STOPPED__");
  }
  if (!fillDone || fillDone.timedOut) {
    // ★ 失敗でもロックを外さないと次客 switch が pipeline_busy で止まる
    try { await _releasePipelineLock("fill_timeout", customerId); } catch (_) {}
    /**
     * ★ 2026-11-16 連続客: fill-done が来ない時、ページ側の _axFillRunning が true のまま残ると
     *   次客の fill が「重複」で無視される → さらに timeout。タブへ強制クリアを送る。
     */
    try {
      var _ftTabs = await chrome.tabs.query({ url: _siteKey === "itandi" ? ["https://itandibb.com/*"] : ["https://www.realnetpro.com/*"] });
      (_ftTabs || []).forEach(function (t) {
        if (!t || !t.id) return;
        try {
          chrome.tabs.sendMessage(t.id, { type: "axlx-force-fill-clear", reason: "fill_timeout", customerId: customerId }, function () { void chrome.runtime.lastError; });
        } catch (_) {}
      });
    } catch (_) {}
    try {
      if (_runId) _auditStep(_runId, "handoff_loop", "欠=検索・送付・送付後外し／fill-done未着→次客のleftoverに任せる");
    } catch (_) {}
    throw new Error(_site + " 検索完了シグナル（fill-done）が" + Math.round(_fillDoneTimeoutMs(siteLabel === "itandi" ? "itandi" : "realnetpro") / 1000) + "秒以内に届きませんでした。");
  }
  if (fillDone.error) {
    try { await _releasePipelineLock("fill_error", customerId); } catch (_) {}
    try {
      if (_runId) {
        _auditStep(_runId, "handoff_loop", "欠=検索以降／fill_error=" + String(fillDone.error).slice(0, 80) + "→次客のleftoverに任せる");
      }
    } catch (_) {}
    // superseded は次客へ進むための正常な切替（失敗扱いのロック解除は上で済）
    throw new Error("page-script側エラー（スキップ）: " + fillDone.error);
  }

  // fill-done 受信後、bulk-dl.js が axlx-autofill-initiated → autoSendAllPages → 全ページPDF送信
  // axlx-batch-customer-done で完走を待つ（初期10分＋進捗後は無進捗15分まで延長。固定5分切り上げは廃止）
  // これにより次顧客のautofillがページを書き換える前に現顧客の送信が確実に完了する
  console.log("[scrapeAndCompare] fill-done 受信 → 全ページ送信完了を待機 customer=" + customerId);
  // ★ 2026-11-18 平田: 検索完了後は送付完走まで待つ。初期待ちは10分（bulk 起動・一覧待ち）。以降はハートビートでリセット。
  // ★ 2026-11-18: 送付待ち初期も最低20分（旧10分）
  var _batchWaitMs = fillDone && !fillDone.error ? Math.max(1200000, BATCH_IDLE_MS) : BATCH_IDLE_MS;
  if (_manualBulkAlive) _bulkPhaseSet("wait_batch_done", _batchWaitMs, { cid: String(customerId) });
  var batchDone = await _createBatchCustomerDoneWaiter(customerId, _batchWaitMs, _siteKey);
  if (batchDone && batchDone.stopped) {
    try { await _releasePipelineLock("batch_stopped", customerId); } catch (_) {}
    throw new Error("__BATCH_STOPPED__");
  }
  var _propCount = 0;
  var _out = { timedOut: false, sawProgress: !!(batchDone && batchDone.sawProgress) };
  _scrapeLastOutcome = _out;
  _scrapeOutcomeBySite[_siteKey] = _out;
  if (batchDone && batchDone.timedOut) {
    var _idleSec = Math.round((batchDone.idleMs || _batchWaitMs || BATCH_IDLE_MS) / 1000);
    var _saw = !!batchDone.sawProgress;
    console.warn("[scrapeAndCompare] 全ページ送信完了シグナルが" + _idleSec + "秒（無進捗）以内に届きませんでした" + (_saw ? "（送付進捗あり・件数不明）" : "") + " customer=" + customerId);
    // 2026-09-25 竹内（検索の点検）: 待ち切れは「0件」と限らない → LINE では「⚠ 検索できなかった」に分ける。
    // ★ 2026-11-18: 進捗ありなら「0件」扱いを避け、countUnknown にして次客破壊を抑える
    _out.timedOut = true;
    _out.sawProgress = _saw;
    var _sentPartial = batchDone.sentCount > 0 ? batchDone.sentCount : 0;
    _out.sentPartial = _sentPartial;
    if (_saw) _out.countUnknown = true;
    // ★ 2026-11-18: 送付進捗ありの無進捗切り上げ — 一連ロックは batch-customer-done まで維持（次客 autofill で壊さない）
    if (_saw) {
      try { await chrome.storage.local.set({ axlx_pipeline_send_hold: { cid: String(customerId), at: Date.now() } }); } catch (_) {}
    }
    // ★ 2026-11-18: 部分送付済みなら「失敗パス」に数えない（0件扱い・次客への破壊的な切替の根拠にしない）
    if (_sentPartial > 0) _out.timedOut = false;
    var _toRun = _auditOpenRunId(customerId, siteLabel === "itandi" ? "itandi" : "realpro");
    if (_toRun) {
      _auditTracker.attachResult(_toRun, { batch_timed_out: true, saw_progress: _saw, idle_sec: _idleSec, sent_partial: _sentPartial });
      _auditStep(_toRun, "batch_timeout", (_saw ? "送付進捗あり・" : "") + (_sentPartial ? "送付済み" + _sentPartial + "件・" : "") + _idleSec + "秒無進捗");
    }
    if (!suppressZeroNotify && customerName) {
      fetch(SUMORA_BATCH_API + "/api/notify-group", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: _saw
            ? "⚠【送付途中】" + customerName + "さんの" + _site + "検索は送付が進んでいましたが完了合図が届きませんでした（" + (_sentPartial ? "送付済み" + _sentPartial + "件・" : "") + _idleSec + "秒無進捗・0件とは限りません）"
            : "⚠【検索できなかった】" + customerName + "さんの" + _site + "検索が途中で止まりました（結果を読み終わる合図が" + _idleSec + "秒届かず・0件とは限りません）",
          group_key: "pickup_group_id"
        })
      }).catch(function() {});
    }
    _propCount = _sentPartial; // 部分送付済みはその件数を数える（0件扱いにしない）
  } else {
    console.log("[scrapeAndCompare] 全ページ送信完了 customer=" + customerId);
    // 2026-09-27 v2.5.30: 件数の無い完了（bulk-dl の送信エラー・次ページへ進めない＝「送信済みがあるので0件と言わない」の合図）を
    //   0件と数えていた → YUMA の実検索で34件送れていたのに「🔍【物件0件】」がグループに出た。件数が分からない時は0件と言わない
    _out.countUnknown = !(batchDone && batchDone.propertyCount != null);
    _propCount = (batchDone && batchDone.propertyCount) ? batchDone.propertyCount : 0;
    // 2026-09-30 v2.5.42 ITANDI: 条件が効いていない形で資料を取りに行かずに止めた（呼び出し元が1回だけ入れ直す・0件とは言わない）
    _out.guard = (batchDone && batchDone.guard) || null;
  }
  // 0件時 → LINEグループへアナウンス（timedOut 分岐で既に通知済みの場合は重複しない）
  //   2026-09-29 v2.5.41: 送付済みの部屋だけだった（全部飛ばした）時は「0件」と言わず「新しい物件なし・N件は送付済み」
  var _skippedHere = _lastSentSkipped[_sentSkipKey(customerId, _siteKey)] || _lastSentSkipped[String(customerId)] || 0;
  if (_propCount === 0 && !_out.countUnknown && !(batchDone && batchDone.timedOut) && !suppressZeroNotify && customerName) {
    fetch(SUMORA_BATCH_API + "/api/notify-group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: _skippedHere > 0
        ? "🔍【新しい物件なし】" + customerName + "さんの" + _site + "検索は送付済みの部屋だけでした（" + _skippedHere + "件は飛ばしました・資料もダウンロードしていません）"
        : "🔍【物件0件】" + customerName + "さんの" + _site + "検索が0件でした", group_key: "pickup_group_id" })
    }).catch(function() {});
  }
  /**
   * ★ 2026-11-19 竹内さん「入れたのを覚えていたら外せるので、完了したらちゃんと外すようにすれば問題ない。順番に行えば」→ 統括Pro 案B:
   *   リアプロの送付が終わった直後（次客の switch／fill より前・一連ロックを外す前）に、そのタブへ「送付後の外し」を頼み、
   *   最大120秒まで待つ（非致命・失敗は握りつぶしてログ）。次客開始時のきれい確認（page-script の _cleanStartGate）は安全網として残る。
   *   ・ITANDI には入れない（リアプロの連続のみ）／送付が途中のまま切り上げた回（送付進捗あり）は触らない
   *   ・最後のお客さん（_axlxLastCustomerId）は待たずに戻す（ページを汚れたまま残さないが、完了を待たせない）
   *   ・chrome.storage.local の axlx_post_send_clear_off が true なら実行しない（切り替えフラグ）
   */
  var _psRes = null;
  var _psIsLast = false;
  if (_siteKey === "realnetpro") {
    try {
      if (!(batchDone && batchDone.timedOut && batchDone.sawProgress)) {
        _psIsLast = !!(self._axlxLastCustomerId && String(self._axlxLastCustomerId) === String(customerId));
        if (_manualBulkAlive && !_psIsLast) _bulkPhaseSet("post_send_clear", 140000, { cid: String(customerId) });
        var _psP = _postSendClearRealpro(customerId, _runId);
        if (_psIsLast) {
          _psP.catch(function () {});
          _psRes = { skipped: "last_customer_async" };
        } else {
          _psRes = await _psP;
        }
      } else {
        try {
          if (_runId) _auditStep(_runId, "post_send_clear", "見送り=送付進捗ありtimeout（ロック維持）");
        } catch (_) {}
        _psRes = { skipped: "send_timeout_hold" };
      }
    } catch (_) { /* 次客を止めない */ _psRes = { ok: false, why: "post_send_exception" }; }
  }
  try {
    if (_runId) {
      /** ★ 2.8.204: 連続客細原子を1つずつ残す（統括・F62が弱い所を名指しできるように） */
      /** ★ 2.8.214: 外し未完了なのに「stamp済」「渡してよい」と偽らない */
      /** ★ 2.8.223: skipped（last_async/no_tab/off/fill_running等）を外しOKと偽らない。未完了なら次客で強制外す */
      var _psOk = true;
      if (_siteKey === "realnetpro") {
        if (!_psRes) _psOk = false;
        else if (_psRes.skipped) _psOk = false;
        else if (_psRes.ok === false || (_psRes.left != null && Number(_psRes.left) > 0)) _psOk = false;
        else if (_psRes.why && String(_psRes.why).indexOf("ledger_place") >= 0) _psOk = false;
      }
      _auditStep(_runId, "handoff_atom_send", "送付prop=" + _propCount);
      _auditStep(
        _runId,
        "handoff_atom_post_send",
        _psOk
          ? "送付後外しOK"
          : ("送付後外し未完了 left=" + (_psRes && _psRes.left != null ? _psRes.left : "?") + " " + String((_psRes && (_psRes.why || _psRes.skipped)) || "").slice(0, 40)),
      );
      _auditStep(_runId, "handoff_atom_ready", _psOk ? "次客へ渡してよい" : "次客へ渡す（外し残りは次客開始時に再外し）");
      _auditStep(
        _runId,
        "handoff_loop",
        (_psOk ? "送付後外しまで完了" : "送付後外しギャップあり") + " prop=" + _propCount + "→次客へ",
      );
      _auditStep(_runId, "series_done", _psOk ? "一連完了→次客へ渡してよい" : "一連完了→次客（外しギャップあり）");
      /**
       * ★ 2.8.222: ループ完了→次客を明示把握（いま誰が終わった／次は誰／次の動き=外す）
       * ★ 2.8.223: 外し未完了なら「次=外す」を明示＋ページに強制外しを渡す（把握と実行を揃える）
       */
      try {
        var _lm = loopMeta && typeof loopMeta === "object" ? loopMeta : null;
        var _curNm = String(customerName || (_lm && _lm.currentName) || "").slice(0, 20);
        var _nxtNm = String((_lm && _lm.nextName) || "").slice(0, 20);
        var _idx = _lm && _lm.index != null ? Number(_lm.index) : 0;
        var _tot = _lm && _lm.total != null ? Number(_lm.total) : 0;
        var _pos = _idx > 0 && _tot > 0 ? "（" + _idx + "/" + _tot + "）" : "";
        var _adv = _nxtNm
          ? ("客完了→次へ" + _pos + " いま=" + (_curNm || "-") + " 次=" + _nxtNm)
          : ("客完了・一括末" + _pos + " いま=" + (_curNm || "-"));
        _auditStep(_runId, "loop_advance", _adv.slice(0, 120));
        _auditStep(
          _runId,
          "loop_who_grasp",
          "いま客=" + (_curNm || String(customerId || "-").slice(0, 8)) + " 次客=" + (_nxtNm || "（末）"),
        );
        _auditStep(
          _runId,
          "next_customer_grasp",
          "いま=" + (_curNm || "-") + " 次客=" + (_nxtNm || "（末）") + " series_done",
        );
        var _needClear = !_psOk || !!_nxtNm;
        _auditStep(
          _runId,
          "next_move_grasp",
          "次の動き=" +
            (_needClear ? "前客の選択を1つずつ外す" : "一括完了") +
            (_psOk ? " 送付後外し済" : " 送付後未完→次客で外す") +
            " series_done",
        );
        if (!_psOk) {
          _auditStep(
            _runId,
            "post_send_clear_gap",
            "送付後外し未完→次客開始で強制外す " + String((_psRes && (_psRes.skipped || _psRes.why)) || "gap").slice(0, 50),
          );
          try {
            await chrome.storage.local.set({
              axlx_force_clear_next: {
                at: Date.now(),
                why: String((_psRes && (_psRes.skipped || _psRes.why)) || "post_send_gap").slice(0, 60),
                fromCid: String(customerId || ""),
              },
            });
          } catch (_) {}
          try {
            var _gapTabs = await chrome.tabs.query({ url: ["https://www.realnetpro.com/*"] });
            var _gapTab = (_gapTabs || []).filter(function (t) { return t && t.id && t.active; })[0] || (_gapTabs || [])[0];
            if (_gapTab && _gapTab.id) {
              // ★ 2.8.265: タブが固まっていると executeScript が返らず次客へ進めなかった → 10秒で先へ
              await _withTimeout(chrome.scripting.executeScript({
                target: { tabId: _gapTab.id },
                world: "MAIN",
                func: function () {
                  try { window.__axlxForceClearAllPlace = true; } catch (_) {}
                  try { window.__axlxPostSendClearGap = true; } catch (_) {}
                },
              }), 10000, "force_clear_gap_flag");
            }
          } catch (_) {}
        }
      } catch (_) {}
    }
  } catch (_) {}
  // ★ 次客へ移る前に一連ロックを外す。送付進捗ありの batch_timeout は batch-customer-done まで維持
  try {
    var _holdSend = !!(batchDone && batchDone.timedOut && batchDone.sawProgress);
    if (_holdSend) {
      console.warn("[scrapeAndCompare] 送付進捗あり batch_timeout → pipeline 維持（合図待ち）customer=" + customerId);
    } else {
      if (_manualBulkAlive) _bulkPhaseSet("release_lock", 30000, { cid: String(customerId) });
      await _withTimeout(_releasePipelineLock(batchDone && batchDone.timedOut ? "batch_timeout" : "scrape_done", customerId), 15000, "release_lock");
    }
  } catch (_) {}
  return _propCount;
}

/**
 * 2026-09-30 v2.5.42 ITANDI の「条件が効いていない形」を1回だけ入れ直す（_runBatchSearch の ITANDI の回から）。
 *   ・1回目の読み戻し（入れようとした値が欄に入ったか）を先に控える（入れ直すと上書きされる）＝原因の分け方（拡張側か ITANDI 側か）の材料
 *   ・人が結果を見直して条件の画面に戻る間（9〜22秒・itandi-guard.js retryGapMs）→ いつもと同じ入力の流れ（popup・人の間）でもう一度
 *   ・直らなければこのお客様の ITANDI は見送り（資料は開いていない）＋★物件出し★に1行（pickup_group_id）
 *   連続の再試行はしない（1回だけ・サイトへのアクセスを増やしすぎない）
 */
function _compactFill(f) {
  if (!f || typeof f !== "object") return null;
  var names = function (a) { return Array.isArray(a) ? a.slice(0, 10).map(function (x) { return x && x.name ? String(x.name).slice(0, 30) : String(x).slice(0, 30); }) : []; };
  return {
    search_clicked: f.search_clicked != null ? !!f.search_clicked : null,
    form: f.form || null,
    click_fails: Array.isArray(f.click_fails) ? f.click_fails.slice(0, 5).map(function (c) { return { what: c && c.what ? String(c.what).slice(0, 40) : null, text: c && c.text ? String(c.text).slice(0, 40) : null }; }) : [],
    stations_missing: names(f.stations_missing), lines_missing: names(f.lines_missing),
    reset_fail: f.reset_fail ? String(f.reset_fail).slice(0, 120) : null,
    // v2.5.46 前の条件を外した結果（外した欄・残った欄の名前だけ）
    reset: f.reset ? { cleared: Array.isArray(f.reset.cleared) ? f.reset.cleared.slice(0, 12) : [], leftover: Array.isArray(f.reset.leftover) ? f.reset.leftover.slice(0, 12) : [] } : null,
    update_days: f.update_days && f.update_days.status ? { status: f.update_days.status } : null,
    area_path: f.area_path || null, fallback: f.fallback || null,
  };
}
async function _itandiGuardRetry(o) {
  var G = self.AxlxItandiGuard;
  var cid = String(o.customer.id);
  var name = o.customer.customer_name || null;
  var runId = o.audit ? o.audit.runId : null;
  var run = runId && _auditTracker ? _auditTracker.get(runId) : null;
  var firstFill = _compactFill(run && run.filled);
  var gap = G ? G.retryGapMs() : 15000;
  var why = G ? G.reasonsJa(o.first.reasons) : String(o.first.reasons || "");
  console.warn("[batch] ITANDI の検索に条件が効いていない形（" + why + "）→ " + Math.round(gap / 1000) + "秒おいて1回だけ入れ直す customer=" + cid);
  _auditStep(runId, "itandi_guard_retry", why + " → " + Math.round(gap / 1000) + "秒おいて入れ直す");
  _watchSet({ waitingFor: "ITANDI の条件の入れ直しまでの間（" + Math.round(gap / 1000) + "秒）" }, "itandi");
  await new Promise(function (r) { setTimeout(r, gap); });
  if (_batchShouldStop) throw new Error("__BATCH_STOPPED__");
  if (_itandiGuardCtx && String(_itandiGuardCtx.customerId) === cid) _itandiGuardCtx.attempt = 1;
  var fillDoneP2 = _createFillDoneWaiter("itandi", cid, _fillDoneTimeoutMs("itandi"));
  var conds2 = await _batchAutofill(o.customer, "itandi", o.isWide, o.payload, o.audit);
  var n = await _scrapeAndSendRealpro(fillDoneP2, cid, name, conds2 || _buildBatchConditions(o.customer, o.isWide, o.payload), "itandi", !!o.suppressZero, runId);
  var second = _scrapeOutcomeFor("itandi").guard;
  var fixed = !(second && second.suspect);
  var rec = {
    suspect: true, reasons: o.first.reasons || [],
    first: { reasons: o.first.reasons || [], judged: o.first.judged, outside: o.first.outside, count: o.first.count, count_text: o.first.count_text || null, samples: (o.first.samples || []).slice(0, 5) },
    first_fill: firstFill,
    retry: { tried: true, fixed: fixed, reasons: second ? (second.reasons || []) : [], judged: second ? second.judged : null, outside: second ? second.outside : null, count: second ? second.count : null, gap_ms: gap },
  };
  try { if (runId && _auditTracker) _auditTracker.attachResult(runId, { guard: rec, guard_stopped: !fixed }); } catch (_) {}
  if (fixed) {
    console.log("[batch] ITANDI: 入れ直したら条件が効いた → そのまま続けた（" + (n || 0) + "件）customer=" + cid);
    _auditStep(runId, "itandi_guard_fixed", "入れ直しで直った");
  } else {
    _scrapeOutcomeFor("itandi").guardSkipped = true;
    _auditStep(runId, "itandi_guard_skip", "入れ直しても直らない → このお客様の ITANDI は見送り");
    var text = G ? G.skipNotice(name, (second && second.reasons && second.reasons.length) ? second.reasons : o.first.reasons) : null;
    if (text) {
      fetch(SUMORA_BATCH_API + "/api/notify-group", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text, group_key: "pickup_group_id" })
      }).catch(function () {});
    }
  }
  return n;
}

// ── 2026-09-30 v2.5.43 リアプロと ITANDI を同時に動かす（parallel-sites.js）─────────────────────
// 竹内「拡張ツールはリアプロと ITANDI を開いているので、同時に動かす形でも大丈夫ならそれで行う」
//   v2.5.42 が順にした理由（背面のタブは Chrome がタイマーを間引く・見張りと待ち手が1本）を、判定と本ごとの見張り・待ち手で外した。
//   判定を満たさない PC・お客様は v2.5.42 の順のまま（理由はログと点検の段 lane_mode）

// そのタブの見え方と1秒のタイマーの遅れを content script（snapshot-core.js の受け口 axlx-lane-probe）に聞く。答えが無ければ ok:false
async function _laneProbe(tabId) {
  var P = self.AxlxParallelSites;
  if (tabId == null || !P) return { ok: false, error: "no_tab" };
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "axlx-lane-probe" }, { frameId: 0 }),
      new Promise(function (r) { setTimeout(function () { r({ ok: false, error: "no_answer" }); }, P.PROBE_WAIT_MS); }),
    ]) || { ok: false, error: "empty" };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 120) };
  }
}

// このお客様のサイトを同時に動かしてよいか（タブ・窓の形を先に見て、満たす時だけ実測する＝満たさない時はタブに何も送らない）
async function _decideLanes(sites) {
  var P = self.AxlxParallelSites;
  var list = Array.isArray(sites) ? sites : [];
  if (!P) return { parallel: false, reason: list.indexOf("itandi") >= 0 && list.indexOf("realnetpro") >= 0 ? "no_module" : "single_site", lanes: [] };
  try {
    var flagSt = await chrome.storage.local.get(P.STORAGE_FLAG);
    var flag = flagSt ? flagSt[P.STORAGE_FLAG] : undefined;
    var tabs = await chrome.tabs.query({});
    var wins = [];
    try { wins = await chrome.windows.getAll({}); } catch (_) { wins = []; }
    var okProbe = { ok: true, visibilityState: "visible", lagMs: 0 };
    var pre = P.decideParallel({ sites: list, tabs: tabs, windows: wins, probes: { realnetpro: okProbe, itandi: okProbe }, flag: flag });
    if (!pre.parallel) return pre;
    var probes = {};
    var got = await Promise.all([_laneProbe(pre.tabs.realnetpro), _laneProbe(pre.tabs.itandi)]);
    probes.realnetpro = got[0]; probes.itandi = got[1];
    var d = P.decideParallel({ sites: list, tabs: tabs, windows: wins, probes: probes, flag: flag });
    d.probes = { realnetpro: got[0], itandi: got[1] };
    return d;
  } catch (e) {
    return { parallel: false, reason: "probe_failed", lanes: [], error: String((e && e.message) || e).slice(0, 120) };
  }
}

/**
 * 1人のお客様のリアプロと ITANDI を2本で走らせ、両方が終わる（時間切れ・見送りも）のを待つ。
 *   ・リアプロを先に始め、ITANDI は laneStartOffsetMs（3〜15秒）ずらす（ずらす間も止める要求を見る）
 *   ・各本は自分の見張り（_startPassGuard lane・リアプロ20分・ITANDI 25分）で閉じる。合流の上限（joinBudgetMs）はその保険
 *   ・合流の上限を過ぎた本は、待ちを解いて（fill-done は end・送信の終わりは stopped）置き去りにする＝遅れて動いても知らせ・件数を書かない
 * @returns {{ cancelled: boolean, errors: string[], timedOut: boolean, pending: string[] }}
 */
async function _runLanesParallel(customer, runLane, laneNote) {
  var P = self.AxlxParallelSites, SC = self.AxlxSnapshotCore;
  var cid = String(customer.id);
  var offset = P.laneStartOffsetMs();
  var passes = customer.area_mode === "both" ? 2 : 1;
  var budget = P.joinBudgetMs(["realnetpro", "itandi"], function (s) { return SC ? SC.passDeadlineMs(s) : 20 * 60 * 1000; }, passes, offset);
  console.log("[batch] 同時: リアプロを始め、ITANDI は " + offset + "ms 後に始める（両方が終わるまで最長 " + Math.round(budget / 60000) + "分）customer=" + cid);
  var t0 = Date.now();
  var pRp = runLane(customer, "realnetpro", true, laneNote);
  var pIt = (async function () {
    var until = Date.now() + offset;
    while (Date.now() < until) {
      if (_batchShouldStop) return { cancelled: true };
      await new Promise(function (r) { setTimeout(r, Math.min(500, Math.max(0, until - Date.now()))); });
    }
    if (_batchShouldStop) return { cancelled: true };
    return runLane(customer, "itandi", true, laneNote);
  })();
  var joined = await P.joinLanes([{ site: "realnetpro", promise: pRp }, { site: "itandi", promise: pIt }], budget);
  var out = { cancelled: false, errors: [], timedOut: !!joined.timedOut, pending: joined.pending || [] };
  ["realnetpro", "itandi"].forEach(function (s) {
    var r = joined.results[s];
    if (!r) return;
    if (r.ok && r.value && r.value.cancelled) out.cancelled = true;
    if (!r.ok) {
      // 本の中の失敗は1パスずつ拾っている（ここに来るのは想定外の失敗だけ）。もう片方は止めない
      var msg = (r.error && r.error.message) || String(r.error);
      if (msg === "__BATCH_STOPPED__") out.cancelled = true;
      else { console.error("[batch] 同時の本（" + s + "）が想定外の失敗:", r.error); out.errors.push(cid + "/" + s + "/lane: " + msg); }
    }
  });
  if (joined.timedOut) {
    var why = "両方が終わるのを待つ上限（" + Math.round(budget / 60000) + "分）を過ぎた: " + (customer.customer_name || cid) + "さん・待っていた本=" + out.pending.join("・");
    console.error("[batch-watch] " + why + " → 置き去りにして次のお客様へ");
    _snapOnEvent("pass_deadline", why);
    out.pending.forEach(function (s) {
      try { _endFillDoneWaiter(s, cid, "合流の時間切れ"); } catch (_) {}
      try { _abandonBatchCustomerDoneWaiter(cid, s); } catch (_) {}
      out.errors.push(cid + "/" + s + "/lane: " + why);
    });
  }
  console.log("[batch] 同時: " + (customer.customer_name || cid) + "さんのリアプロ・ITANDI が終わった（" + Math.round((Date.now() - t0) / 1000) + "秒"
    + (joined.results.realnetpro ? "・リアプロ " + Math.round(joined.results.realnetpro.ms / 1000) + "秒" : "")
    + (joined.results.itandi ? "・ITANDI " + Math.round(joined.results.itandi.ms / 1000) + "秒" : "") + "）");
  return out;
}

// ===== END: 自動化バッチ検索 =====

// ===== 会話画面の「🔍 物件検索」→ このお客様を拡張の一番上へ（v2.5.86・2026-10-06 竹内）=====
// 竹内「ここ（会話の上の状態の帯）広げたところに物件検索ボタンを出す。そうすると拡張ツール繰り上げられるようにする」
//   「スマホで押しても連携して拡張ツールのお客さんの一番上に繰り上がるようにする」
// 印そのものはサーバー（property_search_focus）に残る＝スマホで押しても、どの PC の拡張でも一番上に出る（search-focus.js・popup の一覧）。
// ここは「同じ PC の Chrome で押した時」の近道だけ:
//   axlx-search-focus       … 手元の印（axlx_search_focus_open）を置く＝開いている popup／横のパネルが一番上に出す。
//                              リアプロ／ITANDI のタブがあれば一番最近見ていたタブを前に出し、下のバー（underbar）を広げてそのお客様を開く。
//                              検索は押さない（案内モード＝人が ▶案内 を押す・自動の検索は止めている）。一括の回（batchRunning）の最中はタブを動かさない
//   axlx-search-focus-panel … リアプロ／ITANDI のタブが無い時、押したタブの横に拡張のパネル（side panel）を開く。
//                              Chrome は「人の操作の直後」でないと開かせない → ここでは await より前に sidePanel.open を呼ぶ（断られたら理由を返す）
var SEARCH_FOCUS_TAB_URLS = ["https://www.realnetpro.com/*", "https://realnetpro.com/*", "https://itandibb.com/*"];
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || (msg.type !== "axlx-search-focus" && msg.type !== "axlx-search-focus-panel")) return false;
  if (!msg.customerId) { sendResponse({ ok: false, reason: "no-customer" }); return false; }

  if (msg.type === "axlx-search-focus-panel") {
    var tabId = sender && sender.tab && sender.tab.id;
    if (!chrome.sidePanel || !chrome.sidePanel.open || tabId == null) { sendResponse({ ok: false, reason: "no-side-panel" }); return false; }
    try {
      chrome.sidePanel.open({ tabId: tabId }).then(
        function () { sendResponse({ ok: true, via: "panel" }); },
        function (e) { sendResponse({ ok: false, reason: "panel-refused", error: String((e && e.message) || e).slice(0, 160) }); }
      );
    } catch (e) {
      sendResponse({ ok: false, reason: "panel-refused", error: String((e && e.message) || e).slice(0, 160) });
      return false;
    }
    return true;
  }

  (async function () {
    var nowIso = new Date().toISOString();
    var item = { customerId: String(msg.customerId), customerName: msg.customerName || "", at: msg.at || nowIso, ts: Date.now() };
    try { await chrome.storage.local.set({ axlx_search_focus_open: item }); } catch (_) {}
    try {
      var st = await chrome.storage.local.get("batchRunning");
      var lock = st && st.batchRunning;
      var lockAt = (lock && typeof lock === "object") ? lock.startedAt : 0;
      if (lock && lockAt && Date.now() - lockAt < BATCH_LOCK_TTL_MS) {
        sendResponse({ ok: true, via: "none", reason: "batch-running" });
        return;
      }
      var tabs = await chrome.tabs.query({ url: SEARCH_FOCUS_TAB_URLS });
      if (!tabs || !tabs.length) { sendResponse({ ok: true, via: "none", reason: "no-site-tab" }); return; }
      tabs.sort(function (a, b) { return (b.lastAccessed || 0) - (a.lastAccessed || 0); });
      var t = tabs[0];
      var site = /itandibb\.com/.test(t.url || "") ? "itandi" : "realpro";
      await chrome.tabs.update(t.id, { active: true });
      try { await chrome.windows.update(t.windowId, { focused: true }); } catch (_) {}
      chrome.tabs.sendMessage(t.id, { type: "axlx-search-focus-open", customerId: item.customerId, customerName: item.customerName, at: item.at }, function (r) {
        void chrome.runtime.lastError;
        sendResponse({ ok: true, via: "tab", site: site, opened: !!(r && r.ok), reason: (r && r.reason) || null });
      });
    } catch (e) {
      sendResponse({ ok: false, reason: "error", error: String((e && e.message) || e).slice(0, 160) });
    }
  })();
  return true;
});
