import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// P4: AIX機能改善提案（aix_feature_suggestions）
// corpus2skill 週次Opusが new_aix_picker 提案をINSERTし、
// TemplateModal の「💡 AIX改善案」タブで採用/却下を管理する

// GET: pending の改善提案を最新20件
export async function GET() {
  const { data, error } = await supabase
    .from("aix_feature_suggestions")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, suggestions: data ?? [] });
}

// POST: status 更新（adopted / dismissed。却下時は dismissedReason も保存）
export async function POST(req: NextRequest) {
  const body = await req.json() as {
    id: string;
    status: "adopted" | "dismissed";
    dismissedReason?: string;
  };

  const { id, status, dismissedReason } = body;
  if (!id || (status !== "adopted" && status !== "dismissed")) {
    return NextResponse.json({ ok: false, error: "id and status (adopted|dismissed) required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("aix_feature_suggestions")
    .update({
      status,
      ...(status === "dismissed" && dismissedReason?.trim() ? { dismissed_reason: dismissedReason.trim() } : {}),
    })
    .eq("id", id);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, updated: true });
}
