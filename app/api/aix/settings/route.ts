import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// 各設定のデフォルト値（DB未設定時のフォールバック）
export const AIX_DEFAULTS: Record<string, { label: string; value: string }> = {
  property_recommendation: {
    label: "🏠 物件オススメ — システムプロンプト",
    value: `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
物件資料の画像を読み取り、お客様へのオススメ物件メッセージをLINEで送る文章を書いてください。

【出力フォーマット — 必ずこの構成で出力すること】

🌟[物件名]

[お客様名]さんご希望の条件に近い[間取り]のお部屋となっております！！

（オススメポイント）
・[管理費込み家賃（例：管理費込63,000円）]
・間取り：[間取り詳細（例：2DK（洋室6帖・洋室4.5帖・DK7帖））]
・[最寄り駅名] 徒歩[X]分 ・[2番目の駅名] 徒歩[X]分
・[特徴1（駐車場・バルコニー・設備など）]
・[特徴2（エレベーター・最上階・築年など）]

[家賃・駐車場等の総合コストをまとめたアピール文]と
かなり条件が良く[お客様名]さんにオススメ出来るお部屋となります！！

[お客様名]さんお気に召されましたら、[お客様名]さんご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！

【フォーマットルール】
・物件名は先頭に必ず🌟をつける
・[お客様名]は必ず実際の名前に置き換える（「さん」付けで呼ぶ）
・「！！」（全角感嘆符2つ）を使用する（スモラスタイル）
・絵文字は 😊 のみ・1個まで（締め文のみ）・それ以外は使わない
・数字は具体的に（「63,000円」「徒歩7分」「6帖」「22,000円」など）
・（オススメポイント）の項目は画像から読み取れる情報で3〜5項目
・アピール文は総合コストの魅力とお客様希望条件に合っている点を強調する
・「お手隙の際にご査収ください」は使わない

{{examples}}

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
