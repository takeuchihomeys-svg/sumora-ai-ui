import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000 });

const SUPPORTED_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      image_base64?: string;
      media_type?: string;
    };

    const imageBase64 = body.image_base64 ?? "";
    const mediaType = body.media_type || "image/jpeg";

    if (!imageBase64) {
      return NextResponse.json({ error: "画像を指定してください" }, { status: 400 });
    }
    if (!SUPPORTED_MIME.has(mediaType)) {
      return NextResponse.json(
        { error: `非対応の画像形式です（${mediaType}）。JPEG / PNG に変換して再度お試しください。` },
        { status: 400 }
      );
    }

    const systemPrompt = `あなたは不動産の物件資料（マイソク・募集図面・物件画像）を読み取るAIです。
画像から「物件名（マンション名・アパート名・建物名）」のみを抽出し、以下のJSON形式のみで返してください。他のテキストは不要です。

{"propertyName": "物件名"}

重要なルール:
- 号室・部屋番号は含めない（建物名のみ。例: 「エムズ新大阪 202号室」→「エムズ新大阪」）
- 物件名が読み取れない場合は {"propertyName": ""} を返す
- 余計な説明文・敬称・記号は付けない`;

    const res = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 300,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                data: imageBase64,
              },
            },
            { type: "text", text: "この物件資料から物件名（号室なし）をJSONで抽出してください。" },
          ],
        },
      ],
    });

    const textBlock = res.content.find((b) => b.type === "text");
    const raw = textBlock && textBlock.type === "text" ? textBlock.text.trim() : "{}";
    const match = raw.match(/\{[\s\S]*\}/);
    let propertyName = "";
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as { propertyName?: string };
        propertyName = (parsed.propertyName ?? "").trim();
      } catch {
        propertyName = "";
      }
    }

    return NextResponse.json({ ok: true, propertyName });
  } catch (err) {
    console.error("[extract-property-name]", err);
    return NextResponse.json({ error: "物件名の読み取りに失敗しました" }, { status: 500 });
  }
}
