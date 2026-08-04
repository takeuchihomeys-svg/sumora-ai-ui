import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

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
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  const results: Record<string, number> = {};
  let totalAiQuestions = 0;

  for (const actionType of AIX_ACTIONS) {
    try {
      // Fetch yesterday's AIX edits for this action
      const { data: examples } = await supabase
        .from("ai_reply_examples")
        .select("id, customer_message, ai_draft, sent_reply, conversation_id, created_at")
        .eq("entry_source", "aix_action")
        .eq("aix_action", actionType)
        .eq("was_ai_modified", true)
        .gte("created_at", oneDayAgo)
        .not("ai_draft", "is", null)
        .not("sent_reply", "is", null)
        .order("created_at", { ascending: false })
        .limit(10);

      if (!examples || examples.length === 0) {
        results[actionType] = 0;
        continue;
      }

      // Check if there's a strong repeated pattern worth capturing
      if (examples.length < 2) {
        // Single edit: store as candidate for weekly analysis but don't write rule yet
        results[actionType] = 0;
        continue;
      }

      const examplesText = examples.map((ex, i) =>
        `【編集例${i + 1}】\n顧客メッセージ: ${ex.customer_message?.slice(0, 100) ?? "不明"}\nAI生成:\n${ex.ai_draft?.slice(0, 250) ?? ""}\n\nスタッフ送信:\n${ex.sent_reply?.slice(0, 250) ?? ""}`
      ).join("\n\n---\n\n");

      const response = await anthropic.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 800,
        messages: [{
          role: "user",
          content: `AIXボタン「${actionType}」の本日の編集例:\n\n${examplesText}\n\n明らかな繰り返しパターンがあれば1〜2個のルールをJSONで返してください。パターンがなければ空配列を返してください。\n形式: [{"rule": "ルール文（日本語・具体的）", "severity": "high|medium"}]`
        }],
        system: `あなたはLINE賃貸営業AIの品質監視エージェントです。AIXボタン「${actionType}」の本日の編集パターンを分析し、明確に繰り返している問題だけをルール化してください。1回だけの修正や文体の好みはルール化しない。`,
      });

      const rawText = response.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text ?? "";
      const jsonMatch = rawText.match(/\[\s*[\s\S]*?\]/);
      if (!jsonMatch) { results[actionType] = 0; continue; }

      const rules: { rule: string; severity: string }[] = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(rules) || rules.length === 0) { results[actionType] = 0; continue; }

      // Only write high/medium severity rules from daily analysis
      const highPriorityRules = rules.filter(r => r.severity === "high");

      let saved = 0;
      for (let i = 0; i < highPriorityRules.length; i++) {
        const ruleKey = `LEARN-AIX-daily-${actionType}-${dateKey}-${i + 1}`;
        const { error } = await supabase.from("ai_prompt_rules").upsert({
          rule_key: ruleKey,
          rule_text: highPriorityRules[i].rule,
          action_type: actionType,
          priority: 6,
          is_active: true,
          is_permanent: false,
          reason: `日次AIX分析（${dateKey}）: high severity pattern`,
        }, { onConflict: "rule_key", ignoreDuplicates: true });
        if (!error) saved++;
      }

      // If 3+ edits of same type today, generate an ai_feedback_items question
      if (examples.length >= 3 && totalAiQuestions < 3) {
        const oneDayAgo2 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { count: discardCount } = await supabase
          .from("aix_generate_log")
          .select("id", { count: "exact", head: true })
          .eq("action_type", actionType)
          .eq("status", "discarded")
          .gte("created_at", oneDayAgo2);

        const { data: existing } = await supabase
          .from("ai_feedback_items")
          .select("id")
          .eq("entry_source", "aix_action")
          .eq("aix_action", actionType)
          .gte("created_at", oneDayAgo)
          .limit(1);

        if (!existing || existing.length === 0) {
          const isBoundaryCase = (discardCount ?? 0) >= 2;
          const questionCategory = isBoundaryCase ? "aix_boundary" : "aix_pattern";
          const questionText = isBoundaryCase
            ? `【線引き質問】AIX「${actionType}」の本日の生成文がスタッフに送信されませんでした（${discardCount}件破棄）。このアクションをいつ使うべきか教えてください。\n[aix_boundary_action:${actionType}]`
            : `【AIX日次分析】「${actionType}」で本日${examples.length}件の編集が発生しました。スタッフが繰り返し修正しているポイントを教えてください。`;
          await supabase.from("ai_feedback_items").insert({
            question: questionText,
            speculation: `AI生成テキストにパターン的な問題がある可能性`,
            category: questionCategory,
            confidence: 0.7,
            entry_source: "aix_action",
            aix_action: actionType,
            status: "pending",
          });
          totalAiQuestions++;
        }
      }

      results[actionType] = saved;
    } catch (e) {
      console.error(`aix-analyze-diffs error for ${actionType}:`, e);
      results[actionType] = -1;
    }
  }

  return NextResponse.json({ ok: true, dateKey, results, aiQuestionsCreated: totalAiQuestions });
}
