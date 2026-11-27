/**
 * 一括検索パネル用の把握文（決定論・LLMなし）
 *
 * 2026-11-23 竹内さん「誰を一括で検索するのか／合計何件／次のお客さんは誰か／理解できているのか
 *   を拡張ツールの部分に表示する」
 * ★ 2.8.227: いまの行動（外している最中／入れている最中）を now に出す
 * ★ 2.8.228: task_now（間取外:2LDK 等）があれば now に優先
 */

/**
 * ★ 2.8.319 竹内さん「拡張ツールに表示されているアナウンスの部分もちゃんと手順書とあわせる（確認できるから）」:
 *   パネルの「いま／つぎ」に出す言葉は、手順書（action-playbook.ts の手）と同じ言葉に揃える。
 *   手順書の手の文にも同じ言葉を入れてある（試験 bulk-panel-playbook-sync が両方に在るか見張る）。
 *   JS の写し: chrome-extension/bulk-panel-grasp.js の PANEL_PHASE_WORDS（同じ言葉・試験で一致を見る）。
 */
export const PANEL_PHASE_WORDS = {
  reset: { now: "リセットを押して待っている最中", next: "次客の条件をAPIから読み直して入れる" },
  fill: { now: "条件を入れている最中", next: "検索を押す" },
  search: { now: "検索を押す最中", next: "並べ替え（検索確認から40〜50秒後）" },
  sort: { now: "並べ替え最中", next: "物件取得（全部送付済みなら次ページへ）" },
  list: { now: "物件取得最中", next: "全部送付済みなら次ページへ・無ければ客完了" },
  all_sent: { now: "全部送付済み→次ページへ", next: "次ページ（無ければ客完了→リセット）" },
  next_page: { now: "次ページへ移動中", next: "物件取得（送付済み以外の行）" },
  done: { now: "客完了→リセットへ", next: "リセットを押して30〜34秒待つ" },
} as const;

/** 古い内部の言葉（page-script／bulk-dl が出す）を、手順書と同じ言葉に直して見せる */
function playbookAction(a: string): string {
  const t = String(a || "");
  if (/外している最中|外し中/.test(t)) return PANEL_PHASE_WORDS.reset.now;
  if (/新しい条件を入れている最中/.test(t)) return PANEL_PHASE_WORDS.fill.now;
  return t;
}
function playbookMove(m: string): string {
  const t = String(m || "");
  if (/次ページ|送付済み|客完了|リセット|API/.test(t)) return t;
  if (/外す|外して|物件取得完了/.test(t)) return PANEL_PHASE_WORDS.done.next;
  if (/新しいお客さんの条件|条件を1つ/.test(t)) return PANEL_PHASE_WORDS.reset.next;
  return t;
}

export type BulkPanelGraspInput = {
  total: number;
  /** 1始まり。0=まだ誰も始めていない */
  index: number;
  currentName?: string | null;
  nextName?: string | null;
  waitingFor?: string | null;
  /** ★ 2.8.219: 次の動き（外す／賃料1つ／検索 等） */
  nextMove?: string | null;
  /** ★ 2.8.227: いまの行動（外している最中 等） */
  currentAction?: string | null;
  /** ★ 2.8.228: いまの1タスク（間取外:2LDK／入れる:賃料 等） */
  taskNow?: string | null;
};

export type BulkPanelGraspLines = {
  now: string;
  next: string;
  grasp: string;
  graspOk: boolean;
};

function nm(s: string | null | undefined): string {
  const t = String(s || "").replace(/\s+/g, "").trim();
  if (!t) return "";
  return /さん$/.test(t) ? t : t + "さん";
}

function actionFromMove(move: string): string | null {
  const m = String(move || "");
  if (/リセット/.test(m)) return PANEL_PHASE_WORDS.reset.now;
  if (/次ページ|送付済み/.test(m)) return PANEL_PHASE_WORDS.all_sent.now;
  if (/外す/.test(m)) return PANEL_PHASE_WORDS.reset.now;
  if (/入れ|条件を1つ/.test(m)) return PANEL_PHASE_WORDS.fill.now;
  if (/並べ替え/.test(m)) return "並べ替え最中";
  if (/検索を押/.test(m)) return "検索を押す最中";
  if (/物件|取得/.test(m)) return "物件取得最中";
  return null;
}

/** パネル「いま／つぎ／把握」の3行を作る */
export function formatBulkPanelGrasp(g: BulkPanelGraspInput | null | undefined): BulkPanelGraspLines | null {
  if (!g || !(Number(g.total) > 0)) return null;
  const total = Math.floor(Number(g.total));
  const index = Math.max(0, Math.floor(Number(g.index) || 0));
  const cur = nm(g.currentName);
  const nxt = nm(g.nextName);
  const graspOk = !!(cur || index === 0) && total > 0;
  const move = playbookMove(String(g.nextMove || "").trim().slice(0, 40)).slice(0, 40);
  const taskNow = playbookAction(String(g.taskNow || "").trim().slice(0, 28)).slice(0, 28);
  const act =
    taskNow ||
    playbookAction(String(g.currentAction || "").trim().slice(0, 28)).slice(0, 28) ||
    actionFromMove(move) ||
    (g.waitingFor ? String(g.waitingFor).slice(0, 28) : "");

  let now = "";
  if (index <= 0) {
    now = "一括" + total + "人を把握（開始前）";
  } else if (act) {
    now = (cur ? cur + "／" : "") + act + "（" + index + "/" + total + "）";
  } else if (cur) {
    now = cur + "を検索中（" + index + "/" + total + "）";
  } else {
    now = "一括 " + index + "/" + total + "（客名未把握）";
  }

  let next = "";
  if (nxt) next = "次は " + nxt;
  else if (index >= total && index > 0) next = "一括の最後（次の客なし）";
  else if (index <= 0) next = nxt ? "次は " + nxt : "最初の客へ";
  else next = "次の客を把握中…";
  if (move) {
    // いまの行動が外すなら、次の動きは「新しい条件を入れる」を優先表示
    if (/外して/.test(act) || /外す/.test(act) || /外:/.test(act) || /間取外/.test(act) || /リセットを押して/.test(act)) {
      next += (next ? "／" : "") + "次の動き:" + PANEL_PHASE_WORDS.reset.next;
    } else {
      next += (next ? "／" : "") + "次の動き:" + move;
    }
  }

  const grasp =
    "一括" + total + "人" + (graspOk ? " ✓把握" : " ✗未把握") +
    (cur ? "／いま" + cur.replace(/さん$/, "") : "") +
    (act ? "／行" + act.slice(0, 10) : "") +
    (nxt ? "／次" + nxt.replace(/さん$/, "") : index >= total && index > 0 ? "／次なし" : "") +
    (move ? "／動" + move.slice(0, 12) : "");

  return { now, next, grasp, graspOk };
}

/** キュー配列から現在行の把握入力を作る */
export function bulkGraspFromQueue(
  names: ReadonlyArray<string>,
  index0: number,
  waitingFor?: string | null,
  nextMove?: string | null,
  currentAction?: string | null,
  taskNow?: string | null,
): BulkPanelGraspInput {
  const total = names.length;
  const i = Math.max(0, Math.min(index0, total));
  return {
    total,
    index: i + 1,
    currentName: names[i] || "",
    nextName: i + 1 < total ? names[i + 1] || "" : "",
    waitingFor: waitingFor || null,
    nextMove: nextMove || null,
    currentAction: currentAction || null,
    taskNow: taskNow || null,
  };
}
