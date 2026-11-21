/**
 * 物件検索（統括Pro）の毎日の質の数を quality_daily に書く（2026-11-21 作業員G・LLM なし）
 *
 *   search_found_ok:<site>・search_found_critical:<site>・search_pro_completion:<site>・search_cause_layer:<層>:<site>
 *   （最新の統括Pro の根拠の行から・site = realpro / itandi / all）と、search_pro_misjudge（段Aの結果・scripts/search-pro-exam.ts）。
 *   quality_daily.scope は takeuchi/all/draft/employee だけなので scope='all' に置き、サイトは metric の後ろに付ける。
 *   呼ぶ所: /api/cron/supervisor-think の終わり（毎晩・dry では呼ばない）。読むのは scope ごとに最新の1行だけ（軽い）。
 */
import { supabase } from "@/app/lib/supabase-server";
import { searchQualityRows, type EvRow, type SearchQualityRow } from "@/app/lib/search-pro-exam";

const jstDay = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);

export async function writeSearchQualityRows(rows: SearchQualityRow[], source: string, now = Date.now()): Promise<number> {
  if (!rows.length) return 0;
  const day = jstDay(now);
  const payload = rows.map((r) => ({ day, metric: r.metric, scope: "all", value: r.value, n: r.n, source, detail: r.detail }));
  const { error } = await supabase.from("quality_daily").upsert(payload, { onConflict: "day,metric,scope" });
  if (error) throw new Error(`quality_daily: ${error.message}`);
  return payload.length;
}

export const SEARCH_QUALITY_SITES = ["realpro", "itandi", "all"] as const;

/** scope ごとに最新の統括Pro（根拠の行がある行・llm_think 以外）から数を作って書く */
export async function writeLatestSearchQuality(now = Date.now()): Promise<{ rows: number; sites: Record<string, number | null> }> {
  const all: SearchQualityRow[] = [];
  const sites: Record<string, number | null> = {};
  for (const site of SEARCH_QUALITY_SITES) {
    const { data } = await supabase.from("learn_supervisor_log").select("id, created_at, meeting")
      .eq("scope", site).neq("verdict", "llm_think").not("meeting->evidence", "is", null)
      .order("id", { ascending: false }).limit(1).maybeSingle();
    const row = data as { id: number; created_at: string; meeting: { evidence?: EvRow[] } | null } | null;
    if (!row?.meeting?.evidence?.length) { sites[site] = null; continue; }
    sites[site] = row.id;
    all.push(...searchQualityRows(site, row.meeting.evidence, { log_id: row.id, logged_at: row.created_at }));
  }
  const rows = await writeSearchQualityRows(all, "cron/supervisor-think", now);
  return { rows, sites };
}
