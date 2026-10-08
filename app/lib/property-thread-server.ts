// app/lib/property-thread-server.ts — 物件ごとの状況の台帳（property-thread.ts）の材料を DB から読む所（読むだけ・新しい表は作らない）
// 2026-10-07 竹内（S❤ 事例）「物件にたいして反応や進捗があれば1件ずつそのデータ保管して、物件の事にたいしての話になったときは、状況を理解出来るように」
//   保管は既存の記録（messages の引用・送った画像の記録 sent_image_properties／sent_properties・aix_usage_logs・estimate_records）＝二重に持たない。
import { supabase } from "@/app/lib/supabase";
import { propertyLabelsForImages } from "@/app/lib/quoted-context";
import { resolvePropertyThreads, buildPropertyThreadNote, propertyThreadEnabled, type PropertyThreadState, type PtMsg, type PtAix, type PtEstimate, type PtRecommendation } from "@/app/lib/property-thread";

/** 会話の台帳を作る（asOf があればその時刻までの記録だけ＝再生・監査用）。失敗は null（材料を足さないだけ） */
export async function loadPropertyThreads(conversationId: string, opts: { asOf?: string | null; days?: number } = {}): Promise<PropertyThreadState | null> {
  try {
    // 既定は「今＋1日」まで（テストの場面は未来の時刻に置くため・本番に未来の行は無い）
    const until = opts.asOf ?? new Date(Date.now() + 86400_000).toISOString();
    // 2026-10-08 8巡目（記録の続き）: 窓を30日で切らない（その会話の物件は期間を問わず・件数の上限で）。戻す: PROPERTY_THREAD_DAYS=30
    const days = opts.days ?? (Number(process.env.PROPERTY_THREAD_DAYS ?? "0") || 0);
    const since = days > 0 ? new Date(Date.parse(until) - days * 86400_000).toISOString() : "2000-01-01T00:00:00Z";
    const [msgs, aix, est, recs] = await Promise.all([
      supabase.from("messages").select("sender, text, created_at, line_message_id, quoted_message_id, image_url, is_aix_generated")
        .eq("conversation_id", conversationId).gte("created_at", since).lte("created_at", until).order("created_at", { ascending: false }).limit(500),
      supabase.from("aix_usage_logs").select("created_at, aix_type, check_pattern, property_names, prop_statuses, estimate_sent, generated_text")
        .eq("conversation_id", conversationId).not("sent_at", "is", null).gte("created_at", since).lte("created_at", until).order("created_at", { ascending: false }).limit(300),
      // 2026-10-08 8巡目（記録）: 割引・初期費用も読んで台帳の「見積書を送った」に添える（AD は読まない＝お客様向けの文に出さない）
      supabase.from("estimate_records").select("created_at, property_name, room_no, discount_yen, initial_cost_yen")
        .eq("conversation_id", conversationId).gte("created_at", since).lte("created_at", until).order("created_at", { ascending: false }).limit(200),
      // 2026-10-08: 物件オススメの控え（🌟の物件・本文）＝「オススメした」出来事（今までどこからも読まれていなかった）
      supabase.from("recommendation_snapshots").select("sent_at, star_name, star_room, star_text")
        .eq("conversation_id", conversationId).gte("sent_at", since).lte("sent_at", until).order("sent_at", { ascending: false }).limit(60),
    ]);
    if (msgs.error) throw new Error(msgs.error.message);
    const messages = ((msgs.data ?? []) as PtMsg[]).reverse();
    const urls = messages.filter((m) => m.sender === "staff" && m.image_url).map((m) => m.image_url as string);
    // 画像が多い会話（YUMA 30日で数百枚）で .in() の URL が長すぎて fetch が落ちた → 40枚ずつ読む
    const imageLabels = new Map<string, string>();
    const uniq = [...new Set(urls)];
    for (let i = 0; i < uniq.length; i += 40) {
      for (const [k, v] of await propertyLabelsForImages(conversationId, uniq.slice(i, i + 40))) imageLabels.set(k, v);
    }
    return resolvePropertyThreads({
      messages, imageLabels,
      aix: (aix.data ?? []) as PtAix[],
      estimates: (est.data ?? []) as PtEstimate[],
      recommendations: (recs.data ?? []) as PtRecommendation[],
    });
  } catch (e) {
    console.warn("[property-thread] load failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** ブレイン・返信に入れる文（今の番が物件の話でなければ ""・PROPERTY_THREAD_NOTE=off なら ""） */
export async function propertyThreadNoteFor(conversationId: string, opts: { asOf?: string | null } = {}): Promise<string> {
  if (!propertyThreadEnabled()) return "";
  const s = await loadPropertyThreads(conversationId, opts);
  if (!s) return "";
  const note = buildPropertyThreadNote(s);
  if (note) console.log(JSON.stringify({ tag: "property-thread:note", conversationId, targets: s.turnTargets.map((t) => ({ room: t.display, topic: t.topic, by: t.by })), rooms: s.rooms.length, chars: note.length }));
  return note;
}
