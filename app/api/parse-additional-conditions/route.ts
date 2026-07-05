import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

const PARSE_PROMPT = (text: string) => `以下はお客さんからの条件テキストです。
ここから更新したい物件条件を読み取り、JSONで返してください。

【駅・沿線リストの取り扱い — 最優先】
- テキストに「設定中の駅」「設定中の沿線」「駅:」「沿線:」というセクションがある場合:
  → そのセクション以下の全ての駅名・沿線名を desired_area に「・」区切りで全て入れる（1件も省略しない）
- 例: 「### 設定中の駅\nなかもず・新金岡・北花田・あびこ」→ desired_area: "なかもず・新金岡・北花田・あびこ"
- 「・」「、」で区切られた日本の駅名・路線名が5件以上並んでいる場合も、全て desired_area に入れる
  例: 「なかもず・新金岡・北花田・あびこ・長居・西田辺・昭和町・天王寺」→ desired_area: "なかもず・新金岡・北花田・あびこ・長居・西田辺・昭和町・天王寺"
- 何十駅あっても絶対に省略しない・全件列挙する

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
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
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

【物件検索サイト（リアプロ・itandi・REINS等）の駅・沿線選択画面の場合 — 最優先】
画面右側に「設定中の沿線」「設定中の駅」というパネルがある場合:
- そこに列挙されているテキストを全て一字一句正確に書き出す
- 「・」「、」「改行」で区切られた駅名・沿線名を全て拾う
- 1駅も漏らさず全て書き出すこと（省略・「など」は禁止）

右パネルがない・読みにくい場合（駅ボタンがメインの画面）:
- 他のボタンと視覚的に違う（背景が濃い・オレンジ/青/緑に塗りつぶし・チェックあり）ボタンだけ読む
- 全ての駅ボタンを読むのではなく、明らかに選択状態のものだけ
- 家賃の入力欄・上限下限があれば読む

【その他の画像】
- LINEの会話画面: お客さんのメッセージから条件を読む
- 手書きメモ・条件表: そのまま読む

【出力形式】
- 箇条書きで日本語のみ（JSON不要）
- 駅が複数ある場合は全て列挙する（例: 「駅: 西大路、大阪、梅田、天王寺」）
- 読み取れない場合のみ「条件が読み取れませんでした」と返す`,
            },
          ],
        }],
      }),
      signal: AbortSignal.timeout(30_000),
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
      signal: AbortSignal.timeout(30_000),
    });

    if (!parseRes.ok) return NextResponse.json({ ok: false, error: "AI error" }, { status: 500 });

    const parseData = await parseRes.json() as { content?: Array<{ text: string }> };
    const raw = parseData.content?.[0]?.text ?? "";
    const match = raw.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim().match(/\{[\s\S]*\}/);
    if (!match) return NextResponse.json({ ok: false, error: "parse error" }, { status: 500 });

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ ok: false, error: "parse error" }, { status: 500 });
    }
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
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) return NextResponse.json({ ok: false, error: "AI error" }, { status: 500 });

  const data = await res.json() as { content?: Array<{ text: string }> };
  const raw = data.content?.[0]?.text ?? "";
  const match = raw.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim().match(/\{[\s\S]*\}/);
  if (!match) return NextResponse.json({ ok: false, error: "parse error" }, { status: 500 });

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "parse error" }, { status: 500 });
  }
  for (const f of ["rent_min", "rent_max", "initial_cost_limit"]) {
    const v = parsed[f];
    if (typeof v === "number" && v > 0 && v <= 300) parsed[f] = v * 10000;
  }

  return NextResponse.json({ ok: true, parsed });
}
