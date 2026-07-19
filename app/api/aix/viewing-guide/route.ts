import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const SONNET_MODEL = "claude-sonnet-4-6";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      action: "analyze" | "adapt" | "ocr_name";
      image?: { base64: string; mediaType: string };
      properties?: Array<{ name: string; roomNumber: string }>;
      propertyName?: string;
      roomNumber?: string;
      customerName?: string;
      baseText?: string;
      recentMessages?: Array<{ sender: string; text: string }>;
    };

    const {
      action,
      image,
      properties: inputProperties,
      propertyName = "",
      roomNumber = "",
      customerName = "お客様",
      baseText = "",
      recentMessages = [],
    } = body;

    if (action === "analyze") {
      // 物件リスト構築（複数対応）
      const propList = (inputProperties && inputProperties.length > 0)
        ? inputProperties.filter(p => p.name.trim())
        : propertyName ? [{ name: propertyName, roomNumber }] : [];

      let status: "available" | "vacating" = "available";
      let vacateDate = "";

      // 単一物件+画像の場合のみ空室状況チェック
      if (propList.length <= 1 && image?.base64) {
        const statusPrompt = `あなたは賃貸物件の空室状況を読み取るアシスタントです。
送られた物件写真を見て、「内覧可能（空室・即入居）」か「退去予定（退去予定日あり）」かを判定してください。

【出力フォーマット（JSONのみ）】
{ "status": "available" | "vacating", "vacate_date": "退去予定日（例：7月末、8月上旬、9月1日）または空文字" }
- available: 空室・即入居可
- vacating: 退去予定・現在入居中
- 判定できない場合は "available" とする`;

        const statusRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: HAIKU_MODEL,
            max_tokens: 256,
            system: statusPrompt,
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

        if (statusRes.ok) {
          const statusData = await statusRes.json() as { content?: Array<{ text?: string }> };
          const statusRaw = (statusData.content?.[0]?.text?.trim() ?? "").replace(/```json\n?|```/g, "").trim();
          try {
            const parsed = JSON.parse(statusRaw) as { status?: string; vacate_date?: string };
            status = parsed.status === "vacating" ? "vacating" : "available";
            vacateDate = parsed.vacate_date ?? "";
          } catch {
            // default to available
          }
        }
      }

      // 物件ラベル生成
      const propLabels = propList.map(p =>
        [p.name.trim(), p.roomNumber?.trim() ? p.roomNumber.trim() + "号室" : ""].filter(Boolean).join(" ")
      );
      const propStr = propLabels.join("と");

      let text = "";
      if (status === "available") {
        if (propStr) {
          text = `${propStr}現在ご内覧可能ですので\n${customerName}さんご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！`;
        } else {
          text = `${customerName}さんご都合よろしいお日にちにご案内させて頂きます😊！！`;
        }
      } else {
        text = `${propStr ? propStr + "についてですが、" : ""}${vacateDate}退去予定のお部屋となっております！！\n${vacateDate}以降にご案内可能ですので${customerName}さんご都合よろしいお日にちにご案内させて頂きます😊！！`;
      }

      return NextResponse.json({ ok: true, status, vacateDate, text });
    }

    if (action === "ocr_name") {
      if (!image?.base64) {
        return NextResponse.json({ ok: false, error: "no image" }, { status: 400 });
      }
      const ocrPrompt = `この賃貸物件の資料画像から物件名と号室を読み取ってください。

【出力フォーマット（JSONのみ）】
{ "property_name": "物件名（例：ヴェローナI）", "room_number": "号室の数字のみ（例：206）" }
- 物件名が読み取れない場合は空文字
- 号室が読み取れない場合は空文字
- 説明や補足は一切不要`;

      const ocrRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: HAIKU_MODEL,
          max_tokens: 256,
          system: ocrPrompt,
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
              { type: "text" as const, text: "物件名と号室をJSONで返してください。" },
            ],
          }],
        }),
      });

      if (!ocrRes.ok) {
        return NextResponse.json({ ok: true, propertyName: "", roomNumber: "" });
      }
      const ocrData = await ocrRes.json() as { content?: Array<{ text?: string }> };
      const ocrRaw = (ocrData.content?.[0]?.text?.trim() ?? "").replace(/```json\n?|```/g, "").trim();
      try {
        const parsed = JSON.parse(ocrRaw) as { property_name?: string; room_number?: string };
        return NextResponse.json({ ok: true, propertyName: parsed.property_name ?? "", roomNumber: parsed.room_number ?? "" });
      } catch {
        return NextResponse.json({ ok: true, propertyName: "", roomNumber: "" });
      }
    }

    if (action === "adapt") {
      const conversationText = recentMessages
        .slice(-10)
        .map(m => `${m.sender === "customer" ? "お客様" : "スタッフ"}: ${m.text}`)
        .join("\n");

      // スタッフの直近メッセージに絵文字があれば絵文字スタイルを合わせる
      const staffUsesEmoji = recentMessages
        .slice(-10)
        .filter(m => m.sender !== "customer")
        .some(m => /\p{Emoji_Presentation}/u.test(m.text));
      const emojiRule = staffUsesEmoji
        ? "- 絵文字はこちらの会話に合わせて自然に使う"
        : "- 絵文字は控えめ（1〜2個まで）";

      // H1: 学習済み適応改善ルール（内覧系カテゴリ）を取得してプロンプトに注入
      // ※ analyze-template-modifications が template_category（日本語）で蓄積するため
      //   内覧系の実カテゴリ名 + 将来用の英語キーの両方をカバーする
      let adaptRuleNote = "";
      try {
        const { data: adaptRules } = await supabase
          .from("adaptation_improvement_rules")
          .select("rule_text")
          .in("category", ["viewing_invite", "内覧へ！【AIX】", "内覧【AIX】", "挨拶【AIX】", "greeting_viewing"])
          .eq("is_active", true)
          .order("example_count", { ascending: false })
          .order("confidence", { ascending: false })
          .limit(5);
        if (adaptRules?.length) {
          adaptRuleNote =
            "\n\n【過去の適応改善ルール（スタッフ修正から学習・必ず守る）】\n" +
            adaptRules.map(r => `・${r.rule_text as string}`).join("\n");
        }
      } catch {
        // ルール取得失敗時は注入なしで続行（adapt自体は成立させる）
      }

      const systemPrompt = `あなたはスモラ賃貸仲介の営業担当です。
会話の流れに合わせて、内覧誘導メッセージを自然につなげて書き直してください。

【スモラの文体ルール】
- 語尾に「！！」を多用する
${emojiRule}
- 敬語だが親しみやすい
- お客様の気持ち・温度感に合わせる
- 本文のみ出力（説明文は一切不要）${adaptRuleNote}`;

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
