import { NextRequest, NextResponse } from "next/server";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json() as { text: string };
    if (!text?.trim()) return NextResponse.json({ error: "no text" }, { status: 400 });

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        messages: [{
          role: "user",
          content: `以下のLINE返信文を、トピック・要件ごとに2通の独立したメッセージに分割してください。

ルール:
・各メッセージはそれぞれ完結した文章にする
・冒頭の挨拶（「お世話になっております」等）は1通目にのみ残す
・2通目は内容から自然につながる書き出しにする
・「！！」などスモラの文体・絵文字はそのまま維持する
・「---」「===」「───」等の区切り線・セパレーターは絶対に入れない
・JSONのみ返す（説明文不要）

返信文:
${text}

出力形式:
{"msg1":"1通目の文章","msg2":"2通目の文章"}`
        }]
      })
    });

    if (!res.ok) return NextResponse.json({ error: "api error" }, { status: 500 });

    const data = await res.json() as { content?: Array<{ text?: string }> };
    const raw = (data.content?.[0]?.text ?? "").trim().replace(/```json\n?|```/g, "").trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return NextResponse.json({ error: "parse failed" }, { status: 500 });

    const result = JSON.parse(jsonMatch[0]) as { msg1?: string; msg2?: string };
    if (!result.msg1 || !result.msg2) return NextResponse.json({ error: "split failed" }, { status: 500 });

    const clean = (s: string) => s.trim().replace(/^[-─―=＝\s]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
    return NextResponse.json({ msg1: clean(result.msg1), msg2: clean(result.msg2) });
  } catch {
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
