import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";

// AI盲点フィードバック（ai_feedback_items）
// corpus2skill 週次Opusが「分からない部分・憶測」を質問としてINSERTし、
// TemplateModal の「❓ AI質問」タブで竹内さんが回答 → Sonnet 4.6 が知識化して
// trigger_action_rules（trigger_keywords を通常n-gramルールとして高confidence保存）/
// ai_prompts（feedback_rule_{id}）+ ai_prompt_rules（FEEDBACK-{id}-{n}）に保存する
// ※旧 MANUAL_RULE: 接頭辞は suggest-next-action の msg.includes() に絶対マッチしないため廃止

export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", timeout: 50_000, maxRetries: 1 });

type ExtractedRule = {
  rule_text: string;
  save_target: "trigger_action_rules" | "ai_prompts";
  action_type: string | null;
  trigger_keywords?: string[];
};

// GET: pending + answered を最新30件取得
export async function GET() {
  const { data, error } = await supabase
    .from("ai_feedback_items")
    .select("*")
    .in("status", ["pending", "answered"])
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, items: data ?? [] });
}

// 回答をSonnet 4.6で解釈して業務ルールを1〜3個抽出する
async function extractRules(question: string, answer: string): Promise<ExtractedRule[]> {
  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    temperature: 0,
    system: `あなたはLINE不動産接客AIの知識管理エージェントです。担当者からの回答を、AIが今後使える業務ルールに変換します。`,
    messages: [{
      role: "user",
      content: `以下はAIが担当者（竹内悠馬さん）に質問した内容と、その回答です。

【AIの質問】
${question}

【竹内さんの回答】
${answer}

この質問と回答から、AIが今後使える業務ルールを1〜3個抽出してください。
各ルールについて:
- rule_text: ルール本文（AIがそのまま参照できる具体的な指示文・150文字以内）
- save_target: "trigger_action_rules"（特定AIXボタンの発動条件に関わるルール）or "ai_prompts"（返信文面・対応方針の一般ルール）
- action_type: 該当AIXボタン名（property_send / viewing_invite / application_push / condition_hearing / estimate_sheet / followup_revive / acknowledge_check / property_check_result / property_recommendation / meeting_place 等）、なければ null
- save_target が "trigger_action_rules" の場合は、trigger_keywords フィールドも必ず付ける。
  trigger_keywords: 顧客メッセージに実際に含まれるであろうキーワード3文字以上の語句を1〜3個（例：「スモ割」「審査通る」「築年数」）。
  ルールの説明文ではなく、顧客がLINEで実際に打つ語句そのものを選ぶこと。

JSON配列のみ返してください（説明・コードフェンス不要）:
[{"rule_text": "...", "save_target": "trigger_action_rules"|"ai_prompts", "action_type": "..."|null, "trigger_keywords": ["..."]}]`,
    }],
  });

  const text = res.content[0]?.type === "text" ? res.content[0].text.trim() : "";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as ExtractedRule[];
    return Array.isArray(parsed) ? parsed.filter((r) => r?.rule_text?.trim()).slice(0, 3) : [];
  } catch {
    return [];
  }
}

// POST: { id, answer } → user_answer保存 + Sonnetで知識化 + status="answered"に更新
export async function POST(req: NextRequest) {
  const body = await req.json() as { id?: string; answer?: string };
  const id = body.id;
  const answer = body.answer?.trim();
  if (!id || !answer) {
    return NextResponse.json({ ok: false, error: "id and answer required" }, { status: 400 });
  }

  const { data: item, error: fetchError } = await supabase
    .from("ai_feedback_items")
    .select("id, question, status")
    .eq("id", id)
    .single();
  if (fetchError || !item) {
    return NextResponse.json({ ok: false, error: "item not found" }, { status: 404 });
  }

  // 知識化（失敗しても回答自体は保存する）
  let rules: ExtractedRule[] = [];
  try {
    rules = await extractRules(item.question as string, answer);
  } catch (e) {
    console.error("[ai-feedback] ルール抽出失敗:", e);
  }

  const appliedRules: string[] = [];
  const promptRuleTexts: string[] = [];

  for (const rule of rules) {
    const ruleText = rule.rule_text.trim();
    const keywords = (rule.trigger_keywords ?? [])
      .map((k) => (k ?? "").trim())
      .filter((k) => k.length >= 3)
      .slice(0, 3);

    if (rule.save_target === "trigger_action_rules" && rule.action_type?.trim() && keywords.length > 0) {
      // 竹内さん確認済みルール → 実際の発動キーワードを通常のn-gramルールとして保存
      // （旧 MANUAL_RULE:接頭辞は顧客メッセージの msg.includes() に絶対マッチしないため廃止）
      // confidence 0.95 / occurrence_count 10 = learn-trigger-rules のクリーンアップで絶対に削除されない
      let savedKeywords = 0;
      for (const keyword of keywords) {
        const { error } = await supabase.from("trigger_action_rules").upsert({
          keyword: keyword.slice(0, 200),
          action_type: rule.action_type.trim(),
          confidence: 0.95,
          occurrence_count: 10,
          updated_at: new Date().toISOString(),
        }, { onConflict: "action_type,keyword" });
        if (!error) savedKeywords++;
        else console.error("[ai-feedback] trigger_action_rules upsert error:", error.message);
      }
      if (savedKeywords > 0) appliedRules.push(`[${rule.action_type}] ${ruleText}（キーワード: ${keywords.join("・")}）`);
    } else {
      // 一般ルール（キーワード抽出できなかった trigger ルールも情報を失わずこちらへ）
      promptRuleTexts.push(ruleText);
    }
  }

  if (promptRuleTexts.length > 0) {
    const { error } = await supabase.from("ai_prompts").upsert({
      key: `feedback_rule_${id}`,
      label: `盲点フィードバック回答（${new Date().toISOString().slice(0, 10)}）`,
      content: `【竹内さん確認済みルール】${item.question}\n→回答: ${answer}\n\n抽出ルール:\n${promptRuleTexts.map((r) => `- ${r}`).join("\n")}`,
      updated_at: new Date().toISOString(),
    }, { onConflict: "key" });
    if (!error) appliedRules.push(...promptRuleTexts);
    else console.error("[ai-feedback] ai_prompts upsert error:", error.message);

    // ai_prompt_rules にも保存 → fetchPromptRules 経由で generate-reply / AIX に実際に注入される
    // （ai_prompts の feedback_rule_{id} は generate-reply の固定キーwhitelist外で参照されないため）
    for (let i = 0; i < promptRuleTexts.length; i++) {
      const { error: ruleError } = await supabase.from("ai_prompt_rules").upsert({
        rule_key: `FEEDBACK-${id}-${i + 1}`,
        action_type: null,
        condition_key: null,
        condition_value: null,
        rule_text: promptRuleTexts[i],
        reason: `AI盲点質問への竹内さん回答（${new Date().toISOString().slice(0, 10)}）: ${item.question}`.slice(0, 500),
        priority: 8,
        is_active: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: "rule_key" });
      if (ruleError) console.error("[ai-feedback] ai_prompt_rules upsert error:", ruleError.message);
    }
  }

  const { error: updateError } = await supabase
    .from("ai_feedback_items")
    .update({
      user_answer: answer,
      status: "answered",
      applied_rule: appliedRules.length > 0 ? appliedRules.join(" / ").slice(0, 500) : null,
      answered_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (updateError) return NextResponse.json({ ok: false, error: updateError.message }, { status: 500 });
  return NextResponse.json({ ok: true, rulesApplied: appliedRules.length });
}

// DELETE: { id } → status="dismissed"
export async function DELETE(req: NextRequest) {
  const body = await req.json() as { id?: string };
  if (!body.id) {
    return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("ai_feedback_items")
    .update({ status: "dismissed" })
    .eq("id", body.id);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
