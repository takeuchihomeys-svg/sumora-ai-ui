// app/lib/material-prefetch-server.ts — 8秒の待ちの間にも先に始めてよい、会話の id だけで決まる材料の読み（brain-core の登録と同じ関数を1か所に）
// 2026-11-27 作業員L（統括役の案 2）: ブレインの登録（brain-core の mpf.register）と入口の待ちの間（generate-draft-bg-async）が同じ関数を使う＝答えの中身は同じ
//   新しい発言に依らない物だけ（今の番の文を使う nearOpinion・customerMemo、前の通に依る prevDecision は入れない）
import type { SupabaseClient } from "@supabase/supabase-js";
import { pickupCandidatesListOn } from "./brain-material-wiring";
import { pickupFitNowOn } from "./pickup-fit-now"; // 2026-11-28 統括役（合わせ）: 作業員A #821 PICKUP_FIT_NOW_LINE も同じ列の選び

export function materialEarlyJobs(supabase: SupabaseClient, conversationId: string): Record<"offline" | "ptNote" | "reapply" | "pendNow" | "dealOutcomes", () => Promise<unknown>> {
  return {
    offline: async () => (await import("./offline-result-server")).loadOfflineResultLineWithin(5_000, conversationId),
    ptNote: async () => { const { propertyThreadNoteFor } = await import("./property-thread-server"); return Promise.race([propertyThreadNoteFor(conversationId), new Promise<string>((r) => setTimeout(() => r(""), 8_000))]); },
    reapply: async () => { const { reapplyBrainNoteFor } = await import("./reapply-customer-server"); return Promise.race([reapplyBrainNoteFor(supabase, conversationId), new Promise<null>((r) => setTimeout(() => r(null), 4_000))]); },
    pendNow: async () => supabase.from("property_pickups").select(pickupCandidatesListOn() || pickupFitNowOn() ? "created_at, expired_at, property_name, room_no, summary_text, score, rank, verdict" : "created_at, expired_at").eq("conversation_id", conversationId).eq("status", "pending").order("created_at", { ascending: false }).limit(50),
    dealOutcomes: async () => supabase.from("deal_outcomes").select("episode_no, result, ended_at, property_name").eq("conversation_id", conversationId).order("episode_no", { ascending: false }).limit(3),
  };
}
