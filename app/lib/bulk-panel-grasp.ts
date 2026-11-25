/**
 * 一括検索パネル用の把握文（決定論・LLMなし）
 *
 * 2026-11-23 竹内さん「誰を一括で検索するのか／合計何件／次のお客さんは誰か／理解できているのか
 *   を拡張ツールの部分に表示する」
 * ★ 2.8.227: いまの行動（外している最中／入れている最中）を now に出す
 * ★ 2.8.228: task_now（間取外:2LDK 等）があれば now に優先
 */

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
  if (/外す/.test(m)) return "外している最中";
  if (/入れ|条件を1つ/.test(m)) return "新しい条件を入れている最中";
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
  const move = String(g.nextMove || "").trim().slice(0, 28);
  const taskNow = String(g.taskNow || "").trim().slice(0, 24);
  const act =
    taskNow ||
    String(g.currentAction || "").trim().slice(0, 24) ||
    actionFromMove(move) ||
    (g.waitingFor ? String(g.waitingFor).slice(0, 24) : "");

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
    if (/外して/.test(act) || /外す/.test(act) || /外:/.test(act) || /間取外/.test(act)) {
      next += (next ? "／" : "") + "次の動き:新しいお客さんの条件を入れる";
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
