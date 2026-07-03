import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { normalizeStatus } from "@/app/lib/status-normalize";

// AIX送信後に呼び出す（1件ログ）または既存データをブートストラップ
// POST { action: "log", conversation_status, action_type, customer_msg_summary }
// POST { action: "bootstrap" }  → 既存データから一括学習
// GET → パターン統計を返す

export async function GET() {
  const { data, error } = await supabase
    .from("action_pattern_logs")
    .select("conversation_status, action_type")
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // ステータス×アクションの集計
  const freq: Record<string, Record<string, number>> = {};
  for (const row of data ?? []) {
    const s = row.conversation_status as string;
    const a = row.action_type as string;
    freq[s] ??= {};
    freq[s][a] = (freq[s][a] ?? 0) + 1;
  }
  return NextResponse.json({ ok: true, total: data?.length ?? 0, freq });
}

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    action: "log" | "bootstrap";
    conversation_status?: string;
    action_type?: string;
    customer_msg_summary?: string;
    previous_action_type?: string;
    predicted_action?: string;
    source?: string;
  };

  // ① 1件ログ（AIX送信後にフロントから呼ぶ）
  if (body.action === "log") {
    if (!body.conversation_status || !body.action_type) {
      return NextResponse.json({ ok: false, error: "missing fields" });
    }
    // フロントから渡された source を尊重（提案採択学習ループ用）
    const ALLOWED_SOURCES = new Set(["manual", "suggestion_accepted", "suggestion_dismissed", "prediction_match", "prediction_mismatch"]);
    const source = body.source && ALLOWED_SOURCES.has(body.source) ? body.source : "manual";
    await supabase.from("action_pattern_logs").insert({
      conversation_status: normalizeStatus(body.conversation_status),
      action_type: body.action_type,
      customer_msg_summary: (body.customer_msg_summary ?? "").slice(0, 150),
      previous_action_type: body.previous_action_type ?? null,
      predicted_action: body.predicted_action ?? null,
      source,
    });
    return NextResponse.json({ ok: true });
  }

  // ② ブートストラップ（一度だけ呼ぶ）
  if (body.action === "bootstrap") {
    const inserted: { status: string; action: string; msg: string }[] = [];

    // ---- A: line_tasks → property_check / property_send / estimate_sheet ----
    const { data: tasks } = await supabase
      .from("line_tasks")
      .select("id, conversation_id, task_type, created_at")
      .in("status", ["completed", "pending"])
      .order("created_at", { ascending: false })
      .limit(400);

    for (const task of tasks ?? []) {
      // タスク作成直前の顧客メッセージを取得
      const { data: msgRow } = await supabase
        .from("messages")
        .select("text")
        .eq("conversation_id", task.conversation_id as string)
        .eq("sender", "customer")
        .lt("created_at", task.created_at as string)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      // この会話の現在のステータス
      const { data: conv } = await supabase
        .from("conversations")
        .select("status")
        .eq("id", task.conversation_id as string)
        .single();

      const status = normalizeStatus((conv?.status as string) ?? "hearing");
      const actionType = task.task_type as string;
      const msgText = ((msgRow?.text as string) ?? "").slice(0, 150);

      await supabase.from("action_pattern_logs").insert({
        conversation_status: status,
        action_type: actionType,
        customer_msg_summary: msgText,
        source: "bootstrap",
      });
      inserted.push({ status, action: actionType, msg: msgText.slice(0, 30) });
    }

    // ---- B: 内覧・申込フェーズの会話から viewing_invite / application_push を推定 ----
    // viewing以降のステータス = 内覧が成立したはず
    const { data: viewingConvs } = await supabase
      .from("conversations")
      .select("id, status")
      .in("status", ["viewing", "application", "contract"])
      .limit(200);

    for (const conv of viewingConvs ?? []) {
      // その会話の最後の顧客メッセージを取得（タイミング推定用）
      const { data: msgRow } = await supabase
        .from("messages")
        .select("text")
        .eq("conversation_id", conv.id as string)
        .eq("sender", "customer")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      // viewing = proposing → viewing の遷移で viewing_invite が使われた
      // application/contract = viewing → application で application_push が使われた
      const rawPrevStatus = (conv.status as string) === "viewing" ? "proposing" : "viewing";
      const prevStatus = normalizeStatus(rawPrevStatus);
      const actionType = (conv.status as string) === "viewing" ? "viewing_invite" : "application_push";
      const msgText = ((msgRow?.text as string) ?? "").slice(0, 150);

      await supabase.from("action_pattern_logs").insert({
        conversation_status: prevStatus,
        action_type: actionType,
        customer_msg_summary: msgText,
        source: "bootstrap_inferred",
      });
      inserted.push({ status: prevStatus, action: actionType, msg: msgText.slice(0, 30) });
    }

    return NextResponse.json({ ok: true, inserted: inserted.length, breakdown: inserted.slice(0, 20) });
  }

  return NextResponse.json({ ok: false, error: "unknown action" });
}
