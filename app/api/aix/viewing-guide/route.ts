import { NextRequest, NextResponse } from "next/server";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const SONNET_MODEL = "claude-sonnet-4-6";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      action: "analyze" | "adapt";
      image?: { base64: string; mediaType: string };
      propertyName?: string;
      roomNumber?: string;
      customerName?: string;
      baseText?: string;
      recentMessages?: Array<{ sender: string; text: string }>;
    };

    const {
      action,
      image,
      propertyName = "",
      roomNumber = "",
      customerName = "お客様",
      baseText = "",
      recentMessages = [],
    } = body;

    if (action === "analyze") {
      let status: "available" | "vacating" = "available";
      let vacateDate = "";

      if (image?.base64) {
        const systemPrompt = `あなたは賃貸物件の空室状況を読み取るアシスタントです。
送られた物件写真を見て、「内覧可能（空室・即入居）」か「退去予定（退去予定日あり）」かを判定してください。

【出力フォーマット（JSONのみ）】
{ "status": "available" | "vacating", "vacate_date": "退去予定日（例：7月末、8月上旬、9月1日）または空文字" }
- available: 空室・即入居可
- vacating: 退去予定・現在入居中
- 判定できない場合は "available" とする`;

        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: HAIKU_MODEL,
            max_tokens: 256,
            system: systemPrompt,
            messages: [{
              role: "user",
              content: [
                {
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: image.mediaType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
                    data: image.base64,
                  },
                },
                { type: "text" as const, text: "この物件の空室状況をJSONで返してください。" },
              ],
            }],
          }),
        });

        if (res.ok) {
          const data = await res.json() as { content?: Array<{ text?: string }> };
          const raw = (data.content?.[0]?.text?.trim() ?? "").replace(/```json\n?|```/g, "").trim();
          try {
            const parsed = JSON.parse(raw) as { status?: string; vacate_date?: string };
            status = parsed.status === "vacating" ? "vacating" : "available";
            vacateDate = parsed.vacate_date ?? "";
          } catch {
            // default to available
          }
        }
      }

      const propLabel = [propertyName, roomNumber ? roomNumber + "号室" : ""].filter(Boolean).join(" ");
      let text = "";
      if (status === "available") {
        text = `${propLabel ? propLabel + "ですが、" : ""}${customerName}さんお気に召されていましたらご都合よろしいお日にちにご案内させていただきます！！\n一度ご内覧如何でしょうか！！`;
      } else {
        text = `${propLabel ? propLabel + "ですが、" : ""}${vacateDate}退去予定ですので\n${customerName}さんおきにめされていましたら${vacateDate}以降でご都合よろしいお日にちにお部屋ご案内させていただきます！！`;
      }

      return NextResponse.json({ ok: true, status, vacateDate, text });
    }

    if (action === "adapt") {
      const conversationText = recentMessages
        .slice(-10)
        .map(m => `${m.sender === "customer" ? "お客様" : "スタッフ"}: ${m.text}`)
        .join("\n");

      const systemPrompt = `あなたはスモラ賃貸仲介の営業担当です。
会話の流れに合わせて、内覧誘導メッセージを自然につなげて書き直してください。

【スモラの文体ルール】
- 語尾に「！！」を多用する
- 絵文字は控えめ（1〜2個まで）
- 敬語だが親しみやすい
- お客様の気持ち・温度感に合わせる
- 本文のみ出力（説明文は一切不要）`;

      const userPrompt = `【直近の会話】\n${conversationText || "（なし）"}\n\n【内覧誘導ベースメッセージ】\n${baseText}\n\n会話の流れに合わせて内覧誘導メッセージを書き直してください。`;

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: SONNET_MODEL,
          max_tokens: 512,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });

      if (!res.ok) {
        return NextResponse.json({ ok: true, text: baseText });
      }

      const data = await res.json() as { content?: Array<{ text?: string }> };
      const adaptedText = data.content?.[0]?.text?.trim() ?? baseText;
      return NextResponse.json({ ok: true, text: adaptedText });
    }

    return NextResponse.json({ ok: false, error: "invalid action" }, { status: 400 });
  } catch {
    return NextResponse.json({ ok: false, error: "server error" }, { status: 500 });
  }
}
