import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { sumoraLlmMarks } from "@/app/lib/llm-usage-recorder";
import { callDeepSeekRead, VISION_ALT_MODEL_DEFAULT } from "@/app/lib/vision-alt-provider";
import { parseOcrPropertyJson, ocrPropertyProvider } from "@/app/lib/ocr-property-parse";

export const maxDuration = 30;

// 2026-09-29 API 費用の調査: 名札だけ付ける（動きは変えない）
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""), timeout: 25_000, maxRetries: 1, defaultHeaders: { "anthropic-beta": "prompt-caching-2024-07-31", ...sumoraLlmMarks("ocr_property") } });

// 専任物件ピッカー用: 物件スクショから物件名・号室を読む。
// 2026-10-08 竹内「AIX の物件資料の読み取り DeepSeek にすることはできるか」→ DeepSeek の口を用意（推論なし・温度0・1回だけ読み直し）。ただし同じ8枚で号室を 2/8 読み違えたので既定は Claude のまま（ocr-property-parse.ts）。
//   物件の読み取りは DeepSeek で行い Claude に倒さない決まり（vision-alt-provider.callDeepSeekRead・09-25 竹内）に合わせる。
//   DeepSeek を試す: OCR_PROPERTY_PROVIDER=deepseek（読めなければ空で返す＝スタッフが手で入れる）
const OCR_SYSTEM = `この画像から物件名と号室を読み取ってください。
必ずJSON形式のみで返してください。余分なテキスト不要。
{"prop_name": "物件名（マンション名・アパート名）", "room_no": "号室（例: 101号室）"}
号室が読み取れない場合は room_no を空文字にしてください。`;
const OCR_USER = "物件名と号室をJSONで返してください。";
const OCR_MAX_TOKENS = 300;
const OCR_TIMEOUT_MS = 20_000;

export async function POST(req: NextRequest) {
  try {
    const { image_base64, media_type } = (await req.json()) as {
      image_base64?: string;
      media_type?: string;
    };
    if (!image_base64) {
      return NextResponse.json({ prop_name: "", room_no: "" });
    }
    const mediaType = (media_type ?? "image/jpeg") as "image/jpeg" | "image/png" | "image/webp" | "image/gif";

    if (ocrPropertyProvider() === "deepseek") {
      const t0 = Date.now();
      const model = (process.env.VISION_ALT_MODEL ?? VISION_ALT_MODEL_DEFAULT).trim();
      const content = [
        { type: "text", text: OCR_USER },
        { type: "image_url", image_url: { url: `data:${mediaType};base64,${image_base64}` } },
      ];
      const read = await callDeepSeekRead(OCR_SYSTEM, content, { maxTokens: OCR_MAX_TOKENS, timeoutMs: OCR_TIMEOUT_MS },
        (t) => parseOcrPropertyJson(t),
        { retryIf: (elapsed) => OCR_TIMEOUT_MS + 5_000 - elapsed >= 3_000, retryTimeoutMs: (elapsed) => Math.max(3_000, OCR_TIMEOUT_MS + 5_000 - elapsed) });
      void import("@/app/lib/llm-usage-recorder").then(({ recordAltUsage }) => {
        for (const a of read.attempts) {
          recordAltUsage({
            model: a.res?.model ?? model, action: "ocr_property", conversationId: null,
            usage: { input_tokens: a.res?.usage.cacheMiss ?? 0, output_tokens: a.res?.usage.output ?? 0, cache_read_input_tokens: a.res?.usage.cacheHit ?? 0 },
            status: a.res ? 200 : 0, errorType: a.ok ? null : a.res ? "empty_or_unparsable" : "no_response",
            durationMs: a.ms, sysHead: (a.retry ? "【読み直し】" : "") + OCR_SYSTEM.slice(0, 180), sysKeyFull: null, maxTokens: OCR_MAX_TOKENS,
          });
        }
      }).catch(() => {});
      if (read.failed) console.warn("[ocr-property] DeepSeek で読めなかった（空で返す）", Date.now() - t0, "ms");
      return NextResponse.json(read.value ?? { prop_name: "", room_no: "" });
    }

    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: OCR_MAX_TOKENS,
      thinking: { type: "disabled" }, // 2026-09-14: 省略すると思考が 300 の枠を使い、読み取り結果が空・途中で切れる
      system: [{ type: "text", text: OCR_SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: image_base64 } },
            { type: "text", text: OCR_USER },
          ],
        },
      ],
    });

    const text = response.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text ?? "";
    return NextResponse.json(parseOcrPropertyJson(text) ?? { prop_name: "", room_no: "" });
  } catch (e) {
    console.error("[ocr-property] OCR失敗:", e);
    return NextResponse.json({ prop_name: "", room_no: "" });
  }
}
