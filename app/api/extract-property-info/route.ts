import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 30;

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
  timeout: 25_000,
  maxRetries: 1,
});

// ─── Levenshtein distance ────────────────────────────────────────────────────
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = edit distance between a[0..i-1] and b[0..j-1]
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

function stringSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.trim().toLowerCase();
  const na = norm(a);
  const nb = norm(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

// ─── POST handler ────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      image_url?: string;
      conversation_id?: string;
      property_customer_id?: string;
    };

    const { image_url, conversation_id, property_customer_id: bodyPcId } = body;

    if (!image_url) {
      return NextResponse.json({ error: "image_url は必須です" }, { status: 400 });
    }
    if (!conversation_id) {
      return NextResponse.json({ error: "conversation_id は必須です" }, { status: 400 });
    }

    // ── 1. Resolve property_customer_id ──────────────────────────────────────
    let propertyCustomerId: string | null = bodyPcId ?? null;
    if (!propertyCustomerId) {
      const { data: conv } = await supabase
        .from("conversations")
        .select("property_customer_id")
        .eq("id", conversation_id)
        .single();
      propertyCustomerId = conv?.property_customer_id ?? null;
    }

    // ── 2. OCR via Claude Haiku Vision ───────────────────────────────────────
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "url", url: image_url },
            },
            {
              type: "text",
              text: `この物件資料の画像から物件名と号室（部屋番号）を読み取ってください。

【書式パターン】
- ITANDIフォーマット: 上部に大きく「物件名 ○○○号室」と記載
- リアプロフォーマット: 左側の表に「物件名」「号室名」が別行で記載

JSONのみで返答してください：
{"property_name": "物件名（マンション名）", "room_no": "号室番号のみ（例：803、0902）"}
物件名が読み取れない場合はnullを返してください。`,
            },
          ],
        },
      ],
    });

    const raw =
      response.content.find((b): b is Anthropic.TextBlock => b.type === "text")
        ?.text ?? "{}";
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);

    let propertyName: string | null = null;
    let roomNo: string | null = null;
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as {
          property_name?: string | null;
          room_no?: string | null;
        };
        propertyName = parsed.property_name?.trim() || null;
        roomNo = parsed.room_no?.trim() || null;
      } catch {
        // OCR parse failure — return nulls
      }
    }

    // ── 3. Duplicate check ───────────────────────────────────────────────────
    let isDuplicate = false;
    let duplicateInfo: { sent_at: string; property_name: string; room_no: string } | null =
      null;

    if (propertyCustomerId && propertyName && roomNo) {
      const { data: existing } = await supabase
        .from("sent_properties")
        .select("property_name, room_no, sent_at")
        .eq("property_customer_id", propertyCustomerId)
        .order("sent_at", { ascending: false });

      if (existing && existing.length > 0) {
        for (const row of existing as Array<{ property_name: string; room_no: string; sent_at: string }>) {
          const roomMatch =
            row.room_no.trim().toLowerCase() === roomNo.toLowerCase();
          const nameSim = stringSimilarity(row.property_name, propertyName);
          // Duplicate: exact room_no match AND property_name similarity > 80%
          if (roomMatch && nameSim > 0.8) {
            isDuplicate = true;
            duplicateInfo = {
              sent_at: row.sent_at,
              property_name: row.property_name,
              room_no: row.room_no,
            };
            break;
          }
        }
      }
    }

    // ── 4. Save to sent_properties ───────────────────────────────────────────
    let insertErrorMessage: string | null = null;
    if (propertyName && roomNo && !isDuplicate) {
      const { error: insertError } = await supabase
        .from("sent_properties")
        .insert({
          property_customer_id: propertyCustomerId ?? null,
          conversation_id,
          property_name: propertyName,
          room_no: roomNo,
          image_url,
          source: "vision",
        });
      if (insertError) {
        console.error("[extract-property-info] insert error:", insertError.message);
        insertErrorMessage = insertError.message;
      }
    }

    return NextResponse.json({
      ok: true,
      property_name: propertyName,
      room_no: roomNo,
      is_duplicate: isDuplicate,
      insert_error: insertErrorMessage,
      ...(duplicateInfo ? { duplicate_info: duplicateInfo } : {}),
    });
  } catch (err) {
    console.error("[extract-property-info]", err);
    return NextResponse.json(
      { error: "物件情報の抽出に失敗しました" },
      { status: 500 }
    );
  }
}
