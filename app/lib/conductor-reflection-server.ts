// app/lib/conductor-reflection-server.ts — 毎週の振り返りの読み（サーバーだけ）。作業員5・11/07
//   返信の番だけの文の質（作業員9の app/lib/reply-quality-weekly.ts の純関数）を、終わった週とその前の週の分だけ読む。
//   読み方は scripts/reply-quality-weekly.ts と同じ（ai_reply_examples を 1000行の頁・スタッフの通は会話 200件ずつ・前後3分で一番近い通）。LLM なし
import type { SupabaseClient } from "@supabase/supabase-js";
import { weeklyReplyQuality, nearestStaffMessage, jstWeekOf, turnRepliesOf, type QualityRow, type WeekStat } from "@/app/lib/reply-quality-weekly";

const PAGE = 1000, MAX_ROWS = 5000, MSG_MAX_ROWS = 20000;
type Ex = { conversation_id: string; sent_at: string; ai_similarity: number | null; ai_draft: string | null; sent_reply: string | null };
type Msg = { conversation_id: string; created_at: string; sender: string; text: string | null; staff_writer: string | null; is_aix_generated: boolean | null };

/** JST の今週の月曜 0時から weeks 週前（今週は含めて数え、比べる時に外す） */
export function reflectionSince(now: number, weeks: number): string {
  const d = new Date(now + 9 * 3600_000);
  const dow = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow - 7 * weeks) - 9 * 3600_000).toISOString();
}

/** 終わった週2つ＋今週の stats と今週の印。失敗は null（振り返りの他の部分は止めない） */
export async function loadReplyQualityStats(sb: SupabaseClient, o: { now?: number; weeks?: number; writer?: string } = {}): Promise<{ since: string; currentWeek: string; stats: WeekStat[]; read: number } | null> {
  const now = o.now ?? Date.now();
  const since = reflectionSince(now, o.weeks ?? 2);
  const ex: Ex[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await sb.from("ai_reply_examples").select("conversation_id, sent_at, ai_similarity, ai_draft, sent_reply")
      .gte("sent_at", since).not("ai_draft", "is", null).not("ai_similarity", "is", null).order("sent_at", { ascending: true }).range(from, from + PAGE - 1);
    if (error) return null;
    ex.push(...((data ?? []) as Ex[]));
    if ((data ?? []).length < PAGE) break;
  }
  const rowsIn = ex.filter((e) => (e.ai_draft ?? "").trim() && (e.sent_reply ?? "").trim() && e.conversation_id);
  const convIds = [...new Set(rowsIn.map((e) => e.conversation_id))];
  const msgs = new Map<string, Msg[]>();
  const sinceMsg = new Date(Date.parse(since) - 5 * 60_000).toISOString();
  for (let i = 0; i < convIds.length; i += 200) {
    // 2026-11-07 作業員9: お客様の通と本文も読む（番の区切りと、返信を2〜3通に分けた番の中身の入りを見るため）
    for (let from = 0; from < MSG_MAX_ROWS; from += PAGE) {
      const { data, error } = await sb.from("messages").select("conversation_id, created_at, sender, text, staff_writer, is_aix_generated")
        .in("conversation_id", convIds.slice(i, i + 200)).gte("created_at", sinceMsg).order("created_at", { ascending: true }).range(from, from + PAGE - 1);
      if (error) return null;
      for (const m of (data ?? []) as Msg[]) (msgs.get(m.conversation_id) ?? msgs.set(m.conversation_id, []).get(m.conversation_id)!).push(m);
      if ((data ?? []).length < PAGE) break;
    }
  }
  const rows: QualityRow[] = rowsIn.map((e) => {
    const conv = msgs.get(e.conversation_id) ?? [];
    const m = nearestStaffMessage(e.sent_at, conv.filter((x) => x.sender !== "customer"));
    return { sentAt: e.sent_at, similarity: Number(e.ai_similarity), draft: e.ai_draft ?? "", sent: e.sent_reply ?? "", writer: m?.staff_writer ?? null, aix: m?.is_aix_generated ?? null,
      turnReplies: turnRepliesOf(e.sent_at, conv) };
  });
  return { since, currentWeek: jstWeekOf(new Date(now).toISOString()), stats: weeklyReplyQuality(rows, o.writer ?? "takeuchi"), read: rowsIn.length };
}
