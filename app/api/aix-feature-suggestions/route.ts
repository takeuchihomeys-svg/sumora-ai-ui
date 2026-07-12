import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// P4: AIX機能改善提案（aix_feature_suggestions）
// corpus2skill 週次Opusが new_aix_picker 提案をINSERTし、
// TemplateModal の「💡 AIX改善案」タブで採用/却下を管理する

// GET: pending + approved の改善提案を最新20件
// approved = 改善案打ち合わせ（/api/aix/improvement-meeting）で確定した実装待ち仕様。タブ上部に表示する
export async function GET() {
  const { data, error } = await supabase
    .from("aix_feature_suggestions")
    .select("*")
    .in("status", ["pending", "approved"])
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  // 打ち合わせ済み（approved = 実装待ち）を上部に表示
  const suggestions = (data ?? []).sort((a, b) => {
    if (a.status !== b.status) return a.status === "approved" ? -1 : 1;
    return 0; // created_at 降順（元のDB順）を維持
  });
  return NextResponse.json({ ok: true, suggestions });
}

// POST: status 更新（adopted / dismissed / implemented。却下時は dismissedReason も保存）
export async function POST(req: NextRequest) {
  const body = await req.json() as {
    id: string;
    status: "adopted" | "dismissed" | "implemented";
    dismissedReason?: string;
  };

  const { id, status, dismissedReason } = body;
  if (!id || !["adopted", "dismissed", "implemented"].includes(status)) {
    return NextResponse.json({ ok: false, error: "id and status (adopted|dismissed|implemented) required" }, { status: 400 });
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
