import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 30;

// 質問コンテキストを system prompt に毎ターン埋め込む
// （以前は初回ターンのみ user メッセージとして注入していたが、クライアント側 state に保存されず
//   2ターン目以降で質問コンテキストが消失するバグがあったため system 側に移設）
function buildSystemPrompt(params: {
  question: string;
  speculation?: string | null;
  evidence?: string | null;
  phase?: string | null;
  importance?: number | null;
}): string {
  const attrs: string[] = [];
  if (params.phase) attrs.push(`フェーズ: ${params.phase}`);
  if (params.importance !== null && params.importance !== undefined) attrs.push(`重要度: ${params.importance}`);
  if (params.speculation) attrs.push(`AIの憶測: ${params.speculation}`);
  if (params.evidence) attrs.push(`根拠・予測場面: ${params.evidence}`);

  return `あなたは不動産AIアシスタント「スモラAI」のルール調整担当です。
竹内さん（スタッフ）がAIのルール（返信ルール）を判断するのを手伝ってください。

【今回の質問内容】
${params.question}
${attrs.length > 0 ? `
【質問の属性】
${attrs.join("\n")}
` : ""}
竹内さんと一緒に、この質問に対して正しい判断ができるよう議論してください。
LINEのような短い返信で、分かりやすく会話してください。
竹内さんの回答が曖昧な場合は、具体的な例を挙げてさらに聞いてください。
最終的に竹内さんが「①新しいルールが正しい」「②既存のルールが正しい」「③場面で使い分ける」のどれか、
または具体的な回答文を決められるよう導いてください。
実際のナレッジ更新は竹内さんが画面上の回答ボタンで行うため、あなた自身が更新するとは言わないでください。`;
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY が設定されていません" }, { status: 500 });
  }

  let body: {
    item_id: string;
    question: string;
    speculation?: string | null;
    evidence?: string | null;
    phase?: string | null;
    importance?: number | null;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    user_message: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "リクエストボディの解析に失敗しました" }, { status: 400 });
  }

  const { question, speculation, evidence, phase, importance, messages, user_message } = body;

  if (!question || !user_message) {
    return NextResponse.json({ ok: false, error: "question と user_message は必須です" }, { status: 400 });
  }

  // 過去の会話履歴に今回のユーザーメッセージを追加
  // （質問コンテキストは system prompt に毎ターン含まれるため、履歴への注入は不要）
  const conversationMessages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...(messages ?? []),
    { role: "user", content: user_message },
  ];

  const client = new Anthropic({ apiKey, timeout: 25_000, maxRetries: 1 });

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: buildSystemPrompt({ question, speculation, evidence, phase, importance }),
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
