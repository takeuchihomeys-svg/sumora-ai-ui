// app/lib/prop-brain-daily-server.ts — 物件出しのブレインの毎日の物差しの読み（DB は読むだけ・LLM なし）
// 呼ぶ所: app/api/cron/prop-brain-daily（毎朝・prod-yardstick の cron-chain の子）と scripts/prop-brain-daily.ts（手元）。
// 読む量: 直近 days 日の recommendation_snapshots・お客様の発言・条件の履歴と、その会話の物件顧客の行だけ（7日で数千行）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { starStats, conditionReachStats, propBrainDailySummary, PROP_BRAIN_DAILY_AUDIT, type SnapLite, type Writer, type ReachMsg, type ReachHist } from "./prop-brain-daily";
import { YUMA_CONVERSATION_ID, TEST_ONLY_CONVERSATION_IDS } from "./test-conversations";

type Row = Record<string, unknown>;
async function pageAll(q: (a: number, b: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<Row[]> {
  const out: Row[] = [];
  for (let p = 0; p < 100; p++) {
    const { data, error } = await q(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    const a = (data ?? []) as Row[];
    out.push(...a);
    if (a.length < 1000) break;
  }
  return out;
}
const chunks = <T,>(xs: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };

export async function loadPropBrainDaily(sb: SupabaseClient, o: { days?: number; nowMs?: number } = {}) {
  const days = o.days ?? 7;
  const now = o.nowMs ?? Date.now();
  const since = new Date(now - days * 86_400_000).toISOString();
  const test = new Set<string>([YUMA_CONVERSATION_ID, ...TEST_ONLY_CONVERSATION_IDS]);
  // ①② 🌟
  const snaps = (await pageAll((a, b) => sb.from("recommendation_snapshots").select("conversation_id, aix_usage_log_id, candidates").gte("created_at", since).order("id").range(a, b) as never))
    .filter((s) => !test.has(String(s.conversation_id)));
  const logIds = [...new Set(snaps.map((s) => String(s.aix_usage_log_id ?? "")).filter(Boolean))];
  const lmOf = new Map<string, string>();
  for (const c of chunks(logIds, 100)) { const { data } = await sb.from("aix_usage_logs").select("id, line_message_id").in("id", c); for (const r of (data ?? []) as Row[]) if (r.line_message_id) lmOf.set(String(r.id), String(r.line_message_id)); }
  const wOf = new Map<string, string>();
  for (const c of chunks([...new Set(lmOf.values())], 100)) { const { data } = await sb.from("messages").select("line_message_id, staff_writer").in("line_message_id", c); for (const r of (data ?? []) as Row[]) wOf.set(String(r.line_message_id), String(r.staff_writer ?? "")); }
  const lite: SnapLite[] = snaps.map((s) => { const w = wOf.get(lmOf.get(String(s.aix_usage_log_id ?? "")) ?? "") ?? ""; return { candidates: s.candidates, writer: (w === "takeuchi" || w === "employee" ? w : "unknown") as Writer }; });
  const star = starStats(lite);
  // ③ 条件の届き
  const msgs = (await pageAll((a, b) => sb.from("messages").select("conversation_id, text, created_at").eq("sender", "customer").gte("created_at", since).order("id").range(a, b) as never))
    .filter((m) => !test.has(String(m.conversation_id))) as unknown as ReachMsg[];
  const convIds = [...new Set(msgs.map((m) => m.conversation_id))];
  const pcOfConv = new Map<string, string>();
  for (const c of chunks(convIds, 200)) { const { data } = await sb.from("conversations").select("id, property_customer_id, is_post_apply").in("id", c); for (const r of (data ?? []) as Row[]) if (r.property_customer_id && !r.is_post_apply) pcOfConv.set(String(r.id), String(r.property_customer_id)); }
  const pcIds = [...new Set(pcOfConv.values())];
  const pcRow = new Map<string, Row>();
  for (const c of chunks(pcIds, 200)) { const { data } = await sb.from("property_customers").select("id, created_at, desired_area, floor_plan, rent_max, rent_min, move_in_time, ng_points, preferences, other_requests, commute_station, commute_minutes, pet, walk_minutes").in("id", c); for (const r of (data ?? []) as Row[]) pcRow.set(String(r.id), r); }
  const hist = (await pageAll((a, b) => sb.from("property_condition_history").select("property_customer_id, changed_field, created_at").gte("created_at", new Date(now - (days + 1) * 86_400_000).toISOString()).order("id").range(a, b) as never)) as unknown as ReachHist[];
  const reach = conditionReachStats({ msgs, pcOfConv, hist, pcRow });
  return { audit: PROP_BRAIN_DAILY_AUDIT, days, star, reach, summary: propBrainDailySummary(star, reach, days) };
}
