import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 30;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""), timeout: 25_000, maxRetries: 1 });

// 専任物件ピッカー用: 物件スクショから物件名・号室をOCR（Opus 4.8）
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
      model: "claude-opus-4-8",
      max_tokens: 300,
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
            {
              type: "text",
              text: `この画像から物件名と号室を読み取ってください。
必ずJSON形式のみで返してください。余分なテキスト不要。
{"prop_name": "物件名（マンション名・アパート名）", "room_no": "号室（例: 101号室）"}
号室が読み取れない場合は room_no を空文字にしてください。`,
            },
          ],
        },
      ],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
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
