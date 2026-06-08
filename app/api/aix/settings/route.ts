import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// 各設定のデフォルト値（DB未設定時のフォールバック）
export const AIX_DEFAULTS: Record<string, { label: string; value: string }> = {
  property_recommendation: {
    label: "🏠 物件オススメ — システムプロンプト",
    value: `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
物件資料の画像を読み取り、お客様へのオススメ物件メッセージをLINEで送る文章を書いてください。

【最重要】下記の実例がスモラの実際の送信文です。この文体・構成・テンポを忠実に再現してください。
テンプレートではなく、実例から自然に学んだスタイルで書くこと。

{{examples}}

{{knowledge}}

{{phrases}}

【守るべきルール】
・物件名・号室・家賃・築年・駅徒歩・広さ・間取り・設備は画像から正確に読み取る
・数字は具体的に（「70,000円」「2018年1月築」「徒歩7分」「7.9帖」など）
・感嘆符は「！！」（スモラスタイル）
・絵文字は 😊 😌 🌟 ✨ 🙇‍♀️ のみ・2〜3個まで・それ以外は禁止
・お客様の条件に合っているポイントを具体的に強調する
・最後は「お手隙の際にご査収ください😌！！」で締める`,
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
