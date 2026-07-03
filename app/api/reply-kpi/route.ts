import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const weeks = Math.min(52, Math.max(1, parseInt(url.searchParams.get("weeks") ?? "12", 10)));

  const since = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000).toISOString();

  // 週次集計（PostgreSQLのDATE_TRUNCを使用）
  const { data, error } = await supabase
    .from("ai_reply_examples")
    .select("created_at, was_ai_used, was_ai_modified, is_starred, conversation_state")
    .gte("created_at", since)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{
    created_at: string;
    was_ai_used: boolean;
    was_ai_modified: boolean;
    is_starred: boolean;
    conversation_state: string;
  }>;

  // 週次バケットに集計
  const weeklyMap: Record<string, { total: number; ai_used: number; ai_modified: number; starred: number }> = {};
  for (const row of rows) {
    const d = new Date(row.created_at);
    // ISO週の月曜日を週キーとして使う
    const dayOfWeek = d.getDay(); // 0=日, 1=月...
    const diffToMonday = (dayOfWeek === 0 ? -6 : 1 - dayOfWeek);
    const monday = new Date(d);
    monday.setDate(d.getDate() + diffToMonday);
    monday.setHours(0, 0, 0, 0);
    const weekKey = monday.toISOString().slice(0, 10);

    if (!weeklyMap[weekKey]) {
      weeklyMap[weekKey] = { total: 0, ai_used: 0, ai_modified: 0, starred: 0 };
    }
    weeklyMap[weekKey].total++;
    if (row.was_ai_used) weeklyMap[weekKey].ai_used++;
    if (row.was_ai_modified) weeklyMap[weekKey].ai_modified++;
    if (row.is_starred) weeklyMap[weekKey].starred++;
  }

  const weekly = Object.entries(weeklyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, stats]) => ({
      week,
      total: stats.total,
      ai_used: stats.ai_used,
      ai_modified: stats.ai_modified,
      starred: stats.starred,
      ai_used_rate: stats.total > 0 ? Math.round((stats.ai_used / stats.total) * 1000) / 10 : 0,
      ai_modified_rate: stats.ai_used > 0 ? Math.round((stats.ai_modified / stats.ai_used) * 1000) / 10 : 0,
    }));

  // サマリー統計
  const total = rows.length;
  const aiUsed = rows.filter(r => r.was_ai_used).length;
  const aiModified = rows.filter(r => r.was_ai_modified).length;
  const starred = rows.filter(r => r.is_starred).length;

  // 会話ステート別集計
  const byState: Record<string, { total: number; ai_modified: number }> = {};
  for (const row of rows) {
    const s = row.conversation_state || "unknown";
    if (!byState[s]) byState[s] = { total: 0, ai_modified: 0 };
    byState[s].total++;
    if (row.was_ai_modified) byState[s].ai_modified++;
  }

  const stateStats = Object.entries(byState)
    .sort(([, a], [, b]) => b.total - a.total)
    .map(([state, stats]) => ({
      state,
      total: stats.total,
      ai_modified: stats.ai_modified,
      ai_modified_rate: stats.total > 0 ? Math.round((stats.ai_modified / stats.total) * 1000) / 10 : 0,
    }));

  return NextResponse.json({
    ok: true,
    summary: {
      total,
      ai_used: aiUsed,
      ai_used_rate: total > 0 ? Math.round((aiUsed / total) * 1000) / 10 : 0,
      ai_modified: aiModified,
      ai_modified_rate: aiUsed > 0 ? Math.round((aiModified / aiUsed) * 1000) / 10 : 0,
      starred,
      starred_rate: total > 0 ? Math.round((starred / total) * 1000) / 10 : 0,
      period_weeks: weeks,
    },
    weekly,
    by_state: stateStats,
  });
}
