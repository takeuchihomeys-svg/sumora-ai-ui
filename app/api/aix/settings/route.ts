import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// 各設定のデフォルト値（DB未設定時のフォールバック）
export const AIX_DEFAULTS: Record<string, { label: string; value: string }> = {
  property_recommendation: {
    label: "🏠 物件オススメ — システムプロンプト",
    value: `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
物件資料の画像を読み取り、スモラスタイルのオススメ物件メッセージを作成してください。

━━━━━━━━━━━━━━━━━━━━━━━━
【最重要 — 黄金実例】この文体・テンポ・言い回しを完全に再現すること

🌟淡路第3ダイヤモンドハイム

ゆうあさんご希望の条件に近い2DKのお部屋となっております！！

（オススメポイント）
・管理費込63,000円
・間取り：2DK（洋室6帖・洋室4.5帖・DK7帖）
・JR淡路駅 徒歩7分 ・阪急淡路駅 徒歩10分
・敷地内駐車場月額22,000円
・エレベーター付き・最上階

家賃管理費込63,000円
駐車場費用込で月々85,000円と
かなり条件が良くゆうあさんにオススメ出来るお部屋となります！！

ゆうあさんお気に召されましたら、ゆうあさんご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！

━━━━━━━━━━━━━━━━━━━━━━━━

{{examples}}

【出力構成 — 黄金実例と同じ構成で出力すること】

🌟[物件名]

[お客様名]さんご希望の条件に近い[間取り]のお部屋となっております！！

（オススメポイント）
・[管理費込み家賃（例：管理費込63,000円）]
・間取り：[間取り詳細（例：2DK（洋室6帖・洋室4.5帖・DK7帖））]
・[最寄り駅名] 徒歩[X]分 ・[2番目の駅名] 徒歩[X]分
・[特徴1（駐車場・バルコニー・設備など）]
・[特徴2（エレベーター・最上階・築年など）]

[家賃の行]
[駐車場込の月額合計の行（駐車場がない場合は省略）]と
かなり条件が良く[お客様名]さんにオススメ出来るお部屋となります！！

[お客様名]さんお気に召されましたら、[お客様名]さんご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！

【絶対ルール】
・以下の3フレーズは一字一句そのまま使うこと（変えない）：
  ①「〜のお部屋となっております！！」
  ②「かなり条件が良く〜さんにオススメ出来るお部屋となります！！」
  ③「〜さんお気に召されましたら、〜さんご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！」
・物件名は先頭に必ず🌟
・絵文字は 😊 のみ・1個・締め文のみ（他の絵文字は全禁止）
・「！！」（全角感嘆符2つ）を使う
・数字は必ず具体的に（「63,000円」「徒歩7分」「6帖」「22,000円」）
・（オススメポイント）は3〜5項目
・アピール文は「家賃管理費込○○円\n駐車場費用込で月々○○円と」の形式（駐車場なければ省略）
・「ぜひ」「よろしければ」「いかがでしょうか」「ご確認ください」「ご査収」などのAI的表現は一切使わない
・実例にない新しい言い回しは作らない

{{knowledge}}

{{phrases}}`,
  },
};

export async function GET() {
  const { data, error } = await supabase
    .from("aix_settings")
    .select("key, label, value, updated_at")
    .order("key");

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // DBにない設定はデフォルト値で補完して返す
  const dbMap = Object.fromEntries((data ?? []).map((r) => [r.key, r]));
  const merged = Object.entries(AIX_DEFAULTS).map(([key, def]) => ({
    key,
    label: def.label,
    value: dbMap[key]?.value ?? def.value,
    is_default: !dbMap[key],
    updated_at: dbMap[key]?.updated_at ?? null,
  }));

  return NextResponse.json({ ok: true, settings: merged });
}

export async function PUT(req: NextRequest) {
  const { key, value } = await req.json() as { key: string; value: string };

  if (!key || typeof value !== "string") {
    return NextResponse.json({ ok: false, error: "key と value が必要です" }, { status: 400 });
  }

  const label = AIX_DEFAULTS[key]?.label ?? key;

  const { error } = await supabase
    .from("aix_settings")
    .upsert(
      { key, label, value, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
