import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 120;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (secret !== process.env.CRON_SECRET && secret !== process.env.INTERNAL_API_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // 直近7日に追加・更新されたai_reply_knowledgeのconfirmedエントリ
  const { data: recentKnowledge } = await supabase
    .from("ai_reply_knowledge")
    .select("title, content, category, hypothesis_status, created_at, updated_at")
    .eq("hypothesis_status", "confirmed")
    .or(`created_at.gte.${since},updated_at.gte.${since}`)
    .order("created_at", { ascending: false })
    .limit(20);

  // 直近7日に成約したケース
  const { data: recentWon } = await supabase
    .from("conversations")
    .select("customer_name, conversation_state, updated_at")
    .eq("conversation_state", "closed_won")
    .gte("updated_at", since)
    .limit(10);

  // 既存のsystem_design_thinkingタイトル（重複防止）
  const { data: existingTitles } = await supabase
    .from("system_design_thinking")
    .select("title")
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(30);

  if (!recentKnowledge?.length && !recentWon?.length) {
    return NextResponse.json({ skipped: true, reason: "直近7日の変化なし" });
  }

  const existingTitleList = (existingTitles ?? []).map(e => e.title).join("\n");
  const knowledgeSummary = (recentKnowledge ?? [])
    .map(k => `[${k.category}] ${k.title}: ${(k.content ?? "").slice(0, 200)}`)
    .join("\n");
  const wonSummary = (recentWon ?? [])
    .map(w => `${w.customer_name} → closed_won (${w.updated_at?.slice(0, 10)})`)
    .join("\n");

  const prompt = `あなたはシステム設計思想を抽出するエージェントです。

【直近7日に追加・更新されたai_reply_knowledgeエントリ】
${knowledgeSummary || "なし"}

【直近7日の成約件数】
${wonSummary || "なし"}

【既に記録済みのsystem_design_thinkingタイトル（重複させない）】
${existingTitleList}

上記の変化から「なぜこのルールが追加されたか」「どんな設計判断が背景にあるか」を読み取り、
system_design_thinkingに記録すべき設計知見を抽出してください。

以下の形式でJSON配列を返してください（0件の場合は空配列）。
既存タイトルと内容が重複するものは含めないこと。
1回のcronで最大3件まで。

[
  {
    "title": "短いタイトル（30字以内）",
    "category": "architecture | prompt_engineering | data_model | ux | performance | ai_design",
    "insight": "知見の内容（何をどうしたか・200字以内）",
    "rationale": "なぜそうするか（根拠・100字以内）",
    "context": "どういう状況で生まれたか（日付含む・100字以内）",
    "applied_to": "適用したファイル・機能（50字以内）",
    "tags": ["タグ1", "タグ2"]
  }
]

抽出できる設計知見がなければ [] を返す。`;

  let insights: Array<{
    title: string;
    category: string;
    insight: string;
    rationale: string;
    context: string;
    applied_to: string;
    tags: string[];
  }> = [];

  try {
    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content[0]?.type === "text" ? res.content[0].text.trim() : "[]";
    const match = text.match(/\[[\s\S]*\]/);
    insights = match ? JSON.parse(match[0]) : [];
  } catch (e) {
    console.error("[learn-design-thinking] LLM error", e);
    return NextResponse.json({ error: "LLM failed" }, { status: 500 });
  }

  if (!insights.length) {
    return NextResponse.json({ inserted: 0, reason: "新しい設計知見なし" });
  }

  const inserted: string[] = [];
  for (const insight of insights.slice(0, 3)) {
    const { data, error } = await supabase
      .from("system_design_thinking")
      .insert({
        title: insight.title,
        category: insight.category,
        insight: insight.insight,
        rationale: insight.rationale,
        context: insight.context,
        applied_to: insight.applied_to,
        tags: insight.tags,
      })
      .select("id, title")
      .single();
    if (!error && data) inserted.push(data.title);
  }

  console.log(`[learn-design-thinking] inserted ${inserted.length}件:`, inserted);
  return NextResponse.json({ inserted: inserted.length, titles: inserted });
}
