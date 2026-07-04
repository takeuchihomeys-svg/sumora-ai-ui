import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// ④ action_type → phrase_dictionary カテゴリ（save-reply-example の STATE_TO_PHRASE_CATEGORY と対応）
const ACTION_TO_PHRASE_CATEGORY: Record<string, string> = {
  estimate_sheet:         "estimate_send",
  property_send:          "property_search_start",
  property_recommendation:"property_recommendation",
  viewing_invite:         "viewing_invite",
  application_push:       "application_push",
  property_check_result:  "property_recommendation",
  meeting_place:          "viewing_invite",
  condition_hearing:      "hearing_followup",
  acknowledge_check:      "hearing_followup",
  followup_revive:        "hearing_followup",
};

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

    // ④ phrase_dictionary にも同期（generate-reply が参照する本流テーブルへ連携）
    const phraseCategory = ACTION_TO_PHRASE_CATEGORY[body.action_type];
    if (phraseCategory) {
      const { data: dictEntry } = await supabase
        .from("phrase_dictionary")
        .select("id, priority")
        .eq("category", phraseCategory)
        .eq("phrase", phrase)
        .maybeSingle();

      if (dictEntry) {
        await supabase
          .from("phrase_dictionary")
          .update({ priority: Math.min(15, (dictEntry.priority as number) + 1) })
          .eq("id", dictEntry.id as number);
      } else {
        await supabase.from("phrase_dictionary").insert({
          category: phraseCategory,
          phrase,
          priority: 3,
          role: "auto_usage",
        });
      }
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
