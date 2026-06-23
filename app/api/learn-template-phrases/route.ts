import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// フレーズ抽出：LINE文章をフレーズ単位に分割
function extractPhrases(text: string): string[] {
  // ！！ や \n で区切ってフレーズ単位に分割
  const raw = text
    .split(/！！|\n|。/)
    .map((s) => s.replace(/^[\s　\-・【】\[\]「」『』()（）]+|[\s　\-・【】\[\]「」『』()（）]+$/g, "").trim())
    .filter((s) => s.length >= 8 && s.length <= 80);

  // 固有名詞っぽい短いもの・記号だけは除外
  return raw.filter((s) => /[ぁ-んァ-ン一-龯]/.test(s));
}

// POST: 送信後にフレーズを記録
export async function POST(req: NextRequest) {
  const body = await req.json() as {
    action_type: string;
    conversation_status: string;
    sent_text: string;
  };

  if (!body.action_type || !body.sent_text) {
    return NextResponse.json({ ok: false, error: "missing fields" });
  }

  const phrases = extractPhrases(body.sent_text);
  if (!phrases.length) return NextResponse.json({ ok: true, logged: 0 });

  const status = body.conversation_status || "hearing";
  let logged = 0;

  for (const phrase of phrases) {
    // upsert: 既存なら usage_count +1
    const { data: existing } = await supabase
      .from("template_phrase_logs")
      .select("id, usage_count")
      .eq("action_type", body.action_type)
      .eq("conversation_status", status)
      .eq("phrase", phrase)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("template_phrase_logs")
        .update({ usage_count: (existing.usage_count as number) + 1, updated_at: new Date().toISOString() })
        .eq("id", existing.id as string);
    } else {
      await supabase.from("template_phrase_logs").insert({
        action_type: body.action_type,
        conversation_status: status,
        phrase,
        usage_count: 1,
      });
    }
    logged++;
  }

  return NextResponse.json({ ok: true, logged, phrases });
}

// GET: アクション×ステータスのよく使われるフレーズ Top5
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action_type = searchParams.get("action_type");
  const conversation_status = searchParams.get("conversation_status") ?? "hearing";

  if (!action_type) return NextResponse.json({ ok: false, error: "action_type required" });

  const { data } = await supabase
    .from("template_phrase_logs")
    .select("phrase, usage_count")
    .eq("action_type", action_type)
    .eq("conversation_status", conversation_status)
    .order("usage_count", { ascending: false })
    .limit(5);

  // 件数が少ない場合はステータス問わず全体のTop5も返す
  if ((data?.length ?? 0) < 3) {
    const { data: allData } = await supabase
      .from("template_phrase_logs")
      .select("phrase, usage_count")
      .eq("action_type", action_type)
      .order("usage_count", { ascending: false })
      .limit(5);
    return NextResponse.json({ ok: true, phrases: allData ?? [], source: "all" });
  }

  return NextResponse.json({ ok: true, phrases: data ?? [], source: "status_match" });
}
