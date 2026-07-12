import { NextRequest, NextResponse, after } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { upsertKnowledge, generateEmbedding, buildKnowledgeEmbeddingInput } from "@/app/lib/knowledge-utils";

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
  followup_revive: "追客【AIX】",
  acknowledge_check: "確認します【AIX】",
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
  followup_revive: "追客メッセージ",
  acknowledge_check: "確認します",
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

  // aix_edit は evidence_count >= 2 のもののみ返す（1件だけのものは顧客名入りノイズになりやすい）
  // 他のsource（auto / improvement / manual 等）はフィルタなし
  const candidates = (data ?? []).filter(
    (c: { source?: string | null; evidence_count?: number | null }) =>
      c.source !== "aix_edit" || (c.evidence_count ?? 1) >= 2
  );
  return NextResponse.json({ ok: true, candidates });
}

// POST: 新しいテンプレート候補を保存
export async function POST(req: NextRequest) {
  const body = await req.json() as {
    actionType: string;
    templateText: string;
    conversationId?: string;
    suggestedTitle?: string;
    source?: string;
    originalText?: string;
    reason?: string;
  };

  const { actionType, templateText, conversationId, suggestedTitle, source, originalText, reason } = body;
  if (!actionType || !templateText?.trim()) {
    return NextResponse.json({ ok: false, error: "actionType and templateText required" }, { status: 400 });
  }

  const category = ACTION_TO_CATEGORY[actionType] ?? "その他【AIX】";
  const defaultTitle = ACTION_TO_DEFAULT_TITLE[actionType] ?? actionType;
  const title = suggestedTitle?.trim() || defaultTitle;
  const text = templateText.trim();

  // 重複チェック: 同じカテゴリ・同じ本文（先頭50文字）が既に候補にあるか
  // LIKE特殊文字（% _ \）をエスケープして誤マッチを防ぐ
  const textKey = text.slice(0, 50);
  const escapedKey = textKey.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  const { data: existing } = await supabase
    .from("ai_template_candidates")
    .select("id, evidence_count")
    .eq("category", category)
    .eq("is_dismissed", false)
    .ilike("template_text", `${escapedKey}%`)
    .limit(1);

  if (existing && existing.length > 0) {
    // P1: 重複はスキップではなく「同じ編集パターンの証拠」としてカウントアップ
    const dup = existing[0] as { id: string; evidence_count: number | null };
    const newCount = (dup.evidence_count ?? 1) + 1;
    const { error: updErr } = await supabase
      .from("ai_template_candidates")
      .update({
        evidence_count: newCount,
        ...(reason?.trim() ? { reason: reason.trim() } : {}),
      })
      .eq("id", dup.id);
    if (updErr) return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });
    return NextResponse.json({ ok: true, merged: true, evidenceCount: newCount });
  }

  const { error } = await supabase.from("ai_template_candidates").insert({
    action_type: actionType,
    category,
    suggested_title: title,
    template_text: text,
    conversation_id: conversationId ?? null,
    source: source ?? "manual",
    original_text: originalText ?? null,
    reason: reason?.trim() || null,
    evidence_count: 1,
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
    customText?: string;
    dismissedReason?: string;
  };

  const { id, action, customTitle, customCategory, customText, dismissedReason } = body;
  if (!id || !action) return NextResponse.json({ ok: false, error: "id and action required" }, { status: 400 });

  if (action === "dismiss") {
    // P5: 却下理由チップ（既存テンプレで足りる/文が不自然/場面が違う/情報が古い）を保存し週次学習の材料にする
    const { error } = await supabase
      .from("ai_template_candidates")
      .update({
        is_dismissed: true,
        ...(dismissedReason?.trim() ? { dismissed_reason: dismissedReason.trim() } : {}),
      })
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
        text: customText?.trim() || c.template_text,
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

    // 採用後、テンプレート本文を ai_reply_knowledge に正例として学習（fire-and-forget）
    after(async () => {
      try {
        const textToLearn = customText?.trim() || c.template_text;
        // trigger_example = 候補タイトル（どういう状況で使うかのヒント）をベクトルに含めることで
        // 顧客メッセージクエリとの類似度が上がり vector 検索でヒットしやすくなる
        const triggerHint = (customTitle ?? c.suggested_title ?? "").slice(0, 60);
        const embInput = buildKnowledgeEmbeddingInput({
          content: textToLearn,
          conversation_state: c.action_type,
          trigger_example: triggerHint || undefined,
        });
        const embedding = embInput ? await generateEmbedding(embInput) : null;
        await upsertKnowledge(supabase, {
          title: "[採用テンプレ] " + (customTitle ?? c.suggested_title).slice(0, 40),
          content: textToLearn,
          category: "pattern",
          importance: 8,
          conversation_state: c.action_type,
          ...(embedding ? { embedding } : {}),
        });
      } catch (e) {
        console.warn("[ai-template-candidates] 採用後ナレッジ保存失敗:", e);
      }
    });

    return NextResponse.json({ ok: true, adopted: true, templateId });
  }

  return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
}
