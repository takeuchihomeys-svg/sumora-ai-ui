import { createClient } from "@supabase/supabase-js";
import { replayFloorFetch } from "@/app/lib/test-replay-floor";
import { resolveRestTimeoutMs, withRestTimeout } from "@/app/lib/supabase-fetch-timeout";

// 2026-10-21 RLS を入れる準備 ①: ここは画面（'use client'）用＝公開キーの窓口。サーバー（app/api/**・サーバーだけの app/lib/**・scripts）は
//   app/lib/supabase-server.ts を使う（RLS を入れた後もサーバー専用の鍵で読み書きできるように）。
//   画面とサーバーの両方から読まれる部品（app/lib/calendarSlots.ts）は窓口を呼ぶ側から受け取る（② 2026-10-21）。
// 2026-10-01 YUMA の再生テスト（scripts/yuma-replay-scenarios.ts）: REPLAY_FLOOR_FILE がある手元の開発サーバ・スクリプトだけ、
//   テスト用の会話の「場面より前の記録」を読まない fetch で包む（app/lib/test-replay-floor.ts）。本番には REPLAY_FLOOR_FILE を入れない＝今までと同じ
// 2026-10-07 竹内「たまにサーバーがかたまる」: REST（/rest/v1/）の1回に上限 25秒（app/lib/supabase-fetch-timeout.ts）。
//   10/05 13:14〜13:28 に Supabase が応答しなくなった時、関数が上限の 300秒まで待ち続け・画面も「読み込み中」のまま待たされていた。
//   打ち切りは supabase-js の通常のエラー（throw しない）になるので、呼び出し側の既存のエラー処理に流れる。戻す時は NEXT_PUBLIC_SUPABASE_REST_TIMEOUT_MS=0
const baseFetch: typeof fetch = process.env.REPLAY_FLOOR_FILE ? (replayFloorFetch as typeof fetch) : (input, init) => fetch(input, init);
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { global: { fetch: withRestTimeout(baseFetch, resolveRestTimeoutMs(process.env.NEXT_PUBLIC_SUPABASE_REST_TIMEOUT_MS)) } },
);
