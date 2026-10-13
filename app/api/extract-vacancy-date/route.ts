import Anthropic from "@anthropic-ai/sdk";
import { sumoraLlmMarks } from "@/app/lib/llm-usage-recorder";
import { NextResponse } from "next/server";
import { extractVacancyDateSystem, parseExtractVacancyResponse, EXTRACT_VACANCY_USER_TEXT } from "@/app/lib/extract-vacancy-date-prompt";
import { sheetVacancyFieldsEnabled } from "@/app/lib/sheet-vacancy";

// 2026-09-29 API 費用の調査: 名札だけ付ける（動きは変えない）
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, defaultHeaders: sumoraLlmMarks("extract_vacancy_date") });

export async function POST(req: Request) {
  try {
    const { imageBase64, mediaType } = await req.json() as {
      imageBase64: string;
      mediaType: string;
    };

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      // 新は欄を書き写す（数行）ので 128 では切れる。旧（SHEET_VACANCY_FIELDS=off）は 128 のまま
      max_tokens: sheetVacancyFieldsEnabled() ? 600 : 128,
      // 2026-10-13: Haiku は欄を書き写すだけ・退去予定日は sheet-vacancy が欄で決める（app/lib/extract-vacancy-date-prompt.ts・SHEET_VACANCY_FIELDS=off で旧）
      system: extractVacancyDateSystem(),
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
          { type: "text", text: sheetVacancyFieldsEnabled() ? EXTRACT_VACANCY_USER_TEXT : "この物件資料から物件名と退去予定日を抽出してください。" },
        ],
      }],
    });

    const raw = response.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text?.trim() ?? "";
    const parsed = parseExtractVacancyResponse(raw);
    if (parsed.fields) console.log(JSON.stringify({ tag: "extract-vacancy-date:fields", fields: parsed.fields, vacancyDate: parsed.vacancyDate, from: parsed.vacancyFrom ?? null }));
    return NextResponse.json({ propertyName: parsed.propertyName, vacancyDate: parsed.vacancyDate });
  } catch {
    return NextResponse.json({ propertyName: null, vacancyDate: null });
  }
}
