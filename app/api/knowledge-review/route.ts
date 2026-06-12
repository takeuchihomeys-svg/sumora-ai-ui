import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// GET: 自動抽出ナレッジ一覧
export async function GET() {
  const { data, error } = await supabase
    .from("ai_reply_knowledge")
    .select("id, title, content, category, conversation_state, importance, created_at")
    .like("title", "差分学習%")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return NextResponse.json({ rules: [] });
  return NextResponse.json({ rules: data ?? [] });
}

// DELETE: ナレッジ削除
export async function DELETE(req: NextRequest) {
  const { id } = await req.json() as { id: string };
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

  const { error } = await supabase
    .from("ai_reply_knowledge")
    .delete()
    .eq("id", id);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// PATCH: 承認（タイトルを「差分学習 [承認済]」に変更）
export async function PATCH(req: NextRequest) {
  const { id } = await req.json() as { id: string };
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

  const { error } = await supabase
    .from("ai_reply_knowledge")
    .update({ title: "差分学習 [承認済]", importance: 10 })
    .eq("id", id);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
