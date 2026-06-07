import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

const STATE_SEARCH_ALIASES: Record<string, string[]> = {
  first_reply: ["first_reply"],
  hearing:     ["hearing", "condition_hearing", "property_search"],
  proposing:   ["proposing", "property_recommendation", "viewing", "estimate_request", "availability_check"],
  applying:    ["applying", "application", "screening", "contract"],
  closed_won:  ["closed_won"],
};
const STATE_NORMALIZE: Record<string, string> = {
  condition_hearing: "hearing", property_search: "hearing",
  property_recommendation: "proposing", viewing: "proposing",
  estimate_request: "proposing", availability_check: "proposing",
  application: "applying", screening: "applying", contract: "applying",
};

async function fetchEnhanceContext(state: string): Promise<{ knowledge: string; examples: string }> {
  const normalized = STATE_NORMALIZE[state] ?? state;
  const aliases = STATE_SEARCH_ALIASES[normalized] || [normalized];

  const [{ data: knowledgeRows }, { data: exampleRows }] = await Promise.all([
    // importance 8以上（principle・差分学習ルール）を最大12件
    supabase.from("ai_reply_knowledge")
      .select("category, title, content, importance")
      .in("conversation_state", aliases)
      .gte("importance", 8)
      .order("importance", { ascending: false })
      .limit(12),

    // ☆つき実例を最大5件（文体参照用）
    supabase.from("ai_reply_examples")
      .select("customer_message, sent_reply")
      .in("conversation_state", aliases)
      .eq("is_starred", true)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  const knowledge = (knowledgeRows || []).length > 0
    ? "\n【スモラのノウハウ（必ず従うこと）】\n" +
      (knowledgeRows as { category: string; title: string; content: string }[])
        .map((r) => `・[${r.category}] ${r.content}`)
        .join("\n")
    : "";

  const examples = (exampleRows || []).length > 0
    ? "\n【⭐ スモラの実際の送信例（文体・感嘆符・絵文字はこれに合わせる）】\n" +
      (exampleRows as { customer_message: string; sent_reply: string }[])
        .map((r, i) => `[例${i + 1}]\nお客様:「${r.customer_message}」\nスモラ:「${r.sent_reply}」`)
        .join("\n\n")
    : "";

  return { knowledge, examples };
}

const BASE_SYSTEM = `あなたは賃貸仲介サービス「スモラ」のLINE文章改善AIです。
スタッフが入力した下書き・単語・メモをもとに、スモラらしい完成されたLINEメッセージに仕上げてください。

【絵文字ルール — 最重要・必ず守ること】
▼ 使ってよい絵文字：😊 😌 🙇‍♀️ 🌟 ✨ のみ（他は全禁止）
▼ 絵文字は1〜2個まで。文末か文の区切りのみ。

【出力ルール】
・LINEでそのまま送れる完成文のみを出力する
・解説・補足・括弧書きは禁止
・候補は1つだけ
・感嘆符は「！！」（スモラスタイル）`;

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "");
  if (!apiKey) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, { status: 500 });

  const { currentDraft, conversationState, customerName, recentMessages, customerConditions } = await req.json() as {
    currentDraft: string;
    conversationState?: string;
    customerName?: string;
    recentMessages?: Array<{ sender: string; text: string }>;
    customerConditions?: string;
  };

  if (!currentDraft?.trim()) {
    return NextResponse.json({ ok: false, error: "currentDraft required" }, { status: 400 });
  }

  // knowledge + examples を並列取得
  const { knowledge, examples } = await fetchEnhanceContext(conversationState || "hearing");

  const history = (recentMessages || [])
    .slice(-15)
    .filter((m) => m.text && m.text !== "[画像]" && m.text !== "[動画]")
    .map((m) => `${m.sender === "customer" ? "お客様" : "スモラ"}: ${m.text}`)
    .join("\n");

  const nameNote = customerName ? `お客様名：${customerName}さん` : "";
  const conditionsNote = customerConditions ? `\n【お客様の希望条件】\n${customerConditions}` : "";
  const stateNote = conversationState ? `現在の営業フェーズ：${conversationState}` : "";

  const system = `${BASE_SYSTEM}${knowledge}${examples}`;

  const userPrompt = `
${nameNote}${conditionsNote}
${stateNote}

【直近の会話】
${history || "なし"}

【スタッフが入力した下書き・単語・メモ】
${currentDraft.trim()}

上記の下書きを、スモラの実例・ノウハウに沿ったLINEメッセージに仕上げてください。`.trim();

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        system,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ ok: false, error: err }, { status: 500 });
    }

    const data = await res.json() as { content?: Array<{ text: string }> };
    const enhanced = data.content?.[0]?.text?.trim() || "";

    return NextResponse.json({ ok: true, enhanced });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
