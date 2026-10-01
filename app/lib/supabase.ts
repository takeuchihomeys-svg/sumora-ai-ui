import { createClient } from "@supabase/supabase-js";
import { replayFloorFetch } from "@/app/lib/test-replay-floor";

// 2026-10-01 YUMA の再生テスト（scripts/yuma-replay-scenarios.ts）: REPLAY_FLOOR_FILE がある手元の開発サーバ・スクリプトだけ、
//   テスト用の会話の「場面より前の記録」を読まない fetch で包む（app/lib/test-replay-floor.ts）。本番には REPLAY_FLOOR_FILE を入れない＝今までと同じ
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  process.env.REPLAY_FLOOR_FILE ? { global: { fetch: replayFloorFetch } } : undefined,
);
