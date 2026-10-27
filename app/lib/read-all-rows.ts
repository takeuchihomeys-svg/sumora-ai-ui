// app/lib/read-all-rows.ts — PostgREST の1回の上限（max-rows 1000）で静かに切れる読みを、1000行ずつ回して読む（DB の行の取り方だけ・LLM なし）
//
// 2026-10-28 調べ（作業員4・やることリストの読み込みの計測で見つけた）: `.limit(8000)` と書いても本番は1回 1000行で切れる（エラーは出ない）。
//   例: brain-attention-server.buildTargetInputs のお客様の発言（45日・ターゲット候補の会話）は 1000行で切れ、
//   最後の発言の時刻が古い会話ほど抜けて「止まっている」と読み違える余地があった。
//   直し: 読み手が (from, to) と「回して読むか」を受け取る形で問い合わせを作り、この関数が 1000行ずつ最後まで（max まで）読む。
//   切替 READ_ALL_ROWS=on の時だけ回す（既定 off＝今まで通り1回だけ・上限は max のまま＝本番では 1000行で切れる）。
//   回して読む時は並びが決まっている必要がある（読み手が paged=true の時に id 等で並びを足す）。
// テスト: app/lib/__tests__/read-all-rows.test.ts

export const POSTGREST_MAX_ROWS = 1000;

export function readAllRowsEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.READ_ALL_ROWS ?? "").trim().toLowerCase() === "on";
}

type Res<T> = { data: T[] | null; error: { message: string } | null };
export type RowsQuery<T> = (from: number, to: number, paged: boolean) => PromiseLike<Res<T>>;

/**
 * 最大 max 行まで読む。enabled=false は1回だけ（range(0, max-1)＝今までの limit(max) と同じ）。
 * enabled=true は 1000行ずつ・足りなくなるか max に届くまで。truncated は max で止めた時だけ true
 */
export async function readRowsUpTo<T>(mk: RowsQuery<T>, max: number, enabled: boolean = readAllRowsEnabled()): Promise<{ data: T[]; error: { message: string } | null; pages: number; truncated: boolean }> {
  if (!enabled) {
    const r = await mk(0, Math.max(0, max - 1), false);
    return { data: r.data ?? [], error: r.error, pages: 1, truncated: false };
  }
  const out: T[] = [];
  let pages = 0;
  for (let from = 0; from < max; from += POSTGREST_MAX_ROWS) {
    const to = Math.min(max, from + POSTGREST_MAX_ROWS) - 1;
    const r = await mk(from, to, true);
    pages++;
    if (r.error) return { data: out, error: r.error, pages, truncated: false };
    const rows = r.data ?? [];
    out.push(...rows);
    if (rows.length < to - from + 1) return { data: out, error: null, pages, truncated: false };
  }
  return { data: out, error: null, pages, truncated: true };
}
