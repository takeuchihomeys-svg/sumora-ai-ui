import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// AIXアクション → テンプレートカテゴリ変換
// ※ 値は TemplateModal.tsx の AIX_CATEGORY_ORDER（実カテゴリ名）と一致させること
const ACTION_TO_CATEGORY: Record<string, string> = {
  property_send: "物件ピックアップした【AIX】",
  property_recommendation: "物件オススメ【AIX】",
  property_check_result: "物件確認した【AIX】",
  viewing_invite: "内覧へ！【AIX】",
  application_push: "申込へ！【AIX】",
  meeting_place: "内覧【AIX】",
  condition_hearing: "ヒアリング【AIX】",
  estimate_sheet: "見積書送る【AIX】",
  greeting_viewing: "内覧【AIX】",
};

// AIXアクション → デフォルトタイトル
const ACTION_TO_DEFAULT_TITLE: Record<string, string> = {
  property_send: "物件ピックアップした",
  property_recommendation: "イチオシ物件",
  property_check_result: "物件確認結果",
  viewing_invite: "内覧誘導",
  application_push: "申込誘導",
  meeting_place: "待ち合わせ案内",
  condition_hearing: "条件ヒアリング",
  estimate_sheet: "見積書送付",
  greeting_viewing: "内覧挨拶",
};

// GET: 未採用・未却下の候補を全件返す（カテゴリ順）
export async function GET() {
  const { data, error } = await supabase
    .from("ai_template_candidates")
    .select("*")
    .eq("is_adopted", false)
    .eq("is_dismissed", false)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, candidates: data ?? [] });
}

// POST: 新しいテンプレート候補を保存
export async function POST(req: NextRequest) {
  const body = await req.json() as {
    actionType: string;
    templateText: string;
    conversationId?: string;
    suggestedTitle?: string;
  };

  const { actionType, templateText, conversationId, suggestedTitle } = body;
  if (!actionType || !templateText?.trim()) {
    return NextResponse.json({ ok: false, error: "actionType and templateText required" }, { status: 400 });
  }

  const category = ACTION_TO_CATEGORY[actionType] ?? "その他【AIX】";
  const defaultTitle = ACTION_TO_DEFAULT_TITLE[actionType] ?? actionType;
  const title = suggestedTitle?.trim() || defaultTitle;
  const text = templateText.trim();

  // 重複チェック: 同じカテゴリ・同じ本文（先頭50文字）が既に候補にあればスキップ
  const textKey = text.slice(0, 50);
  const { data: existing } = await supabase
    .from("ai_template_candidates")
    .select("id")
    .eq("category", category)
    .eq("is_dismissed", false)
    .ilike("template_text", `${textKey}%`)
    .limit(1);

  if (existing && existing.length > 0) {
    return NextResponse.json({ ok: true, skipped: true, reason: "duplicate" });
  }

  const { error } = await supabase.from("ai_template_candidates").insert({
    action_type: actionType,
    category,
    suggested_title: title,
    template_text: text,
    conversation_id: conversationId ?? null,
  });

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, saved: true });
}

// PATCH: 採用（adopt）or 却下（dismiss）
export async function PATCH(req: NextRequest) {
  const body = await req.json() as {
    id: string;
    action: "adopt" | "dismiss";
    customTitle?: string;
    customCategory?: string;
  };

  const { id, action, customTitle, customCategory } = body;
  if (!id || !action) return NextResponse.json({ ok: false, error: "id and action required" }, { status: 400 });

  if (action === "dismiss") {
    const { error } = await supabase
      .from("ai_template_candidates")
      .update({ is_dismissed: true })
      .eq("id", id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, dismissed: true });
  }

  if (action === "adopt") {
    // 候補を取得
    const { data: candidate, error: fetchErr } = await supabase
      .from("ai_template_candidates")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchErr || !candidate) {
      return NextResponse.json({ ok: false, error: "Candidate not found" }, { status: 404 });
    }

    const c = candidate as {
      id: string;
      category: string;
      suggested_title: string;
      template_text: string;
      action_type: string;
    };

    // templates テーブルに INSERT
    const { data: newTemplate, error: insertErr } = await supabase
      .from("templates")
      .insert({
        category: customCategory ?? c.category,
        label: customTitle ?? c.suggested_title,
        text: c.template_text,
        sort_order: 0,
        requires_image: false,
      })
      .select("id")
      .single();

    if (insertErr) return NextResponse.json({ ok: false, error: insertErr.message }, { status: 500 });

    const templateId = (newTemplate as { id: string }).id;

    // 候補を採用済みにマーク
    await supabase
      .from("ai_template_candidates")
      .update({ is_adopted: true, adopted_template_id: templateId })
      .eq("id", id);

    return NextResponse.json({ ok: true, adopted: true, templateId });
  }

  return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
}
