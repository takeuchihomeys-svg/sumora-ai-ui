import { NextRequest, NextResponse } from "next/server";

const PARSE_PROMPT = (text: string) => `以下はお客さんからのLINE新着要望ログです。
ここから更新したい物件条件を読み取り、JSONで返してください。

【ルール】
- 言及されていない項目は null にする
- 家賃は円単位（例: 8万 → 80000）
- 徒歩分数は数値（例: 15分以内 → 15）
- 広さは㎡の数値（例: 30㎡以上 → 30）
- 初期費用は円単位

【家賃と間取りの区別 — 最重要】
- 「7～8」「7〜8」「6〜7」のように数字だけの範囲 → 家賃の万円表記。rent_min/rent_max に変換する（例: 「7〜8」→ rent_min: 70000, rent_max: 80000）
- 「1LDK」「2K」「1R」のようにアルファベットが必ず付く場合のみ floor_plan として読み取る
- 数字だけの範囲は絶対に floor_plan にしない

【築年数ルール】
- 「出来るだけ浅め」「できるだけ浅め」「築浅希望」「なるべく新しい」「浅め」「新しめ」→ building_age は null のまま、preferences に「築浅希望」と入れる
- 「20年以内」「築10年以内」のように明確な数値上限がある場合のみ building_age に数値を入れる

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
${text}`;

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    text?: string;
    imageBase64?: string;
    imageMediaType?: string;
  };

  const apiKey = process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "");
  if (!apiKey) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, { status: 500 });

  // ① 画像がある場合: Vision で条件テキストを抽出してからパース
  if (body.imageBase64) {
    // Step1: 画像から条件テキストを読み取る
    const extractRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: (body.imageMediaType ?? "image/jpeg") as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
                data: body.imageBase64,
              },
            },
            {
              type: "text",
              text: `このスクリーンショットから、お客さんの物件希望条件を読み取ってください。
LINEの会話・条件メモ・物件検索条件など、どのような形式でも対応します。

【読み取り対象】エリア・間取り・家賃・駅徒歩・広さ・築年数・入居時期・初期費用・こだわり・NG条件など
【出力形式】条件を箇条書きで日本語でまとめてください（JSON不要）。
読み取れない場合は「条件が読み取れませんでした」とだけ返してください。`,
            },
          ],
        }],
      }),
    });

    if (!extractRes.ok) return NextResponse.json({ ok: false, error: "Vision error" }, { status: 500 });

    const extractData = await extractRes.json() as { content?: Array<{ text: string }> };
    const extractedText = extractData.content?.[0]?.text?.trim() ?? "";

    if (!extractedText || extractedText.includes("読み取れませんでした")) {
      return NextResponse.json({ ok: false, error: "画像から条件を読み取れませんでした" }, { status: 422 });
    }

    // Step2: 抽出テキストを構造化パース（既存フローと同じ）
    const parseRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        messages: [{ role: "user", content: PARSE_PROMPT(extractedText) }],
      }),
    });

    if (!parseRes.ok) return NextResponse.json({ ok: false, error: "AI error" }, { status: 500 });

    const parseData = await parseRes.json() as { content?: Array<{ text: string }> };
    const raw = parseData.content?.[0]?.text ?? "";
    const match = raw.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim().match(/\{[\s\S]*\}/);
    if (!match) return NextResponse.json({ ok: false, error: "parse error" }, { status: 500 });

    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    for (const f of ["rent_min", "rent_max", "initial_cost_limit"]) {
      const v = parsed[f];
      if (typeof v === "number" && v > 0 && v <= 300) parsed[f] = v * 10000;
    }

    // extracted_text も返す（フロントでテキスト欄に自動セット）
    return NextResponse.json({ ok: true, parsed, extracted_text: extractedText });
  }

  // ② テキストのみの場合: 従来フロー
  if (!body.text?.trim()) return NextResponse.json({ ok: false, error: "text or image required" }, { status: 400 });

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
      messages: [{ role: "user", content: PARSE_PROMPT(body.text) }],
    }),
  });

  if (!res.ok) return NextResponse.json({ ok: false, error: "AI error" }, { status: 500 });

  const data = await res.json() as { content?: Array<{ text: string }> };
  const raw = data.content?.[0]?.text ?? "";
  const match = raw.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim().match(/\{[\s\S]*\}/);
  if (!match) return NextResponse.json({ ok: false, error: "parse error" }, { status: 500 });

  const parsed = JSON.parse(match[0]) as Record<string, unknown>;
  for (const f of ["rent_min", "rent_max", "initial_cost_limit"]) {
    const v = parsed[f];
    if (typeof v === "number" && v > 0 && v <= 300) parsed[f] = v * 10000;
  }

  return NextResponse.json({ ok: true, parsed });
}
