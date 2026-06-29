import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: Request) {
  try {
    const { imageBase64, mediaType } = await req.json() as {
      imageBase64: string;
      mediaType: string;
    };

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 128,
      system: `あなたは物件資料から情報を抽出するAIです。
以下の2つをJSON形式で返してください。

【propertyName】
- 「物件名」「マンション名」と号室を「マンション名 ○○○号室」の形式で返す
- 例: "KTIレジデンス西中島II 202号室"
- 号室番号の先頭ゼロは省略（0202→202）
- 不明なら null

【vacancyDate】
- 「現況」「入居時期」「退去予定」の欄を確認する
- 「空室 / ○月○旬」「○月○日退去予定」など退去・空室時期が記載されていれば日付部分のみ返す
  - 例: "7月下旬" "8月31日" "8月上旬"
- 「空室」「即入居可」など今すぐ入れる場合は null を返す
- 退去予定の記載がない場合も null を返す
- 「2026年」などの西暦は含めない（「7月下旬」のみ）

出力形式（JSONのみ・説明文なし）:
{"propertyName":"...","vacancyDate":"..."}`,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
              data: imageBase64,
            },
          },
          { type: "text", text: "この物件資料から物件名と退去予定日を抽出してください。" },
        ],
      }],
    });

    const raw = (response.content[0] as { type: string; text?: string }).text?.trim() ?? "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return NextResponse.json({ propertyName: null, vacancyDate: null });
    const parsed = JSON.parse(jsonMatch[0]) as { propertyName?: string; vacancyDate?: string };

    return NextResponse.json({
      propertyName: parsed.propertyName || null,
      vacancyDate: parsed.vacancyDate || null,
    });
  } catch {
    return NextResponse.json({ propertyName: null, vacancyDate: null });
  }
}
