import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { syncConfirmedToPromptRule, deactivatePromptRule } from "@/app/lib/knowledge-promote";

// GET: hypothesis ナレッジ一覧（手動承認待ち）
export async function GET() {
  const [{ data, error }, { count: totalHypothesis }] = await Promise.all([
    supabase
      .from("ai_reply_knowledge")
      .select("id, title, content, category, conversation_state, importance, correct_count, wrong_count, apply_count, created_at")
      .eq("hypothesis_status", "hypothesis")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("ai_reply_knowledge")
      .select("*", { count: "exact", head: true })
      .eq("hypothesis_status", "hypothesis"),
  ]);

  if (error) return NextResponse.json({ rules: [], total: 0 });
  return NextResponse.json({ rules: data ?? [], total: totalHypothesis ?? 0 });
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

// PATCH: 承認（hypothesis_status → confirmed）or 却下（hypothesis_status → rejected）
export async function PATCH(req: NextRequest) {
  const { id, action } = await req.json() as { id: string; action?: "confirm" | "reject" };
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

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
