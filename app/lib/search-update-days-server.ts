// app/lib/search-update-days-server.ts（サーバー専用・DB を読むだけ）
// 「前回の検索（そのお客様×サイトで最後に終わった回）」を search_audits から引き、更新日の計画（search-update-days.planUpdateDays）を作る。
// 決まりは純関数の search-update-days.ts。ここは読むだけ（書かない）。
//
// 前回の検索＝search_audits の status=finished・error なし・error_kind なし・時間切れの印なし（batch_timed_out／fill_timed_out）。
//   search_audits はブレインの PC の回だけ（スタッフの手の検索・ブレインでない PC の回は無い）→ 前回が実際より古く見えるだけ＝広い側（漏れない）。
//   読めない時は「記録なし」＝今までの決まりのまま（検索は止めない）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { planUpdateDays, type UpdateDaysPlan } from "./search-update-days";

/** 見る範囲（これより前の回は無い物として扱う＝指定なしまで広がる前に今までの決まりに任せる） */
const LOOKBACK_DAYS = 30;

type AuditLite = { property_customer_id: string | null; site: string | null; created_at: string; error: string | null; error_kind: string | null; result: Record<string, unknown> | null };

export function siteOfCommand(s: string | null | undefined): string | null {
  const v = String(s ?? "").toLowerCase();
  if (v === "realnetpro" || v === "realpro") return "realpro";
  if (v === "itandi") return "itandi";
  if (v === "reins") return "reins";
  return null;
}

function completed(r: AuditLite): boolean {
  if (r.error || r.error_kind) return false;
  const res = r.result ?? {};
  return !res.batch_timed_out && !res.fill_timed_out;
}

/** お客様ごと×サイトごとの前回の検索（最後に終わった回の開始時刻）。beforeIso より前だけ */
export async function lastCompleteSearches(
  sb: SupabaseClient, customerIds: ReadonlyArray<string>, opts: { beforeIso?: string | null; nowMs?: number } = {},
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  const ids = [...new Set(customerIds.map(String).filter(Boolean))];
  if (!ids.length) return out;
  const nowMs = opts.nowMs ?? Date.now();
  const since = new Date(nowMs - LOOKBACK_DAYS * 86400_000).toISOString();
  for (let i = 0; i < ids.length; i += 50) {
    let q = sb.from("search_audits").select("property_customer_id, site, created_at, error, error_kind, result")
      .in("property_customer_id", ids.slice(i, i + 50)).eq("status", "finished").gte("created_at", since)
      .order("created_at", { ascending: false }).limit(2000);
    if (opts.beforeIso) q = q.lt("created_at", opts.beforeIso);
    const { data, error } = await q;
    if (error) { console.warn("[update-days] 前回の検索を読めない（今までの決まりのまま）:", error.message); continue; }
    for (const r of (data ?? []) as AuditLite[]) {
      const id = String(r.property_customer_id ?? "");
      const site = siteOfCommand(r.site);
      if (!id || !site || !completed(r)) continue;
      const m = out.get(id) ?? {};
      if (!m[site] || m[site] < r.created_at) m[site] = r.created_at;
      out.set(id, m);
    }
  }
  return out;
}

/**
 * これから検索するサイトのうち、記録のあるサイトの一番古い「前回」（1つの更新日で全部のサイトを覆う）。どのサイトも記録が無ければ null
 */
export function oldestLast(last: Record<string, string> | undefined, sites: ReadonlyArray<string>): string | null {
  if (!last) return null;
  let oldest: string | null = null;
  for (const s of sites) {
    const k = siteOfCommand(s);
    const v = k ? last[k] : undefined;
    if (v && (!oldest || v < oldest)) oldest = v;
  }
  return oldest;
}

/** お客様ごとの計画（base＝今までの決まりの値） */
export async function planUpdateDaysFor(
  sb: SupabaseClient, entries: ReadonlyArray<{ id: string; baseDays: number | null }>, sites: ReadonlyArray<string>, nowMs: number = Date.now(),
): Promise<Array<{ id: string; plan: UpdateDaysPlan }>> {
  let last = new Map<string, Record<string, string>>();
  try { last = await lastCompleteSearches(sb, entries.map((e) => e.id), { nowMs }); } catch (e) { console.warn("[update-days] 計画を作れない（今までの決まりのまま）:", e instanceof Error ? e.message : String(e)); }
  return entries.map((e) => ({ id: String(e.id), plan: planUpdateDays({ baseDays: e.baseDays, lastSearchAt: oldestLast(last.get(String(e.id)), sites), nowMs }) }));
}

/** 点検（C1・C3）用: その回の命令の payload と、同じお客様×サイトの前回の検索 */
export async function auditUpdateContext(
  sb: SupabaseClient, row: { command_id?: string | null; property_customer_id?: string | null; site?: string | null; created_at?: string | null },
): Promise<{ command_payload: Record<string, unknown> | null; last_search_at: string | null }> {
  let command_payload: Record<string, unknown> | null = null;
  let last_search_at: string | null = null;
  try {
    if (row.command_id) {
      const c = await sb.from("automation_commands").select("payload").eq("id", row.command_id).maybeSingle();
      if (!c.error) command_payload = ((c.data as { payload?: Record<string, unknown> } | null)?.payload) ?? null;
    }
    const site = siteOfCommand(row.site);
    if (row.property_customer_id && site && row.created_at) {
      const m = await lastCompleteSearches(sb, [row.property_customer_id], { beforeIso: row.created_at, nowMs: Date.parse(row.created_at) || Date.now() });
      last_search_at = m.get(String(row.property_customer_id))?.[site] ?? null;
    }
  } catch (e) {
    console.warn("[update-days] 点検の材料を読めない:", e instanceof Error ? e.message : String(e));
  }
  return { command_payload, last_search_at };
}
