// chrome-extension/customer-handoff.js
// 「1人のお客さんが終わってから次のお客さんへ」を決める（純関数・テストあり）。
//
// 2026-11-18 竹内さん「今自動モードでしていたら次のお客さんが入ってきてバグ起きたのか地域の途中で止まってしまった。
//   お客さん検索中や選択中上書きしないように ちゃんと１人のお客さん完了してから次のお客さんに移るように ここの部分弱いので強化する 必要なら土台も作る」
//
// 実測（search_audits 1488→1489・human_motion_learn）:
//   ① 自動が大阪市都島区を押した change を「人の操作」と取り違えて human_takeover で止めた（1/9区）
//   ② background は関所の止まりを全部「このお客様は飛ばして次へ」にしていたので、1秒後に次のお客さん（大村）を開始
//   ③ 大村さんの入力が始まる前（08:02:30）に、前に残っていた「検索した印」で画面の一覧の印刷用PDFを押し、大村さんの名前で1件共有した
//
// 決まり:
//   ・人が引き取った／別のお客さんの入力中に来た → 一括を止める（次へ進まない）
//   ・タブで別のお客さんの入力が進んでいる間は、次のお客さんを入れない（待つ・待ちきれなければ見送る＝上書きしない）
//   ・「検索した印」は、その後に新しいお客さんの入力が始まっていたら使わない（前の一覧を次のお客さんの名前で送らない）

(function (root) {
  "use strict";

  /** 一括を止める（次のお客さんへ進まない）関所の種類 */
  var HOLD_GATES = ["human_takeover", "busy_other_customer"];

  function gateHoldsBatch(kind) {
    return HOLD_GATES.indexOf(String(kind || "")) >= 0;
  }

  /** タブで前のお客さんの入力が続いている時に待つ上限（入力は人の速さで数分かかる） */
  var OTHER_FILL_WAIT_MS = 10 * 60 * 1000;

  /**
   * 次のお客さんの入力をタブに送ってよいか。
   * @param {{fillRunning?: boolean, fillCustomerId?: string|null}|null} probe タブへの問い合わせの答え
   * @param {string} nextCid これから始めるお客さん
   * @param {number} waitedMs 待ち始めてからの時間
   * @returns {"go"|"wait"|"give_up"}
   */
  function tabHandoffDecision(probe, nextCid, waitedMs, maxWaitMs) {
    var p = probe || {};
    if (!p.fillRunning) return "go";
    if (!nextCid || String(p.fillCustomerId || "") === String(nextCid)) return "go";
    /**
     * ★ 2026-11-19 (2.8.126) audit 1533/1535: 入力中なのに**誰の入力か分からない**（番号なし＝人の手動の単発など）時、
     *   旧は「同じお客さん」とみなして "go" → 一括が人の入力の途中でタブを読み直して壊した（画面更新されて止まった）。
     *   → 番号が無くても、これから始める自分の入力はまだ始まっていないので、入力中のものは**別の入力**。
     *     ただし番号なしの印が古いまま残る場合に永久に待たないよう、番号なしだけは上限を短く（3分・ページの無進捗の上限と同じ）。
     */
    if (!p.fillCustomerId) {
      var ulim = typeof maxWaitMs === "number" ? Math.min(maxWaitMs, FILL_ALIVE_IDLE_MS) : FILL_ALIVE_IDLE_MS;
      return (Number(waitedMs) || 0) < ulim ? "wait" : "go";
    }
    var limit = typeof maxWaitMs === "number" ? maxWaitMs : OTHER_FILL_WAIT_MS;
    return (Number(waitedMs) || 0) < limit ? "wait" : "give_up";
  }

  /** ページの中: 入力が「進んでいる」とみなす無進捗の上限（これを超えたら止まった入力として閉じてよい） */
  var FILL_ALIVE_IDLE_MS = 3 * 60 * 1000;

  /**
   * ページの中で入力中に別のお客さんの依頼が来た時。
   * @returns {"start"|"duplicate"|"reject_busy"|"supersede_stale"}
   */
  function pageIncomingDecision(s) {
    var o = s || {};
    if (!o.running || o.done) return "start";
    var run = o.runCid ? String(o.runCid) : null;
    var inc = o.newCid ? String(o.newCid) : null;
    // 片方だけ番号が無い＝同じお客さんと確かめられない（audit 1494: 平田さん入力中に番号無しの依頼で上書き）→ 別の人として扱う
    if ((!run && !inc) || run === inc) return "duplicate";
    var idle = (Number(o.now) || 0) - (Number(o.lastTouchAt) || 0);
    return idle < (typeof o.aliveIdleMs === "number" ? o.aliveIdleMs : FILL_ALIVE_IDLE_MS) ? "reject_busy" : "supersede_stale";
  }

  /** 「検索した印」が古いとみなす時間（bulk-dl Case C の旧の線と同じ 10分） */
  var PENDING_FLAG_MAX_AGE_MS = 10 * 60 * 1000;
  var BUSY_MAX_AGE_MS = 20 * 60 * 1000;

  /**
   * ページの読み直し後に「検索した印」で一覧を押してよいか。押してはいけない時は理由を返す（null＝押してよい）。
   * @param {{ts?: number, customerId?: string|null}|null} flag axlx_pending_auto_send
   * @param {{at?: number, customerId?: string|null}|null} busy axlx_fill_busy（入力を始めた印）
   * @param {string|null} nowCid 今のお客さん
   */
  function pendingFlagBlockReason(flag, busy, nowCid, now) {
    if (!flag || typeof flag !== "object") return "no_flag";
    var t = Number(now) || 0;
    var ts = Number(flag.ts) || 0;
    if (ts && t - ts > PENDING_FLAG_MAX_AGE_MS) return "stale";
    if (busy && typeof busy === "object") {
      var bat = Number(busy.at) || 0;
      if (bat && t - bat < BUSY_MAX_AGE_MS) {
        if (bat > ts) return "newer_customer_started";
        if (flag.customerId && busy.customerId && String(flag.customerId) !== String(busy.customerId)) return "busy_other_customer";
      }
    }
    if (flag.customerId && nowCid && String(flag.customerId) !== String(nowCid)) return "customer_changed";
    return null;
  }

  var api = {
    HOLD_GATES: HOLD_GATES,
    OTHER_FILL_WAIT_MS: OTHER_FILL_WAIT_MS,
    FILL_ALIVE_IDLE_MS: FILL_ALIVE_IDLE_MS,
    gateHoldsBatch: gateHoldsBatch,
    tabHandoffDecision: tabHandoffDecision,
    pageIncomingDecision: pageIncomingDecision,
    pendingFlagBlockReason: pendingFlagBlockReason,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AxlxCustomerHandoff = api;
})(typeof self !== "undefined" ? self : globalThis);
