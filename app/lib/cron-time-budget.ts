// app/lib/cron-time-budget.ts — cron の時間の残りで次の仕事を始めるか決める・一括更新を小分けにする（純関数・作業員N2・2026-11-22・台帳 #591・#592）
//
// #592 update-knowledge（maxDuration 60秒）: 本番の記録（Vercel の実行の記録・7日）で 11/15〜11/18・11/20・11/21 の6回が毎回「Task timed out after 60 seconds」（11/19 は記録なし）。
//   中身: ☆の例文を3件ずつ Haiku で読む（1回 7〜26秒）→ 1件あたり約10の知識の行を1行ずつ embedding＋upsert（1行 0.1〜1秒）。2組目の書き込みの途中で切れる。
//   その後ろの片付け（重複の掃除・未使用の行の削除・knowledge_apply_log の14日の期限・ai_feedback_items の30日の期限）が 8/18 から1度も回っていない。
//   UPDATE_KNOWLEDGE_TIME_BUDGET=on（既定 off）: 始めて 25秒を過ぎたら次の組を始めない・掃除は 40秒までに始められる時だけ＝後ろの片付けまで届く
// #591 auto-star-winners: 11/21 に ☆の一括更新（46行・1文）が DB の statement timeout。ai_reply_examples は embedding の HNSW 索引が3本あり、
//   行の更新ごとに索引の書き込みが要る。AUTO_STAR_BULK_CHUNK=<n>（既定なし＝今まで通り1文）で n 行ずつに分ける
type Env = Record<string, string | undefined>;

export const updateKnowledgeBudgetOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.UPDATE_KNOWLEDGE_TIME_BUDGET ?? "").trim().toLowerCase() === "on";
/** 2026-11-22 統括役の決め: 未使用の知識の行を消さずに印（hypothesis_status=rejected・rejection_reason=unused_30d／unused_90d）を付ける（既定 off・UPDATE_KNOWLEDGE_UNUSED_MARK=on）。
 *  UPDATE_KNOWLEDGE_TIME_BUDGET はこれを on にしてから on にする（片付けが届くと、止まっていた 3,646行を一度に消してしまうため） */
export const updateKnowledgeUnusedMarkOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.UPDATE_KNOWLEDGE_UNUSED_MARK ?? "").trim().toLowerCase() === "on";
/** 次の組を始めてよい最後の時刻（始めてからの ms）と、掃除を始めてよい最後の時刻 */
export const UPDATE_KNOWLEDGE_BUDGET = { nextChunkUntilMs: 25_000, cleanupUntilMs: 40_000 } as const;

/** 始めてから untilMs を過ぎていなければ次を始めてよい */
export function canStartWithin(startMs: number, nowMs: number, untilMs: number): boolean {
  return nowMs - startMs <= untilMs;
}

/** 一括更新の1文の行の数（AUTO_STAR_BULK_CHUNK・1〜200 の整数だけ・それ以外は null＝分けない） */
export function autoStarBulkChunk(env: Env = typeof process !== "undefined" ? process.env : {}): number | null {
  const n = Number((env.AUTO_STAR_BULK_CHUNK ?? "").trim());
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : null;
}

/** 配列を size ごとに（size が null なら1つのまま） */
export function chunksOf<T>(xs: ReadonlyArray<T>, size: number | null): T[][] {
  if (!xs.length) return [];
  if (!size) return [[...xs]];
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}
