// scripts/lib/compose-prod-daily-db.ts — 文の当たりの本番の物差しの DB の読み（読むだけ・LLM なし）。毎朝の cron（app/api/cron/compose-prod-daily）と手元の台本（scripts/compose-prod-daily.ts）が同じ物を使う
//   2026-11-15 作業員H。見張りの番（line_watch_turns・下書き draft_last と竹内さんの実送信 staff_texts）と、その番の最初のスタッフの通の書き手（messages）だけを読む
import type { SupabaseClient } from "@supabase/supabase-js";
import { compareProdTurn, tallyProd, type ProdElResult, type ProdTally } from "./compose-prod-elements";
import { isTestConversation } from "../../app/lib/test-conversations";
import { writerMatches, windowsAround, type WriterMode, type FixSpec } from "./compose-prod-window";

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
/** その番の最初のスタッフの通の書き手と AIX か（読めなければ null）。2026-11-19: AIX と書き手不明を分ける（--writers=all のため） */
async function writerOf(sb: SupabaseClient, w: W): Promise<{ writer: string | null; aix: boolean } | null> {
  const first = (w.staff_texts ?? []).find((s) => s.at);
  if (!first?.at) return null;
  const t = Date.parse(first.at);
  const { data } = await sb.from("messages").select("staff_writer, is_aix_generated").eq("conversation_id", w.conversation_id).neq("sender", "customer")
    .gte("created_at", new Date(t - 2000).toISOString()).lte("created_at", new Date(t + 2000).toISOString()).limit(1);
  const m = ((data ?? []) as Array<{ staff_writer: string | null; is_aix_generated: boolean }>)[0];
  return m ? { writer: m.staff_writer ?? null, aix: !!m.is_aix_generated } : null;
}
export type ProdWindow = { turns: number; tally: ProdTally; results: Array<{ id: number; at: string; writer: string | null; r: ProdElResult[] }>; byWriter: Record<string, number> };
/** writers: 既定 takeuchi（今まで通り）・all＝AIX でないスタッフの返信全部・{names}＝その書き手だけ */
export async function measureProdWindow(sb: SupabaseClient, fromIso: string, toIso: string, writers: WriterMode = "takeuchi"): Promise<ProdWindow> {
  const rows = await readWindow(sb, fromIso, toIso);
  const results: ProdWindow["results"] = [];
  for (const w of rows) {
    const wm = await writerOf(sb, w);
    if (!writerMatches(wm, writers)) continue;
    const texts = (w.staff_texts ?? []).map((s) => String(s.text ?? "")).filter(Boolean);
    results.push({ id: w.id, at: w.customer_turn_at, writer: wm?.writer ?? null, r: compareProdTurn(texts, String(w.draft_last ?? "")) });
  }
  const byWriter: Record<string, number> = {};
  for (const x of results) byWriter[x.writer ?? "(不明)"] = (byWriter[x.writer ?? "(不明)"] ?? 0) + 1;
  return { turns: results.length, tally: tallyProd(results.map((x) => x.r)), results, byWriter };
}
/** 前の窓と今の窓（days 日ずつ） */
export async function runComposeProdDaily(sb: SupabaseClient, days: number, nowMs = Date.now(), writers: WriterMode = "takeuchi"): Promise<{ days: number; before: ProdWindow; after: ProdWindow }> {
  const cut = new Date(nowMs - days * 86_400_000).toISOString(), since = new Date(nowMs - 2 * days * 86_400_000).toISOString(), nowIso = new Date(nowMs).toISOString();
  return { days, before: await measureProdWindow(sb, since, cut, writers), after: await measureProdWindow(sb, cut, nowIso, writers) };
}
/** 2026-11-19 作業員H: 直した物ごとに、on の前と後の窓（同じ長さ・最大 days 日）で比べる。後の窓が6時間に満たない物は notYet（まだ測れない） */
export type FixCompare = { fix: FixSpec; spanH: number; before: ProdWindow; after: ProdWindow } | { fix: FixSpec; notYet: true };
export async function runProdAroundFixes(sb: SupabaseClient, fixes: FixSpec[], days: number, nowMs = Date.now(), writers: WriterMode = "takeuchi"): Promise<FixCompare[]> {
  const out: FixCompare[] = [];
  for (const fix of fixes) {
    const w = windowsAround(fix, days, nowMs);
    if (!w) { out.push({ fix, notYet: true }); continue; }
    const iso = (ms: number) => new Date(ms).toISOString();
    out.push({ fix, spanH: w.spanH, before: await measureProdWindow(sb, iso(w.before[0]), iso(w.before[1]), writers), after: await measureProdWindow(sb, iso(w.after[0]), iso(w.after[1]), writers) });
  }
  return out;
}
