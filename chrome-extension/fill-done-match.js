// chrome-extension/fill-done-match.js
// 「この自動入力完了シグナル（fill-done）は、今待っている顧客のものか」を決める（純関数）。
//
// 2026-09-18 竹内「一括検索する際に情報ずれて、違うお客さんの条件で送られてしまっているバグ」
//
// 起きていたこと（3つ重なっていた）:
//   ①page-script.js は fill-done に顧客 ID を**載せていなかった**。中継する content.js が
//     「その時点の _pendingFillCustomerId」を付けていたので、**遅れて届いたシグナルに次の顧客の ID が付く**
//   ②background の照合が「片方でも ID が無ければ site だけで解決」＝ID があっても素通りできた
//   ③ID の無いシグナルが「最古の待ち」を解決していた（別顧客の待ちでも解決できた）
//   → 顧客Aの待ちがタイムアウト → 次へ → Aの fill-done が遅れて到着 → **Bの待ちを解決** →
//     まだ検索が終わっていない画面を「Bの結果」としてスクレイプ・送信
//
// 直し: 誰の入力かを**送る側（page-script）**が持ち、そのまま返す。受ける側は一致しない限り解決しない。
//   さらにタイムアウトで捨てた顧客 ID を覚え、遅れて届いた分を無視する。
// 設計知見「rowKey は URL の ID を使う（位置ではなく）」＝ その時の状態ではなく対象そのものに紐づける。

(function (root) {
  "use strict";

  /**
   * 待ち（waiter）とシグナルが同じ相手か。
   * ・site は両方あれば一致が必要
   * ・待ちが顧客 ID を持っているなら**必ず一致**（旧: 片方 null なら素通り）
   * ・待ちが ID を持たない（旧経路・reins）時だけ、ID 無しのシグナルで解決してよい
   */
  function matchesWaiter(waiter, signal) {
    var w = waiter || {}, s = signal || {};
    var siteMatch = !w.site || !s.site || w.site === s.site;
    if (!siteMatch) return false;
    if (w.customerId) return !!s.customerId && String(w.customerId) === String(s.customerId);
    return !s.customerId; // ID を持たない待ちは、ID 無しのシグナルだけで解決する
  }

  /**
   * このシグナルで解決してよい待ちを選ぶ。
   * ・捨てた顧客（タイムアウト済み）の遅延シグナルは何も解決しない
   * ・ID 無しのシグナルは「ID を持たない待ち」の最古1件だけ
   */
  function selectWaiters(waiters, signal, abandonedIds) {
    var list = Array.isArray(waiters) ? waiters : [];
    var s = signal || {};
    if (s.customerId && abandonedIds && abandonedIds.has && abandonedIds.has(String(s.customerId))) {
      return { resolve: [], reason: "abandoned" };
    }
    var hit = list.filter(function (w) { return matchesWaiter(w, s); });
    if (!s.customerId) hit = hit.slice(0, 1); // ID 無しは最古1件だけ
    return { resolve: hit, reason: hit.length ? "matched" : "no-match" };
  }

  var api = { matchesWaiter: matchesWaiter, selectWaiters: selectWaiters };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AxlxFillDoneMatch = api;
})(typeof self !== "undefined" ? self : globalThis);
