import { NextRequest, NextResponse, after } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";

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
  const authError = requireInternalAuth(req);
  if (authError) return authError;

  const { id, source, result, result_note } = await req.json() as {
    id: string;
    source?: string;
    // 空室確認の構造化結果（物件あった=available / 2番手=second_position / 埋まってた=taken / 退去予定=move_out_planned）
    result?: "available" | "taken" | "second_position" | "move_out_planned";
    result_note?: string;
  };
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

  const VALID_RESULTS = ["available", "taken", "second_position", "move_out_planned"];
  const completedAt = new Date().toISOString();
  const patch: Record<string, unknown> = { status: "completed", completed_at: completedAt };
  if (result && VALID_RESULTS.includes(result)) {
    patch.result = result;
    patch.result_note = result_note?.slice(0, 500) ?? null;
    patch.resolved_at = completedAt;
  }

  const { data: task, error } = await supabase
    .from("line_tasks")
    .update(patch)
    .eq("id", id)
    .eq("status", "pending")
    .select("task_type, customer_name, conversation_id")
    .single();

  if (error || !task) {
    return NextResponse.json({ ok: false, reason: "not found or already completed" });
  }

  // AIX誘導中sentinelをクリア（他にpendingタスクが残っていない場合のみ）
  const { count: remainingTasks } = await supabase
    .from("line_tasks")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", task.conversation_id as string)
    .eq("status", "pending")
    .neq("id", id);
  if ((remainingTasks ?? 0) === 0) {
    const { error: clearErr } = await supabase
      .from("conversations")
      .update({ ai_draft: null, draft_attempted_at: null })
      .eq("id", task.conversation_id as string)
      .eq("ai_draft", "[AIX誘導中]");
    if (clearErr) console.error("[line-tasks/complete] sentinelクリア失敗:", task.conversation_id, clearErr);
  }

  const label = TASK_LABEL[task.task_type as string] ?? task.task_type;
  const suffix = source === "aix" ? "AIX送信で完了しました" : "2通送信で自動完了しました";
  const text = `✅【${label} 完了】\n${task.customer_name as string}さんへ${suffix}`;

  sendGroupMessage(text).catch(console.error);

  // 物件出し完了時：紐付き顧客の property_send_count を自動+1
  if (task.task_type === "property_send") {
    after(async () => {
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
    });
  }

  // 空室確認タスクの結果 → 直近送付物件の募集状況を事実化（Writer 5）
  // 対象物件 = この会話の最新 sent_property（確認対象は直近送付物件というヒューリスティック）
  if (task.task_type === "property_check" && patch.result) {
    after(async () => {
      try {
        const STATUS_MAP: Record<string, string> = {
          available: "open",
          taken: "occupied",
          second_position: "open",
          move_out_planned: "move_out_planned",
        };
        const { data: sp } = await supabase
          .from("sent_properties")
          .select("id")
          .eq("conversation_id", task.conversation_id as string)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!sp) return;
        const upd: Record<string, unknown> = {
          recruitment_status: STATUS_MAP[patch.result as string],
          recruitment_checked_at: new Date().toISOString(),
        };
        if (patch.result === "second_position") upd.applicant_rank = 2;
        if (patch.result === "available") upd.applicant_rank = 1;
        await supabase.from("sent_properties").update(upd).eq("id", sp.id as string);
      } catch (e) {
        console.warn("[line-tasks/complete] sent_properties status:", e);
      }
    });
  }

  return NextResponse.json({ ok: true });
}
