import { NextRequest, NextResponse } from "next/server";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { supabase } from "@/app/lib/supabase";

// ─── モデル定義 ───────────────────────────────────────────────────────────────
// Step1（分析）: Haiku — 速度重視
const analysisModel = new ChatAnthropic({
  model: "claude-haiku-4-5-20251001",
  maxTokens: 1024,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
});

// Step2（生成）: Sonnet — 品質重視
const generationModel = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  maxTokens: 4096,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
});

// ─── 絵文字・スタイルルール（全プロンプト共通） ──────────────────────────────
const EMOJI_RULE = `
【絵文字ルール — 最重要・必ず守ること】
▼ 使ってよい絵文字はこの5つだけ：😊 😌 🙇‍♀️ 🌟 ✨
▼ 上記以外は一切禁止：🙏 ⭐️ 🏠 💰 💪 👍 🔍 ✋ 👏 🎉 📋 😆 😄 その他すべて禁止
▼ 絵文字は1〜2個まで。文末か文の区切りにのみ置く。
・😊 😌 → 余裕を示しながらリードする場面（誘導・申込・締め）
・🙇‍♀️ → 連絡が遅れた時・男性客の冒頭（女性スタッフ感）
・🌟 ✨ → 物件紹介の冒頭・オススメ強調のみ`.trim();

const STYLE_RULE = `
【スモラのLINEスタイル】
・感嘆符は「！！」（スモラスタイル。「!」1つや「！」1つは禁止）
・「〇〇さん」とお客様名を必ず呼ぶ（名前が分かる場合）
・こちらが動く姿勢を示す（「確認します」「ピックアップします」等）
・「顧客」「弊社」「御社」などビジネス敬語は一切使わない
・LINEでそのまま送れる文章のみ。解説・補足・候補複数は禁止
・返信案は必ず1つだけ`.trim();

// ─── Step1: お客様状況の深層分析（Haiku）───────────────────────────────────
const ANALYSIS_SYSTEM = `あなたは賃貸仲介の営業コーチです。
LINEのやりとりから、お客様の状況・感情・本当のニーズを深く分析してください。
JSONのみで返答（説明不要）。`;

async function analyzeCustomerSituation(
  customerMessage: string,
  history: string,
  state: string,
  customerName: string
): Promise<string> {
  const prompt = `
【営業フェーズ】${state}
【お客様名】${customerName || "不明"}
【直近の会話履歴】
${history || "なし"}
【最新メッセージ】
${customerMessage}

以下をJSONで分析してください：
{
  "emotion": "お客様の感情状態（例：期待と不安が混在、前向き、迷っているなど）",
  "real_need": "表面の質問の奥にある本当のニーズ・懸念（例：費用が心配で踏み出せない、家族に相談したいなど）",
  "key_insight": "優秀な営業スタッフが気づくべき重要なポイント（例：価格比較をしている、決断を急かされたくないなど）",
  "approach": "このメッセージへの最適な返し方の方針（例：まず共感→動画を送ると約束→内覧への自然な誘導など）",
  "tone": "適切なトーン（例：温かく・余裕を持って・軽く背中を押す）"
}`;

  try {
    const res = await analysisModel.invoke([
      new SystemMessage(ANALYSIS_SYSTEM),
      new HumanMessage(prompt),
    ]);
    const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    const match = text.match(/\{[\s\S]*\}/);
    return match ? match[0] : "";
  } catch {
    return "";
  }
}

// ─── Step2: LINE返信生成（Sonnet）──────────────────────────────────────────
const GENERATION_SYSTEM = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当（女性スタッフ）です。
お客様の状況分析と会話履歴をもとに、そのまま送れる最高品質のLINE返信案を1つだけ作成してください。

${EMOJI_RULE}

${STYLE_RULE}

【説明ルール（曖昧表現禁止）】
× 築浅 → ○ 2023年6月築
× 広い → ○ 洋室9帖
× 駅近 → ○ 本町駅徒歩5分

【重要】
お客様の「本当のニーズ」に寄り添い、表面の質問だけに答えず、感情・懸念にも届く文を作ること。
押しつけがましくなく、でも確実に次のステップ（内覧・申込）へ近づける文を書くこと。`;

async function generateReplyWithLangChain(
  customerMessage: string,
  customerName: string,
  history: string,
  state: string,
  nextState: string,
  analysis: string,
  knowledge: string,
  examples: string
): Promise<string> {
  const nameNote = customerName ? `お客様名：${customerName}さん` : "お客様名：不明";

  let analysisBlock = "";
  if (analysis) {
    try {
      const parsed = JSON.parse(analysis) as Record<string, string>;
      analysisBlock = `
【お客様状況の深層分析（必ず参考にすること）】
・感情状態：${parsed.emotion || ""}
・本当のニーズ・懸念：${parsed.real_need || ""}
・重要な気づき：${parsed.key_insight || ""}
・最適な返し方の方針：${parsed.approach || ""}
・適切なトーン：${parsed.tone || ""}`;
    } catch {
      analysisBlock = "";
    }
  }

  const prompt = `
${nameNote}
【現在の営業フェーズ】${state} → 次フェーズ：${nextState}

【直近の会話履歴】
${history || "なし"}
${analysisBlock}
${knowledge}
${examples}

【お客様の最新メッセージ】
${customerMessage}

上記の分析と会話の流れを踏まえ、スモラスタイルのLINE返信案を1つだけ作成してください。`;

  const res = await generationModel.invoke([
    new SystemMessage(GENERATION_SYSTEM),
    new HumanMessage(prompt),
  ]);

  const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
  return text.trim() || "返信生成失敗";
}

// ─── Intent分類（Haiku）──────────────────────────────────────────────────────
const ALLOWED_INTENTS = new Set([
  "condition_share", "consult_property_search", "estimate_request",
  "like_property", "dislike_property", "viewing_request", "application_interest",
  "search_more_properties", "conditions_complete", "conditions_incomplete",
  "property_available", "property_unavailable", "screening_passed", "screening_failed", "other",
]);

const ALLOWED_STATES = new Set([
  "first_reply", "condition_hearing", "property_search", "property_recommendation",
  "viewing", "estimate_request", "availability_check", "application", "screening",
  "contract", "closed_won",
]);

const NEXT_STATE_MAP: Record<string, Record<string, string>> = {
  first_reply: { condition_share: "property_search", consult_property_search: "condition_hearing", estimate_request: "availability_check" },
  condition_hearing: { conditions_complete: "property_search", conditions_incomplete: "condition_hearing" },
  property_search: { other: "property_recommendation" },
  property_recommendation: { like_property: "viewing", dislike_property: "property_search", search_more_properties: "property_search" },
  viewing: { application_interest: "application", search_more_properties: "property_search", viewing_request: "viewing" },
  availability_check: { property_available: "estimate_request", property_unavailable: "property_search" },
  estimate_request: { application_interest: "application", search_more_properties: "property_search" },
  application: { other: "screening" },
  screening: { screening_passed: "contract", screening_failed: "property_search" },
  contract: { other: "closed_won" },
  closed_won: { other: "closed_won" },
};

function normalizeState(k: string): string {
  return ALLOWED_STATES.has(k) ? k : "first_reply";
}
function getNextState(current: string, intent: string): string {
  const map = NEXT_STATE_MAP[normalizeState(current)] || {};
  return map[intent] || map["other"] || current;
}

async function classifyIntent(message: string, state: string, history: string): Promise<string> {
  const system = `賃貸仲介LINE営業のintent分類器。以下のintent_keyのどれか1つをJSONで返す。
condition_share, consult_property_search, estimate_request, like_property, dislike_property,
viewing_request, application_interest, search_more_properties, conditions_complete,
conditions_incomplete, property_available, property_unavailable, screening_passed, screening_failed, other
必ず {"intent_key":"..."} のみ返すこと。`;

  try {
    const res = await analysisModel.invoke([
      new SystemMessage(system),
      new HumanMessage(`state: ${state}\n履歴:\n${history || "なし"}\nメッセージ: ${message}`),
    ]);
    const text = typeof res.content === "string" ? res.content : "";
    const match = text.match(/\{[\s\S]*?\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as { intent_key?: string };
      const intent = parsed.intent_key || "other";
      return ALLOWED_INTENTS.has(intent) ? intent : "other";
    }
    return "other";
  } catch {
    return "other";
  }
}

// ─── DB取得 ─────────────────────────────────────────────────────────────────
async function fetchKnowledge(state: string): Promise<string> {
  const [{ data: global }, { data: stateSpecific }] = await Promise.all([
    supabase.from("ai_reply_knowledge").select("category, title, content, importance")
      .is("conversation_state", null).order("importance", { ascending: false }).limit(8),
    supabase.from("ai_reply_knowledge").select("category, title, content, importance")
      .eq("conversation_state", state).order("importance", { ascending: false }).limit(6),
  ]);

  const all = [...(stateSpecific || []), ...(global || [])];
  if (all.length === 0) return "";

  const patterns = all.filter((k) => k.category === "pattern" || k.category === "principle");
  const phrases = all.filter((k) => k.category === "phrase");

  const sections: string[] = [];
  if (patterns.length > 0) {
    sections.push("【スモラの営業パターン・原則】\n" + patterns.map((k) => `・${k.content}`).join("\n"));
  }
  if (phrases.length > 0) {
    sections.push("【よく使うフレーズ】\n" + phrases.map((k) => `「${k.content}」`).join("　"));
  }
  return sections.length > 0 ? "\n\n" + sections.join("\n\n") : "";
}

async function fetchExamples(state: string): Promise<string> {
  const [{ data: starred }, { data: aiUsed }] = await Promise.all([
    supabase.from("ai_reply_examples").select("customer_message, sent_reply")
      .eq("conversation_state", state).eq("is_starred", true)
      .order("created_at", { ascending: false }).limit(3),
    supabase.from("ai_reply_examples").select("customer_message, sent_reply")
      .eq("conversation_state", state).eq("is_starred", false).eq("was_ai_used", true)
      .order("created_at", { ascending: false }).limit(2),
  ]);

  const all = [
    ...(starred || []).map((ex) => ({ ...ex, label: "★実例" })),
    ...(aiUsed || []).map((ex) => ({ ...ex, label: "参考" })),
  ];
  if (all.length === 0) return "";

  return "\n\n【実際のやりとり例（文体・トーンの参考）】\n" +
    all.map((ex) => `[${ex.label}]\nお客様:「${ex.customer_message}」\nスモラ:「${ex.sent_reply}」`).join("\n\n");
}

// ─── POST ────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }

  let message: string, state: string, customerName: string, recentMessages: Array<{ sender: string; text: string }>;
  try {
    const body = await req.json() as {
      message: string;
      state: string;
      customerName?: string;
      recentMessages?: Array<{ sender: string; text: string }>;
    };
    message = body.message;
    state = body.state;
    customerName = body.customerName || "";
    recentMessages = body.recentMessages || [];
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  if (!message) return NextResponse.json({ ok: false, error: "message required" }, { status: 400 });

  try {
    const currentState = normalizeState(state || "first_reply");
    const history = recentMessages
      .slice(-20)
      .filter((m) => m.text && m.text !== "[画像]" && m.text !== "[動画]")
      .map((m) => `${m.sender === "customer" ? "お客様" : "スモラ"}: ${m.text}`)
      .join("\n");

    // 並列実行: intent分類 + 状況分析 + 知識取得 + 実例取得
    const [detectedIntent, analysis, knowledge, examples] = await Promise.all([
      classifyIntent(message, currentState, history),
      analyzeCustomerSituation(message, history, currentState, customerName),
      fetchKnowledge(currentState),
      fetchExamples(currentState),
    ]);

    const nextState = getNextState(currentState, detectedIntent);

    // Sonnetで高品質生成
    const aiReply = await generateReplyWithLangChain(
      message, customerName, history, currentState, nextState,
      analysis, knowledge, examples
    );

    return NextResponse.json({
      ok: true,
      ai_reply: aiReply,
      detected_intent: detectedIntent,
      next_state: nextState,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "返信生成エラー";
    console.error("generate-reply error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
