import { NextRequest, NextResponse } from "next/server";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";

function getModel() {
  return new ChatAnthropic({
    model: "claude-haiku-4-5-20251001",
    maxTokens: 512,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
  });
}

// の/ノ 表記ゆれを正規化（駅名の「の」はカタカナ「ノ」に統一）
// 例: 八戸の里 → 八戸ノ里 / 四天王寺前夕陽ヶ丘 → 変化なし（漢字まじりのヶは対象外）
function normalizeStationNames(input: string): string {
  return input
    .split(/[・、,]+/)
    .map((t) => {
      const s = t.trim();
      // ひらがなの「の」がカタカナ駅名に挟まれている場合はカタカナに変換
      // 例: 「八戸の里」→「八戸ノ里」
      return s.replace(/([ぁ-んァ-ン一-龯]{1,6})の([ぁ-んァ-ン一-龯]{1,6})/g, "$1ノ$2");
    })
    .join("・");
}

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
以下の2つのフィールドを分析・整理してください。

【地域フィールド（現在）】: ${area_input || "（空）"}
【駅フィールド（現在）】: ${station_input || "（空）"}

整理ルール:
1. 【駅フィールドへ移動すべきもの】
   - 「〇〇駅」「〇〇線」「〇〇方面」など交通・鉄道に関する語句が地域フィールドにある場合
   - 駅サフィックスなしでも、以下は明確に駅名: 梅田・難波・天王寺・鶴橋・布施・八戸ノ里・河内永和・淡路・江坂など
   - 「A〜B」「A～B」の範囲表記は「AとBが両方とも駅名」と判定し、両方を駅フィールドへ移動（例: 「布施〜八戸の里」→ 駅:「布施・八戸ノ里」）

2. 【地域フィールドへ移動すべきもの】
   - 「〇〇区」「〇〇市」「〇〇町」「〇〇丁目」「〇〇エリア」「〇〇地区」など行政区画・地域名が駅フィールドにある場合
   - 都道府県名・大字・字は地域フィールドへ

3. 【駅名の正規化】
   - 「八戸の里」→「八戸ノ里」（漢字の間の平仮名「の」をカタカナ「ノ」に統一）
   - 「ヶ島」→「ケ島」（ヶ→ケ）
   - 「駅」サフィックスは削除（「梅田駅」→「梅田」）
   - 「なんば」→「難波」（ひらがなの通称→漢字の正式名）
   - 「おおさかじょうこうえん」→「大阪城公園」のような読み→漢字変換
   - 「布施〜八戸の里あたり」のような範囲は「布施・八戸ノ里」に変換（あたり/周辺/付近は除去）

4. 【共通ルール】
   - 同一内容の重複は除去する
   - 複数項目の区切りは「・」に統一する
   - 変更がない場合はchangesを空配列にする
   - 判断が難しい場合は現状維持（無理に移動しない）

5. 【地域名の正規化】（地域フィールドにある市区名の短縮形を正式名に展開する）
   - 大阪府の独立市: 高槻・茨木・吹田・摂津・守口・門真・枚方・東大阪・八尾・寝屋川・大東・四條畷・交野・豊中・池田・箕面・柏原・藤井寺・松原・羽曳野・富田林・河内長野・大阪狭山・和泉・岸和田・貝塚・泉佐野・泉南・阪南・泉大津・高石 → 「〇〇市」を付ける（例: 「高槻」→「高槻市」、「守口」→「守口市」）
   - 【重要】「門真」は大阪府門真市（独立した市）。「大阪市門真区」は存在しない → 必ず「門真市」
   - 【重要】「東大阪」は東大阪市（独立した市）。「大阪市東大阪区」は存在しない → 必ず「東大阪市」
   - 大阪市の区（鶴見区・平野区・城東区・住吉区・住之江区・東住吉区・西成区・浪速区・天王寺区・阿倍野区・生野区・東成区・旭区・都島区・福島区・此花区・西淀川区・淀川区・東淀川区・西区・港区・大正区・中央区・北区）は「大阪市〇〇区」を付ける（例: 「鶴見区」→「大阪市鶴見区」、「平野区」→「大阪市平野区」）
   - 堺市の区（堺区・北区・西区・中区・東区・南区・美原区）は「堺市〇〇区」を付ける
   - すでに「〇〇市」「大阪市〇〇区」の形になっている場合は変更不要

6. 【suggested_mode の判定】
   - 整理後の地域フィールドに市名・区名など行政区画のみが残り、駅名が含まれない → "ward"
   - 整理後の駅フィールドのみに内容があり、地域フィールドが空 → "station"
   - 両方に内容がある → "both"
   - 判断できない場合 → "auto"

JSONのみ返してください（コードブロック不要）:
{"area_input":"整理後の地域","station_input":"整理後の駅","changes":["変更内容の説明文"],"suggested_mode":"ward"}`;

  try {
    const res = await getModel().invoke([new HumanMessage(prompt)]);
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
      suggested_mode?: string;
    };

    // AIの結果にさらに の/ノ 正規化を適用（AI が見落とした場合の保険）
    const finalStation = normalizeStationNames(parsed.station_input ?? station_input);

    return NextResponse.json({
      area_input: parsed.area_input ?? area_input,
      station_input: finalStation,
      changes: Array.isArray(parsed.changes) ? parsed.changes : [],
      suggested_mode: parsed.suggested_mode ?? "auto",
    });
  } catch (err) {
    console.error("[organize-area-station] Anthropic call failed:", err);
    return NextResponse.json({ area_input, station_input, changes: [] });
  }
}
