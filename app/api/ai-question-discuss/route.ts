import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 30;

const SYSTEM_PROMPT = `あなたは不動産会社のAIアシスタントです。竹内悠馬さん（社長）が AI学習ナレッジについて確認・打ち合わせできるようサポートします。
以下のナレッジ確認質問について、竹内さんの回答を元に具体的に整理・確認してください。
LINEのような短い返信で、分かりやすく会話してください。
竹内さんの回答が曖昧な場合は、具体的な例を挙げてさらに聞いてください。
最終的に「了解しました。〇〇としてナレッジを更新します。」と確認できたらその旨を伝えてください。`;

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY が設定されていません" }, { status: 500 });
  }

  let body: {
    item_id: string;
    question: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    user_message: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "リクエストボディの解析に失敗しました" }, { status: 400 });
  }

  const { question, messages, user_message } = body;

  if (!question || !user_message) {
    return NextResponse.json({ ok: false, error: "question と user_message は必須です" }, { status: 400 });
  }

  // 過去の会話履歴に今回のユーザーメッセージを追加
  const conversationMessages: Array<{ role: "user" | "assistant"; content: string }> = [
    // 最初のターンは質問文をユーザーメッセージとして挿入（履歴が空の場合）
    ...(messages.length === 0
      ? [{ role: "user" as const, content: `【ナレッジ確認質問】\n${question}` }]
      : messages),
    { role: "user", content: user_message },
  ];

  const client = new Anthropic({ apiKey, timeout: 25_000, maxRetries: 1 });

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: conversationMessages,
    });

    const reply =
      response.content
        .filter((block) => block.type === "text")
        .map((block) => (block as { type: "text"; text: string }).text)
        .join("") || "";

    return NextResponse.json({ ok: true, reply });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "不明なエラー";
    console.error("[ai-question-discuss] Claude API エラー:", message);
    return NextResponse.json({ ok: false, error: `AI呼び出しに失敗しました: ${message}` }, { status: 500 });
  }
}
