import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 300;

const HAIKU = "claude-haiku-4-5-20251001";
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 15_000 });

const SKIP_STATUSES = ["contract", "closed_won", "closed_lost", "lost"];

const AIX_BRAIN_NOTES: Record<string, string> = {
  viewing_invite:          "内覧日程の候補を提示してください → AIX【内覧日調整】で日時を選択して送信してください",
  property_send:           "物件URLが揃ったら → AIX【物件ピックアップした】でカバーメッセージを生成して一緒に送ってください",
  estimate_sheet:          "見積書が届いたら → AIX【見積書送る】で読み取って自動計算＋カバーメッセージを生成できます",
  application_push:        "AIX【申込へ！】でクロージングメッセージを生成できます",
  condition_hearing:       "AIX【条件ヒアリング】ボタンで既知情報をスキップした形式で送れます",
  acknowledge_check:       "送信後 → AIX【確認します】で管理会社への空室確認＋見積書依頼を送ってください（宛先は管理会社です）",
  followup_revive:         "AIX【追客する】で再接触メッセージを生成できます",
  property_check_result:   "管理会社から返答が来たら → AIX【物件確認した（募集状況）】で結果報告文を生成してください",
  property_recommendation: "お客様の条件に最も合う1件を特にオススメとしてAIX【物件オススメ】で提案してください",
  meeting_place:           "内覧の日時・物件が確定したら → AIX【待ち合わせ】で待ち合わせ場所の案内を送ってください",
  greeting_viewing:        "内覧前後の挨拶は → AIX【内覧挨拶】でシーンに合わせた挨拶メッセージを生成できます",
};

// Maps raw DB conversation status to a Japanese meaning string injected into the Haiku prompt
const STATUS_MEANING: Record<string, string> = {
  first_reply:             "完全初回（はじめてのお客様・挨拶必須）",
  hearing:                 "条件ヒアリング段階（物件未提案・条件確認中）",
  condition_hearing:       "条件ヒアリング段階（物件未提案・条件確認中）",
  property_search:         "条件ヒアリング段階（物件未提案・条件確認中）",
  proposing:               "物件提案中（物件を送った後・内覧調整段階）",
  property_recommendation: "物件提案中（物件を送った後・内覧調整段階）",
  viewing:                 "物件提案中（内覧調整段階）",
  estimate_request:        "物件提案中（見積書依頼段階）",
  availability_check:      "物件提案中（空室確認段階）",
  applying:                "申込・審査中（クロージング段階）",
  application:             "申込・審査中（申込書類収集段階）",
  screening:               "申込・審査中（審査進行中）",
  contract:                "契約済み（成約完了）",
};

// Concise AIX capability summary injected into Haiku prompts for action/template reasoning
const AIX_CAPABILITY_MAP = `
【AIXボタン能力マップ】
- viewing_invite: 内覧日程の候補をLINEで提案するメッセージを生成
- property_send: 物件ピックアップのカバーメッセージを生成（物件URL送信時）
- estimate_sheet: 見積書を読み取り自動計算+カバーメッセージ生成
- application_push: 申込クロージングメッセージを生成
- condition_hearing: 既知条件をスキップした条件ヒアリングを生成
- acknowledge_check: 管理会社への空室確認+見積書依頼を生成
- followup_revive: 追客・再接触メッセージを生成
- property_check_result: 空室確認結果の報告文を生成
- property_recommendation: Vision読み取りで物件紹介文を生成（1件詳細）
- meeting_place: 内覧の待ち合わせ場所案内を生成
- greeting_viewing: 内覧前後の挨拶メッセージを生成
`.trim();

async function analyzeConversation(
  conversationId: string,
  convStatus: string | null,
  propertyCustomerId: string | null,
): Promise<{ action: string; note: string; source: string; enforcement_level: string; closing_strategy?: string; template_hint?: string; next_steps?: string[]; reply_mode?: "aix" | "auto_reply" } | null> {
  const [msgResult, pcResult, examplesResult, checkpointsResult, sentPropsResult, promptRulesResult, knowledgePrinciplesResult, templatesResult, boundaryPromptRulesResult, boundaryTriggerRulesResult] = await Promise.all([
    supabase
      .from("messages")
      .select("sender, text, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(15),
    propertyCustomerId
      ? supabase
          .from("property_customers")
          .select("desired_area, floor_plan, rent_min, rent_max, move_in_time, preferences")
          .eq("id", propertyCustomerId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("ai_reply_examples")
      .select("sent_reply")
      .eq("conversation_id", conversationId)
      .eq("is_starred", true)
      .order("created_at", { ascending: false })
      .limit(3),
    supabase
      .from("conversation_checkpoints")
      .select("checkpoint_index, summary, key_facts")
      .eq("conversation_id", conversationId)
      .order("checkpoint_index", { ascending: false })
      .limit(2),
    // Sent properties for this customer (duplicate/history awareness)
    propertyCustomerId
      ? supabase
          .from("sent_properties")
          .select("property_name, room_no, sent_at")
          .eq("property_customer_id", propertyCustomerId)
          .order("sent_at", { ascending: false })
          .limit(10)
      : Promise.resolve({ data: null }),
    // Global permanent operator rules (apply to all conversations, no pgvector needed)
    supabase
      .from("ai_prompt_rules")
      .select("rule_text, priority")
      .eq("is_active", true)
      .eq("is_permanent", true)
      .is("action_type", null)
      .order("priority", { ascending: false })
      .limit(10),
    // Confirmed top-importance principles (importance >= 9, no pgvector needed)
    supabase
      .from("ai_reply_knowledge")
      .select("content, importance")
      .eq("category", "principle")
      .gte("importance", 9)
      .neq("hypothesis_status", "rejected")
      .order("importance", { ascending: false })
      .limit(3),
    // Top templates by win_rate for context (brain uses these to recommend best template)
    supabase
      .from("templates")
      .select("category, label, win_rate, use_count")
      .like("category", "AIX%")
      .order("win_rate", { ascending: false })
      .limit(5),
    // BOUNDARY rules: which triggers must be escalated to AIX vs auto-reply
    supabase
      .from("ai_prompt_rules")
      .select("rule_text, rule_key, priority")
      .eq("is_active", true)
      .like("rule_key", "BOUNDARY-%")
      .order("priority", { ascending: false })
      .limit(15),
    supabase
      .from("trigger_action_rules")
      .select("keyword, action_type, confidence")
      .like("keyword", "BOUNDARY%")
      .order("confidence", { ascending: false })
      .limit(10),
  ]);

  const messages = msgResult.data;
  if (!messages || messages.length === 0) return null;

  const history = [...messages]
    .reverse()
    .map((m: { sender: string; text: string | null }) => {
      const label = m.sender === "ai" ? "[AI自動返信]" : m.sender === "staff" ? "[スタッフ/AIX]" : "[顧客]";
      return `${label} ${m.text ?? "（画像/添付）"}`;
    })
    .join("\n");

  type PC = { desired_area?: string | null; floor_plan?: string | null; rent_max?: number | null; move_in_time?: string | null; preferences?: string | null } | null;
  const pc = (pcResult.data ?? null) as PC;
  const condParts: string[] = [];
  if (pc?.desired_area) condParts.push(`エリア: ${pc.desired_area}`);
  if (pc?.floor_plan) condParts.push(`間取り: ${pc.floor_plan}`);
  if (pc?.rent_max) condParts.push(`家賃上限: ${Math.floor((pc.rent_max as number) / 10000)}万`);
  if (pc?.move_in_time) condParts.push(`入居: ${pc.move_in_time}`);
  if (pc?.preferences) condParts.push(`希望: ${pc.preferences}`);
  const condText = condParts.length > 0 ? `\n顧客条件: ${condParts.join(" / ")}` : "";
  const statusMeaning = convStatus && STATUS_MEANING[convStatus] ? STATUS_MEANING[convStatus] : (convStatus ?? "");
  const statusText = convStatus ? `\n現在のステータス: ${statusMeaning}` : "";

  const examples = (examplesResult.data ?? []) as Array<{ sent_reply: string | null }>;
  const examplesText = examples.length > 0
    ? `\n過去のスタッフ優良返信例:\n${examples.map((e) => `- ${e.sent_reply ?? ""}`).join("\n")}`
    : "";

  type Checkpoint = { checkpoint_index: number; summary: string | null; key_facts: string | null };
  const checkpoints = ((checkpointsResult.data ?? []) as Checkpoint[]).reverse();
  const checkpointText = checkpoints.length > 0
    ? `\n【過去の会話まとめ】\n${checkpoints.map((cp) => `■ ブロック${cp.checkpoint_index}: ${cp.summary ?? ""}`).join("\n")}`
    : "";

  // Sent properties — what has already been proposed to this customer
  type SentProp = { property_name: string; room_no: string; sent_at: string };
  const sentProps = ((sentPropsResult.data ?? []) as SentProp[]);
  const sentPropsText = sentProps.length > 0
    ? `\n【すでに送付済みの物件（${sentProps.length}件）】\n${sentProps.map((p) => `- ${p.property_name} ${p.room_no}（${new Date(p.sent_at).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })}送付）`).join("\n")}`
    : "";

  type PromptRule = { rule_text: string; priority: number };
  const promptRules = (promptRulesResult.data ?? []) as PromptRule[];
  const promptRulesText = promptRules.length > 0
    ? `\n【絶対ルール（オペレーター設定）】\n${promptRules.map((r) => `- ${r.rule_text}`).join("\n")}`
    : "";

  type KnowledgePrinciple = { content: string; importance: number };
  const knowledgePrinciples = (knowledgePrinciplesResult.data ?? []) as KnowledgePrinciple[];
  const knowledgeText = knowledgePrinciples.length > 0
    ? `\n【重要原則】\n${knowledgePrinciples.map((k) => `- ${k.content}`).join("\n")}`
    : "";

  // Top-performing AIX templates (for template_hint context)
  type TopTemplate = { category: string | null; label: string | null; win_rate: number | null; use_count: number | null };
  const topTemplates = (templatesResult.data ?? []) as TopTemplate[];
  const templatesText = topTemplates.length > 0
    ? `\n【高成約率テンプレート（参考）】\n${topTemplates.map((t) => `- ${t.category}: ${t.label} (成約率: ${((t.win_rate ?? 0) * 100).toFixed(0)}%, ${t.use_count ?? 0}回使用)`).join("\n")}`
    : "";

  // BOUNDARY rules — determines when AIX escalation is required vs auto-reply allowed
  type BoundaryRule = { rule_text: string; rule_key: string; priority: number };
  type BoundaryTrigger = { keyword: string; action_type: string; confidence: number };
  const boundaryPromptRules = (boundaryPromptRulesResult.data ?? []) as BoundaryRule[];
  const boundaryTriggerRules = (boundaryTriggerRulesResult.data ?? []) as BoundaryTrigger[];
  const boundaryLines: string[] = [
    ...boundaryPromptRules.map((r) =>
      r.rule_key.endsWith("-gr") ? `- ${r.rule_text} → 自動返信禁止` : `- ${r.rule_text} → AIX: ${r.rule_key}`
    ),
    ...boundaryTriggerRules.map((t) => `- ${t.keyword} → AIX: ${t.action_type}`),
  ];
  const boundaryText = boundaryLines.length > 0
    ? `\n【境界ルール（AIXエスカレーション条件）】\n${boundaryLines.join("\n")}`
    : "";

  const prompt = `あなたはスモラAI。以下の会話履歴を読んで、スタッフが次にすべき1アクションを20字以内で答えてください。必ずJSON形式のみで返してください。${statusText}${condText}${promptRulesText}${knowledgeText}${boundaryText}${examplesText}${checkpointText}${sentPropsText}${templatesText}

${AIX_CAPABILITY_MAP}

会話履歴:
${history}

回答形式（JSONのみ・説明文不要）:
{"action": "スタッフが次にすべき具体的なアクション（20字以内）", "reason": "その理由（30字以内）", "aix": "最も適切なAIXタイプ（viewing_invite/property_send/estimate_sheet/application_push/condition_hearing/acknowledge_check/followup_revive/property_check_result/property_recommendation/meeting_place/greeting_viewing/null）", "closing_strategy": "この顧客が契約に至るための具体的な戦略を1〜2文で", "template_hint": "このお客さんに合うテンプレートのトーン・スタイルのヒント（20字以内、例：丁寧語・プッシュ弱め）", "next_steps": ["Step1（今すぐ）: 具体的アクション", "Step2（次回）: 具体的アクション", "Step3（その次）: 具体的アクション"], "reply_mode": "aix or auto_reply（境界ルールに該当する場合はaix、そうでなければauto_reply）"}`;

  try {
    const response = await client.messages.create({
      model: HAIKU,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as {
      action?: string;
      aix?: string | null;
      closing_strategy?: string;
      template_hint?: string;
      next_steps?: string[];
      reply_mode?: "aix" | "auto_reply";
    };

    let finalAix = parsed.aix && AIX_BRAIN_NOTES[parsed.aix] ? parsed.aix : null;
    // Quality gate: suppress AIX suggestions with < 30% acceptance rate over 10+ samples
    if (finalAix) {
      const { data: rateData } = await supabase
        .from("trigger_action_rules")
        .select("confidence, total_occurrence")
        .eq("keyword", `SOURCE_ACCEPT_RATE:${finalAix}:analysis_step1`)
        .eq("action_type", finalAix)
        .maybeSingle();
      if (rateData) {
        const occ = (rateData.total_occurrence as number | null) ?? 0;
        const conf = (rateData.confidence as number | null) ?? 1;
        if (occ >= 10 && conf < 0.3) finalAix = null;
      }
    }
    return {
      action: finalAix ?? "",
      note: finalAix ? AIX_BRAIN_NOTES[finalAix] : (parsed.action ?? ""),
      source: "brain_weekly",
      enforcement_level: "recommended",
      closing_strategy: parsed.closing_strategy || undefined,
      template_hint: parsed.template_hint || undefined,
      next_steps: Array.isArray(parsed.next_steps) && parsed.next_steps.length > 0 ? parsed.next_steps : undefined,
      reply_mode: (parsed.reply_mode === "aix" || parsed.reply_mode === "auto_reply") ? parsed.reply_mode : undefined,
    };
  } catch {
    return null;
  }
}

// Process an array of items concurrently with a max concurrency limit
async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

export async function GET() {
  // Fetch active non-要対応 conversations (last_sender = 'staff' or 'ai')
  const { data: conversations, error } = await supabase
    .from("conversations")
    .select("id, status, updated_at, property_customer_id")
    .neq("last_sender", "customer")
    .not("status", "in", `(${SKIP_STATUSES.join(",")})`)
    .not("status", "is", null)
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (conversations ?? []) as Array<{
    id: string;
    status: string | null;
    updated_at: string;
    property_customer_id: string | null;
  }>;

  if (rows.length === 0) {
    return NextResponse.json({ processed: 0, skipped: 0 });
  }

  let processed = 0;
  let failed = 0;

  await withConcurrency(rows, 5, async (conv) => {
    const meta = await analyzeConversation(conv.id, conv.status, conv.property_customer_id);
    if (!meta) { failed++; return; }

    const { error: upsertErr } = await supabase
      .from("conversations")
      .update({ suggested_aix_meta: meta })
      .eq("id", conv.id);

    if (!upsertErr) processed++;
    else failed++;
  });

  return NextResponse.json({ processed, failed, total: rows.length });
}
