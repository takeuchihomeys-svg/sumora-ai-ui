import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 30_000 });
  const body = await req.json() as { images?: Array<{ base64: string; mimeType: string }> };
  const { images = [] } = body;
  if (images.length === 0) {
    return NextResponse.json({ ok: true, site: "unknown", propertyName: "", roomNumber: "" });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contentParts: any[] = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mimeType, data: img.base64 },
  }));
  contentParts.push({
    type: "text",
    text: "この物件資料画像を見て、以下のJSONのみを返してください（他のテキスト不要）:\n{\"site\": \"realnetpro\" or \"itandi\" or \"unknown\", \"propertyName\": \"物件名\", \"roomNumber\": \"号室(数字のみ)\"}\n\n判断基準:\n- realnetpro: 資料にリアルネットプロ/realnetpro の表記がある\n- itandi: 資料にitandi/イタンジ/ITANDI BB! の表記がある\n- 不明な場合はunknown",
  });
  try {
    const res = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 200,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: contentParts }],
    });
    const textBlock = res.content.find((b) => b.type === "text");
    const raw = textBlock && textBlock.type === "text" ? textBlock.text.trim() : "{}";
    const match = raw.match(/{[\s\S]*}/);
    const data = match ? JSON.parse(match[0]) : {};
    return NextResponse.json({ ok: true, site: data.site || "unknown", propertyName: data.propertyName || "", roomNumber: data.roomNumber || "" });
  } catch {
    return NextResponse.json({ ok: true, site: "unknown", propertyName: "", roomNumber: "" });
  }
}
