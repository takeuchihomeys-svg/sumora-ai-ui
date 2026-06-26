import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

const TASK_LABEL: Record<string, string> = {
  property_check: "物件確認",
  property_send: "物件出し",
  estimate_sheet: "見積書対応",
};

async function sendGroupMessage(text: string): Promise<void> {
  let targetId = process.env.LINE_STAFF_GROUP_ID ?? null;
  if (!targetId) {
    const { data: grpRow } = await supabase.from("hanbancyo_settings").select("value").eq("key", "group_id").single();
    targetId = grpRow?.value ?? null;
  }
  if (!targetId) return;
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;
  if (!token) return;

  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: targetId, messages: [{ type: "text", text }] }),
  });
}

// POST: タスク完了 + 完了アナウンス
export async function POST(req: NextRequest) {
  const { id, source } = await req.json() as { id: string; source?: string };
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

  const { data: task, error } = await supabase
    .from("line_tasks")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending")
    .select("task_type, customer_name, conversation_id")
    .single();

  if (error || !task) {
    return NextResponse.json({ ok: false, reason: "not found or already completed" });
  }

  const label = TASK_LABEL[task.task_type as string] ?? task.task_type;
  const suffix = source === "aix" ? "AIX送信で完了しました" : "2通送信で自動完了しました";
  const text = `✅【${label} 完了】\n${task.customer_name as string}さんへ${suffix}`;

  sendGroupMessage(text).catch(console.error);

  // 物件出し完了時：紐付き顧客の property_send_count を自動+1
  if (task.task_type === "property_send") {
    void (async () => {
      try {
        const { data: conv } = await supabase
          .from("conversations")
          .select("property_customer_id")
          .eq("id", task.conversation_id as string)
          .single();
        if (!conv?.property_customer_id) return;

        const { data: pc } = await supabase
          .from("property_customers")
          .select("property_send_count")
          .eq("id", conv.property_customer_id as string)
          .single();
        if (!pc) return;

        const current = (pc.property_send_count as number | null) ?? 0;
        const now = new Date().toISOString();
        await supabase
          .from("property_customers")
          .update({
            property_send_count: current + 1,
            last_property_sent_at: now,
            updated_at: now,
          })
          .eq("id", conv.property_customer_id as string);
      } catch {}
    })();
  }

  return NextResponse.json({ ok: true });
}
