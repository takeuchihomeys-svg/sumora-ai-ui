import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;

const GUARANTOR_COMPANY_LIST = `【保証会社タイプ一覧（独立系が最も審査緩い）】
信販系（最も厳しい）: エポスカード、オリコフォレントインシュア、アプラス、ジャックス、フォーレント
LICC系（一般的）: ジェイリース（J-Lease）、全保連（全国賃貸保証業協会）、JID、全国保証、アート・プランニング、青山ライフデザイン、保証ベース
独立系（最も審査緩い）: 日本セーフティー、エルズサポート、Casa（カーサ）、フォーシーズンズ、ルームバンク（ルームバンクインシュア）、いえらぶ保証、スマートタカミ、イントラスト、レジデンシャルパートナーズ、株式会社日本トラストコーポレーション（日本トラスト）`;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ ok: false, error: "ファイルが見つかりません" }, { status: 400 });
    }

    // ファイルサイズチェック（10MB上限）
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json({ ok: false, error: "ファイルサイズが大きすぎます（10MB以下にしてください）" }, { status: 400 });
    }

    // MIMEタイプチェック
    const supportedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    const rawMimeType = file.type || "image/jpeg";
    if (!supportedTypes.includes(rawMimeType)) {
      return NextResponse.json({ ok: false, error: "対応フォーマットはJPEG・PNG・WebP・GIFのみです" }, { status: 400 });
    }

    // ファイルをbase64に変換
    const arrayBuffer = await file.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString("base64");

    // MIMEタイプを取得（デフォルト: image/jpeg）
    const mediaType = rawMimeType as
      | "image/jpeg"
      | "image/png"
      | "image/gif"
      | "image/webp";

    const system = `賃貸物件資料の画像から保証会社情報を抽出してください。
${GUARANTOR_COMPANY_LIST}

画像を分析し、以下のJSON形式のみで返答してください（説明不要）：
{
  "property_name": "物件名（資料から読み取った正確な名前・見当たらなければ空文字）",
  "company_name": "保証会社名（資料から読み取った正確な名前・見当たらなければ空文字）",
  "guarantor_type": "独立系|LICC系|信販系|不明"
}

判定ルール:
- 会社名が上記リストに一致する場合 → 対応するタイプを返す
- 会社名が不明または上記リストにない場合 → "不明"
- 物件名は「物件名」「建物名」「マンション名」等のラベルの横に書かれた名前`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        system,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "この物件資料から物件名・保証会社名・タイプを特定してください。",
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: base64Data,
                },
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[extract-guarantor-info] Claude error:", errText);
      return NextResponse.json({ ok: false, error: "Claude API エラー" }, { status: 500 });
    }

    const data = await res.json() as { content?: Array<{ text?: string }> };
    const rawText = data.content?.[0]?.text?.trim() || "";

    // JSONを抽出してパース
    let propertyName = "";
    let companyName = "";
    let guarantorType = "不明";

    try {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as {
          property_name?: string;
          company_name?: string;
          guarantor_type?: string;
        };
        propertyName = parsed.property_name || "";
        companyName = parsed.company_name || "";
        guarantorType = parsed.guarantor_type || "不明";
      }
    } catch {
      console.error("[extract-guarantor-info] JSON parse error, raw:", rawText);
    }

    return NextResponse.json({
      ok: true,
      property_name: propertyName,
      company_name: companyName,
      guarantor_type: guarantorType,
    });
  } catch (err) {
    console.error("[extract-guarantor-info] error:", err);
    return NextResponse.json({ ok: false, error: "処理に失敗しました" }, { status: 500 });
  }
}
