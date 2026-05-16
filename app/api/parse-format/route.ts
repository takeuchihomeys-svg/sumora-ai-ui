import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export async function POST(req: NextRequest) {
  const { text } = await req.json();
  if (!text) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: `以下のLINEメッセージから物件検索条件を抽出してJSONで返してください。
項目が不明な場合はnullにしてください。金額は数値（円）で返してください。

抽出するJSON形式:
{
  "move_in_time": "入居時期（文字列）",
  "rent_min": 最低賃料（数値・円・null可）,
  "rent_max": 最高賃料（数値・円・null可）,
  "desired_area": "希望地域・駅（文字列）",
  "walk_minutes": 徒歩分数（数値・null可）,
  "floor_plan": "希望間取り（文字列）",
  "initial_cost_limit": 初期費用上限（数値・円・null可）,
  "building_age": 築年数上限（数値・null可）,
  "other_requests": "その他要望（文字列）"
}

LINEメッセージ:
${text}

JSONのみ返してください。マークダウンやコードブロックは不要です。`,
      },
    ],
  });

  const raw = message.content[0].type === "text" ? message.content[0].text : "";

  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return NextResponse.json({ error: "AI解析に失敗しました", raw }, { status: 500 });
  }

  return NextResponse.json(parsed);
}
