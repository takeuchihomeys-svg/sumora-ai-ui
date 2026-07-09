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

  // A06: extractPhrases が同一文中で重複フレーズを返す場合がある → Set で重複除去して usage_count の二重加算を防ぐ
  const phrases = [...new Set(extractPhrases(body.sent_text))];
  if (!phrases.length) return NextResponse.json({ ok: true, logged: 0 });

  const status = body.conversation_status || "hearing";
  const phraseCategory = ACTION_TO_PHRASE_CATEGORY[body.action_type];

  // F1: バッチSELECTで N+1 を解消（phrases件数分のラウンドトリップ → 2回のSELECT）
  const [{ data: existingLogs }, { data: dictEntries }] = await Promise.all([
    supabase
      .from("template_phrase_logs")
      .select("id, phrase, usage_count")
      .eq("action_type", body.action_type)
      .eq("conversation_status", status)
      .in("phrase", phrases),
    phraseCategory
      ? supabase
          .from("phrase_dictionary")
          .select("id, phrase, priority")
          .eq("category", phraseCategory)
          .in("phrase", phrases)
      : Promise.resolve({ data: [] as { id: number; phrase: string; priority: number }[] }),
  ]);

  const logMap = Object.fromEntries((existingLogs ?? []).map(r => [r.phrase as string, r]));
  const dictMap = Object.fromEntries((dictEntries ?? []).map(r => [r.phrase as string, r]));

  // 新規フレーズをバルクINSERT
  const newLogPhrases = phrases.filter(p => !logMap[p]);
  if (newLogPhrases.length > 0) {
    await supabase.from("template_phrase_logs").insert(
      newLogPhrases.map(phrase => ({ action_type: body.action_type, conversation_status: status, phrase, usage_count: 1 }))
    );
  }
  if (phraseCategory) {
    const newDictPhrases = phrases.filter(p => !dictMap[p]);
    if (newDictPhrases.length > 0) {
      await supabase.from("phrase_dictionary").insert(
        newDictPhrases.map(phrase => ({ category: phraseCategory, phrase, priority: 3, role: "auto_usage" }))
      );
    }
  }

  // 既存フレーズのカウンタをインクリメント（SUPABASEはbulk incrementをサポートしないため個別UPDATE）
  for (const phrase of phrases.filter(p => logMap[p])) {
    const r = logMap[phrase];
    await supabase
      .from("template_phrase_logs")
      .update({ usage_count: (r.usage_count as number) + 1, updated_at: new Date().toISOString() })
      .eq("id", r.id as string);
  }
  if (phraseCategory) {
    for (const phrase of phrases.filter(p => dictMap[p])) {
      const r = dictMap[phrase];
      await supabase
        .from("phrase_dictionary")
        .update({ priority: Math.min(15, (r.priority as number) + 1) })
        .eq("id", r.id as number);
    }
  }

  return NextResponse.json({ ok: true, logged: phrases.length, phrases });
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
