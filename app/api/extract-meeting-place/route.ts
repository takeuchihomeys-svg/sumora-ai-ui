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
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
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
              text: "この画像から物件名と住所を読み取ってください。\n出力形式（他の文言は不要）:\n物件名: ○○マンション\n住所: 大阪府○○市○○町1-2-3",
            },
          ],
        },
      ],
    });

    const text = response.content[0].type === "text" ? response.content[0].text.trim() : "";

    // 「集合場所: 物件名 住所」に整形
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
