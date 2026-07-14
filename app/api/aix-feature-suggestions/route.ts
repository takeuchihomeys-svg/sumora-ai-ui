import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { syncConfirmedToPromptRule } from "@/app/lib/knowledge-promote";

// P4: AIX機能改善提案（aix_feature_suggestions）
// corpus2skill 週次Opusが new_aix_picker 提案をINSERTし、
// TemplateModal の「💡 AIX改善案」タブで採用/却下を管理する

// GET: pending + approved の改善提案を最新100件
// ?type=<suggestion_type> で suggestion_type フィルタリング可能
//   例: ?type=knowledge_question → auto-judge で生成されたナレッジ品質確認質問のみ返す
// approved = 改善案打ち合わせ（/api/aix/improvement-meeting）で確定した実装待ち仕様。タブ上部に表示する
// limit=100: 20件だと直近の knowledge_aix_align 等で枠が埋まり、古い new_picker 提案が
// 「②ピッカー」フィルターに1件も出なくなるため拡大した
export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type");

  let query = supabase
    .from("aix_feature_suggestions")
    .select("*")
    .in("status", ["pending", "approved", "adopted"])
    .order("created_at", { ascending: false })
    .limit(100);

  if (type) query = query.eq("suggestion_type", type);

  const { data, error } = await query;

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  // 打ち合わせ済み（approved = 実装待ち）を上部に表示
  const STATUS_ORDER: Record<string, number> = { approved: 0, adopted: 1, pending: 2 };
  const suggestions = (data ?? []).sort((a, b) => {
    const ao = STATUS_ORDER[a.status as string] ?? 3;
    const bo = STATUS_ORDER[b.status as string] ?? 3;
    if (ao !== bo) return ao - bo;
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
    // adopted 時のナレッジ連動用（UIが implementation_notes からパースして渡す。無ければDBから補完）
    suggestion_type?: string;
    knowledge_id?: string;
    append_text?: string;
  };

  const { id, status, dismissedReason } = body;
  if (!id || !["adopted", "dismissed", "implemented"].includes(status)) {
    return NextResponse.json({ ok: false, error: "id and status (adopted|dismissed|implemented) required" }, { status: 400 });
  }

  // implemented マーク時: ルール生成の前に ruleText を検証してからステータス更新（同期処理）
  if (status === "implemented") {
    const { data: sg } = await supabase
      .from("aix_feature_suggestions")
      .select("description, implementation_notes, action_type, suggestion_type")
      .eq("id", id)
      .maybeSingle();

    if (!sg) {
      return NextResponse.json({ ok: false, error: "提案が見つかりません" }, { status: 404 });
    }

    // knowledge_question: auto-judgeが生成したナレッジ品質確認質問。
    // clarify (/api/knowledge-review PATCH) が既に HUMAN-* ルールを作成済みのため、
    // ここでは status を "implemented" に更新するだけ（重複ルール作成を防ぐ）
    if ((sg as Record<string, unknown>).suggestion_type === "knowledge_question") {
      const { error: sErr } = await supabase
        .from("aix_feature_suggestions")
        .update({ status: "implemented" })
        .eq("id", id);
      if (sErr) console.warn("[aix-feature-suggestions] knowledge_question status更新失敗:", sErr.message);
      return NextResponse.json({ ok: true, updated: true, type: "knowledge_question" });
    }

    // knowledge_aix_align: ナレッジコンテンツ直接更新（ai_prompt_rulesは作成しない）
    if ((sg as Record<string, unknown>).suggestion_type === "knowledge_aix_align") {
      try {
        const rawNotes = (sg.implementation_notes as string | null) ?? "{}";
        const { knowledge_id, append_text } = JSON.parse(rawNotes) as { knowledge_id?: string; append_text?: string };
        if (!knowledge_id || !append_text) {
          return NextResponse.json({ ok: false, error: "implementation_notesにknowledge_idまたはappend_textがありません" }, { status: 400 });
        }
        const { data: kRow } = await supabase
          .from("ai_reply_knowledge")
          .select("content, importance, conversation_state, title")
          .eq("id", knowledge_id)
          .maybeSingle();
        const newContent = ((kRow?.content as string | null) ?? "") + "\n" + append_text;
        const { error: kUpdateErr } = await supabase
          .from("ai_reply_knowledge")
          .update({ content: newContent })
          .eq("id", knowledge_id);
        if (kUpdateErr) {
          return NextResponse.json({ ok: false, error: "ナレッジ更新失敗: " + kUpdateErr.message }, { status: 500 });
        }
        // ai_prompt_rules に即時反映（knowledge_aix_align は content 更新のみで sync を呼ばないバグを修正）
        await syncConfirmedToPromptRule({
          id: knowledge_id,
          title: (kRow?.title as string | null) ?? "",
          content: newContent,
          importance: (kRow?.importance as number | null) ?? 0,
          conversation_state: (kRow?.conversation_state as string | null) ?? null,
        });
        const { error: sErr } = await supabase
          .from("aix_feature_suggestions")
          .update({ status: "implemented" })
          .eq("id", id);
        if (sErr) console.warn("[aix-feature-suggestions] status更新失敗:", sErr.message);
        return NextResponse.json({ ok: true, updated: true, type: "knowledge_aix_align" });
      } catch (e) {
        return NextResponse.json({ ok: false, error: "knowledge_aix_align処理エラー: " + String(e) }, { status: 500 });
      }
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

    // action_type=nullのルールは全アクション・全generate-replyに適用されます
    const warning = !sg.action_type ? 'action_type未設定のため全アクションにルールが適用されます' : null;
    return NextResponse.json({ ok: true, updated: true, ...(warning ? { warning } : {}) });
  }

  // ── adopted: ナレッジ連動型の提案は「採用」時点で実際にナレッジへ反映する ──
  // （従来は status を adopted に変えるだけのデッドエンドで、ナレッジ側に何も起きなかった）
  if (status === "adopted") {
    try {
      // suggestion_type / knowledge_id / append_text は UI から渡されるが、
      // 欠けている場合は DB の実データから補完する（古いUIキャッシュでも動作させる）
      let suggestionType = body.suggestion_type ?? null;
      let knowledgeId = body.knowledge_id ?? null;
      let appendText = body.append_text ?? null;
      if (!suggestionType || !knowledgeId) {
        const { data: sg } = await supabase
          .from("aix_feature_suggestions")
          .select("suggestion_type, implementation_notes")
          .eq("id", id)
          .maybeSingle();
        suggestionType = suggestionType ?? ((sg?.suggestion_type as string | null) ?? null);
        if (!knowledgeId && sg?.implementation_notes) {
          try {
            const notes = JSON.parse(sg.implementation_notes as string) as { knowledge_id?: string; append_text?: string };
            knowledgeId = notes.knowledge_id ?? null;
            appendText = appendText ?? (notes.append_text ?? null);
          } catch { /* implementation_notes がJSONでない提案は連動対象外 */ }
        }
      }

      // knowledge_aix_align: 追記テキストをナレッジ本文に反映 + confirmed 化 + ai_prompt_rules 再同期
      if (suggestionType === "knowledge_aix_align" && knowledgeId && appendText) {
        const { data: kRow } = await supabase
          .from("ai_reply_knowledge")
          .select("title, content, importance, conversation_state")
          .eq("id", knowledgeId)
          .maybeSingle();
        const newContent = (((kRow?.content as string | null) ?? "") + "\n" + appendText).trim();
        const { error: kErr } = await supabase
          .from("ai_reply_knowledge")
          .update({ content: newContent, hypothesis_status: "confirmed" })
          .eq("id", knowledgeId);
        if (!kErr) {
          await syncConfirmedToPromptRule({
            id: knowledgeId,
            title: (kRow?.title as string | null) ?? "",
            content: newContent,
            importance: (kRow?.importance as number | null) ?? 0,
            conversation_state: (kRow?.conversation_state as string | null) ?? null,
          });
        } else {
          console.warn("[aix-feature-suggestions] adopted knowledge_aix_align 更新失敗:", kErr.message);
        }
      }

      // knowledge_brushup: 対象ナレッジを confirmed に差し戻して ai_prompt_rules を再同期
      if (suggestionType === "knowledge_brushup" && knowledgeId) {
        const { error: kErr } = await supabase
          .from("ai_reply_knowledge")
          .update({ hypothesis_status: "confirmed" })
          .eq("id", knowledgeId);
        if (kErr) {
          // ナレッジ更新失敗はユーザーに伝え、status 更新も行わない（失敗を隠さない）
          return NextResponse.json({ ok: false, error: "ナレッジの更新に失敗しました: " + kErr.message }, { status: 500 });
        } else {
          const { data: kRow } = await supabase
            .from("ai_reply_knowledge")
            .select("id, title, content, conversation_state, importance")
            .eq("id", knowledgeId)
            .maybeSingle();
          if (kRow) await syncConfirmedToPromptRule(kRow);
        }
      }
    } catch (e) {
      // ナレッジ連動の失敗はステータス更新自体を止めない（警告のみ）
      console.warn("[aix-feature-suggestions] adopted ナレッジ連動処理失敗:", e);
    }
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
