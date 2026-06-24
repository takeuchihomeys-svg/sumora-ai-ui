import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export async function GET() {
  // ルール一覧 + accept/dismiss 集計を同時取得
  const [{ data: rules, error }, { data: feedback }] = await Promise.all([
    supabase
      .from("trigger_action_rules")
      .select("id, action_type, keyword, confidence, occurrence_count, conversation_status")
      .order("action_type", { ascending: true })
      .order("confidence", { ascending: false })
      .order("occurrence_count", { ascending: false })
      .limit(2000),
    supabase
      .from("action_pattern_logs")
      .select("action_type, source")
      .in("source", ["suggestion_accepted", "suggestion_dismissed"])
      .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
  ]);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // action_type ごとに accept/dismiss 集計
  const acceptStats: Record<string, { accepted: number; dismissed: number }> = {};
  for (const row of feedback ?? []) {
    const a = row.action_type as string;
    acceptStats[a] ??= { accepted: 0, dismissed: 0 };
    if (row.source === "suggestion_accepted") acceptStats[a].accepted++;
    else acceptStats[a].dismissed++;
  }

  return NextResponse.json({ ok: true, rules: rules ?? [], acceptStats });
}

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    action_type: string;
    keyword: string;
    confidence?: number;
    conversation_status?: string | null;
  };

  const { action_type, keyword, confidence = 0.9, conversation_status } = body;
  if (!action_type || !keyword?.trim()) {
    return NextResponse.json({ ok: false, error: "action_type と keyword は必須" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("trigger_action_rules")
    .insert({
      action_type,
      keyword: keyword.trim(),
      confidence,
      occurrence_count: 1,
      conversation_status: conversation_status || null,
    })
    .select("id, action_type, keyword, confidence, occurrence_count, conversation_status")
    .single();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, rule: data });
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json() as { id: string };
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

  const { error } = await supabase
    .from("trigger_action_rules")
    .delete()
    .eq("id", id);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
