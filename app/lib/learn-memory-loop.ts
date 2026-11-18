/**
 * 記憶 → 改善が続くかの関所（2026-11-18 竹内さん）
 *
 *   「仕組み細かくちゃんと／記憶もちゃんとできて改善ちゃんとできるように／統括Pro徹底」
 *
 * ★ なぜ要るか
 *   判断を出しても same_bundle で捨てる・強化を learn_improvements に残さないと、
 *   次の打合せで同じ穴を忘れ、改善が一周で止まる。
 *
 * ⚠ 純関数。DBに書かない。
 */

export type LearnMemoryInput = {
  /** 直近統括ログ件数 */
  supervisorLogN?: number | null;
  /** 直近に Pro/RAG 根拠があるか */
  hasProLog?: boolean | null;
  /** 直近強化記録件数（learn_improvements） */
  improvementN?: number | null;
  /** Pro が log_memory を握った件数 */
  logMemoryN?: number | null;
  /** 前回と今回の point/read など（記憶の前後） */
  beforePointPct?: number | null;
  afterPointPct?: number | null;
  beforeReadCount?: number | null;
  afterReadCount?: number | null;
  /** ループ継続中か */
  continueLoop?: boolean | null;
  /** 同束スキップで捨てられたか（保存失敗の印） */
  lastSaveSkippedSameBundle?: boolean | null;
};

export type LearnMemoryStep = {
  n: number;
  id: string;
  name: string;
  ok: boolean;
  detail: string;
};

export type LearnMemoryLoop = {
  steps: LearnMemoryStep[];
  bottleneck_n: number | null;
  bottleneck: string | null;
  line: string;
  /** 次に記憶へ残す1行（改善記録用） */
  remember_line: string;
};

/**
 * 記憶→改善の一連が細かく回っているか。
 */
export function buildLearnMemoryLoop(inp: LearnMemoryInput): LearnMemoryLoop {
  const logN = Number(inp.supervisorLogN) || 0;
  const impN = Number(inp.improvementN) || 0;
  const memN = Number(inp.logMemoryN) || 0;
  const hasPro = inp.hasProLog === true;
  const cont = inp.continueLoop === true;
  const skipped = inp.lastSaveSkippedSameBundle === true;
  const bPoint = inp.beforePointPct;
  const aPoint = inp.afterPointPct;
  const bRead = inp.beforeReadCount;
  const aRead = inp.afterReadCount;

  const steps: LearnMemoryStep[] = [
    {
      n: 1,
      id: "judge_saved",
      name: "統括判断がログに残る",
      ok: logN >= 1 && !skipped,
      detail: skipped
        ? "同束スキップで新しい打合せが捨てられた（指紋更新が要る）"
        : (logN >= 1 ? `ログ${logN}件` : "learn_supervisor_log が空"),
    },
    {
      n: 2,
      id: "pro_in_log",
      name: "Pro根拠がログに載る",
      ok: hasPro,
      detail: hasPro ? "Pro/RAGがログにある" : "Pro根拠がログに無い（脳が薄い）",
    },
    {
      n: 3,
      id: "log_memory_used",
      name: "前回ログを次判断で使う",
      ok: memN >= 1 || logN < 1,
      detail: memN >= 1 ? `log_memory ${memN}` : (logN < 1 ? "まだ前回なし" : "前回ログがあるのに使っていない"),
    },
    {
      n: 4,
      id: "improvement_saved",
      name: "強化が1件ずつ残る",
      ok: impN >= 1 || !cont,
      detail: impN >= 1
        ? `learn_improvements ${impN}件`
        : (cont ? "周回中なのに強化記録0（改善が続かない）" : "強化記録は任意"),
    },
    {
      n: 5,
      id: "delta_remembered",
      name: "前後の数字を覚えて比べる",
      ok: (bPoint != null && aPoint != null) || (bRead != null && aRead != null) || !cont,
      detail: (bPoint != null || aPoint != null || bRead != null || aRead != null)
        ? `point ${bPoint ?? "?"}→${aPoint ?? "?"}／read ${bRead ?? "?"}→${aRead ?? "?"}`
        : "前後比較の材料が無い（beforeを残す）",
    },
    {
      n: 6,
      id: "continue_improve",
      name: "未達ならまた改善へ戻る",
      ok: !cont || (logN >= 1 && hasPro),
      detail: cont
        ? "continue_loop=true → 記憶を継いで①へ"
        : "一旦完了（または周回不要）",
    },
  ];

  const stuck = steps.find((s) => !s.ok) || null;
  const line = steps.map((s) => `${s.n}.${s.name}${s.ok ? "✓" : "✗"}`).join(" → ")
    + (stuck ? ` ／止: ${stuck.n}.${stuck.name}（${stuck.detail}）` : " ／記憶→改善ループ完了");

  const remember_line = [
    aPoint != null ? `point=${aPoint}` : null,
    aRead != null ? `read=${aRead}` : null,
    cont ? "continue=1" : "continue=0",
    stuck ? `止=${stuck.id}` : "ok",
  ].filter(Boolean).join(" ");

  return {
    steps,
    bottleneck_n: stuck ? stuck.n : null,
    bottleneck: stuck ? `${stuck.n}.${stuck.name}: ${stuck.detail}` : null,
    line,
    remember_line,
  };
}
