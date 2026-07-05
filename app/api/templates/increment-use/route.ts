import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// テンプレート使用回数のインクリメント
// POST /api/templates/increment-use { templateId }
// use_count を +1、last_used_at を現在時刻に更新する
export async function POST(req: NextRequest) {
  const { templateId } = await req.json() as { templateId?: string };
  if (!templateId) {
    return NextResponse.json({ ok: false, error: "templateId required" }, { status: 400 });
  }

  // RPC でアトミックインクリメント（Read-Modify-Write 競合を排除）
  const { error } = await supabase.rpc("increment_template_use_count", { p_id: templateId });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
