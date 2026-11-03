// app/lib/brain-manuals-weekly-server.ts — 取扱説明書の毎週の書き直しの DB の側（③・作業員1・11/04・既定 off）
//   読む: line_watch_turns（直近 N 日・答えの分かった番の列だけ）と、その会話のこちらの送信の書き手（messages.staff_writer・sure）。テスト用の会話は外す。
//   書く: brain_manuals（RLS・サーバーの鍵だけ）。BRAIN_MANUALS_WEEKLY=on かつ apply の時だけ。それ以外は計画（書く行）を返すだけ。
//   重い読みは夜だけ（呼ぶ側の cron が JST 22〜9 に動く・営業時間の手動実行はしない）
import type { SupabaseClient } from "@supabase/supabase-js";
import { isTestConversation } from "@/app/lib/test-conversations";
import { tallyWeekly, weeklyRows, writerOfTurn, brainManualsWeeklyOn, type WeeklyTurn, type ExistingRow, type ManualUpsert, type WeeklyStats } from "@/app/lib/brain-manuals-weekly";

type Turn = { conversation_id: string; customer_turn_at: string; staff_first_at: string | null; brain_reply_mode: string | null; brain_action: string | null; staff_aix: Array<{ aix_type?: string }> | null; verdict: string | null; scene_key: string | null };
type Msg = { conversation_id: string; created_at: string; staff_writer: string | null; staff_writer_confidence: string | null };

async function pageAll<T>(sb: SupabaseClient, table: string, cols: string, f: (q: any) => any): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = [];
  for (let i = 0; ; i += 1000) {
    const r = (await f(sb.from(table).select(cols)).range(i, i + 999)) as { data: unknown; error: { message: string } | null };
    if (r.error) throw new Error(`${table}: ${r.error.message}`);
    const rows = (r.data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

export type WeeklyResult = { turns: number; stats: WeeklyStats; rows: ManualUpsert[]; written: boolean };

export async function runBrainManualsWeekly(sb: SupabaseClient, o: { days?: number; apply?: boolean } = {}): Promise<WeeklyResult> {
  const days = o.days ?? 30;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const turns = (await pageAll<Turn>(sb, "line_watch_turns", "conversation_id, customer_turn_at, staff_first_at, brain_reply_mode, brain_action, staff_aix, verdict, scene_key", (q) => q.gte("customer_turn_at", since).not("staff_first_at", "is", null).order("customer_turn_at")))
    .filter((t) => !isTestConversation(t.conversation_id));
  const convs = [...new Set(turns.map((t) => t.conversation_id))];
  const byConv = new Map<string, Msg[]>();
  for (let i = 0; i < convs.length; i += 50) {
    const part = convs.slice(i, i + 50);
    const ms = await pageAll<Msg>(sb, "messages", "conversation_id, created_at, staff_writer, staff_writer_confidence", (q) => q.in("conversation_id", part).neq("sender", "customer").gte("created_at", since).order("created_at"));
    for (const m of ms) { const l = byConv.get(m.conversation_id) ?? []; l.push(m); byConv.set(m.conversation_id, l); }
  }
  const recs: WeeklyTurn[] = turns.map((t) => ({
    writer: writerOfTurn(t.customer_turn_at, t.staff_first_at, byConv.get(t.conversation_id) ?? []),
    scene: t.scene_key,
    brainMode: t.brain_reply_mode,
    brainAction: t.brain_action || null,
    staffAix: (t.staff_aix ?? []).map((x) => String(x.aix_type ?? "")).filter(Boolean),
    verdict: t.verdict,
    hasStaff: !!t.staff_first_at,
  }));
  const stats = tallyWeekly(recs);
  const { data: ex, error } = await sb.from("brain_manuals").select("brain, item, body, source, stats").in("item", ["hit_rate", "strengths"]);
  if (error) throw new Error(`brain_manuals: ${error.message}`);
  const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const rows = weeklyRows(stats, (ex ?? []) as ExistingRow[], { days, day });
  const write = !!o.apply && brainManualsWeeklyOn();
  if (write && rows.length) {
    const now = new Date().toISOString();
    const prevBody = new Map(((ex ?? []) as ExistingRow[]).map((r) => [`${r.brain}|${r.item}`, r.body]));
    const up = rows.map((r) => ({ ...r, updated_at: now, ...(prevBody.get(`${r.brain}|${r.item}`) !== r.body ? { changed_at: now } : {}) }));
    const { error: e2 } = await sb.from("brain_manuals").upsert(up, { onConflict: "brain,item" });
    if (e2) throw new Error(`brain_manuals upsert: ${e2.message}`);
  }
  return { turns: recs.length, stats, rows, written: write && rows.length > 0 };
}
