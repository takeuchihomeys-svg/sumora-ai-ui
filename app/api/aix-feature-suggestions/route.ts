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

  // implemented マーク時: ルール生成の前に ruleText を検証してからステータス更新（同期処理）
  if (status === "implemented") {
    const { data: sg } = await supabase
      .from("aix_feature_suggestions")
      .select("description, implementation_notes, action_type")
      .eq("id", id)
      .maybeSingle();

    if (!sg) {
      return NextResponse.json({ ok: false, error: "提案が見つかりません" }, { status: 404 });
    }

    const notes = (sg.implementation_notes as string | null)?.trim() ?? "";
    const desc = (sg.description as string | null)?.trim() ?? "";
    // 各フィールドを独立してトリミング（notes単独500字超で desc が消えるバグを防ぐ）
    const ruleText = [
      notes ? notes.slice(0, 350) : "",
      desc ? desc.slice(0, 150) : "",
    ].filter(Boolean).join("\n").trim();

    if (!ruleText) {
      // ruleText が空 = ルールを生成できない → implementedマークをブロック
      return NextResponse.json({
        ok: false,
        error: "implementation_notes または description が必要です（ルールを生成できません）",
      }, { status: 400 });
    }

    // ステータス更新
    const { error: updateErr } = await supabase
      .from("aix_feature_suggestions")
      .update({ status })
      .eq("id", id);
    if (updateErr) return NextResponse.json({ ok: false, error: updateErr.message }, { status: 500 });

    const actionType = (sg.action_type as string | null) ?? null;

    // AIXスコープルール（同action_typeのAIXで最優先）— 同期実行・失敗時は500を返す
    const { error: upsertErr } = await supabase.from("ai_prompt_rules").upsert({
      rule_key: "IMPLEMENT-" + id,
      action_type: actionType,
      rule_text: ruleText,
      reason: "AIX改善案: 実装完了としてマーク済み",
      priority: 7,
      is_active: true,
    }, { onConflict: "rule_key" });
    if (upsertErr) {
      return NextResponse.json({ ok: false, error: "ルール登録失敗: " + upsertErr.message }, { status: 500 });
    }

    // generate-reply コピー: action_type があるルールも LINE 返信生成に届けるため
    if (actionType) {
      const { error: grErr } = await supabase.from("ai_prompt_rules").upsert({
        rule_key: "IMPLEMENT-" + id + "-gr",
        action_type: "generate_reply",
        rule_text: ruleText,
        reason: "AIX改善案: generate-reply コピー",
        priority: 7,
        is_active: true,
      }, { onConflict: "rule_key" });
      if (grErr) {
        // メインルールは登録済みなので警告のみ（致命的ではない）
        console.error("[aix-feature-suggestions] generate-reply コピールール登録失敗:", grErr.message);
      }
    }

    return NextResponse.json({ ok: true, updated: true });
  }

  // implemented 以外のステータス更新（adopted / dismissed）
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
