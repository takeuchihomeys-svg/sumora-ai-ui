import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { text } = await req.json() as { text: string };
  if (!text) return NextResponse.json({ ok: false, error: "text required" }, { status: 400 });

  const apiKey = process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "");
  if (!apiKey) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, { status: 500 });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{
        role: "user",
        content: `以下はお客さんからのLINE新着要望ログです。
ここから更新したい物件条件を読み取り、JSONで返してください。

【ルール】
- 言及されていない項目は null にする
- 家賃は円単位（例: 8万 → 80000）
- 徒歩分数は数値（例: 15分以内 → 15）
- 築年数は数値（例: 20年以内 → 20）
- 広さは㎡の数値（例: 30㎡以上 → 30）
- 初期費用は円単位

返すJSONのみ（説明不要）:
{
  "desired_area": null,
  "floor_plan": null,
  "rent_min": null,
  "rent_max": null,
  "walk_minutes": null,
  "move_in_time": null,
  "building_age": null,
  "floor_area_min": null,
  "initial_cost_limit": null,
  "preferences": null,
  "ng_points": null,
  "other_requests": null
}

新着要望ログ:
${text}`,
      }],
    }),
  });

  if (!res.ok) return NextResponse.json({ ok: false, error: "AI error" }, { status: 500 });

  const data = await res.json() as { content?: Array<{ text: string }> };
  const raw = data.content?.[0]?.text ?? "";
  const match = raw.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim().match(/\{[\s\S]*\}/);
  if (!match) return NextResponse.json({ ok: false, error: "parse error" }, { status: 500 });

  const parsed = JSON.parse(match[0]) as Record<string, unknown>;

  // 家賃バリデーション（万円単位誤りを自動修正）
  for (const f of ["rent_min", "rent_max", "initial_cost_limit"]) {
    const v = parsed[f];
    if (typeof v === "number" && v > 0 && v <= 300) parsed[f] = v * 10000;
  }

  return NextResponse.json({ ok: true, parsed });
}
