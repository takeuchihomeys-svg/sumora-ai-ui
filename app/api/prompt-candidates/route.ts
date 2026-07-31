import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// プロンプト候補ピッカー API
// cron（prompt-candidate-gen）が生成した prompt_candidates を
// TemplateModal の AI質問タブ下部で一覧表示し、承認/却下する。
// 承認時は ai_prompt_rules に insert され、fetchPromptRules() の
// 非LEARN枠に自動的に乗って generate-reply / AIX プロンプトへ注入される。

export const maxDuration = 30;

// ─────────────────────────────────────────────
// GET: pending 候補一覧（バッジ用 pendingCount 付き）
// ─────────────────────────────────────────────
export async function GET() {
  try {
    const { data, error, count } = await supabase
      .from("prompt_candidates")
      .select("id, content, reason, category, action_type, status, week_label, created_at", { count: "exact" })
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) {
      console.error("[prompt-candidates] GET error:", error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      candidates: data ?? [],
      pendingCount: count ?? (data?.length ?? 0),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[prompt-candidates] GET exception:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// ─────────────────────────────────────────────
// PATCH: { id, action: 'approve' | 'dismiss', editedContent? }
//   dismiss → status='dismissed' のみ
//   approve → ai_prompt_rules に insert → status='approved' + applied_rule_id
// ─────────────────────────────────────────────
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const id: string | undefined = body?.id;
    const action: string | undefined = body?.action;
    const editedContent: string | undefined =
      typeof body?.editedContent === "string" && body.editedContent.trim()
        ? body.editedContent.trim()
        : undefined;

    if (!id || (action !== "approve" && action !== "dismiss")) {
      return NextResponse.json(
        { ok: false, error: "id と action ('approve' | 'dismiss') が必要です" },
        { status: 400 }
      );
    }

    // 存在チェック（prompt-rules PATCH と同じガード構造）
    const { data: candidate, error: fetchErr } = await supabase
      .from("prompt_candidates")
      .select("id, content, reason, category, action_type, status, source_feedback_ids")
      .eq("id", id)
      .maybeSingle();

    if (fetchErr) {
      return NextResponse.json({ ok: false, error: fetchErr.message }, { status: 500 });
    }
    if (!candidate) {
      return NextResponse.json({ ok: false, error: "候補が見つかりません" }, { status: 404 });
    }
    if (candidate.status !== "pending") {
      return NextResponse.json(
        { ok: false, error: `この候補は既に処理済みです（status=${candidate.status}）` },
        { status: 409 }
      );
    }

    const nowIso = new Date().toISOString();

    if (action === "dismiss") {
      const { error: updErr } = await supabase
        .from("prompt_candidates")
        .update({ status: "dismissed", reviewed_at: nowIso })
        .eq("id", id);

      if (updErr) {
        return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });
      }
      return NextResponse.json({ ok: true, message: "候補を却下しました" });
    }

    // ── approve ──
    const ruleText = editedContent ?? candidate.content;

    // 重複ガード: 同一 rule_text のアクティブルールが既にあれば insert しない
    const { data: dup } = await supabase
      .from("ai_prompt_rules")
      .select("id")
      .eq("rule_text", ruleText)
      .eq("is_active", true)
      .limit(1);

    let ruleId: string | null = null;

    if (dup && dup.length > 0) {
      ruleId = dup[0].id;
    } else {
      const sourceIds: string[] = Array.isArray(candidate.source_feedback_ids)
        ? candidate.source_feedback_ids
        : [];

      const { data: inserted, error: insErr } = await supabase
        .from("ai_prompt_rules")
        .insert({
          rule_key: `PROMPT_CANDIDATE_${id.slice(0, 8)}`,
          rule_text: ruleText,
          reason: candidate.reason ?? `プロンプト候補ピッカーで承認（category=${candidate.category ?? "unknown"}）`,
          action_type: candidate.action_type ?? null,
          priority: 5,
          is_active: true,
          is_permanent: false,
          source_feedback_item_id: sourceIds[0] ?? null,
        })
        .select("id")
        .single();

      if (insErr) {
        return NextResponse.json(
          { ok: false, error: `ai_prompt_rules への登録に失敗: ${insErr.message}` },
          { status: 500 }
        );
      }
      ruleId = inserted?.id ?? null;
    }

    const { error: updErr } = await supabase
      .from("prompt_candidates")
      .update({ status: "approved", applied_rule_id: ruleId, reviewed_at: nowIso })
      .eq("id", id);

    if (updErr) {
      // ルールは作成済みだが候補の更新に失敗した状態（次回PATCHで409になり再insertは重複ガードで防がれる）
      return NextResponse.json(
        { ok: false, error: `ルール作成後の候補更新に失敗: ${updErr.message}`, ruleId },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, message: "候補を承認しルール化しました", ruleId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[prompt-candidates] PATCH exception:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
