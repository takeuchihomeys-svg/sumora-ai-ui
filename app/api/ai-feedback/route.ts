import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { upsertKnowledge, generateEmbedding, buildKnowledgeEmbeddingInput } from "@/app/lib/knowledge-utils";
import Anthropic from "@anthropic-ai/sdk";

// AI盲点フィードバック（ai_feedback_items）
// corpus2skill 週次Opusが「分からない部分・憶測」を質問としてINSERTし、
// TemplateModal の「❓ AI質問」タブで竹内さんが回答 → Opus 4.8 が知識化して
// trigger_action_rules（trigger_keywords を通常n-gramルールとして高confidence保存）/
// ai_prompts（feedback_rule_{id}）+ ai_prompt_rules（FEEDBACK-{id}-{n}）に保存する
// ※旧 MANUAL_RULE: 接頭辞は suggest-next-action の msg.includes() に絶対マッチしないため廃止

export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", timeout: 50_000, maxRetries: 1 });

// FEEDBACKルール上限: アクティブな FEEDBACK-* ルールがこれを超えたら古い順に無効化する
// （回答のたびに増え続けてプロンプトが肥大化するのを防ぐ）
const MAX_FEEDBACK_RULES = 60;  // AIXスコープ付きルールの generate-reply コピー（-gr）が加わるため

// 改善⑧: suggest-next-action/route.ts の KNOWN_AIX_TYPES と同一のwhitelist。
// Opusが返す未知の action_type をそのまま trigger_action_rules に upsert すると
// suggest-next-action 側で使われない汚染ルールが蓄積するため、
// whitelist外は ai_prompts（一般ルール）へフォールバック保存する。
// ※ suggest-next-action 側のリストを変更した場合はここも同時に更新すること
const KNOWN_AIX_TYPES = new Set([
  "property_send", "viewing_invite", "property_recommendation", "hearing",
  "follow_up", "application", "document_request", "contract", "greeting",
  "property_check_result", "estimate_sheet", "meeting_place",
  "acknowledge_check", "followup_revive", "application_push",
  "condition_hearing", "alternative_send",
]);

// FEEDBACKルールの action_type スコープ用whitelist。
// fetchPromptRules("<action>", ...) を実際に呼んでいるAIXアクション名のみ許可する。
// Opusがこのいずれかを返した場合は ai_prompt_rules.action_type にスコープ付きで保存し、
// それ以外（general / 未知 / null）はグローバル（null）として保存する。
// ※ 全ルールをnull（グローバル）で保存すると全アクションのプロンプトに注入されノイズになるため
const PROMPT_RULE_ACTION_TYPES = new Set([
  "property_check_result", "property_send", "viewing_invite", "estimate_sheet",
  "property_recommendation", "condition_hearing", "greeting_viewing",
  "application_push", "meeting_place", "acknowledge_check", "followup_revive",
]);

type ExtractedRule = {
  rule_text: string;
  save_target: "trigger_action_rules" | "ai_prompts";
  action_type: string | null;
  trigger_keywords?: string[];
};

// GET: pending + answered + applied を最新30件取得
// applied = ルール反映済み（UI でグレーアウト表示用に含める）
export async function GET() {
  const { data, error } = await supabase
    .from("ai_feedback_items")
    .select("*")
    .in("status", ["pending", "answered", "applied"])
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, items: data ?? [] });
}

// 回答をOpus 4.8で解釈して業務ルールを1〜3個抽出する（高品質な永続ルールを生成するため最上位モデルを使用）
async function extractRules(question: string, answer: string): Promise<ExtractedRule[]> {
  const res = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1500,
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
    .select("id, question, status, category")
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
  const promptRuleTexts: Array<{ text: string; actionType: string | null }> = [];

  for (const rule of rules) {
    const ruleText = rule.rule_text.trim();
    const keywords = (rule.trigger_keywords ?? [])
      .map((k) => (k ?? "").trim())
      .filter((k) => k.length >= 3)
      .slice(0, 3);
    const actionType = rule.action_type?.trim() ?? "";
    // ai_prompt_rules 保存時のスコープ: 既知AIXアクションならスコープ付き、それ以外はグローバル（null）
    const scopedActionType = PROMPT_RULE_ACTION_TYPES.has(actionType) ? actionType : null;

    // 改善⑧: whitelist外の action_type は trigger_action_rules を汚染するため
    // ai_prompts（一般ルール）へフォールバック保存する
    if (rule.save_target === "trigger_action_rules" && actionType && !KNOWN_AIX_TYPES.has(actionType)) {
      console.warn(`[ai-feedback] whitelist外のaction_type "${actionType}" → trigger_action_rules をスキップし ai_prompts へフォールバック保存`);
      promptRuleTexts.push({ text: ruleText, actionType: scopedActionType });
      continue;
    }

    if (rule.save_target === "trigger_action_rules" && actionType && keywords.length > 0) {
      // 竹内さん確認済みルール → 実際の発動キーワードを通常のn-gramルールとして保存
      // （旧 MANUAL_RULE:接頭辞は顧客メッセージの msg.includes() に絶対マッチしないため廃止）
      // confidence 0.95 / occurrence_count 10 = learn-trigger-rules のクリーンアップで絶対に削除されない
      let savedKeywords = 0;
      for (const keyword of keywords) {
        const { error } = await supabase.from("trigger_action_rules").upsert({
          keyword: keyword.slice(0, 200),
          action_type: actionType,
          confidence: 0.95,
          occurrence_count: 10,
          updated_at: new Date().toISOString(),
        }, { onConflict: "action_type,keyword" });
        if (!error) savedKeywords++;
        else console.error("[ai-feedback] trigger_action_rules upsert error:", error.message);
      }
      if (savedKeywords > 0) appliedRules.push(`[${actionType}] ${ruleText}（キーワード: ${keywords.join("・")}）`);
      // trigger_action_rules に保存したルールも返信内容として ai_prompt_rules に記録する
      // （キーワード→AIX発動のマッピングだけでは「どう返すか」が失われるため）
      promptRuleTexts.push({ text: ruleText, actionType: scopedActionType });
    } else {
      // 一般ルール（キーワード抽出できなかった trigger ルールも情報を失わずこちらへ）
      promptRuleTexts.push({ text: ruleText, actionType: scopedActionType });
    }
  }

  if (promptRuleTexts.length > 0) {
    const { error } = await supabase.from("ai_prompts").upsert({
      key: `feedback_rule_${id}`,
      label: `盲点フィードバック回答（${new Date().toISOString().slice(0, 10)}）`,
      content: `【竹内さん確認済みルール】${item.question}\n→回答: ${answer}\n\n抽出ルール:\n${promptRuleTexts.map((r) => `- ${r.text}`).join("\n")}`,
      updated_at: new Date().toISOString(),
    }, { onConflict: "key" });
    if (!error) appliedRules.push(...promptRuleTexts.map((r) => r.text));
    else console.error("[ai-feedback] ai_prompts upsert error:", error.message);

    // ai_prompt_rules にも保存 → fetchPromptRules 経由で generate-reply / AIX に実際に注入される
    // （ai_prompts の feedback_rule_{id} は generate-reply の固定キーwhitelist外で参照されないため）
    for (let i = 0; i < promptRuleTexts.length; i++) {
      const { error: ruleError } = await supabase.from("ai_prompt_rules").upsert({
        rule_key: `FEEDBACK-${id}-${i + 1}`,
        // Opusが既知AIXアクションを返した場合はスコープ付きで保存（全アクションへのノイズ注入を防止）。
        // 受け側の fetchPromptRules は .or(`action_type.eq.${actionType},action_type.is.null`) で
        // 取得するため、スコープ付きルールは該当アクションのプロンプトにのみ注入される
        action_type: promptRuleTexts[i].actionType,
        condition_key: null,
        condition_value: null,
        rule_text: promptRuleTexts[i].text,
        reason: `AI盲点質問への竹内さん回答（${new Date().toISOString().slice(0, 10)}）: ${item.question}`.slice(0, 500),
        priority: 8,
        is_active: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: "rule_key" });
      if (ruleError) console.error("[ai-feedback] ai_prompt_rules upsert error:", ruleError.message);

      // AIXスコープ付きFEEDBACKルールは generate-reply にも注入する
      // （viewing_invite等のルールは LINE文案生成の同フェーズでも有効なため）
      if (!ruleError && promptRuleTexts[i].actionType !== null) {
        await supabase.from("ai_prompt_rules").upsert({
          rule_key: `FEEDBACK-${id as string}-${i + 1}-gr`,
          action_type: "generate_reply",
          condition_key: null,
          condition_value: null,
          rule_text: promptRuleTexts[i].text,
          reason: `AI盲点質問generate-replyコピー（${new Date().toISOString().slice(0, 10)}）: ${item.question as string}`.slice(0, 500),
          priority: 7,   // 元の priority=8 より低く（AIX側と重複するため）
          is_active: true,
          updated_at: new Date().toISOString(),
        }, { onConflict: "rule_key" });
      }
    }
  }

  // knowledge_gap（AIが誤った事実を述べた → 竹内さんが正しい事実を回答）は
  // ai_prompt_rules（150字ルール）だけでは弱いため、ai_reply_knowledge の principle としても保存する。
  // item.question は「AIが〜と誤回答しました」等のメタ文のため embedding が意味空間ズレ。
  // 正しい知識内容（answer）を embedding 化して顧客の類似質問に pgvector でヒットさせる
  if (item.category === "knowledge_gap") {
    try {
      const embInput = buildKnowledgeEmbeddingInput({ content: answer });
      const embedding = embInput ? await generateEmbedding(embInput) : null;
      const result = await upsertKnowledge(supabase, {
        title: `[盲点回答] ${(item.question as string).slice(0, 40)}`,
        content: `【竹内さん確認済みの正しい知識】\n質問: ${item.question}\n正しい説明: ${answer}${promptRuleTexts.length > 0 ? `\n\n要点:\n${promptRuleTexts.map((r) => `- ${r.text}`).join("\n")}` : ""}`,
        category: "principle",
        importance: 9,
        ...(embedding ? { embedding } : {}),
      });
      if (result !== "skipped") appliedRules.push(`[knowledge_gap→principle知識化: ${result}]`);
    } catch (e) {
      console.error("[ai-feedback] knowledge_gap の principle 保存失敗:", e);
    }
  }

  // FEEDBACKルール上限管理: アクティブなFEEDBACKルールが MAX_FEEDBACK_RULES 件を超えたら古いものを無効化
  // （エラーが出ても回答保存自体は止めない）
  try {
    const { data: activeFeedbackRules } = await supabase
      .from("ai_prompt_rules")
      .select("rule_key, created_at, action_type")
      .like("rule_key", "FEEDBACK-%")
      .eq("is_active", true)
      .order("created_at", { ascending: true }); // 古い順（後でグローバル優先ソートする）

    if (activeFeedbackRules && activeFeedbackRules.length > MAX_FEEDBACK_RULES) {
      const excessCount = activeFeedbackRules.length - MAX_FEEDBACK_RULES;
      // グローバル（action_type IS NULL）を先に削除、スコープ付きは後（より精密なため）
      const sortedByPriority = [...activeFeedbackRules].sort((a, b) => {
        const aIsGlobal = (a as { action_type: string | null }).action_type === null ? 0 : 1;
        const bIsGlobal = (b as { action_type: string | null }).action_type === null ? 0 : 1;
        if (aIsGlobal !== bIsGlobal) return aIsGlobal - bIsGlobal;
        return new Date(a.created_at as string).getTime() - new Date(b.created_at as string).getTime();
      });
      const oldestKeys = sortedByPriority.slice(0, excessCount).map((r) => r.rule_key);
      const { error: deactivateError } = await supabase
        .from("ai_prompt_rules")
        .update({ is_active: false })
        .in("rule_key", oldestKeys);
      if (deactivateError) console.error("[ai-feedback] FEEDBACKルール無効化エラー:", deactivateError.message);
      else console.log(`[ai-feedback] FEEDBACKルール上限超過 → 古い${excessCount}件を無効化: ${oldestKeys.join(", ")}`);
    }
  } catch (e) {
    console.error("[ai-feedback] FEEDBACKルール上限チェック失敗:", e);
  }

  const { error: updateError } = await supabase
    .from("ai_feedback_items")
    .update({
      user_answer: answer,
      status: "applied",
      applied_rule: appliedRules.length > 0 ? appliedRules.join(" / ").slice(0, 500) : null,
      answered_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (updateError) return NextResponse.json({ ok: false, error: updateError.message }, { status: 500 });
  return NextResponse.json({ ok: true, rulesApplied: appliedRules.length });
}

// DELETE: { id, dismissedReason? } → status="dismissed"（理由があれば dismissed_reason に保存してAIの学習材料にする）
export async function DELETE(req: NextRequest) {
  const body = await req.json() as { id?: string; dismissedReason?: string };
  const { id, dismissedReason } = body;
  if (!id) {
    return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("ai_feedback_items")
    .update({
      status: "dismissed",
      ...(dismissedReason?.trim() ? { dismissed_reason: dismissedReason.trim() } : {}),
    })
    .eq("id", id);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
