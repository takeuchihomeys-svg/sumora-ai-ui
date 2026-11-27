/**
 * 一括検索パネル把握文（app/lib/bulk-panel-grasp.ts の写し・MAIN/SW 共用）
 * 2026-11-23 竹内さん「誰を一括で／何件／次の客／把握できているか」を枠に出す
 * ★ 2.8.227: いまの行動（リセットで空を確かめている最中）を now に出す
 * ★ 2.8.228: task_now（間取外:2LDK 等）があれば now に優先
 */
(function (root) {
  function nm(s) {
    var t = String(s || "").replace(/\s+/g, "").trim();
    if (!t) return "";
    return /さん$/.test(t) ? t : t + "さん";
  }
  /**
   * ★ 2.8.319 手順書と同じ言葉。★ 2.8.323: 正本は流れの地図（app/lib/loop-flow-map.ts の各手の panel）。
   * 下の BEGIN〜END は scripts/gen-panel-words.ts が作る。手で直さない（直すと試験 panel-from-flow-map が止める）。
   */
  /* PANEL_WORDS:BEGIN */
  var PANEL_PHASE_WORDS = {
    reset: { now: "リセットを押す最中", next: "{after}の条件をAPIから読み直して入れる" },
    fill: { now: "条件を入れている最中", next: "検索を押す" },
    search: { now: "検索を押す最中", next: "並べ替え（検索確認から40〜50秒後）" },
    sort: { now: "並べ替え最中", next: "物件取得（全部送付済みなら次ページへ）" },
    list: { now: "物件取得最中", next: "全部送付済みなら次ページへ・無ければ客完了" },
    all_sent: { now: "全部送付済み→次ページへ", next: "次ページ（無ければ客完了→リセット）" },
    next_page: { now: "次ページへ移動中", next: "物件取得（送付済み以外の行）" },
    done: { now: "客完了→リセットへ", next: "リセットを押して30〜34秒待つ" }
  };
  /* PANEL_WORDS:END */
  // ★ 2.8.329 英字だけの内部の段名（handoff 等）は日本語にするか出さない（app/lib/bulk-panel-grasp.ts と同じ）
  var RAW_PHASE_JA = {
    handoff: "客完了→次のお客さんへ",
    ready_next: "客完了→次のお客さんへ",
    list_done: "物件取得完了",
    clear: PANEL_PHASE_WORDS.reset.now,
    next_clear: PANEL_PHASE_WORDS.reset.now,
    fill: PANEL_PHASE_WORDS.fill.now,
    search: PANEL_PHASE_WORDS.search.now,
    sort: PANEL_PHASE_WORDS.sort.now,
    list: PANEL_PHASE_WORDS.list.now
  };
  /** ★ 2.8.329 リセットの「つぎ」は誰の条件か（入れる前＝いまの客・送付のあと＝次の客） */
  function resetAfterName(cur, nxt, resetPos) {
    if (resetPos === "pre_fill") return cur || "このお客さん";
    return nxt || "次のお客さん";
  }
  function fillAfter(text, afterName) {
    return String(text || "").split("{after}").join(afterName || "次のお客さん");
  }
  function playbookAction(a) {
    var t = String(a || "");
    if (/^[a-z][a-z_]*$/.test(t)) return RAW_PHASE_JA[t] || "";
    if (/リセットで空を確かめ|外している最中|外し中/.test(t)) return PANEL_PHASE_WORDS.reset.now;
    if (/新しい条件を入れている最中/.test(t)) return PANEL_PHASE_WORDS.fill.now;
    return t;
  }
  function playbookMove(m) {
    var t = String(m || "");
    if (/次ページ|送付済み|客完了|リセット|API/.test(t)) return t;
    if (/外す|外して|物件取得完了/.test(t)) return PANEL_PHASE_WORDS.done.next;
    if (/新しいお客さんの条件|条件を1つ/.test(t)) return PANEL_PHASE_WORDS.reset.next;
    return t;
  }
  function actionFromMove(move) {
    var m = String(move || "");
    if (/リセット/.test(m)) return PANEL_PHASE_WORDS.reset.now;
    if (/次ページ|送付済み/.test(m)) return PANEL_PHASE_WORDS.all_sent.now;
    if (/外す/.test(m)) return PANEL_PHASE_WORDS.reset.now;
    if (/入れ|条件を1つ/.test(m)) return PANEL_PHASE_WORDS.fill.now;
    if (/並べ替え/.test(m)) return PANEL_PHASE_WORDS.sort.now;
    if (/検索を押/.test(m)) return PANEL_PHASE_WORDS.search.now;
    if (/物件|取得/.test(m)) return PANEL_PHASE_WORDS.list.now;
    return null;
  }
  function formatBulkPanelGrasp(g) {
    if (!g || !(Number(g.total) > 0)) return null;
    var total = Math.floor(Number(g.total));
    var index = Math.max(0, Math.floor(Number(g.index) || 0));
    var cur = nm(g.currentName);
    var nxt = nm(g.nextName);
    var graspOk = !!(cur || index === 0) && total > 0;
    var move = playbookMove(String(g.nextMove || "").trim().slice(0, 40)).slice(0, 40);
    var taskNow = playbookAction(String(g.taskNow || "").trim().slice(0, 28)).slice(0, 28);
    var act =
      taskNow ||
      playbookAction(String(g.currentAction || "").trim().slice(0, 28)).slice(0, 28) ||
      actionFromMove(move) ||
      (g.waitingFor ? String(g.waitingFor).slice(0, 28) : "");
    var now = "";
    if (index <= 0) now = "一括" + total + "人を把握（開始前）";
    else if (act) now = (cur ? cur + "／" : "") + act + "（" + index + "/" + total + "）";
    else if (cur) now = cur + "を検索中（" + index + "/" + total + "）";
    else now = "一括 " + index + "/" + total + "（客名未把握）";
    var resetting = /外して/.test(act) || /外す/.test(act) || /外:/.test(act) || /間取外/.test(act) || /リセットを押/.test(act);
    var afterName = resetAfterName(cur, nxt, g.resetPos);
    var next = "";
    if (resetting && g.resetPos === "pre_fill") {
      next = "次の動き:" + fillAfter(PANEL_PHASE_WORDS.reset.next, afterName) + (nxt ? "／その次の客は " + nxt : "");
    } else {
      if (nxt) next = "次は " + nxt;
      else if (index >= total && index > 0) next = "一括の最後（次の客なし）";
      else if (index <= 0) next = "最初の客へ";
      else next = "次の客を把握中…";
      if (move || resetting) {
        if (resetting) {
          next += (next ? "／" : "") + "次の動き:" + fillAfter(PANEL_PHASE_WORDS.reset.next, afterName);
        } else {
          next += (next ? "／" : "") + "次の動き:" + fillAfter(move, afterName);
        }
      }
    }
    var grasp =
      "一括" + total + "人" + (graspOk ? " ✓把握" : " ✗未把握") +
      (cur ? "／いま" + cur.replace(/さん$/, "") : "") +
      (act ? "／行" + act.slice(0, 10) : "") +
      (nxt ? "／次" + nxt.replace(/さん$/, "") : index >= total && index > 0 ? "／次なし" : "") +
      (move ? "／動" + fillAfter(move, afterName).slice(0, 12) : "");
    return { now: now, next: next, grasp: grasp, graspOk: graspOk };
  }
  function bulkGraspFromQueue(names, index0, waitingFor, nextMove, currentAction, taskNow) {
    names = names || [];
    var total = names.length;
    var i = Math.max(0, Math.min(Number(index0) || 0, Math.max(0, total - 1)));
    if (total === 0) {
      return {
        total: 0, index: 0, currentName: "", nextName: "",
        waitingFor: waitingFor || null, nextMove: nextMove || null,
        currentAction: currentAction || null, taskNow: taskNow || null,
      };
    }
    return {
      total: total,
      index: i + 1,
      currentName: names[i] || "",
      nextName: i + 1 < total ? names[i + 1] || "" : "",
      waitingFor: waitingFor || null,
      nextMove: nextMove || null,
      currentAction: currentAction || null,
      taskNow: taskNow || null,
    };
  }
  var api = { formatBulkPanelGrasp: formatBulkPanelGrasp, bulkGraspFromQueue: bulkGraspFromQueue, PANEL_PHASE_WORDS: PANEL_PHASE_WORDS, resetAfterName: resetAfterName, fillAfter: fillAfter };
  if (typeof self !== "undefined") self.AxlxBulkPanelGrasp = api;
  if (typeof window !== "undefined") window.AxlxBulkPanelGrasp = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : this);
