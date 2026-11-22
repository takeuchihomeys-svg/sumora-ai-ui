// scripts/try-conductor-lessons.ts — 統括が学びを読む口を1回だけ試す（読むだけ・書かない・埋め込み1回・RPC 1回）
// 2026-11-21 作業員L。実行: npx tsx --env-file=.env.local scripts/try-conductor-lessons.ts "<お客様の発言>"
import { createClient } from "@supabase/supabase-js";
import { loadConductorLessons } from "../app/lib/conductor-lessons-server";
import { lessonsMaterialLine, lessonsDigest } from "../app/lib/conductor-lessons";
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const { count } = await sb.from("conductor_lessons").select("id", { count: "exact", head: true }).eq("is_current", true);
  console.log(`学びの行（現行）: ${count ?? "?"}`);
  const rows = await loadConductorLessons(sb as never, { conversationId: "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7", customerTurn: process.argv[2] ?? "他にもありますか？", stage: null });
  console.log(`当たった: ${rows.length}件 ids=${lessonsDigest(rows) ?? "-"}`);
  console.log(lessonsMaterialLine(rows) || "(材料の行なし)");
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
