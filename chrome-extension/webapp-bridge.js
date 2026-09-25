"use strict";
// webapp-bridge.js
// sumora-ai-ui.vercel.app 向け content script
// WebApp の window.postMessage を background.js の chrome.runtime.sendMessage に橋渡しする
//
// 2026-09-25 竹内「文法の誤り直す」:
//   2026-08-10（497a94e9）に見積書自動モードの枝で `var site` を足した時、同じ関数の下の方に `const { site }` が
//   あって「同じ名前の二重の宣言」になり、このファイルは読み込みの時点で SyntaxError だった（1行も動かない）。
//   ＝ 8/10〜9/25 の約6週間、ウェブアプリ→拡張の橋渡しは全部止まっていて、ウェブアプリは
//   「拡張の返事が 1.5秒来ない → キュー（automation_commands）に入れる」の予備の道だけで動いていた。
//   直すと止まっていた道が急に動き出すので、1つずつ「今動いて害が無いか」を確かめて、危ない道は止めたままにした
//   （各枝のコメント・tests/chrome-extension/webapp-bridge.test.js）。拡張の全ファイルは `node --check` を通すこと。

const ALLOWED_ORIGINS = [
  "https://sumora-ai-ui.vercel.app",
  "http://localhost:3000"
];

// ── ウェブアプリから拡張への「直接の検索」（aixlinx-webapp / aixlinx-webapp-scrape）──────────────
// false の間は返事（ACK）もせず background にも渡さない＝ウェブアプリは 1.5秒後にキューへ入れ、
// すぐ下の poll-now で拡張がキューを即座に拾う（6週間の本番と同じ道・速さもほぼ同じ）。
// 止めた理由（2026-09-25 に1つずつ確かめた）:
//   ① 直接の道は background の axlx-webapp-search / axlx-scrape-and-compare に入り、キューの道にある
//      歯止め（スタッフモードなら拾わない・batchRunning のロック中は走らない・自分でロックを取る）が無い。
//      スタッフモードの PC でボタンを押すと、この PC が検索→自動送信まで進めてしまう。
//   ② 要対応一括検索（customers/page.tsx の startBatchSearch・flagged）はキューに全員を入れた上で、
//      1人目にも直接の検索（auto_send_all）を出す作り。直接の道が生きると同じお客様の検索が2本同時に
//      同じリアプロのタブで走る（8/12 に通常の一括で「条件混線」として外したのと同じ形）。
//      しかも1人終わるごとの axlx-batch-customer-done で次の人の直接の検索がまた出て、キューの一括とぶつかる。
//   ③「地域＋駅（both）」のお客様は、直接の道だと 10秒後に同じサイトへ2本目（station）を出す＝1本目の途中で上書き。
//      キューの道は1本（area_mode は拡張の自動判定）。
// 戻す時は、background の2つの受け口にキューと同じ歯止め（スタッフ・ロック・ロックを取る）を入れ、
// ウェブアプリ側の②③の二重の発火を消してから true にする。
const DIRECT_SEARCH_ENABLED = false;

window.addEventListener("message", (e) => {
  // ① origin 検証: 許可済みオリジン以外は即リターン
  if (!ALLOWED_ORIGINS.includes(e.origin)) return;
  // 同じページの自分の window から来た物だけ（ページに埋め込まれた iframe などからの postMessage は受けない）
  if (e.source !== window) return;

  // ── poll-now: automation_commands INSERT直後にアラーム30秒待ちをスキップ ──
  // 動かす: background はスタッフモードなら断り、ロック中も断る。キューの取り合いはサーバーの claim（1件を1台だけ）で、
  //   同じ PC で2回続けて押した時に別々のコマンドを並べて走らせないよう background の _pollAndRunBatch に
  //   「拾っている最中は2本目を始めない」を足した（2026-09-25）。
  if (e.data && e.data.from === "aixlinx-webapp-poll-now") {
    chrome.runtime.sendMessage({ type: "axlx-poll-now" }, () => {
      void chrome.runtime.lastError; // ignore if no listener
    });
    return;
  }

  // ── scrape-and-compare: リアプロ自動スクレイプ+比較の直接トリガー ──
  // Supabase automation_commands 経由より高速・条件は拡張側で resolve（popupと同等）
  if (e.data && e.data.from === "aixlinx-webapp-scrape") {
    // 止めている（DIRECT_SEARCH_ENABLED の説明）: ACK を返さない＝ウェブアプリはキュー（scrape_and_compare）＋poll-now に進む
    if (!DIRECT_SEARCH_ENABLED) return;
    const { customerId, customerName, isWide, conditions } = e.data;
    // 即時ACKを返してwebappに拡張の存在を通知（フォールバック判定用）
    try { window.postMessage({ from: "aixlinx-webapp-scrape-ack", customerId }, "*"); } catch (_) {}
    chrome.runtime.sendMessage(
      { type: "axlx-scrape-and-compare", customerId, conditions: Object.assign({}, conditions, { customerName, isWide: !!isWide }) },
      (resp) => {
        void chrome.runtime.lastError;
        window.postMessage({
          from: "aixlinx-webapp-scrape-result",
          customerId,
          ok:    resp?.ok    ?? false,
          count: resp?.count ?? 0,
          error: resp?.error ?? null,
        }, "*");
      }
    );
    return;
  }

  // ── estimate-auto: 見積書自動モード（物件詳細ページを自動スクレイプ）──────
  // 動かす: 見積書の画面で「自動」を押し、物件名が読めなかった時だけ（旧フロー）。開いている詳細タブを読むだけ（押さない・遷移しない）
  // 2026-09-25: ここの `var site` が下の `const { site }` と二重の宣言になりファイル全体が SyntaxError だった → estimateSite に改名
  if (e.data && e.data.from === "aixlinx-webapp-estimate-auto") {
    var estimateSite = e.data.site || "unknown";
    chrome.runtime.sendMessage(
      { type: "axlx-estimate-auto", site: estimateSite },
      function(resp) {
        void chrome.runtime.lastError;
        if (resp && resp.ok) {
          window.postMessage({ from: "aixlinx-estimate-data", text: resp.text }, "*");
        } else {
          window.postMessage({ from: "aixlinx-estimate-error", error: (resp && resp.error) || "不明なエラー" }, "*");
        }
      }
    );
    return;
  }

  // ── estimate-search: 物件名+号室でリアプロ自動検索（新フロー）────────────
  // 動かす: 見積書の画面で「自動」を押した時だけ。リアプロの main.php のタブでフリーワード検索を押すので、
  //   一括検索が同じタブで走っている時は background が断る（batchRunning のロック・2026-09-25 に足した）
  if (e.data && e.data.from === "aixlinx-webapp-estimate-search") {
    var propName = e.data.propertyName || "";
    var roomNum = e.data.roomNumber || "";
    chrome.runtime.sendMessage(
      { type: "axlx-estimate-realpro-search", propertyName: propName, roomNumber: roomNum },
      function(resp) {
        void chrome.runtime.lastError;
        if (resp && resp.ok) {
          window.postMessage({ from: "aixlinx-estimate-search-data", text: resp.text }, "*");
        } else {
          window.postMessage({ from: "aixlinx-estimate-search-error", error: (resp && resp.error) || "取得に失敗しました" }, "*");
        }
      }
    );
    return;
  }

  // ── pending-supplementary: ポップアップ経由で保存された補足情報を取得 ────
  // 動かす: 見積書の画面が ?pendingSupp=1 で開かれた時だけ頼まれる。6週間分の読み残しが古いまま入らないよう、
  //   background は保存から10分を過ぎた物（時刻の無い古い形も）は渡さずに消す（2026-09-25）
  if (e.data && e.data.from === "aixlinx-webapp-request-pending-supplementary") {
    chrome.runtime.sendMessage({ type: "axlx-get-pending-supplementary" }, function(resp) {
      void chrome.runtime.lastError;
      if (resp && resp.ok && resp.text) {
        window.postMessage({ from: "aixlinx-estimate-pending-supplementary", text: resp.text }, "*");
      }
    });
    return;
  }

  // ② ペイロード検証
  if (!e.data || e.data.from !== "aixlinx-webapp") return;
  // 止めている（DIRECT_SEARCH_ENABLED の説明）: 受領 ACK（aixlinx-webapp-received）も返さない＝
  //   ウェブアプリの queuePropertySearch は 1.5秒後に /api/automation/trigger → poll-now に進む。
  //   要対応一括（auto_send_all）はもともとキューに全員入っているので、ここで捨てても抜けは出ない。
  //   app/page.tsx の条件パネルの「🔍 物件検索」（customerId の無い形）は予備の道が無く、止まっていた6週間と同じく何もしない
  if (!DIRECT_SEARCH_ENABLED) return;
  const { site, conditions } = e.data;
  if (!site || !conditions) return;

  console.log("[webapp-bridge] site=" + site + " conditions=", conditions);

  // 修正6: 拡張が同一ブラウザに存在することを WebApp に即時通知する受領ACK。
  // WebApp（queuePropertySearch）はこのACKを受け取ったらキュー投入をスキップして二重実行を防ぐ
  try {
    window.postMessage({ from: "aixlinx-webapp-received", site: site }, "*");
  } catch (_e) { /* ignore */ }

  const auto_send_all = !!(e.data.auto_send_all);
  chrome.runtime.sendMessage(
    { type: "axlx-webapp-search", site, conditions, auto_send_all },
    (resp) => {
      if (chrome.runtime.lastError) {
        console.warn("[webapp-bridge] sendMessage error:", chrome.runtime.lastError.message);
        return;
      }
      console.log("[webapp-bridge] background response:", resp);
    }
  );
});

// 動かす: background の一括（_runBatchSearch）が1人終わるごとに customerId 無しで送ってくる → 顧客リストの一括の進み具合。
//   要対応一括では画面が次の人の直接の検索を出すが、上で止めているので検索は増えない（進み具合の表示だけ）。
//   ⚠ 画面（customers/page.tsx の onBatchCustomerDone）は一括中かを見ずに進めるので、画面で一括を始めていない時に
//   自動便などが走ると「全員分の検索が完了しました！」が出る（表示だけ・操作は起きない）。画面側で batchMode を見るのが直し方
chrome.runtime.onMessage.addListener(function(msg) {
  if (msg && msg.type === "axlx-batch-customer-done") {
    window.postMessage({ from: "aixlinx-batch-customer-done", customerId: msg.customerId || null }, "*");
  }
});
