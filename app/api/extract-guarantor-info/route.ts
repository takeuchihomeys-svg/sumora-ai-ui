import { NextRequest, NextResponse } from "next/server";
import { GUARANTOR_OCR_NAME_HINT, resolveGuarantor, guarantorTypeJa } from "@/app/lib/guarantor-companies";

export const maxDuration = 30;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;

// 2026-09-26 竹内さん決定（保証会社の知識をマスタ1本に）: 旧はここに種類つきの会社一覧のコピーを持ち、種類を LLM に判定させていた
//   （マスタと一覧が食い違う・マスタに無い会社の種類を推測する）。LLM には会社名の読み取りだけをさせ、種類は読み取った会社名から
//   app/lib/guarantor-companies.ts の resolveGuarantor で決める（マスタに無い会社は「不明」＝種類を推測しない）

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
${GUARANTOR_OCR_NAME_HINT}

画像を分析し、以下のJSON形式のみで返答してください（説明不要）：
{
  "property_name": "物件名（資料から読み取った正確な名前・見当たらなければ空文字）",
  "company_name": "保証会社名（資料に書かれている会社名をそのまま・見当たらなければ空文字）"
}

ルール:
- 保証会社名は資料に書かれている物だけ。「保証会社: 必須」「保証会社利用」のように社名が無ければ空文字（推測しない）
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

    const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
    const rawText = data.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text?.trim() || "";

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
        };
        propertyName = parsed.property_name || "";
        // 種類はマスタで決める（マスタに無い会社は「不明」・会社名は正規名に名寄せ）
        const resolved = resolveGuarantor(parsed.company_name || "");
        companyName = resolved.name;
        guarantorType = companyName ? guarantorTypeJa(resolved.type) : "不明";
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
