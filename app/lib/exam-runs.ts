// app/lib/exam-runs.ts
// 試験の統括（exam-conductor）の結果を **DB に残す／読む**（2026-11-13 竹内さん
//   「試験の統括と拡張ツールとデータベースの連携の部分をちゃんとできるようにする。より強化できるようにする」)
//
// これまでの穴:
//   統括の結果は `memory/exam-brain/conductor/*.json` という**手元のファイルだけ**だった。
//   → 竹内さん・他の PC・私から見えず、**過去の試験と比べる事もできない**（＝連携できていなかった）。
//
// ここでやる事:
//   ① 手元の結果ファイル（SavedResult）を DB の `exam_runs` に**1行ずつ**入れる（同じ label は上書き）
//   ② DB から**新しい順に読む**（画面・スクリプト・学習の材料に）
//   ③ 傾向を数える（合格率・よく落ちる所・費用）＝「統括を強化する」ための材料
//
// ⚠ 入れるのは**点・件数・問題の id・理由・費用だけ**。会話の中身・お客様の名前は入れない。
// ⚠ DB が無くても動く（読めない時は null を返す＝今まで通りファイルで動く）。

export type ExamRunRow = {
  label: string;
  ran_at?: string | null;
  plan_label?: string | null;
  candidates?: number | null;
  material_cls?: string | null;
  material_files?: number | null;
  material_kb_ids?: string[] | null;
  compare?: unknown;
  next_actions?: unknown;
  triage?: unknown;
  llm?: unknown;
  llm_calls?: number | null;
  cost_usd?: number | null;
  summary?: string | null;
};

/** 手元の SavedResult の形（scripts/lib/exam-conductor-io.ts と同じ・緩く受ける） */
export type LocalResult = {
  label?: string | null;
  at?: string | null;
  planLabel?: string | null;
  compare?: unknown;
  next?: unknown;
  triage?: unknown;
  llm?: unknown;
};

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 手元の結果（SavedResult）→ DB の1行（純関数）。
 *   ⚠ 中身は**数と id と理由だけ**。会話本文は入れない。
 */
export function toExamRun(local: LocalResult, plan?: { candidates?: unknown; material?: unknown } | null): ExamRunRow | null {
  const label = typeof local.label === "string" ? local.label.trim().slice(0, 80) : "";
  if (!label) return null;
  // 点・合格数（compare の形は実装ごとに違うので、分かる物だけ拾う）
  const cmp = (local.compare && typeof local.compare === "object" ? local.compare : {}) as Record<string, unknown>;
  const next = Array.isArray(local.next) ? local.next : [];
  const triage = local.triage ?? null;
  const llm = (local.llm && typeof local.llm === "object" ? local.llm : {}) as Record<string, unknown>;
  const calls = num(llm.calls) ?? num(llm.n);
  const cost = num(llm.cost_usd) ?? num(llm.usd);

  // 人が読む1行（点が分かる時だけ点を書く）
  const parts: string[] = [];
  const pass = num(cmp.pass) ?? num(cmp.passed);
  const total = num(cmp.total) ?? num(cmp.n);
  if (pass != null && total != null) parts.push(`合格 ${pass}/${total}`);
  const score = num(cmp.score);
  if (score != null) parts.push(`点 ${score}`);
  if (next.length) parts.push(`次に直す ${next.length}件`);
  if (calls != null) parts.push(`LLM ${calls}回`);
  if (cost != null) parts.push(`$${cost}`);

  const mat = (plan && plan.material && typeof plan.material === "object" ? plan.material : {}) as Record<string, unknown>;
  return {
    label,
    ran_at: typeof local.at === "string" ? local.at : null,
    plan_label: typeof local.planLabel === "string" ? local.planLabel.slice(0, 80) : null,
    candidates: num(plan && plan.candidates),
    material_cls: typeof mat.cls === "string" ? mat.cls.slice(0, 40) : null,
    material_files: num(mat.files),
    material_kb_ids: Array.isArray(mat.kbIds) ? (mat.kbIds as unknown[]).map((x) => String(x).slice(0, 40)).slice(0, 40) : null,
    // ⚠ 中身をそのまま入れるのは compare・next・triage（**点と理由**だけの形）
    compare: cmp,
    next_actions: next.slice(0, 100),
    triage,
    llm,
    llm_calls: calls,
    cost_usd: cost,
    summary: parts.join("・") || null,
  };
}

/**
 * 統括（`scripts/exam-conductor.ts --run`）の結果 → DB の1行（純関数）。
 *
 * なぜ別に要るか（2026-11-13 竹内さん「統括の部分もちゃんと強化されているのか」）:
 *   統括の結果の形は**試験ブレイン（--conduct）と違う**。
 *     - 統括: `pass: "12→14"`（前→今の文字列）・`better`・`worse`・`usd: "$0.123"`・`missStages`
 *     - 試験ブレイン: `compare:{pass,total}`・`next:[{id,why}]`・`llm:{calls,usd}`
 *   `toExamRun` にそのまま渡すと**点が読めず「合格 ?/?」になる**（＝DBに入っても比べられない）。
 *   → 統括用に読み替える。読めない所は null（嘘を入れない）。
 *   ⚠ 入れるのは点・件数・問題の id・理由・費用だけ（会話の中身・お客様の名前は入れない）。
 */
export function toExamRunFromConductor(
  result: Record<string, unknown>,
  plan?: { candidates?: unknown; material?: unknown; label?: unknown } | null,
): ExamRunRow | null {
  const label = typeof result.label === "string" ? result.label.trim().slice(0, 80) : "";
  if (!label) return null;

  // pass は "12→14"（前→今）。今の方を合格数として数える
  const passStr = typeof result.pass === "string" ? result.pass : "";
  const m = /(\d+)\s*→\s*(\d+)/.exec(passStr);
  const compare: Record<string, unknown> = {};
  if (m) { compare.pass = Number(m[2]); compare.pass_before = Number(m[1]); }
  const better = num(result.better);
  const worse = num(result.worse);
  if (better != null) compare.better = better;
  if (worse != null) compare.worse = worse;
  const code = num(result.code);
  if (code != null) compare.exit_code = code;

  // 落ちた問題（missStages）を「次に直す」の形に（id と理由だけ）
  const miss = Array.isArray(result.missStages) ? result.missStages : [];
  const next = miss
    .map((x) => (x && typeof x === "object" ? x as Record<string, unknown> : null))
    .filter((x): x is Record<string, unknown> => !!x && typeof x.id === "string")
    .map((x) => ({
      id: String(x.id).slice(0, 60),
      why: typeof x.stage === "string" ? `段: ${x.stage}`.slice(0, 120) : "",
    }));

  // 費用は "$0.123" の形
  const usdStr = typeof result.usd === "string" ? result.usd : "";
  const um = /\$?\s*([0-9]*\.?[0-9]+)/.exec(usdStr);
  const cost = um ? Number(um[1]) : null;

  const mat = (plan && plan.material && typeof plan.material === "object" ? plan.material : {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (m) parts.push(`合格 ${m[1]}→${m[2]}`);
  if (better != null) parts.push(`良くなった ${better}`);
  if (worse != null) parts.push(`悪くなった ${worse}`);
  if (next.length) parts.push(`次に直す ${next.length}件`);
  if (cost != null) parts.push(`$${cost}`);
  if (typeof result.verdict === "string") parts.push(result.verdict.slice(0, 120));

  return {
    label,
    ran_at: typeof result.at === "string" ? result.at : null,
    plan_label: typeof plan?.label === "string" ? plan.label.slice(0, 80) : null,
    candidates: num(plan && plan.candidates),
    material_cls: typeof mat.cls === "string" ? mat.cls.slice(0, 40) : null,
    material_files: num(mat.files),
    material_kb_ids: Array.isArray(mat.kbIds) ? (mat.kbIds as unknown[]).map((x) => String(x).slice(0, 40)).slice(0, 40) : null,
    compare,
    next_actions: next.slice(0, 100),
    triage: Array.isArray(result.triage) ? result.triage : null,
    llm: null,
    llm_calls: null,
    cost_usd: Number.isFinite(cost as number) ? cost : null,
    summary: parts.join("・").slice(0, 400) || null,
  };
}

/** DB へ1行（同じ label は上書き）。DB が無ければ false（今まで通りファイルで動く） */
export async function upsertExamRun(
  sb: { from: (t: string) => { upsert: (row: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ error: { message: string } | null }> } } | null,
  row: ExamRunRow,
): Promise<{ ok: boolean; error?: string }> {
  if (!sb) return { ok: false, error: "no_db" };
  try {
    const { error } = await sb.from("exam_runs").upsert(
      { ...row, summary: row.summary ?? null },
      { onConflict: "label" },
    );
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** DB から新しい順に読む */
export async function listExamRuns(
  sb: { from: (t: string) => { select: (c: string) => { order: (k: string, o?: Record<string, unknown>) => { limit: (n: number) => Promise<{ data: unknown[] | null; error: { message: string } | null }> } } } } | null,
  limit = 50,
): Promise<{ ok: boolean; rows: ExamRunRow[]; error?: string }> {
  if (!sb) return { ok: false, rows: [], error: "no_db" };
  try {
    const { data, error } = await sb.from("exam_runs")
      .select("label, ran_at, plan_label, candidates, material_cls, material_files, compare, next_actions, llm_calls, cost_usd, summary, created_at")
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 500));
    if (error) return { ok: false, rows: [], error: error.message };
    return { ok: true, rows: (data ?? []) as ExamRunRow[] };
  } catch (e) {
    return { ok: false, rows: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 傾向を数える（統括を強化する材料・純関数）。
 *   ・合格率（点が分かる回だけ）
 *   ・よく落ちる問題（next の id を数える）
 *   ・費用の合計・平均
 */
export function summarizeExamRuns(rows: ReadonlyArray<ExamRunRow>): {
  runs: number;
  pass: number;
  total: number;
  pass_rate: number | null;
  top_misses: Array<{ id: string; n: number; why: string }>;
  cost_total: number;
  cost_avg: number | null;
  llm_calls: number;
} {
  const list = Array.isArray(rows) ? rows : [];
  let pass = 0, total = 0, cost = 0, calls = 0;
  const miss: Record<string, { n: number; why: string }> = {};
  for (const r of list) {
    const cmp = (r.compare && typeof r.compare === "object" ? r.compare : {}) as Record<string, unknown>;
    const p = num(cmp.pass) ?? num(cmp.passed);
    const t = num(cmp.total) ?? num(cmp.n);
    if (p != null) pass += p;
    if (t != null) total += t;
    const c = num(r.cost_usd);
    if (c != null) cost += c;
    const n = num(r.llm_calls);
    if (n != null) calls += n;
    const nx = Array.isArray(r.next_actions) ? r.next_actions : [];
    for (const x of nx) {
      if (!x || typeof x !== "object") continue;
      const o = x as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id.slice(0, 60) : "";
      if (!id) continue;
      if (!miss[id]) miss[id] = { n: 0, why: typeof o.why === "string" ? o.why.slice(0, 120) : "" };
      miss[id].n++;
    }
  }
  const top = Object.entries(miss)
    .map(([id, v]) => ({ id, n: v.n, why: v.why }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 15);
  return {
    runs: list.length,
    pass, total,
    pass_rate: total > 0 ? Math.round((pass / total) * 1000) / 1000 : null,
    top_misses: top,
    cost_total: Math.round(cost * 10000) / 10000,
    cost_avg: list.length ? Math.round((cost / list.length) * 10000) / 10000 : null,
    llm_calls: calls,
  };
}
