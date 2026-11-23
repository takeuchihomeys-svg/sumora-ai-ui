// app/lib/batched-cull.ts — 多い行の書き換えを少しずつ回す（読む口と書く口は呼ぶ側が渡す・2026-11-23 作業員N2・台帳 #656）
//   週の学び（/api/cron/weekly-learning）の「Stage A never-applied cull」は 4,405行を1つの UPDATE で書き換え、毎週 statement timeout で全部戻っていた
//   （書き換える列 hypothesis_status に索引がある＝HOT にならず、1行ごとに全部の索引〈HNSW を含む〉へ足す）。
//   id は1回だけ選ぶ（maxTotal 行まで・選ぶ問い合わせは表を1回なめる＝何度も選ばない）。batch 行ずつ書き換え、時間の上限（budgetMs）で止める。
//   途中で失敗しても、済んだ分は残る（残りは次の週）。
export type BatchedCullResult = { picked: number; rejected: number; batches: number; more: boolean; error: string | null };

export async function cullInBatches(
  io: { pick: (limit: number) => Promise<string[]>; reject: (ids: string[]) => Promise<number> },
  o: { batch: number; budgetMs: number; maxTotal?: number; now?: () => number },
): Promise<BatchedCullResult> {
  const now = o.now ?? Date.now;
  const t0 = now();
  const maxTotal = o.maxTotal ?? 5000;
  let rejected = 0, batches = 0, picked = 0;
  try {
    const ids = await io.pick(maxTotal);
    picked = ids.length;
    for (let i = 0; i < ids.length; i += o.batch) {
      if (now() - t0 >= o.budgetMs) return { picked, rejected, batches, more: true, error: null };
      batches++;
      rejected += await io.reject(ids.slice(i, i + o.batch));
    }
    return { picked, rejected, batches, more: ids.length >= maxTotal, error: null };
  } catch (e) {
    return { picked, rejected, batches, more: true, error: e instanceof Error ? e.message : String(e) };
  }
}
