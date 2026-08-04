import { NextRequest, NextResponse } from "next/server";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";

export const maxDuration = 30;

const VALID_CHIPS = new Set(["家賃", "礼金", "築年数", "地域", "初期費用"]);

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      recent_messages?: Array<{ sender: string; text: string }>;
      customer_conditions?: string;
    };

    const messages = Array.isArray(body.recent_messages)
      ? body.recent_messages.slice(-20)
      : [];
    const conditions = body.customer_conditions ? String(body.customer_conditions) : "";

    if (messages.length === 0 && !conditions) {
      return NextResponse.json({ expanded: [] });
    }

    const conversationText = messages
      .map(m => `[${m.sender === "staff" ? "スタッフ" : "お客様"}]: ${m.text}`)
      .join("\n");

    const userText = [
      conditions ? `【お客様の希望条件】\n${conditions}` : "",
      conversationText ? `【会話履歴（最新${messages.length}件）】\n${conversationText}` : "",
      `\n上記の会話を読み、お客様が了承した・受け入れた・条件を緩めることに同意した項目を以下のラベルから選んでください。\n選択肢：家賃、礼金、築年数、地域、初期費用\n\nラベルが会話に明確に現れない場合は空配列にしてください。\n必ず以下のJSON形式のみで返してください：\n{"expanded":["ラベル1","ラベル2"]}`,
    ].filter(Boolean).join("\n\n");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 64,
        system: `あなたは賃貸仲介のLINE会話を分析するアシスタントです。会話からお客様が条件を緩和した・広げることを了承した項目を特定してJSON配列で返します。`,
        messages: [{ role: "user", content: userText }],
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      return NextResponse.json({ expanded: [] });
    }

    const data = await res.json() as { content?: Array<{ text?: string }> };
    const raw = (data.content?.[0]?.text?.trim() ?? "").replace(/```json\n?|```/g, "").trim();

    let result: string[] = [];
    try {
      const parsed = JSON.parse(raw) as { expanded?: unknown };
      if (Array.isArray(parsed.expanded)) {
        result = (parsed.expanded as unknown[]).filter(
          (v): v is string => typeof v === "string" && VALID_CHIPS.has(v)
        );
      }
    } catch {
      // parse error — return empty, never throw
    }

    return NextResponse.json({ expanded: result });
  } catch {
    return NextResponse.json({ expanded: [] });
  }
}
