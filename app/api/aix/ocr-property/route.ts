import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 30;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""), timeout: 25_000, maxRetries: 1, defaultHeaders: { "anthropic-beta": "prompt-caching-2024-07-31" } });

// 専任物件ピッカー用: 物件スクショから物件名・号室をOCR（Sonnet 5）
const OCR_SYSTEM = `この画像から物件名と号室を読み取ってください。
必ずJSON形式のみで返してください。余分なテキスト不要。
{"prop_name": "物件名（マンション名・アパート名）", "room_no": "号室（例: 101号室）"}
号室が読み取れない場合は room_no を空文字にしてください。`;

export async function POST(req: NextRequest) {
  try {
    const { image_base64, media_type } = (await req.json()) as {
      image_base64?: string;
      media_type?: string;
    };
    if (!image_base64) {
      return NextResponse.json({ prop_name: "", room_no: "" });
    }

    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 300,
      system: [{ type: "text", text: OCR_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: (media_type ?? "image/jpeg") as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
                data: image_base64,
              },
            },
            { type: "text", text: "物件名と号室をJSONで返してください。" },
          ],
        },
      ],
    });

    const text = response.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text ?? "";
    try {
      const json = JSON.parse(
        text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim()
      ) as { prop_name?: string; room_no?: string };
      return NextResponse.json({ prop_name: json.prop_name ?? "", room_no: json.room_no ?? "" });
    } catch {
      return NextResponse.json({ prop_name: "", room_no: "" });
    }
  } catch (e) {
    console.error("[ocr-property] OCR失敗:", e);
    return NextResponse.json({ prop_name: "", room_no: "" });
  }
}
