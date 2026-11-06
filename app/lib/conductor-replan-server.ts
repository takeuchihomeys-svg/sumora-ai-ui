// app/lib/conductor-replan-server.ts — #8 立て直しの記録（作業員5・11/06）。前の判断を使った番（keep）を、毎日の拾い上げで数えられるように残す
//   前の判断の記録（brain_decision_logs の同じ会話・同じ analyzed_msg_ts の一番新しい行）の digest に rp を足すだけ（判断は変えない）。失敗しても何もしない
//   数える SQL（竹内さんの一手と合ったか）: scripts/sql/replan-keep-daily.sql
import { supabase } from "@/app/lib/supabase-server";

export async function markReplanDigest(conversationId: string, analyzedMsgTs: string | null, rp: string): Promise<void> {
  if (!conversationId || !analyzedMsgTs || !rp) return;
  const { data } = await supabase.from("brain_decision_logs").select("id, digest").eq("conversation_id", conversationId).eq("analyzed_msg_ts", analyzedMsgTs).order("created_at", { ascending: false }).limit(1);
  const row = ((data ?? []) as Array<{ id: string | number; digest: Record<string, unknown> | null }>)[0];
  if (!row) return;
  await supabase.from("brain_decision_logs").update({ digest: { ...(row.digest ?? {}), rp } }).eq("id", row.id);
}
