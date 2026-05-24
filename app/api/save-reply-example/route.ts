import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

type KnowledgeEntry = {
  category: "pattern" | "style" | "phrase" | "principle";
  title: string;
  content: string;
  importance: number;
};

type AnalysisResult = {
  situation: string;
  pattern: string;
  style_elements: string[];
  key_phrases: string[];
  principle: string;
};

async function analyzeAndSaveKnowledge(
  exampleId: string,
  conversationState: string,
  customerMessage: string,
  sentReply: string
) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "");
  if (!apiKey) return;

  const prompt = `以下のLINE賃貸営業のやりとりを深く分析してください。

【お客様のメッセージ】
${customerMessage}

【スモラスタッフの返信】
${sentReply}

以下の4点を抽出してください。JSONのみで返答（説明不要）：

{
  "situation": "この状況を一言で表す（例：初めての条件共有、物件への反応など）",
  "pattern": "この状況でのベストな返し方の原則（具体的に・1〜2文）",
  "style_elements": ["口調・文体の特徴を3〜5点（例：お客様名を呼ぶ、絵文字を使う、etc.）"],
  "key_phrases": ["この返信で使われている再利用可能なフレーズ（1〜3個）"],
  "principle": "この返信が優れている核心的な理由（1文）"
}`;

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
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) return;

    const data = await res.json() as { content?: Array<{ text: string }> };
    const text = data.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const analysis = JSON.parse(jsonMatch[0]) as AnalysisResult;

    const entries: KnowledgeEntry[] = [
      {
        category: "pattern",
        title: analysis.situation,
        content: analysis.pattern,
        importance: 7,
      },
      {
        category: "principle",
        title: `原則：${analysis.situation}`,
        content: analysis.principle,
        importance: 8,
      },
      ...analysis.style_elements.map((el) => ({
        category: "style" as const,
        title: `口調・スタイル`,
        content: el,
        importance: 6,
      })),
      ...analysis.key_phrases.map((phrase) => ({
        category: "phrase" as const,
        title: `フレーズ`,
        content: phrase,
        importance: 6,
      })),
    ];

    for (const entry of entries) {
      await supabase.from("ai_reply_knowledge").insert({
        category: entry.category,
        title: entry.title,
        content: entry.content,
        importance: entry.importance,
        conversation_state: conversationState || null,
        source_example_id: exampleId,
      });
    }
  } catch (e) {
    console.error("analyzeAndSaveKnowledge error:", e);
  }
}

export async function POST(req: NextRequest) {
  const { conversationState, customerMessage, sentReply, aiDraft, isStarred } = await req.json() as {
    conversationState: string;
    customerMessage: string;
    sentReply: string;
    aiDraft?: string;
    isStarred?: boolean;
  };

  if (!customerMessage || !sentReply) {
    return NextResponse.json({ ok: false, error: "customerMessage and sentReply required" }, { status: 400 });
  }

  const wasAiUsed = !!aiDraft && aiDraft.trim() === sentReply.trim();
  const wasAiModified = !!aiDraft && !wasAiUsed && aiDraft.trim().length > 0;

  const { data, error } = await supabase
    .from("ai_reply_examples")
    .insert({
      conversation_state: conversationState || "first_reply",
      customer_message: customerMessage,
      sent_reply: sentReply,
      ai_draft: aiDraft || null,
      was_ai_used: wasAiUsed,
      was_ai_modified: wasAiModified,
      is_starred: isStarred ?? false,
    })
    .select("id")
    .single();

  if (error) {
    console.error("save-reply-example error:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // ★スターか手動インポートの場合は深層分析して知識を抽出・保存
  const shouldAnalyze = isStarred === true || (!aiDraft);
  if (shouldAnalyze && data?.id) {
    await analyzeAndSaveKnowledge(data.id, conversationState, customerMessage, sentReply);
  }

  return NextResponse.json({ ok: true, id: data?.id });
}
