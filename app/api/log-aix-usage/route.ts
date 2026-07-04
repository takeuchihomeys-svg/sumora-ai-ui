import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// POST /api/log-aix-usage
// AIX送信時にどのAIX+テンプレートを使ったか記録する（analyze-aix-flowで分析に使用）
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      conversation_id: string;
      aix_type: string;
      template_id?: string | null;
      template_name?: string | null;
      template_category?: string | null;
      conversation_status?: string | null;
      suggested_action?: string | null;
      line_message_id?: string | null;
      sent_at?: string | null;
      previous_action_type?: string | null;
    };

    const { conversation_id, aix_type, template_id, template_name, template_category, conversation_status, suggested_action, line_message_id, sent_at, previous_action_type } = body;
    if (!conversation_id || !aix_type) {
      return NextResponse.json({ ok: false, error: "conversation_id and aix_type required" }, { status: 400 });
    }

    // PA-1: 前回AIXの確実な記録。フロントのin-memory refはリロードで消えるため、
    // 未指定時はこの会話の直近 aix_usage_logs からサーバー側で復元する（INSERT前に読むので競合なし）
    let previousAction: string | null = previous_action_type ?? null;
    if (!previousAction) {
      const { data: prevRow } = await supabase
        .from("aix_usage_logs")
        .select("aix_type")
        .eq("conversation_id", conversation_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      previousAction = (prevRow?.aix_type as string) ?? null;
    }

    const { error } = await supabase.from("aix_usage_logs").insert({
      conversation_id,
      aix_type,
      template_id: template_id ?? null,
      template_name: template_name ?? null,
      template_category: template_category ?? null,
      conversation_status: conversation_status ?? null,
      suggested_action: suggested_action ?? null,
      // P4: LINE送信メッセージの厳密特定用（auto-template-candidatesがsent_atベースでマッチ）
      line_message_id: line_message_id ?? null,
      sent_at: sent_at ?? null,
      // PA-1: チェーンルール学習用（learn-trigger-rules が前後関係を分析できる）
      previous_action_type: previousAction,
    });

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, previous_action_type: previousAction });
  } catch (e) {
    console.error("[log-aix-usage]", e);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
