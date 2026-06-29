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
      system: `あなたは日本の物件資料（不動産マイソク・物件概要書）から情報を抽出するAIです。
以下の2つをJSONで返してください。

【propertyName】
物件名を「マンション名 号室番号号室」の形式で返す。
探し方：
- 資料の最上部・タイトル行に大きく書かれたマンション名（例「エスリード新大阪グランファースト 208 号室」）
- 「物件名」「マンション名」と書かれた欄の値
- 「号室名」欄がある場合はマンション名と組み合わせる（例「KTIレジデンス西中島II 202号室」）
- 号室番号の先頭ゼロは省略（0202→202）
- 不明な場合のみ null

【vacancyDate】
★最重要ルール：「現況」欄が「空室」の場合は必ず null を返す。
退去予定日は「現況が入居中（または空室でない）」かつ「退去予定日が記載されている場合」のみ返す。
- 「現況: 空室」「現況: 空室 / 7月下旬」→ null（空室物件は退去予定ではない）
- 「現況: 入居中」「退去予定: 8月下旬」→ "8月下旬"
- 「現況/入居時期」欄が「空室 / ○月○旬」形式→ 現況が空室なので null
- 「退去予定日」欄に日付がある場合のみ月日を返す（例: "8月31日"）
- 年号（2026年等）は不要・月日のみ返す

出力はJSONのみ・説明文なし：
{"propertyName":"KTIレジデンス西中島II 202号室","vacancyDate":null}`,
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
      propertyName: parsed.propertyName?.trim() || null,
      vacancyDate: parsed.vacancyDate?.trim() || null,
    });
  } catch {
    return NextResponse.json({ propertyName: null, vacancyDate: null });
  }
}
