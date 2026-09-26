import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
// 2026-09-27 竹内: テスト用の会話（YUMA）は学習に入れない（一覧は test-conversations.ts の1か所）
import { isTestConversation } from "@/app/lib/test-conversations";

// テンプレート使用回数のインクリメント
// POST /api/templates/increment-use { templateId }
// use_count を +1、last_used_at を現在時刻に更新する
export async function POST(req: NextRequest) {
  const { templateId, conversationId } = await req.json() as { templateId?: string; conversationId?: string | null };
  if (!templateId) {
    return NextResponse.json({ ok: false, error: "templateId required" }, { status: 400 });
  }
  // 2026-09-27 竹内: テスト用の会話（YUMA）でテンプレートを使った回数は数えない（成績・推薦の学習に入る）
  if (isTestConversation(conversationId)) return NextResponse.json({ ok: true, skipped: true, reason: "test_conversation" });

  // RPC でアトミックインクリメント（Read-Modify-Write 競合を排除）
  const { error } = await supabase.rpc("increment_template_use_count", { p_id: templateId });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
