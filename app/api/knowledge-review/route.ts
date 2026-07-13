import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { syncConfirmedToPromptRule, deactivatePromptRule } from "@/app/lib/knowledge-promote";

// GET: hypothesis ナレッジ一覧（手動承認待ち）
// ?mode=ambiguous: 曖昧ナレッジのみ返す（title短い or 条件・場面マーカーなし）
export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get("mode");

  const [{ data, error }, { count: totalHypothesis }] = await Promise.all([
    supabase
      .from("ai_reply_knowledge")
      .select("id, title, content, category, conversation_state, importance, correct_count, wrong_count, apply_count, needs_clarification, created_at")
      .eq("hypothesis_status", "hypothesis")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("ai_reply_knowledge")
      .select("*", { count: "exact", head: true })
      .eq("hypothesis_status", "hypothesis"),
  ]);

  if (error) return NextResponse.json({ rules: [], total: 0 });

  let rules = data ?? [];

  // 曖昧フィルタ: ?mode=ambiguous
  // 条件: タイトルが15文字未満 OR 内容に条件・場面マーカーなし OR needs_clarification=true
  if (mode === "ambiguous") {
    const STRUCTURE_MARKERS = ["→", "する場合", "ときは", "場面", "タイミング", "場合は", "際は", "のは", "すると"];
    rules = rules.filter(r => {
      if ((r as { needs_clarification?: boolean }).needs_clarification) return true;
      const title = (r.title as string) ?? "";
      const content = (r.content as string) ?? "";
      if (title.replace(/\s+/g, "").length < 15) return true;
      if (!STRUCTURE_MARKERS.some(m => content.includes(m))) return true;
      return false;
    });
  }

  return NextResponse.json({ rules, total: totalHypothesis ?? 0, mode: mode ?? "all" });
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

// PATCH: 承認（hypothesis_status → confirmed）/ 却下（hypothesis_status → rejected）/ ブラッシュアップ（content更新+再confirm）
export async function PATCH(req: NextRequest) {
  const body = await req.json() as { id: string; action?: "confirm" | "reject" | "brushup"; new_content?: string };
  const { id, action, new_content } = body;
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

  // ── brushup: knowledge_contradiction / knowledge_brushup 提案の承認ハンドラー ──
  // 既存 confirmed ルールの content を new_content で上書きし、ai_prompt_rules を再同期する
  if (action === "brushup") {
    if (!new_content) return NextResponse.json({ ok: false, error: "new_content required for brushup" }, { status: 400 });
    const { error: updateErr } = await supabase
      .from("ai_reply_knowledge")
      .update({ content: new_content, hypothesis_status: "confirmed" })
      .eq("id", id);
    if (updateErr) return NextResponse.json({ ok: false, error: updateErr.message }, { status: 500 });

    const { data: row, error: fetchErr } = await supabase
      .from("ai_reply_knowledge")
      .select("id, title, content, conversation_state, importance")
      .eq("id", id)
      .single();
    if (fetchErr || !row) {
      console.warn("[knowledge-review] brushup行の再取得失敗:", fetchErr?.message ?? "row null");
      return NextResponse.json({ ok: true, brushed: true, synced: false });
    }
    await syncConfirmedToPromptRule(row);
    return NextResponse.json({ ok: true, brushed: true, synced: true, rule_key: `LEARN-${id}` });
  }

  const update = action === "reject"
    ? { hypothesis_status: "rejected" }
    : { hypothesis_status: "confirmed" };

  const { error } = await supabase
    .from("ai_reply_knowledge")
    .update(update)
    .eq("id", id);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // confirm/reject 時に ai_prompt_rules へ即時同期
  if (action === "confirm") {
    const { data: row, error: fetchErr } = await supabase
      .from("ai_reply_knowledge")
      .select("id, title, content, conversation_state, importance")
      .eq("id", id)
      .single();
    if (fetchErr || !row) {
      console.warn("[knowledge-review] confirmed行の再取得失敗:", fetchErr?.message ?? "row null");
      return NextResponse.json({ ok: true, synced: false, reason: "re_select_failed" });
    }
    await syncConfirmedToPromptRule(row);
    const importance = (row.importance as number) ?? 0;
    return NextResponse.json({
      ok: true,
      synced: importance >= 7,
      importance,
      rule_key: `LEARN-${id}`,
    });
  } else if (action === "reject") {
    await deactivatePromptRule(id);
  }

  return NextResponse.json({ ok: true });
}
