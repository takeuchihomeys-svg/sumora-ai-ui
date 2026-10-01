"use strict";

// ── ローカル条件解決コア（popup.js と同一ロジック）─────────────────────────
// manifest の background.type が "module" のため importScripts() は使えない。
// 静的 import で読み込み、resolution-core.js が公開する globalThis.SUMORA_RESOLUTION
// 経由で resolveConditionsLocal 等を参照する（_resolveLocalFirst 参照）。
import "./resolution-core.js";
// 2026-09-18 竹内: 検索日の記録（サイト×モード）を popup.js と同じ1つの関数で行う（self.AxlxSearchHistory）
import "./search-history.js";
// 2026-09-18 竹内（一括検索の混線）: fill-done が誰の分かの判定（純関数・テストあり）
import "./fill-done-match.js";
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

// content script から chrome.storage.session へのアクセスを許可
if (chrome.storage && chrome.storage.session && chrome.storage.session.setAccessLevel) {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(function() {});
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.url) return;
    configureSidePanelForTab(tabId, tab.url);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || (changeInfo.status === "complete" ? tab.url : null);
  if (url) configureSidePanelForTab(tabId, url);
});

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

// ── ヘルパー: /api/merge-pdfs を background から呼ぶ（CSP/CORS 完全回避）──
async function callMergeApi(payload) {
  // 送信の3経路（リアプロ・itandi・レインズ）は全部ここを通るので、スタッフモードの判定もここで付ける
  const staffMode = await isStaffModeOn();
  // brain_mode はサーバーの記録用（判定そのものは bulk-dl.js が送信前に /api/property-brain/judge で行う）＝ 売上サポ（property_pickups）に1回分を残す。
  // 2026-09-25 竹内「ブレインでもスタッフモードを行う」: 旧はスタッフモード中は false に倒していたが、ブレイン×スタッフでも記録する
  //   （AxlxModeCore.behavior の recordPickup。スタッフの送り方は変えない: staff_mode=true で送付済みの除外はしないまま・LINE グループへの送り方も同じ）。
  //   サーバー（merge-pdfs）の brain_mode は property_pickups の記録にしか使っておらず、staff_mode（除外しない）とは独立に効く。
  const brainMode = await isBrainModeOn();
  const searchCommandId = _searchCommandIdFor(payload && payload.property_customer_id);
  // 2026-09-27 この送信がピンポイントの検索か広げての検索か（ブレインの時だけ・分からない時は付けない＝サーバーは加点しない）
  const searchMode = brainMode && payload && payload.property_customer_id ? await _searchModeFor(payload.property_customer_id, payload.site) : null;
  // v2.5.49 物件の付け先の見張り（batch-guard.js sendOwner）: 一括の回が走っている間は、送る相手が「今そのサイトで検索している回のお客様」か照らす。
  //   違えば送らない（点検の段 owner_mismatch に残る＝サーバーの札 OWNER_MISMATCH）。相手が空なら回のお客様で送る。
  //   サーバー（merge-pdfs）にも回のお客様（batch_owner）を渡し、同じ照らしをもう一度させる（名前と ID の食い違いもそこで見る）
  let _own = null;
  try { _own = self.AxlxBatchGuard && self.AxlxBatchGuard.sendOwner ? self.AxlxBatchGuard.sendOwner(_batchWatch, _batchLoopAlive, payload && payload.site, payload && payload.property_customer_id) : null; } catch (_) { _own = null; }
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
  if (msg.type === "axlx-send-to-line") {
    (async () => {
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
    })();
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

  if (msg.type === "axlx-guide-sent-rooms") {
    (async () => {
      try {
        const headers = await _getAutomationKeyHeader();
        const res = await fetch(SUMORA_BATCH_API + "/api/automation/sent-rooms?customer_id=" + encodeURIComponent(String(msg.customerId || "")), { headers, signal: AbortSignal.timeout(8000) });
        const j = res.ok ? await res.json() : null;
        sendResponse({ ok: !!(j && Array.isArray(j.rooms)), rooms: j && Array.isArray(j.rooms) ? j.rooms.slice(0, 3000) : [] });
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
          // _realTab は上で取得済み（null の場合は新規タブ作成）
          if (_realTab) {
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
            var _fetchRes = await fetch("https://sumora-ai-ui.vercel.app/api/property-customers", { cache: "no-store" });
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

        var _fetchRes = await fetch("https://sumora-ai-ui.vercel.app/api/property-customers", { cache: "no-store" });
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
  if (msg.type === "axlx-fetch-customer") {
    (async () => {
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
    var _bulkSite = msg.site;
    var _bulkIds  = Array.isArray(msg.customerIds) ? msg.customerIds : [];
    // 2026-09-18 竹内「一括検索も条件広げて検索でできるようにする」:
    //   _batchAutofill は元から isWide を受ける作りだったのに、ここが常に false を渡していた
    var _bulkIsWide = !!msg.isWide;
    sendResponse({ ok: true, started: true });
    (async () => {
      try {
        // 前回バッチのストップ残留をクリア（即解決を防ぐ）
        _batchShouldStop = false;
        try { await chrome.storage.local.set({ batchStopRequested: false }); } catch(_) {}
        // 2026-09-29 見張り: 前の回の「止める」は持ち越さない
        _watchStop = null;
        _watchSkipped = [];
        var _bulkRes = await fetch("https://sumora-ai-ui.vercel.app/api/property-customers", { cache: "no-store" });
        if (!_bulkRes.ok) throw new Error("顧客データ取得失敗");
        var _bulkAll = await _bulkRes.json();
        var _bulkTargets = _bulkIds
          .map(function(id) { return _bulkAll.find(function(c) { return String(c.id) === String(id); }); })
          .filter(Boolean);
        console.log("[manual-bulk-search] ▶ site=" + _bulkSite + " mode=" + (_bulkIsWide ? "wide" : "pinpoint") + " 対象=" + _bulkTargets.length + "人");
        for (var _bi = 0; _bi < _bulkTargets.length; _bi++) {
          var _bc = _bulkTargets[_bi];
          // 2026-09-29 見張り: ログイン切れ・サイトのエラーで見張りが止めたら、次のお客様から見送る（知らせはサーバーの1通だけ）
          if (_watchSkipSite(_bc, _bulkSite)) continue;
          console.log("[manual-bulk-search] (" + (_bi+1) + "/" + _bulkTargets.length + ") " + _bc.customer_name);
          // 検索の点検: この1人の記録を始める（ブレインの時だけ）
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
            console.log("[manual-bulk-search] 更新日=" + (_bulkRpDays ? _bulkRpDays + "日以内" : "指定なし") + " (" + _bc.customer_name + ")");
            var _bulkConds = await _batchAutofill(_bc, _bulkSite, _bulkIsWide, { rp_update_days: _bulkRpDays }, _bulkAudit);
            // 2026-09-18 竹内「一括検索したお客さんも項目のところに日付と一括検索した日にちをいれる」:
            //   個別検索（popup.js）は search_history を書いていたが、一括検索は1行も書いていなかった。
            //   同じ関数（search-history.js）で記録し、顧客リストの RP/IT/RE グリッドが一括の分も埋まるようにする
            // fill-done → axlx-batch-customer-done を待ってから次顧客へ（混線防止）
            // reins は bulk-dl.js 自動送信なし → ウェイターなしでスキップ
            if (_bulkFillDone) {
              await _scrapeAndSendRealpro(
                _bulkFillDone,
                String(_bc.id),
                _bc.customer_name || null,
                _bulkConds || {},
                _bulkSite === "itandi" ? "itandi" : "リアプロ"
              );
            }
            // 2026-09-27 v2.5.32: 記録は検索を押せた後（失敗して投げた回は記録しない）
            _recordBulkSearch(_bc, _bulkSite, _bulkIsWide);
            // レインズは fill-done で閉じる（_auditOnFillDone）
            if (_bulkAudit && _bulkSite !== "reins") _auditFinish(_bulkAudit.runId, {});
          } catch (_be) {
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
            if (_bc.customer_name) {
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
            await new Promise(function(r) { setTimeout(r, 6000 + Math.floor(Math.random() * 6000)); });
          }
        }
        console.log("[manual-bulk-search] ✔ 完了");
      } catch (_be2) {
        console.error("[manual-bulk-search] エラー:", _be2.message || _be2);
      }
    })();
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

  var fillDonePromise = _createFillDoneWaiter("realnetpro", customerId, 90000);

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
      console.log("[scrape-compare] フォールバック → main.phpへ:", _scRealTab.id);
      await chrome.tabs.update(_scRealTab.id, { url: "https://www.realnetpro.com/main.php", active: true });
      await _batchWaitForTabComplete(_scRealTab.id);
      await new Promise(function(r) { setTimeout(r, _settleMs(1500)); });
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

  return await _scrapeAndSendRealpro(fillDonePromise, customerId, _scCustName, conditions);
}

async function _sbHandleCommand(payload) {
  var customerId   = String(payload.customerId   || payload.customer_id   || "");
  var customerName = String(payload.customerName || payload.customer_name || "");
  var conditions   = payload.conditions || {};
  var commandId    = payload.commandId  || null;
  if (!customerId) return;

  // スタッフモード中は Realtime コマンドを無視（claimしないので別PC or DBポーリングが処理する）
  if (await _isStaffModeActive()) {
    console.log("[SB-RT] スタッフモード中 → scrape_command を無視 (customerId=" + customerId + ")");
    return;
  }

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
  try { if (_auditTracker && runId) _auditTracker.step(runId, k, d); } catch (_) {}
}

function _auditFinish(runId, extra) {
  try {
    if (!_auditTracker || !runId) return;
    var t = _auditSingleTimers.get(runId);
    if (t) { clearTimeout(t); _auditSingleTimers.delete(runId); }
    var x = extra || {};
    if (x.error && x.error.message) x = Object.assign({}, x, { error: x.error.message });
    if (x.error && String(x.error) === "__BATCH_STOPPED__") x = Object.assign({}, x, { error_kind: "stopped" });
    _auditTracker.finish(runId, x);
  } catch (e) { console.warn("[search-audit] finish 失敗:", e && e.message); }
}

// fill-done に載ってきた audit を足す。知らない run_id（popup の個別の検索が作った回）はここで記録を作る
async function _auditOnFillDone(msg, sender) {
  try {
    if (!_auditTracker || !msg || !msg.runId) return;
    var run = _auditTracker.get(msg.runId);
    if (!run) {
      var st = await _auditState();
      if (!st.enabled) return;
      // popup が started を送り済み（post_started:false）
      // 2026-09-27: 広げてかどうかは popup の started が正（is_wide を入れている）。ここで既定の false を持つと finished が
      //   is_wide=false で上書きし、広げての個別の検索が「ピンポイント」と記録されていた（自動で広げる連鎖が誤って動く）
      //   → 覚え書き（popup の _auditTag が残す）から読み、分からなければ null（finished で送らない＝started の値のまま）
      var _sm = await _searchModeFor(msg.customerId, msg.site);
      run = _auditTracker.begin({ run_id: msg.runId, site: msg.site, customer_id: msg.customerId, trigger: "single", mode: st.mode, post_started: false, is_wide: _sm ? _sm === "widen" : null });
      var timer = setTimeout(function () { _auditSingleTimers.delete(msg.runId); _auditFinish(msg.runId, { error: null }); }, AUDIT_SINGLE_CLOSE_MS);
      _auditSingleTimers.set(msg.runId, timer);
    }
    var _pageErr = msg.pageError || msg.error || null;
    _auditTracker.attachFill(msg.runId, { audit: msg.audit || null, error: _pageErr });
    // 2026-09-29 見張り（C1・C2）: ここまで来た回はブレインモード（点検の記録がある回）だけ。待たない
    _watchAfterFill(msg, run, sender);
    // レインズは結果の読み取り（一括送信）が無いので fill-done で閉じる。個別の検索で失敗した時もここで閉じる
    if (run.site === "reins" || (run.trigger === "single" && _pageErr)) _auditFinish(msg.runId, {});
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
    w.resolve({ timedOut: false, error: error || null });
  });
  _fillDoneWaiters = _fillDoneWaiters.filter(function (w) { return sel.resolve.indexOf(w) < 0; });
}

// fill-done（自動入力完了の合図）を待つ上限。page-script 側のウォッチドッグより5秒長くする
// itandi は路線ごとに駅リストが切り替わり、「電車1本」の沿線全駅選択（13路線）で時間がかかるため150秒＋5秒（2026-09-12 竹内）
// 2026-09-14 竹内「時間かかっても大丈夫」: page-script のウォッチドッグ 240秒＋5秒
var FILL_DONE_TIMEOUT_MS = { itandi: 245000, realnetpro: 90000 };
function _fillDoneTimeoutMs(site) {
  return FILL_DONE_TIMEOUT_MS[site] || 90000;
}

function _createFillDoneWaiter(site, customerId, timeoutMs) {
  // 2026-09-18: この顧客を新しく待ち始める＝前回「捨てた」記録は用済み（再検索が詰まらないように消す）
  _clearFillDoneAbandoned(customerId, site);
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
      resolve({ timedOut: true, error: null, cancelled: !!extra });
    };
    entry.timer = setTimeout(onTimeout, timeoutMs || 90000);
    // 2026-09-27 v2.5.32: タブを読み直して1回やり直す時は待ちを始めから数え直す（_restartFillDoneWaiter）／
    //   検索しないと決めた時（タブが応答しない・地域が決まらない）は90秒を待たずに閉じる（_endFillDoneWaiter）
    entry.restart = function () { clearTimeout(entry.timer); entry.timer = setTimeout(onTimeout, timeoutMs || 90000); };
    entry.end = function (why) { onTimeout(why || "検索しない"); };
    _fillDoneWaiters.push(entry);
  });
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

// 2026-09-30 v2.5.43 同時の回（リアプロと ITANDI が同じお客様で並んで走る）: 待ち手はサイトも持ち、合図の送り主のタブの URL（site）で当てる。
//   site が分からない合図（旧の経路）は今までどおりお客様 ID だけで当てる（待ちが1本の時）
function _waiterSiteMatch(w, site) { return !site || !w.site || String(w.site) === String(site); }
function _notifyBatchCustomerDone(customerId, propertyCount, audit, site) {
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
    console.warn('[AX] _notifyBatchCustomerDone: no waiter matched for', customerId, site || "");
    return;  // resolve しない・タイムアウト自然消化
  }
  clearInterval(target.stopInterval);
  clearTimeout(target.timer);
  var _bdIdx = _batchCustomerDoneWaiters.indexOf(target);
  if (_bdIdx >= 0) _batchCustomerDoneWaiters.splice(_bdIdx, 1);
  // 2026-09-30 v2.5.42 ITANDI の「条件が効いていない形で止めた」（audit.guard）を待ち手に渡す（_scrapeAndSendRealpro → 1回だけ入れ直す）
  target.resolve({ ok: true, propertyCount: propertyCount != null ? propertyCount : null, guard: (audit && audit.guard_stopped && audit.guard) ? audit.guard : null });
}

function _createBatchCustomerDoneWaiter(customerId, timeoutMs, site) {
  return new Promise(function(resolve) {
    var entry = { customerId: customerId || null, site: site || null, resolve: resolve, timer: null, stopInterval: null, timeoutMs: timeoutMs || 300000 };
    var _expire = function() {
      clearInterval(entry.stopInterval);
      var idx = _batchCustomerDoneWaiters.indexOf(entry);
      if (idx >= 0) _batchCustomerDoneWaiters.splice(idx, 1);
      console.warn("[batch-done-waiter] " + entry.timeoutMs / 1000 + "秒（無進捗）タイムアウト customer=" + entry.customerId + (entry.site ? " site=" + entry.site : ""));
      _snapOnEvent("waiter_timeout", "全ページの送信の終わりの合図が " + entry.timeoutMs / 1000 + "秒来ない customer=" + entry.customerId + (entry.site ? " site=" + entry.site : ""));
      resolve({ timedOut: true });
    };
    // 「固定5分」→「無進捗5分」に変更:
    // 多ページの全ページ送信は5分を超えることがあり、固定タイムアウトのままだと
    // 送信中に次顧客の autofill が始まり検索リロードで送信が破壊されていた
    // （1顧客だけなら誰もページを触らないため完走する＝複数顧客のみ失敗する根本原因）。
    // bulk-dl.js / itandi-bulk-dl.js が送る axlx-batch-progress を受けるたびに延長する。
    entry.resetTimer = function() {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(_expire, entry.timeoutMs);
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
function _notifyBatchProgress(customerId, site) {
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
  targets.forEach(function (t) { if (t.resetTimer) t.resetTimer(); });
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
  var timer = setTimeout(function () { fire(null); }, limit);
  return {
    // phaseMs: その段だけの上限（条件の入力の段は進みの合図が無くロックが延びないので、ロックの15分より短く切る）
    race: function (p, phaseMs) {
      if (!phaseMs) return Promise.race([p, expired]);
      var pt = setTimeout(function () { fire("条件の入力の段が" + Math.round(phaseMs / 60000) + "分を超えた"); }, phaseMs);
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
var PASS_AUTOFILL_PHASE_MS = 8 * 60 * 1000;

// 撮影の許可（<all_urls>・optional_host_permissions）があるか
async function _snapCanCapture() {
  try { return await chrome.permissions.contains({ origins: ["<all_urls>"] }); } catch (_) { return false; }
}

async function _snapModeKey() {
  try {
    var core = self.AxlxModeCore;
    var raw = await chrome.storage.local.get(["staffMode", "staffModeAt", "aixMode", "brainMode"]);
    var st = core ? core.readState(raw, Date.now()) : { mode: raw.aixMode ? "aix" : "normal", brain: !!raw.brainMode };
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
        var dataUrl = await chrome.tabs.captureVisibleTab(picked[j].tab.windowId, { format: "jpeg", quality: 70 });
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
    // 検索の点検: page-script の audit（押せた・押せなかった駅・検索直前のフォームの読み戻し）をその回に足す（ブレインの時だけ）
    if (msg.runId) _auditOnFillDone(msg, _sender);
    // レインズは待ち（_createFillDoneWaiter）を作らないので解決しない（点検の記録だけ）
    if (msg.site !== "reins") _notifyFillDone(msg.site || null, msg.customerId || null, msg.error || null);
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  // 2026-09-30 v2.5.43 合図の送り主のタブ（realnetpro／itandi）＝どの待ち手・どの見張りの1本か（同時の回で取り違えない）
  var _msgSite = _siteOfSender(_sender, msg);
  if (msg && msg.type === "axlx-batch-customer-done") {
    // _scrapeAndSendRealpro の待機を解除して次顧客へ進む（propertyCount: 0 なら0件確定）
    // 検索の点検: ページ数・読んだ行数・送れる行数・0件の理由・件数表示の生の文字をその回に足す（待ちを解く前に＝閉じる前に届くように）
    _auditOnBatchDone(msg.customerId || null, msg.propertyCount != null ? msg.propertyCount : null, msg.audit || null);
    // 2026-09-29 v2.5.41 送付済みで飛ばした数（0件の知らせを「新しい物件なし」に言い分ける）
    if (msg.customerId != null) _lastSentSkipped[_sentSkipKey(msg.customerId, _msgSite)] = (msg.audit && msg.audit.sent_skipped) || 0;
    _notifyBatchCustomerDone(msg.customerId || null, msg.propertyCount != null ? msg.propertyCount : null, msg.audit || null, _msgSite);
    _watchProgress("送信の終わり", _msgSite);
    // Webアプリへの進捗通知は _runBatchSearch の顧客ループ完了後に一元化（リアプロ/itandi/レインズ全サイト対応）
  }
  if (msg && msg.type === "axlx-batch-progress") {
    // 全ページ送信の進捗ハートビート → 無進捗タイムアウトをリセット（次顧客への早すぎる移行を防ぐ）
    _notifyBatchProgress(msg.customerId || null, _msgSite);
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
    chrome.storage.local.get(["aixMode", "brainMode"]).then(function(st) {
      var core = self.AxlxModeCore;
      var mode = on ? "staff" : (st && st.aixMode ? "aix" : "normal");
      var b = core ? core.badge(mode, !!(st && st.brainMode)) : { text: on ? "手動" : "", color: "#16a34a" };
      chrome.action.setBadgeText({ text: b.text });
      if (b.text) chrome.action.setBadgeBackgroundColor({ color: b.color });
    }).catch(function() { /* ignore */ });
  } catch (e) { /* ignore */ }
}

// popup のトグル操作・TTL自動解除をバッジに即時反映
chrome.storage.onChanged.addListener(function(changes, area) {
  if (area === "local" && (changes.staffMode || changes.aixMode || changes.brainMode)) {
    _isStaffModeActive().then(_updateStaffModeBadge);
  }
});

// SW起動時にバッジを復元（TTL失効チェック込み）
_isStaffModeActive().then(_updateStaffModeBadge);

chrome.alarms.onAlarm.addListener(async function(alarm) {
  if (alarm.name !== "sumora-batch-poll") return;
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
    var _modeRaw = await chrome.storage.local.get(["staffMode", "staffModeAt", "aixMode", "brainMode"]);
    var _core = self.AxlxModeCore;
    var _modeSt = _core ? _core.readState(_modeRaw, Date.now()) : { mode: _modeRaw.aixMode ? "aix" : "normal", brain: !!_modeRaw.brainMode };
    var _bh = _core ? _core.behavior(_modeSt.mode, _modeSt.brain) : { claimCommands: true, claimAix: !!_modeRaw.aixMode, claimBrainCommands: false };
    if (!_bh.claimCommands) return;
    var _qs = [];
    if (_bh.claimAix) _qs.push("aix=1");
    if (_bh.claimBrainCommands) _qs.push("brain=1");
    // v2.5.48: リアプロのタブがログインの画面等（main.php が1つも無い）なら rp=0 → サーバーがリアプロを含む手の命令を少しの間ほかの PC に譲る
    //   （2026-09-30 YUMA の手の命令が2回ともログイン切れの PC に渡って AXLX_TAB_DEAD）。タブを読むだけ・サイトには触らない
    try {
      if (self.AxlxBatchGuard && self.AxlxBatchGuard.realproReady && self.AxlxBatchGuard.realproReady(await chrome.tabs.query({})) === false) _qs.push("rp=0");
    } catch (_) {}
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
      var scrapeCustomersRes = await fetch(SUMORA_BATCH_API + "/api/property-customers", { cache: "no-store" });
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
  var customersRes = await fetch(SUMORA_BATCH_API + "/api/property-customers", { cache: "no-store" });
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

  var batchErrors = []; // 修正12: サイト別の失敗を集約してサーバーへ可視化する

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
            _isMultiPass  // suppressZeroNotify: both顧客は呼び出し元が集計して1回通知
          ));
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
            _isMultiPass  // suppressZeroNotify: both顧客は呼び出し元が集計して1回通知
          ));
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
        _passFailed++;
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
        if (!_isMultiPass && self.AxlxBatchGuard && !_watchStopped) {
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
      var _interCustomerDelay = (autoSched && _AR) ? _AR.customerGapMs() : 3000 + Math.floor(Math.random() * 5000);
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
  // auditRun: 検索の点検の { runId, trigger, commandId }（ブレインの時だけ・無ければ null）。popup に渡し、popup を通らない経路では conditions に載せる
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
    tab = await chrome.tabs.create({ url: siteUrls[site], active: false });
    await _batchWaitForTabComplete(tab.id);
    await new Promise(function(r) { setTimeout(r, 1800 + Math.floor(Math.random() * 900)); });
  }
  // 2026-09-27 v2.5.32 竹内「重い順から治す」①: 拡張の読み直し・ログインのし直しの後の動かないタブをそのまま使わない（だめなら開き直す・それでもだめなら検索しない）
  if (site === "realnetpro") tab = await _ensureRealproTab(tab, auditRun, null, customer && customer.id);
  // v2.5.45 ITANDI も同じ: 一覧の画面でない・拡張の読み直しの後で中身が答えないタブは一覧を1回開き直す。それでもだめならこのサイトを飛ばす（理由を残す）
  if (site === "itandi") tab = await _ensureItandiTab(tab, auditRun, customer && customer.id);

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
            resolve({ ok: false, why: String(chrome.runtime.lastError.message || "lastError").slice(0, 120) }); return;
          }
          resolve({ ok: !!(resp && resp.ok), why: resp && resp.ok ? null : ("popup: " + ((resp && resp.reason) || "ok=false")) });
        });
      });
    };
    var _startTimeout = _G ? _G.FILL_START_TIMEOUT_MS : 25000;
    var _started = false;
    for (var _attempt = 0; _attempt < 2 && !_started; _attempt++) {
      if (_attempt > 0) {
        // 1回だけやり直す: タブを開き直し（main.php）・fill-done の待ちを数え直してから
        tab = await _ensureRealproTab(tab, auditRun, _lastWhy && /^popup|Receiving end|Could not establish/.test(_lastWhy) ? "content_script_dead" : "page_script_dead", _cidStr);
        _restartFillDoneWaiter("realnetpro", _cidStr);
      }
      // content.js に現在の顧客IDを事前通知（fill-done relay に customerId を付与するため）
      try { await chrome.tabs.sendMessage(tab.id, { type: "axlx-set-fill-customer", customerId: _cidStr }); } catch(_) {}
      var _startP = _createFillStartWaiter(_cidStr, _startTimeout);
      var _sw = await _sendSwitch();
      var _lastWhy = _sw.why;
      if (_sw.ok) {
        _started = await _startP;
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
        func: function(c) {
          window.postMessage({ from: "axlx-autofill-initiated" }, "*");
          window.postMessage({ from: "aixlinx-fill", conditions: c }, "*");
        },
        args: [conds]
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
    var batchItandiSwitched = await new Promise(function(resolve) {
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
          resolve(false); return;
        }
        resolve(!!(resp && resp.ok));
      });
    });
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
  return {
    is_wide: !!isWide, // 修正5: page-script 側の広ロジック（間取り拡張等）に伝搬
    // 2026-09-29 v2.5.39 通勤の到達時間で駅を選ぶ材料（_applyCommuteReach が読む。page-script は使わない）
    commute_station: c.commute_station || null,
    commute_minutes: c.commute_minutes || null,
    desired_area: c.desired_area || null,
    area_mode: (c.area_mode === 'both') ? null : (c.area_mode || null), // 'both'はnull(自動判定)にフォールバック
    rent_max: c.rent_max || null,
    rent_min: c.rent_min || null,
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
    max_pages: _arOpts ? (_arOpts.max_pages || null) : null
  };
}

function _batchWaitForTabComplete(tabId) {
  return new Promise(function(resolve) {
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
  return { url: url, pong: pong, page: pong && typeof resp.page === "boolean" ? resp.page : null, vis: pong && typeof resp.vis === "string" ? resp.vis : null, err: resp && resp.err ? String(resp.err).slice(0, 120) : null };
}

// 背面（hidden）のリアプロのタブを、そのウィンドウの中で前に出す（ウィンドウの前後・最小化は触らない）。
//   2026-09-27 点検 26: 背面のタブは入力に約10分かかり、fill-done の90秒を過ぎてから物件が届いた
async function _bringRealproTabFront(tab, runId, vis) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
    _auditStep(runId, "tab_front", "背面のタブ（" + vis + "）を前に出した");
    await new Promise(function (r) { setTimeout(r, _settleMs(600)); });
    var p = await _probeRealproTab(tab.id);
    if (p.vis === "hidden") _auditStep(runId, "tab_hidden", "前に出しても見えていない（ウィンドウが最小化・隠れている可能性）");
  } catch (e) { console.warn("[batchAutofill] タブを前に出せない:", e && e.message); }
}

// 使える状態のリアプロのタブを返す（だめなら main.php を開き直して1回だけ確かめ直す）。それでもだめなら投げる（検索しない）
async function _ensureRealproTab(tab, auditRun, why, customerId) {
  var G = self.AxlxBatchGuard;
  var runId = auditRun && auditRun.runId;
  var probe = await _probeRealproTab(tab.id);
  var plan = G ? G.realproTabPlan(probe) : { action: probe.pong ? "use" : "reload", reason: probe.pong ? "alive" : "content_script_dead" };
  if (plan.action === "use" && !why) {
    if (plan.front) await _bringRealproTabFront(tab, runId, probe.vis);
    return tab;
  }
  var reason = why || plan.reason;
  console.warn("[batchAutofill] リアプロのタブを読み直します: " + reason + (probe.err ? "（" + probe.err + "）" : "") + " url=" + String(probe.url).slice(0, 80));
  _auditStep(runId, "tab_reload", (G ? G.reasonJa(reason) : reason) + (probe.err ? " / " + probe.err : ""));
  if (probe.gone) {
    tab = await chrome.tabs.create({ url: "https://www.realnetpro.com/main.php", active: false });
  } else {
    await chrome.tabs.update(tab.id, { url: "https://www.realnetpro.com/main.php" });
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
    if (p.vis === "hidden") _auditStep(runId, "tab_hidden", "ITANDI: 前に出しても見えていない（ウィンドウが最小化・隠れている可能性）");
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
      // 必ずmain.phpへナビゲートしてフォームをクリーンな初期状態にする
      // ※ ping-skip最適化（alive時にナビゲーション省略）は廃止:
      //   検索結果ページ（フォームが折りたたまれた状態）のまま送信されると
      //   「所在地絞り込み」ボタンが見つからず中止になるバグを引き起こしていた
      console.log("[webapp-autofill] → main.php にナビゲート（フォームクリーン化）", targetRealTab.id);
      await chrome.tabs.update(targetRealTab.id, { url: siteUrls.realnetpro, active: true });
      await _batchWaitForTabComplete(targetRealTab.id);
      await new Promise(function(r) { setTimeout(r, 1800 + Math.floor(Math.random() * 900)); });
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
  var fillDonePromise = _createFillDoneWaiter("realnetpro", customerId, 90000);
  try {
    await _webappAutofill("realnetpro", mergedConditions);
    await _scrapeAndSendRealpro(fillDonePromise, customerId, customerName, mergedConditions);
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
var _scrapeLastOutcome = { timedOut: false };
// 2026-09-30 v2.5.43 同時の回: 直前の1回の結果はサイトごと（realnetpro／itandi）。_scrapeLastOutcome は最後に終わった物（旧の読み手のため残す）
var _scrapeOutcomeBySite = {};
function _scrapeOutcomeFor(site) { return _scrapeOutcomeBySite[site] || _scrapeLastOutcome; }
async function _scrapeAndSendRealpro(fillDonePromise, customerId, customerName, conditions, siteLabel, suppressZeroNotify) {
  var _site = siteLabel || "リアプロ";
  var _siteKey = siteLabel === "itandi" ? "itandi" : "realnetpro";
  // fill-done を待つ（検索実行完了シグナル）
  var fillDone = fillDonePromise ? await fillDonePromise : null;
  if (fillDone && fillDone.stopped) {
    throw new Error("__BATCH_STOPPED__");
  }
  if (!fillDone || fillDone.timedOut) {
    throw new Error(_site + " 検索完了シグナル（fill-done）が" + Math.round(_fillDoneTimeoutMs(siteLabel === "itandi" ? "itandi" : "realnetpro") / 1000) + "秒以内に届きませんでした。");
  }
  if (fillDone.error) {
    throw new Error("page-script側エラー（スキップ）: " + fillDone.error);
  }

  // fill-done 受信後、bulk-dl.js が axlx-autofill-initiated → autoSendAllPages → 全ページPDF送信
  // axlx-batch-customer-done シグナルで全ページ送信完了を待つ（最大5分）
  // これにより次顧客のautofillがページを書き換える前に現顧客の送信が確実に完了する
  console.log("[scrapeAndCompare] fill-done 受信 → 全ページ送信完了を待機 customer=" + customerId);
  var batchDone = await _createBatchCustomerDoneWaiter(customerId, 300000, _siteKey);
  if (batchDone && batchDone.stopped) {
    throw new Error("__BATCH_STOPPED__");
  }
  var _propCount = 0;
  var _out = { timedOut: false };
  _scrapeLastOutcome = _out;
  _scrapeOutcomeBySite[_siteKey] = _out;
  if (batchDone && batchDone.timedOut) {
    console.warn("[scrapeAndCompare] 全ページ送信完了シグナルが5分以内に届きませんでした（次顧客へ続行） customer=" + customerId);
    // 2026-09-25 竹内（検索の点検）: 5分の待ち切れは「0件」と限らない（読み取り・送信が途中で止まった）→ LINE では「⚠ 検索できなかった」に分ける。
    //   旧は「タイムアウト = 0件の可能性が高い」として「🔍【物件0件】」を送っていた（本当は検索できていない回も0件に見えた）
    // suppressZeroNotify=true の場合は呼び出し元が集計後に1回だけ通知するためここではスキップ
    _out.timedOut = true;
    var _toRun = _auditOpenRunId(customerId, siteLabel === "itandi" ? "itandi" : "realpro");
    if (_toRun) { _auditTracker.attachResult(_toRun, { batch_timed_out: true }); _auditStep(_toRun, "batch_timeout", "5分無進捗"); }
    if (!suppressZeroNotify && customerName) {
      fetch(SUMORA_BATCH_API + "/api/notify-group", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "⚠【検索できなかった】" + customerName + "さんの" + _site + "検索が途中で止まりました（結果を読み終わる合図が5分届かず・0件とは限りません）", group_key: "pickup_group_id" })
      }).catch(function() {});
    }
    _propCount = 0;
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
  var n = await _scrapeAndSendRealpro(fillDoneP2, cid, name, conds2 || _buildBatchConditions(o.customer, o.isWide, o.payload), "itandi", !!o.suppressZero);
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
