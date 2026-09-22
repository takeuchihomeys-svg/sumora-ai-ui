// app/lib/daily-greeting-server.ts
// 「今日こちらが送ったか」を DB で確かめる（画面から渡される一覧には、1分前に手打ちで送った通がまだ入っていないことがある）。
// 判定そのものは daily-greeting.ts（純関数）。2026-09-22 竹内「今日初めてじゃないときはお世話になっておりますはつかわない」
import { supabase } from "@/app/lib/supabase";

/** 今日（日本時間 0:00 以降）この会話でこちらが1通でも送っていれば true。失敗した時は false（画面の一覧の判定だけに戻る） */
export async function staffSentTodayFromDb(conversationId: string | null | undefined, now: number = Date.now()): Promise<boolean> {
  if (!conversationId) return false;
  const jst = new Date(now + 9 * 3600_000);
  const dayStartUtc = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()) - 9 * 3600_000).toISOString();
  try {
    const { data } = await supabase.from("messages").select("id").eq("conversation_id", conversationId)
      .eq("sender", "staff").gte("created_at", dayStartUtc).limit(1);
    return (data ?? []).length > 0;
  } catch {
    return false;
  }
}
