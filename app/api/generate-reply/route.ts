import { NextRequest, NextResponse } from "next/server";

const SYSTEM_PROMPT = `
あなたは賃貸仲介サービス「スモラ」のLINE営業AIです。
役割は、お客様から届いたLINEメッセージに対して、そのまま送れる自然な返信案を1つだけ作成することです。

営業の本質は、信頼を得ることで契約に繋げることです。
お客様ファーストで信頼を築きながら、自然に内覧または申込へ繋げてください。

【基本方針】
・丁寧
・親しみやすい
・分かりやすい
・読みやすい
・ストレスのない文章
・長すぎない
・営業感が強すぎない
・責任感のある提案

【重要】
・お客様の要望を理解していることを文章で伝える
・「私の方で確認します」「ピックアップします」など、こちらが動く姿勢を入れる
・安心感が伝わる文章にする
・お客様の名前が分かる場合は必ず「〇〇さん」と呼ぶ
・LINEでそのまま送れる文章だけを書く
・解説や補足は禁止
・返信案は必ず1つだけ

【説明ルール】
曖昧な表現は禁止です。
例：
× 築浅
○ 2023年6月築で築年数も浅く

× 広い
○ 洋室9帖と広めのお部屋

× 駅近
○ 本町駅徒歩5分

【物件提案】
物件提案では「おすすめです」だけで終わらせず、
「お客様の条件にかなり近い」と伝えてください。

【内覧誘導】
自然な流れで内覧提案をしてください。
例：
お気に召したお部屋ございましたら、ご都合よろしいお日にちにご内覧させて頂きます😊

【申込誘導】
条件がかなり合う物件の場合は、責任感を持って申込提案をしてください。
例：
〇〇さんの条件にかなり近いお部屋となっておりますので、
お気に召されましたらお申込しお部屋おさえさせて頂きます！！

【返信トーン】
丁寧、柔らかい、信頼感。
`.trim();

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

function normalizeIntent(k: string): string {
  return ALLOWED_INTENTS.has(k) ? k : "other";
}
function normalizeState(k: string): string {
  return ALLOWED_STATES.has(k) ? k : "first_reply";
}
function getNextState(current: string, intent: string): string {
  const map = NEXT_STATE_MAP[normalizeState(current)] || {};
  return map[intent] || map["other"] || current;
}

async function callClaude(apiKey: string, system: string, userMessage: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Anthropic API error:", res.status, errText);
    throw new Error(`Anthropic ${res.status}: ${errText}`);
  }

  const data = await res.json() as { content?: Array<{ type: string; text: string }> };
  return data.content?.[0]?.text?.trim() || "";
}

async function classifyIntent(apiKey: string, state: string, message: string, history: string): Promise<string> {
  const system = `あなたは賃貸仲介LINE営業AIのintent分類器です。
以下のintent_keyのどれか1つだけをJSONで返してください。
condition_share, consult_property_search, estimate_request, like_property, dislike_property,
viewing_request, application_interest, search_more_properties, conditions_complete,
conditions_incomplete, property_available, property_unavailable, screening_passed, screening_failed, other

必ず {"intent_key":"..."} のJSON形式のみで返すこと。説明不要。`;

  const userPrompt = `現在のstate: ${state}
会話履歴:
${history || "なし"}
最新メッセージ: ${message}`;

  try {
    const text = await callClaude(apiKey, system, userPrompt);
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { intent_key?: string };
      return normalizeIntent(parsed.intent_key || "other");
    }
    return "other";
  } catch {
    return "other";
  }
}

async function generateAiReply(apiKey: string, message: string, context: string): Promise<string> {
  const text = await callClaude(apiKey, SYSTEM_PROMPT, `${context}\n\n${message}`);
  return text || "返信生成失敗";
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "");
  if (!apiKey) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, { status: 500 });

  let message: string, state: string, customerName: string | undefined, recentMessages: Array<{ sender: string; text: string }> | undefined;
  try {
    const body = await req.json() as {
      message: string;
      state: string;
      customerName?: string;
      recentMessages?: Array<{ sender: string; text: string }>;
    };
    message = body.message;
    state = body.state;
    customerName = body.customerName;
    recentMessages = body.recentMessages;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  if (!message) return NextResponse.json({ ok: false, error: "message required" }, { status: 400 });

  try {
    const currentState = normalizeState(state || "first_reply");
    const history = (recentMessages || []).slice(-10).map((m) => `${m.sender}: ${m.text}`).join("\n");

    const detectedIntent = await classifyIntent(apiKey, currentState, message, history);
    const nextState = getNextState(currentState, detectedIntent);

    const nameRule = customerName
      ? `お客様名は「${customerName}さん」として返信してください。`
      : "お客様名が不明なため、名前呼びは不要です。";

    const context = `
${nameRule}

【現在の営業状態】
${currentState}

【判定された意図】
${detectedIntent}

【次に進む営業状態】
${nextState}

【直近の会話履歴】
${history || "なし"}

スモラ営業スタイルで自然なLINE返信案を1つだけ作成してください。
`.trim();

    const aiReply = await generateAiReply(apiKey, message, context);

    return NextResponse.json({ ok: true, ai_reply: aiReply, detected_intent: detectedIntent, next_state: nextState });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "返信生成エラー";
    console.error("generate-reply error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
