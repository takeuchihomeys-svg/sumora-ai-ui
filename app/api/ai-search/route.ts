import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY?.replace(/\s/g, "");
  if (!apiKey) return NextResponse.json({ ok: false, error: "OPENAI_API_KEY not set" }, { status: 500 });

  const { query, conversations } = await req.json() as {
    query: string;
    conversations: Array<{
      id: string;
      customerName: string;
      status: string;
      lastMessage: string;
      messages: Array<{ id: string; sender: string; text: string }>;
    }>;
  };

  if (!query || !conversations) {
    return NextResponse.json({ ok: false, error: "query and conversations required" }, { status: 400 });
  }

  const convSummary = conversations.map((c) => ({
    id: c.id,
    name: c.customerName,
    status: c.status,
    lastMessage: c.lastMessage,
    messages: (c.messages || []).slice(-20).map((m) => ({ id: m.id, sender: m.sender, text: m.text || "" })),
  }));

  const systemPrompt = `あなたは賃貸仲介の会話検索AIです。
会話一覧データとユーザーの検索クエリを受け取り、クエリに合致する会話と該当メッセージを返してください。

検索対象：お客様名、物件の希望条件（エリア・間取り・家賃・築年数・ウォークインクローゼットなど）、会話内容全般。

返却形式（JSONのみ）:
{
  "results": [
    {
      "conversationId": "会話ID（文字列）",
      "matchedMessageIds": ["最も関連性の高いメッセージIDを1〜3件（文字列）"]
    }
  ]
}

マッチしない場合: { "results": [] }
余分な説明は不要。JSONのみ返すこと。`;

  const userPrompt = `検索クエリ: ${query}\n\n会話一覧:\n${JSON.stringify(convSummary, null, 2)}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 500,
    }),
  });

  if (!res.ok) return NextResponse.json({ ok: false, error: "OpenAI error" }, { status: 500 });

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const resultText = data.choices?.[0]?.message?.content || "";

  let results: Array<{ conversationId: string; matchedMessageIds?: string[] }> = [];
  try {
    const jsonMatch = resultText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { results?: typeof results };
      results = parsed.results || [];
    }
  } catch {
    results = [];
  }

  const matchedIds = results.map((r) => String(r.conversationId));
  const matchedMessageIds: Record<string, string[]> = {};
  for (const r of results) {
    matchedMessageIds[String(r.conversationId)] = (r.matchedMessageIds || []).map(String);
  }

  return NextResponse.json({ ok: true, matchedIds, matchedMessageIds });
}
