// scripts/lib/exam-situation-now.ts — その番の時刻で切った台帳から meta.situation_now を純関数で組み直す（読むだけ・LLM なし・費用0）
//
// 2026-11-21 作業員K2（統括役の最優先: 試験の写しに situation_now が無い＝SITUATION_WRITER_NOTE_AIX・OUR_ITEMS_WRITER_NOTE・SECOND_BLOCK_RECEIPT_SEEN の
//   our_items の直しが試験で効かない。作業員H の勧め (a)・作業員L の確かめ 11/21）。
//   本番（brain-core 4426行あたり）と同じ入力: messages（新しい20通）・aix_usage_logs（新しい30件）・sent_facts（120件）・calendar_events（60日）。
//   どれもその番の時刻（cut）以前で切る。calendar は作った時刻（created_at）で切る（L の勧め）。clash は送る文に頼る＝null。asks・this_turn は meta に頼る＝入れない。
//   本番と比べる欄（L）: tw・tv・se・ch・oi・ou・po（situationNowDigest）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildSituationNow, type SituationNow } from "../../app/lib/situation-now";
import { buildExchangeLedger } from "../../app/lib/exchange-ledger";
import { buildTimeline } from "../../app/lib/situation-timeline";
import { doneAsOf } from "../../app/lib/calendar-done-at";

export async function rebuildSituationNowAt(sb: SupabaseClient, conv: string, cutIso: string, o: { msgWindow?: number } = {}): Promise<SituationNow> {
  const nowMs = Date.parse(cutIso);
  const [msgsR, aixR, factsR, calR] = await Promise.all([
    sb.from("messages").select("sender, text, created_at, line_message_id, is_aix_generated, quoted_message_id, image_type, image_url").eq("conversation_id", conv).lte("created_at", cutIso).order("created_at", { ascending: false }).limit(o.msgWindow ?? 20),
    sb.from("aix_usage_logs").select("aix_type, line_message_id, sent_at, created_at, template_name, check_pattern, property_names, prop_statuses, estimate_sent, prop_cost_notes, generated_text").eq("conversation_id", conv).lte("created_at", cutIso).order("created_at", { ascending: false }).limit(30),
    sb.from("sent_facts").select("sent_at, origin, aix_type, kind, status, line_message_id, detail, evidence").eq("conversation_id", conv).lte("sent_at", cutIso).order("sent_at", { ascending: false }).limit(120),
    sb.from("calendar_events").select("title, event_type, start_at, end_at, all_day, is_done, done_at, created_at").eq("conversation_id", conv).lte("created_at", cutIso).gte("start_at", new Date(nowMs - 60 * 86_400_000).toISOString()).order("start_at", { ascending: true }).limit(40),
  ]);
  const msgs = (msgsR.data ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null }>;
  const aix = ((aixR.data ?? []) as Array<Record<string, unknown>>).map((a) => ({ ...a, sent_at: a.sent_at && String(a.sent_at) > cutIso ? null : a.sent_at })) as Array<{ aix_type: string | null; created_at: string; sent_at: string | null }>;
  const custMsgs = msgs.filter((m) => m.sender === "customer").slice(0, 40).reverse().map((m) => ({ text: m.text, atMs: Date.parse(m.created_at) })).filter((x) => Number.isFinite(x.atMs));
  // #663: 済みの時刻（done_at）がこの番より後の行は、この番では開いていた。done_at が無い古い行は今の is_done のまま
  const calAt = ((calR.data ?? []) as Array<Record<string, unknown> & { is_done?: boolean | null; done_at?: string | null }>).map((r) => ({ ...r, is_done: doneAsOf(r, nowMs) }));
  const timeline = buildTimeline({ customerMsgs: custMsgs, calendar: calAt as never, nowMs });
  const asc = [...msgs].reverse();
  const exchange = buildExchangeLedger({ msgs: asc, aix: aix.filter((a): a is typeof a & { aix_type: string } => !!a.aix_type) as never, nowMs });
  return buildSituationNow({ timeline, facts: (factsR.data ?? []) as never, aix: aix as never, exchange, clash: null, nowMs });
}
