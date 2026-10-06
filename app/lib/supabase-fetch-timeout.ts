// app/lib/supabase-fetch-timeout.ts
// Supabase の REST（/rest/v1/・PostgREST）への fetch に上限の時間を付ける（画面とサーバーの両方が使う・依存なしの純関数）。
//
// 2026-10-07 竹内「たまにサーバーがかたまるバグが起きるので原因見つけて改善する」:
//   2026-10-05 13:14〜13:28 JST に Supabase 側が応答しなくなった（Cloudflare 522・PostgREST の "Thread killed by timeout manager"・
//   statement timeout が連発）。supabase-js の fetch には上限が無いので、その間 Vercel の関数は Supabase の応答を待ったまま
//   各関数の上限（/api/templates・/api/line-tasks・/api/property-pickups/talk 等は 300秒）まで止まり続け、
//   画面の fetch（/api/templates が 500・一覧の読み込み）も同じだけ待たされていた＝「サーバーが固まった」ように見えた。
//   anon の statement_timeout は 3秒（authenticated / authenticator は 8秒）なので、REST の1回が 25秒を超える時は
//   DB の実行ではなく「つながらない・詰まっている」時だけ。そこで REST だけ 25秒で打ち切り、supabase-js の通常のエラー
//   （{ error: { message: "AbortError: ..." } }・throw しない）として呼び出し側の既存のエラー処理に流す。
//   Storage（/storage/v1/・大きいファイルのアップロード）・Functions・Auth・Realtime には付けない。
// 戻す時: 環境変数 NEXT_PUBLIC_SUPABASE_REST_TIMEOUT_MS=0（0 以下・数でない値は「付けない」）。
// テスト: app/lib/__tests__/supabase-fetch-timeout.test.ts

export const SUPABASE_REST_TIMEOUT_MS = 25_000;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** 環境変数の値から上限の時間を決める（未設定は既定・0 以下や数でない値は null＝付けない） */
export function resolveRestTimeoutMs(raw: string | undefined | null, fallback = SUPABASE_REST_TIMEOUT_MS): number | null {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/** 上限を付ける要求か（Supabase の REST・RPC だけ） */
export function isSupabaseRestUrl(input: RequestInfo | URL): boolean {
  let url = "";
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.href;
  else if (input && typeof (input as Request).url === "string") url = (input as Request).url;
  return url.includes("/rest/v1/");
}

/**
 * fetch を包んで、Supabase の REST の要求だけ timeoutMs で打ち切る。
 * 呼び出し側の signal（supabase-js の .abortSignal()）がある時は両方のどちらかで止まる（AbortSignal.any が無い環境では呼び出し側の signal だけ）。
 */
export function withRestTimeout(baseFetch: FetchLike, timeoutMs: number | null): FetchLike {
  if (timeoutMs == null || !(timeoutMs > 0)) return baseFetch;
  return (input, init) => {
    if (!isSupabaseRestUrl(input)) return baseFetch(input, init);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const callerSignal = init?.signal ?? null;
    let signal: AbortSignal = timeoutSignal;
    if (callerSignal) {
      const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
      if (typeof anyFn !== "function") return baseFetch(input, init);
      signal = anyFn([callerSignal, timeoutSignal]);
    }
    return baseFetch(input, { ...init, signal });
  };
}
