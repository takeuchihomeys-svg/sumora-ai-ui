import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { customerRequestedPropertyCheck } from "@/app/lib/aix-scene-evidence";

const TASK_LABEL: Record<string, string> = {
  property_check: "物件確認",
  property_send: "物件出し",
  estimate_sheet: "見積書対応",
};

const TASK_EMOJI: Record<string, string> = {
  property_check: "🔍",
  property_send: "🏠",
  estimate_sheet: "📋",
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

// GET: pending タスク一覧取得
export async function GET() {
  const { data, error } = await supabase
    .from("line_tasks")
    .select("id, conversation_id, task_type, status, customer_name, created_at")
    .eq("status", "pending");
  if (error) return NextResponse.json({ tasks: [] });
  return NextResponse.json({ tasks: data ?? [] });
}

// DELETE: タスクキャンセル
export async function DELETE(req: NextRequest) {
  const { id } = await req.json() as { id: string };
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

  const { data: task, error } = await supabase
    .from("line_tasks")
    .update({ status: "cancelled", completed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending")
    .select("task_type, customer_name, conversation_id")
    .single();

  if (error || !task) return NextResponse.json({ ok: false, reason: "not found" });

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
    if (clearErr) console.error("[line-tasks/delete] sentinelクリア失敗:", task.conversation_id, clearErr);
  }

  // 取消通知は物件出しのみ（2026-09-12 竹内方針: 物件確認・見積書対応は返信・AIX 系なのでグループに流さない）
  if (task.task_type === "property_send") {
    const label = TASK_LABEL[task.task_type as string] ?? task.task_type;
    const text = `🚫【${label} キャンセル】\n${task.customer_name as string}さんのタスクが取り消されました`;
    sendGroupMessage(text).catch(console.error);
  }
  return NextResponse.json({ ok: true });
}

// POST: タスク作成 + 売上番長グループへアナウンス
export async function POST(req: NextRequest) {
  const body = await req.json() as {
    conversation_id: string;
    task_type: "property_check" | "property_send" | "estimate_sheet";
    customer_name: string;
    silent?: boolean; // true: LINE グループへのアナウンスをスキップ（自動作成時）
    /** 自動作成の出どころ。staff_promise = スタッフが自分で「募集状況確認させて頂きます」等と送った（スタッフの判断なので確認不要） */
    source?: "staff_promise" | "ai_draft";
  };

  const { conversation_id, task_type, customer_name, silent, source } = body;
  if (!conversation_id || !task_type) {
    return NextResponse.json({ ok: false, error: "missing fields" }, { status: 400 });
  }

  // 2026-09-12 竹内「物件確認したもお客さんから物件確認の依頼があった場合となる」:
  //   自動作成（silent）の物件確認タスクは、お客様から確認の依頼（物件の送付・募集状況・入居日・審査・初期費用等）があった時だけ作る。
  //   スタッフがメニューから手動で依頼した時（silent なし）と、スタッフが自分で確認を約束して送った時（source=staff_promise）は
  //   スタッフの判断なのでそのまま作る。
  if (task_type === "property_check" && silent && source !== "staff_promise") {
    const { data: recent } = await supabase
      .from("messages")
      .select("sender, text, created_at")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: false })
      .limit(20);
    const oldestFirst = [...(recent ?? [])].reverse() as { sender: string; text: string | null }[];
    if (!customerRequestedPropertyCheck({ recentMessages: oldestFirst })) {
      return NextResponse.json({ ok: false, skipped: "no_customer_request" });
    }
  }

  // 同じ会話・タイプで既にpendingなら重複作成しない
  const { data: existing } = await supabase
    .from("line_tasks")
    .select("id, created_at")
    .eq("conversation_id", conversation_id)
    .eq("task_type", task_type)
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ ok: true, id: existing.id, created_at: existing.created_at, already_exists: true });
  }

  const { data: task, error } = await supabase
    .from("line_tasks")
    .insert({ conversation_id, task_type, customer_name, status: "pending" })
    .select("id, created_at")
    .single();

  if (error || !task) {
    return NextResponse.json({ ok: false, error: error?.message }, { status: 500 });
  }

  // 2026-09-12 竹内方針: 売上番長グループへの返信・AIX 系の通知は「AIX要対応」だけ → 物件確認・見積書対応の依頼通知は出さない（物件出しのみ）
  if (!silent && task_type === "property_send") {
    const label = TASK_LABEL[task_type] ?? task_type;
    const emoji = TASK_EMOJI[task_type] ?? "📋";
    const text = `${emoji}【${label}依頼】\n${customer_name}さんの${label}を開始しました\n担当スタッフ: 対応よろしくお願いします！`;
    sendGroupMessage(text).catch(console.error);
  }

  return NextResponse.json({ ok: true, id: task.id, created_at: task.created_at });
}
