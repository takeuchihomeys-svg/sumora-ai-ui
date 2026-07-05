import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export async function GET(req: Request) {
  const authHeader = (req.headers as Headers).get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [examplesRes, knowledgeRes, phraseRes, knowledgeCatRes] = await Promise.all([
    supabase
      .from("ai_reply_examples")
      .select("was_ai_used, is_starred, was_ai_modified, conversation_state, created_at", { count: "exact" })
      .limit(10000),
    supabase
      .from("ai_reply_knowledge")
      .select("id, category, importance, conversation_state", { count: "exact" }),
    supabase
      .from("phrase_dictionary")
      .select("id, category, priority", { count: "exact" }),
    supabase
      .from("ai_reply_knowledge")
      .select("category, importance")
      .gte("importance", 8),
  ]);

  const examples = examplesRes.data ?? [];
  const knowledge = knowledgeRes.data ?? [];
  const phrases = phraseRes.data ?? [];
  const goldenKnowledge = knowledgeCatRes.data ?? [];

  const total = examples.length;
  const aiUsed = examples.filter((e) => e.was_ai_used).length;
  const starred = examples.filter((e) => e.is_starred).length;
  const modified = examples.filter((e) => e.was_ai_modified).length;

  // state別集計
  const stateMap: Record<string, { total: number; ai_used: number; starred: number; modified: number }> = {};
  for (const ex of examples) {
    const s = ex.conversation_state ?? "unknown";
    if (!stateMap[s]) stateMap[s] = { total: 0, ai_used: 0, starred: 0, modified: 0 };
    stateMap[s].total++;
    if (ex.was_ai_used) stateMap[s].ai_used++;
    if (ex.is_starred) stateMap[s].starred++;
    if (ex.was_ai_modified) stateMap[s].modified++;
  }
  const stateBreakdown = Object.entries(stateMap)
    .map(([state, d]) => ({
      state,
      total: d.total,
      ai_use_rate: d.total > 0 ? +(d.ai_used / d.total).toFixed(2) : 0,
      star_rate: d.total > 0 ? +(d.starred / d.total).toFixed(2) : 0,
      edit_rate: d.total > 0 ? +(d.modified / d.total).toFixed(2) : 0,
    }))
    .sort((a, b) => b.total - a.total);

  // knowledge カテゴリ別集計
  const knowledgeCatMap: Record<string, number> = {};
  for (const k of knowledge) {
    knowledgeCatMap[k.category] = (knowledgeCatMap[k.category] ?? 0) + 1;
  }

  // importance分布
  const importanceBuckets: Record<string, number> = { "1-4": 0, "5-7": 0, "8-10": 0 };
  for (const k of knowledge) {
    const imp = k.importance ?? 5;
    if (imp <= 4) importanceBuckets["1-4"]++;
    else if (imp <= 7) importanceBuckets["5-7"]++;
    else importanceBuckets["8-10"]++;
  }

  // 健康スコア算出（0-100）
  const aiUseRate = total > 0 ? aiUsed / total : 0;
  const starRate = total > 0 ? starred / total : 0;
  const healthScore = Math.round(
    (aiUseRate * 40) +                            // AI文案採用率 40点
    (Math.min(total / 50, 1) * 20) +              // データ量 20点（50件で満点）
    (Math.min((knowledge.length) / 20, 1) * 20) + // ナレッジ量 20点（20件で満点）
    (starRate * 20)                                // ☆率 20点
  );

  // 警告リスト
  const warnings: string[] = [];
  if (total === 0) warnings.push("❌ ai_reply_examples が0件 — 学習データがない");
  if (aiUseRate < 0.5 && total > 5) warnings.push(`⚠️ AI採用率が低い（${Math.round(aiUseRate * 100)}%） — プロンプト改善が必要`);
  if (knowledge.length === 0) warnings.push("❌ ai_reply_knowledge が0件 — 深層分析が動いていない可能性");
  if (knowledge.length < 5 && total > 0) warnings.push(`⚠️ ナレッジが少ない（${knowledge.length}件） — ☆マークを増やすか手動インポートが必要`);
  if (starRate < 0.05 && total > 10) warnings.push(`⚠️ ☆率が低い（${Math.round(starRate * 100)}%） — スタッフがほとんど☆を付けていない`);
  const weakStates = stateBreakdown.filter((s) => s.ai_use_rate < 0.3 && s.total >= 3);
  if (weakStates.length > 0) warnings.push(`⚠️ AI採用率の低いstate: ${weakStates.map((s) => `${s.state}(${Math.round(s.ai_use_rate * 100)}%)`).join(", ")}`);

  return NextResponse.json({
    ok: true,
    health_score: healthScore,
    warnings,
    kpi: {
      total_examples: total,
      ai_use_rate: +aiUseRate.toFixed(3),
      star_rate: +starRate.toFixed(3),
      edit_rate: total > 0 ? +(modified / total).toFixed(3) : 0,
      knowledge_count: knowledge.length,
      golden_knowledge_count: goldenKnowledge.length,
      phrase_count: phrases.length,
    },
    state_breakdown: stateBreakdown,
    knowledge_by_category: knowledgeCatMap,
    knowledge_importance: importanceBuckets,
    checked_at: new Date().toISOString(),
  });
}
