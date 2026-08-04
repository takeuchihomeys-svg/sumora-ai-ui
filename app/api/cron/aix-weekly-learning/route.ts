import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const AIX_ACTIONS = [
  "property_recommendation","property_send","viewing_invite","meeting_place",
  "application_push","condition_hearing","estimate_sheet","property_check_result",
  "greeting_viewing","followup_revive","acknowledge_check"
];

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // ISO week number for idempotent rule keys
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
  const weekKey = `${now.getFullYear()}W${String(weekNum).padStart(2, '0')}`;

  const results: Record<string, number> = {};

  for (const actionType of AIX_ACTIONS) {
    try {
      // Fetch AIX edits for this action from past 7 days
      const { data: examples } = await supabase
        .from("ai_reply_examples")
        .select("customer_message, ai_draft, sent_reply, conversation_id")
        .eq("entry_source", "aix_action")
        .eq("aix_action", actionType)
        .eq("was_ai_modified", true)
        .gte("created_at", sevenDaysAgo)
        .not("ai_draft", "is", null)
        .not("sent_reply", "is", null)
        .order("created_at", { ascending: false })
        .limit(15);

      if (!examples || examples.length < 2) {
        results[actionType] = 0;
        continue;
      }

      // Format examples for Opus
      const examplesText = examples.map((ex, i) =>
        `【編集例${i + 1}】\nAI生成:\n${ex.ai_draft?.slice(0, 300) ?? ""}\n\nスタッフ送信:\n${ex.sent_reply?.slice(0, 300) ?? ""}`
      ).join("\n\n---\n\n");

      const systemPrompt = `あなたはLINE賃貸営業AIシステムの品質改善エンジニアです。
AIXボタン「${actionType}」で生成されたテキストをスタッフが修正した事例を分析し、
繰り返し発生している修正パターンから改善ルールを抽出してください。

出力形式（JSON配列、厳守）:
[
  {"rule": "ルール文（日本語・100字以内・具体的・actionable）", "reason": "なぜこの修正が繰り返されるか"}
]

ルール抽出の基準:
- 複数の編集例に共通する修正パターンのみ抽出（1例だけの特殊ケースは除外）
- 「〜を避ける」「〜の場合は〜にする」など具体的な行動指示として書く
- 最大3個まで
- 共通パターンが見つからない場合は空配列 [] を返す`;

      const response = await anthropic.messages.create({
        model: "claude-opus-5",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: `以下は過去7日間の「${actionType}」アクションでスタッフが修正した編集例です:\n\n${examplesText}\n\n繰り返しの修正パターンからルールを抽出してください。`
        }],
        system: systemPrompt,
      });

      const rawText = response.content[0]?.type === "text" ? response.content[0].text : "";
      const jsonMatch = rawText.match(/\[\s*[\s\S]*?\]/);
      if (!jsonMatch) { results[actionType] = 0; continue; }

      const rules: { rule: string; reason: string }[] = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(rules) || rules.length === 0) { results[actionType] = 0; continue; }

      let saved = 0;
      for (let i = 0; i < rules.length; i++) {
        const ruleKey = `LEARN-AIX-${actionType}-${weekKey}-${i + 1}`;
        await supabase.from("ai_prompt_rules").upsert({
          rule_key: ruleKey,
          rule_text: rules[i].rule,
          action_type: actionType,
          priority: 6,
          is_active: true,
          is_permanent: false,
          reason: `週次AIX学習（${weekKey}）: ${rules[i].reason}`,
        }, { onConflict: "rule_key", ignoreDuplicates: true });
        saved++;
      }
      results[actionType] = saved;
    } catch (e) {
      console.error(`aix-weekly-learning error for ${actionType}:`, e);
      results[actionType] = -1;
    }
  }

  return NextResponse.json({ ok: true, weekKey, results });
}
