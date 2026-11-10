// scripts/lib/kb-eval-prefetch.ts — kb-eval の先引きの純関数（2026-11-10 作業員8・週の cron の時間切れの直し・scripts/kb-eval.ts が使う）
export const KB_EVAL_EMBED_BATCH = 96;
export const KB_EVAL_RPC_CONCURRENCY = 6;
/** 先に埋める問い（重複なし・空を除く・vecCache に既にある物は除く） */
export function prefetchQueries(qs: string[], have: { has(q: string): boolean }): string[] {
  const out: string[] = []; const seen = new Set<string>();
  for (const q of qs) { if (!q || seen.has(q) || have.has(q)) continue; seen.add(q); out.push(q); }
  return out;
}
/** 同時に n 本まで（順番は入力の順で返す） */
export async function mapLimit<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length); let next = 0;
  const worker = async () => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}
