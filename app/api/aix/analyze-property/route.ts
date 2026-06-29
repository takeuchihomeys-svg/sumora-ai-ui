import { NextRequest, NextResponse } from "next/server";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";

export async function POST(request: NextRequest) {
  try {
    const { images } = await request.json() as {
      images: Array<{ base64: string; mediaType: string }>;
    };

    if (!images || images.length === 0) {
      return NextResponse.json({ ok: true, vacating_note: "" });
    }

    const imageContent = images.map((img) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: img.mediaType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
        data: img.base64,
      },
    }));

    const system = `あなたは賃貸仲介の物件資料を読み取るアシスタントです。
送られた物件資料画像を見て、各物件の「物件名」と「空室状況」を読み取ってください。

【読み取り対象】
- 物件名（マンション名・アパート名）
- 空室状況：「空室（即入居可）」か「退去予定（退去予定日 or 退去予定月）」か

【出力フォーマット（JSON）】
必ず以下のJSON配列のみを出力してください（説明文は一切不要）：
[
  { "name": "物件名", "status": "vacant" | "scheduled", "move_out": "退去予定日（例：6月末、7月2日）" },
  ...
]
- status: "vacant" = 空室・即入居可, "scheduled" = 退去予定あり
- move_out: scheduled の場合のみ記載（vacant の場合は空文字）
- 退去予定が読み取れない場合は "vacant" とする`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 512,
        system,
        messages: [
          {
            role: "user",
            content: [
              ...imageContent,
              { type: "text", text: "上記の物件資料から物件名と空室状況をJSON配列で返してください。" },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      return NextResponse.json({ ok: true, vacating_note: "" });
    }

    const data = await res.json();
    const raw = (data.content?.[0]?.text?.trim() || "").replace(/```json\n?|```/g, "").trim();

    let properties: Array<{ name: string; status: string; move_out: string }> = [];
    try {
      properties = JSON.parse(raw);
    } catch {
      return NextResponse.json({ ok: true, vacating_note: "" });
    }

    // 実データの文体パターンに合わせてテキスト生成
    // 退去予定: "◎〇〇は〇月退去予定となりますのでお部屋ご案内出来ない形となります！！"
    // 空室: 記載しない（案内できる物件は通常通り送るだけ）
    const scheduledLines = properties
      .filter((p) => p.status === "scheduled" && p.name)
      .map((p) => {
        const moveOut = (p.move_out || "").replace(/^\d{4}年/, "");
        return `◎${p.name}は${moveOut ? moveOut + "退去予定" : "退去予定"}となりますのでお部屋ご案内出来ない形となります！！`;
      });

    const vacantLines = properties
      .filter((p) => p.status === "vacant" && p.name)
      .map((p) => `◎${p.name}は空室でご内覧出来ます！！`);

    const vacating_note = [...scheduledLines, ...vacantLines].join("\n");

    return NextResponse.json({ ok: true, vacating_note, properties });
  } catch {
    return NextResponse.json({ ok: true, vacating_note: "" });
  }
}
