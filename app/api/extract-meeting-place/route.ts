import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { sumoraLlmMarks } from "@/app/lib/llm-usage-recorder";
import { supabase } from "@/app/lib/supabase";
import { hasBanchi, materialAddressFromPdfText, pickupMatchesName, supplementMeetingAddress, MEETING_ADDRESS_NO_BANCHI_MESSAGE } from "@/app/lib/meeting-address";

export const maxDuration = 30;

// 2026-09-29 API 費用の調査: 名札だけ付ける（動きは変えない）
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""), defaultHeaders: sumoraLlmMarks("extract_meeting_place") });

const MEETING_PLACE_SYSTEM = `この画像から賃貸物件の建物名と住所を読み取ってください。
物件図面・物件資料・物件サイト・LINE会話・REINS資料など様々な形式が入力されます。

【探し方の優先順位】
1. 建物名と号室（マンション名・アパート名・物件名 + 部屋番号）
   例: 「○○マンション 302号室」「○○コーポ 101」「○○ハイツ 205号室」
   ※ 号室・部屋番号が分かる場合は必ず建物名の後ろにスペースを空けて付ける
   ※ 管理会社名・不動産会社名は除く
2. 住所（所在地・住所の欄）: 都道府県から番地・号まで最後まで
   例: 「大阪府大阪市北区神山町1-27」「大阪府大阪市北区天満3丁目1-27」「大阪府大阪市浪速区稲荷1丁目10番24号」

【住所の決まり（待ち合わせの住所。番地が無いとお客様が建物にたどり着けない）】
- 「◯丁目」で止めない。丁目の後に続く番地・号（例: 3丁目1-27 の「1-27」、10番24号）まで資料に書かれている字のまま全部書く
- 資料に書かれていない番地を推測で作らない。資料が丁目・町名までしか書いていない時は、書いてある所までをそのまま書く
- 郵便番号・建物名・号室・階は住所の行に入れない

【注意事項】
- 物件名が部分的にしか見えない場合も読み取れる部分を記載
- 号室・部屋番号は分かる場合は必ず含める（例: 302号室、101号室）
- 読み取れない場合は該当行を空欄にする

出力形式（この2行のみ返答・他の説明は不要）:
物件名: ○○マンション 302号室
住所: 大阪府○○市○○区○○町1丁目2-3`;

export async function POST(req: NextRequest) {
  try {
    const { image_base64, media_type, conversation_id } = await req.json() as {
      image_base64: string;
      media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
      /** 2026-10-01: 待ち合わせ場所の時だけ渡す。住所に番地が無い時、この会話の売上サポの行（同じ物件）の資料で補う */
      conversation_id?: string;
    };

    if (!image_base64) {
      return NextResponse.json({ ok: false, error: "image_base64が空です" }, { status: 400 });
    }

    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 300,
      thinking: { type: "disabled" }, // 2026-09-14: 省略すると思考が 300 の枠を使い、待ち合わせの抽出が空になる
      system: [{ type: "text", text: MEETING_PLACE_SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } }],
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
            { type: "text", text: "物件名と住所を読み取ってください。" },
          ],
        },
      ],
    });

    const text = response.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text?.trim() ?? "";

    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const nameLine = lines.find((l) => l.startsWith("物件名:"))?.replace("物件名:", "").trim() ?? "";
    const ocrAddress = lines.find((l) => l.startsWith("住所:"))?.replace("住所:", "").trim() ?? "";

    // 2026-10-01 竹内（YUMA「住所: 大阪府大阪市北区天満3丁目」）: 番地が無い時は同じ会話・同じ物件の資料の所在地で補う（資料の字のまま・推測で作らない）
    let addrLine = ocrAddress;
    let addressSource: "ocr" | "material" = "ocr";
    if (conversation_id && nameLine && !hasBanchi(ocrAddress)) {
      try {
        const { data } = await supabase.from("property_pickups")
          .select("property_name,pdf_text")
          .eq("conversation_id", conversation_id)
          .like("pdf_text", "%所在地%")
          .order("created_at", { ascending: false })
          .limit(200);
        const rows = (data ?? []) as Array<{ property_name: string | null; pdf_text: string | null }>;
        const materials = rows
          .filter((r) => pickupMatchesName(r.property_name, nameLine))
          .map((r) => materialAddressFromPdfText(r.pdf_text))
          .filter(Boolean);
        const sup = supplementMeetingAddress(ocrAddress, materials);
        if (sup) { addrLine = sup; addressSource = "material"; }
      } catch (e) {
        console.warn("[extract-meeting-place] 資料で住所を補えず:", e);
      }
    }
    // 住所が入っているのに番地が無い時は画面に知らせる（空の時は今のまま）
    const addressProblem = addrLine && !hasBanchi(addrLine) ? MEETING_ADDRESS_NO_BANCHI_MESSAGE : null;

    const meetingPlace = [nameLine, addrLine].filter(Boolean).join(" ");

    if (!meetingPlace) {
      return NextResponse.json({ ok: false, error: "物件名・住所を読み取れませんでした" });
    }

    return NextResponse.json({ ok: true, meeting_place: meetingPlace, name: nameLine, address: addrLine, address_source: addressSource, address_ocr: ocrAddress, address_problem: addressProblem });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
