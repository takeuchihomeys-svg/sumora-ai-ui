// 2026-10-21 RLS を入れる準備 ①: サーバーで使う Supabase の鍵を選ぶ所（接続はしない＝読み込んだだけで何も起きない）。
//   サーバー専用の鍵（NEXT_PUBLIC_ を付けない）が有ればそれ、無ければ公開キーに戻して一度だけ注意＝今日の動きは今までと同じ。
//   接続そのものは app/lib/supabase-server.ts。自分で createClient している所はこの鍵を渡す。
//   この部品が画面（ブラウザ）で読まれたら止める（サーバー専用の鍵を画面の束に入れないため）。
if (typeof window !== "undefined") {
  throw new Error("app/lib/supabase-server-key.ts は画面（ブラウザ）から読まないでください。画面は app/lib/supabase.ts を使う");
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** このアプリの DB のサーバー用の鍵。SUPABASE_SERVICE_ROLE_KEY が無ければ公開キー（一度だけ注意）。どちらも無ければ undefined */
export function serverSupabaseKey(): string | undefined {
  const service = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (service) return service;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (anon) warnOnce("main", "[supabase-server] SUPABASE_SERVICE_ROLE_KEY が無いので公開キーで動かします（RLS を入れる前に設定が必要）");
  return anon;
}

/** 審査管理（sumora-screening-admin）の DB のサーバー用の鍵。SCREENING_ADMIN_SUPABASE_SERVICE_ROLE_KEY が無ければ公開キー（一度だけ注意）。どちらも無ければ undefined */
export function screeningAdminSupabaseKey(): string | undefined {
  const service = (process.env.SCREENING_ADMIN_SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (service) return service;
  const anon = process.env.SCREENING_ADMIN_SUPABASE_ANON_KEY;
  if (anon) warnOnce("screening", "[supabase-server] SCREENING_ADMIN_SUPABASE_SERVICE_ROLE_KEY が無いので審査管理の DB は公開キーで動かします（RLS を入れる前に設定が必要）");
  return anon;
}
