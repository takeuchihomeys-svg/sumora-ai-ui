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
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `あなたは不動産業者のアシスタントです。
以下のテキストから物件検索条件を読み取ってJSONで返してください。

【重要】
- フォーマットが崩れていたり、書き方がバラバラでも最大限読み取る
- 「11万以内」→ rent_max: 110000 のように数値（円）に変換
- 「2ヶ月後くらい」のような曖昧な表現もそのまま文字列で入れる
- 「1DK.1LDK.2K」のように複数ある場合はそのまま文字列で入れる
- 「できるだけおさえたい」などは other_requests に入れる
- 不明な項目は null にする（絶対に省略しない）

返すJSONの形式（これ以外の形式で返さない）:
{
  "move_in_time": "入居時期（文字列またはnull）",
  "rent_min": 最低賃料の数値か null,
  "rent_max": 最高賃料の数値か null,
  "desired_area": "希望地域・駅名（文字列またはnull）",
  "walk_minutes": 徒歩分数の数値か null,
  "floor_plan": "希望間取り（文字列またはnull）",
  "initial_cost_limit": 初期費用上限の数値か null,
  "building_age": 築年数上限の数値か null,
  "other_requests": "その他要望（文字列またはnull）"
}

テキスト:
${text}

JSONのみ返してください。説明文・コードブロック・マークダウンは一切不要です。`,
      },
    ],
  });

  const raw = message.content[0].type === "text" ? message.content[0].text : "";

  // コードブロックを除去してJSONだけ取り出す
  const cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  // { } で囲まれた部分だけ抽出（前後に余計なテキストがあっても対応）
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    return NextResponse.json({ error: "AI解析に失敗しました", raw }, { status: 500 });
  }

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return NextResponse.json({ error: "AI解析に失敗しました", raw }, { status: 500 });
  }

  return NextResponse.json(parsed);
}
