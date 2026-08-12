import { NextRequest, NextResponse } from "next/server";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";

const model = new ChatAnthropic({
  model: "claude-haiku-4-5-20251001",
  maxTokens: 512,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
});

export async function POST(req: NextRequest) {
  let area_input = "";
  let station_input = "";

  try {
    const body = await req.json() as { area_input?: string; station_input?: string };
    area_input = (body.area_input ?? "").trim();
    station_input = (body.station_input ?? "").trim();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const prompt = `あなたは不動産物件検索の条件整理AIです。
以下の2つのフィールドを分析して整理してください。

【地域フィールド（現在）】: ${area_input}
【駅フィールド（現在）】: ${station_input}

整理ルール:
1. 「〇〇駅」「〇〇線」「〇〇方面」など交通・鉄道に関する語句が地域フィールドに含まれている場合は駅フィールドへ移動する
2. 「〇〇区」「〇〇市」「〇〇町」「〇〇丁目」「〇〇エリア」「〇〇地区」など地名・地域名が駅フィールドに含まれている場合は地域フィールドへ移動する
3. 同一内容の重複は除去する
4. 複数項目の区切りは「・」に統一する
5. 変更がない場合はchangesを空配列にする

JSONのみ返してください（コードブロック不要）:
{"area_input":"整理後の地域","station_input":"整理後の駅","changes":["変更内容の説明文"]}`;

  try {
    const res = await model.invoke([new HumanMessage(prompt)]);
    const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      console.warn("[organize-area-station] JSON not found in response:", text);
      return NextResponse.json({ area_input, station_input, changes: [] });
    }
    const parsed = JSON.parse(match[0]) as {
      area_input?: string;
      station_input?: string;
      changes?: string[];
    };
    return NextResponse.json({
      area_input: parsed.area_input ?? area_input,
      station_input: parsed.station_input ?? station_input,
      changes: Array.isArray(parsed.changes) ? parsed.changes : [],
    });
  } catch (err) {
    console.error("[organize-area-station] Anthropic call failed:", err);
    return NextResponse.json({ area_input, station_input, changes: [] });
  }
}
