import { createClient } from "@supabase/supabase-js";
import { replayFloorFetch } from "@/app/lib/test-replay-floor";
import { resolveRestTimeoutMs, withRestTimeout } from "@/app/lib/supabase-fetch-timeout";
import { serverSupabaseKey } from "@/app/lib/supabase-server-key";

// 2026-10-21 RLS を入れる準備 ①（竹内さん OK・最優先）: サーバー専用の Supabase の窓口。
//   app/api/**・サーバーでだけ使う app/lib/**・scripts はここの `supabase` を使う。
//   画面（'use client'）は今まで通り app/lib/supabase.ts（公開キー）を使う。
//   RLS を入れた後も、サーバーはサーバー専用の鍵（SUPABASE_SERVICE_ROLE_KEY）で読み書きできるようにするため。
//   鍵がまだ無い所（手元・テスト）は公開キーに戻して一度だけ注意＝今日の動きは今までと同じ（app/lib/supabase-server-key.ts）。
//   サーバー専用の鍵は NEXT_PUBLIC_ を付けない（付けると画面に配られる）。この部品が画面で読まれたら止める。
if (typeof window !== "undefined") {
  throw new Error("app/lib/supabase-server.ts は画面（ブラウザ）から読まないでください。画面は app/lib/supabase.ts を使う");
}

// fetch の包み方は app/lib/supabase.ts と同じ（再生テストの床・REST 25秒上限）
const baseFetch: typeof fetch = process.env.REPLAY_FLOOR_FILE ? (replayFloorFetch as typeof fetch) : (input, init) => fetch(input, init);
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  serverSupabaseKey()!,
  { global: { fetch: withRestTimeout(baseFetch, resolveRestTimeoutMs(process.env.NEXT_PUBLIC_SUPABASE_REST_TIMEOUT_MS)) } },
);
