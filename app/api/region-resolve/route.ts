import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

export async function POST(req: NextRequest) {
  let tokens: string[];
  try {
    const body = await req.json();
    tokens = body.tokens as string[];
    if (!Array.isArray(tokens) || tokens.length === 0) throw new Error("empty");
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const db = getDb();

  // 既にSupabaseに学習済みのものをまず返す
  const { data: cached } = await db
    .from("region_map")
    .select("token, ward")
    .in("token", tokens);

  const resolved: Record<string, string> = {};
  const cachedMap: Record<string, string> = {};
  for (const row of cached ?? []) {
    cachedMap[row.token as string] = row.ward as string;
    resolved[row.token as string] = row.ward as string;
  }

  // まだ未解決のトークンをAIで解決
  const unknown = tokens.filter((t) => !cachedMap[t]);
  if (unknown.length > 0) {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    try {
      const res = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        messages: [{
          role: "user",
          content: `あなたは大阪府の地名に精通した専門家です。
以下の地名・エリア名それぞれについて、大阪府内のどの「市区郡」に属するかを答えてください。

【ルール】
- 答えは「大阪市〇〇区」「〇〇市」「〇〇郡〇〇町」の形式で正確に
- 大阪府外の地名・不明な地名は null にする
- 駅名・路線名は null にする（地名のみ対象）
- JSONのみ返す（説明不要）

地名リスト: ${JSON.stringify(unknown)}

返すJSON形式:
{"地名1": "大阪市〇〇区", "地名2": null, ...}`,
        }],
      });

      const raw = res.content[0].type === "text" ? res.content[0].text : "";
      const match = raw.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim().match(/\{[\s\S]*\}/);
      if (match) {
        const aiResult = JSON.parse(match[0]) as Record<string, string | null>;

        // 解決できたものをSupabaseに保存
        const toInsert = Object.entries(aiResult)
          .filter(([, ward]) => ward && typeof ward === "string")
          .map(([token, ward]) => ({ token, ward: ward as string, confidence: 75, source: "ai" }));

        if (toInsert.length > 0) {
          await db.from("region_map").upsert(toInsert, { onConflict: "token" });
          for (const { token, ward } of toInsert) {
            resolved[token] = ward;
          }
        }
      }
    } catch (e) {
      console.error("[region-resolve] AI error:", e);
    }
  }

  return NextResponse.json({ resolved });
}
