// scripts/lib/compose-prod-daily-db.ts — 文の当たりの本番の物差しの DB の読み（読むだけ・LLM なし）。毎朝の cron（app/api/cron/compose-prod-daily）と手元の台本（scripts/compose-prod-daily.ts）が同じ物を使う
//   2026-11-15 作業員H。見張りの番（line_watch_turns・下書き draft_last と竹内さんの実送信 staff_texts）と、その番の最初のスタッフの通の書き手（messages）だけを読む
import type { SupabaseClient } from "@supabase/supabase-js";
import { compareProdTurn, tallyProd, type ProdElResult, type ProdTally } from "./compose-prod-elements";
import { isTestConversation } from "../../app/lib/test-conversations";

type W = { id: number; conversation_id: string; customer_turn_at: string; draft_last: string | null; staff_texts: Array<{ at?: string; text?: string }> | null };
async function readWindow(sb: SupabaseClient, fromIso: string, toIso: string): Promise<W[]> {
  const out: W[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, draft_last, staff_texts")
      .gte("customer_turn_at", fromIso).lt("customer_turn_at", toIso).not("draft_last", "is", null).order("customer_turn_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as W[])); if ((data ?? []).length < 1000) break;
  }
  return out.filter((w) => !isTestConversation(w.conversation_id) && Array.isArray(w.staff_texts) && w.staff_texts.some((s) => s.text));
}
/** その番の最初のスタッフの通の書き手（AIX でない時だけ） */
async function writerOf(sb: SupabaseClient, w: W): Promise<string | null> {
  const first = (w.staff_texts ?? []).find((s) => s.at);
  if (!first?.at) return null;
  const t = Date.parse(first.at);
  const { data } = await sb.from("messages").select("staff_writer, is_aix_generated").eq("conversation_id", w.conversation_id).neq("sender", "customer")
    .gte("created_at", new Date(t - 2000).toISOString()).lte("created_at", new Date(t + 2000).toISOString()).limit(1);
  const m = ((data ?? []) as Array<{ staff_writer: string | null; is_aix_generated: boolean }>)[0];
  return m && !m.is_aix_generated ? m.staff_writer : null;
}
export type ProdWindow = { turns: number; tally: ProdTally; results: Array<{ id: number; at: string; r: ProdElResult[] }> };
export async function measureProdWindow(sb: SupabaseClient, fromIso: string, toIso: string): Promise<ProdWindow> {
  const rows = await readWindow(sb, fromIso, toIso);
  const results: ProdWindow["results"] = [];
  for (const w of rows) {
    if ((await writerOf(sb, w)) !== "takeuchi") continue;
    const texts = (w.staff_texts ?? []).map((s) => String(s.text ?? "")).filter(Boolean);
    results.push({ id: w.id, at: w.customer_turn_at, r: compareProdTurn(texts, String(w.draft_last ?? "")) });
  }
  return { turns: results.length, tally: tallyProd(results.map((x) => x.r)), results };
}
/** 前の窓と今の窓（days 日ずつ） */
export async function runComposeProdDaily(sb: SupabaseClient, days: number, nowMs = Date.now()): Promise<{ days: number; before: ProdWindow; after: ProdWindow }> {
  const cut = new Date(nowMs - days * 86_400_000).toISOString(), since = new Date(nowMs - 2 * days * 86_400_000).toISOString(), nowIso = new Date(nowMs).toISOString();
  return { days, before: await measureProdWindow(sb, since, cut), after: await measureProdWindow(sb, cut, nowIso) };
}
