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
      max_tokens: 64,
      system: `あなたは物件資料から退去予定日・現況を抽出する専門AIです。
抽出ルール：
- 「現況」「入居可能時期」「退去予定」の欄を探す
- 「◯月◯日退去予定」「◯月上旬/中旬/下旬退去予定」「即入居可」「空室」等を確認する
- 退去予定日が記載されていれば「8月下旬」「7月31日」のように日付部分のみ返す
- 「空室」「即入居可」「即入居」等の場合は「空室」と返す
- 退去予定の記載がなければ「なし」と返す
- 説明文・改行・記号は一切付けず、抽出した値のみ1行で返す`,
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
          { type: "text", text: "この物件資料から退去予定日または現況を抽出してください。" },
        ],
      }],
    });

    const raw = (response.content[0] as { type: string; text?: string }).text?.trim() ?? "";
    // 「なし」「空室」「即入居可」はそのまま、それ以外は退去予定日として返す
    const vacancyDate = raw === "なし" || raw === "" ? null : raw;

    return NextResponse.json({ vacancyDate });
  } catch {
    return NextResponse.json({ vacancyDate: null });
  }
}
