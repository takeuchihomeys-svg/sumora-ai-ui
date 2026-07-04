import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "") });

export async function POST(req: NextRequest) {
  try {
    const { image_base64, media_type } = await req.json() as {
      image_base64: string;
      media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
    };

    if (!image_base64) {
      return NextResponse.json({ ok: false, error: "image_base64が空です" }, { status: 400 });
    }

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: media_type || "image/jpeg",
                data: image_base64,
              },
            },
            {
              type: "text",
              text: `この画像から賃貸物件の建物名と住所を読み取ってください。
物件図面・物件資料・物件サイト・LINE会話・REINS資料など様々な形式が入力されます。

【探し方の優先順位】
1. 建物名（マンション名・アパート名・物件名）
   例: 「○○マンション」「○○コーポ」「○○ハイツ」「○○レジデンス」「○○アパート」
   ※ 管理会社名・不動産会社名は除く
2. 住所（都道府県〜番地まで）
   例: 「大阪府大阪市○○区○○町1-2-3」「〒532-XXXX 大阪府…」

【注意事項】
- 物件名が部分的にしか見えない場合も読み取れる部分を記載
- 住所は丁目・番地まで可能な限り正確に読み取る
- 読み取れない場合は該当行を空欄にする

出力形式（この2行のみ返答・他の説明は不要）:
物件名: ○○マンション
住所: 大阪府○○市○○区○○町1-2-3`,
            },
          ],
        },
      ],
    });

    const text = response.content[0].type === "text" ? response.content[0].text.trim() : "";

    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const nameLine = lines.find((l) => l.startsWith("物件名:"))?.replace("物件名:", "").trim() ?? "";
    const addrLine = lines.find((l) => l.startsWith("住所:"))?.replace("住所:", "").trim() ?? "";

    const meetingPlace = [nameLine, addrLine].filter(Boolean).join(" ");

    if (!meetingPlace) {
      return NextResponse.json({ ok: false, error: "物件名・住所を読み取れませんでした" });
    }

    return NextResponse.json({ ok: true, meeting_place: meetingPlace, name: nameLine, address: addrLine });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
