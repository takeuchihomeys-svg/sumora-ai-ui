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

  // Supabaseの.updateは直接インクリメントできないため、現在値取得 → +1 の2ステップ
  const { data: tmpl } = await supabase
    .from("templates")
    .select("use_count")
    .eq("id", templateId)
    .single();

  const { error } = await supabase
    .from("templates")
    .update({
      use_count: (tmpl?.use_count ?? 0) + 1,
      last_used_at: new Date().toISOString(),
    })
    .eq("id", templateId);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
