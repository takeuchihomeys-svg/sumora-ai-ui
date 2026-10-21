// app/lib/link-brain-watch-server.ts — つなぎのブレインの見張りの材料を DB から読む（読むだけ・LLM なし）。判定は link-brain-watch.ts
//   ⚠ PostgREST は1回 1000行まで → 多くなり得る読みは1000行ずつ
import type { SupabaseClient } from "@supabase/supabase-js";
import { isTestConversation } from "@/app/lib/test-conversations";
import {
  watchLinks, type LinkConvInput, type LinkWatchSummary, type LinkWindow, type LinkConversation, type LinkMessage, type LinkAixLog,
  type LinkFact, type LinkTurn, type LinkAixItem, type LinkPickup, type LinkJudgment, type LinkMemoItem,
} from "@/app/lib/link-brain-watch";

const DAY = 86_400_000;
const PAGE = 1000;
type PageQuery = (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
async function pageAll<T>(q: PageQuery, maxRows = 200_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < maxRows; from += PAGE) {
    const { data, error } = await q(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}
const groupBy = <T>(rows: ReadonlyArray<T>, key: (r: T) => string | null | undefined) => {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = key(r); if (!k) continue; const a = m.get(k); if (a) a.push(r); else m.set(k, [r]); }
  return m;
};

/**
 * 窓 [fromMs, toMs) の見張りの材料。約束は熟す時間（72時間）と約束の並びの読む範囲（7日）があるので、
 *   起点は from の 11日前から読む（約束→結果の道を途中で切らない）
 */
export async function loadLinkWatchInputs(sb: SupabaseClient, w: LinkWindow): Promise<LinkConvInput[]> {
  const since = new Date(w.fromMs - 11 * DAY).toISOString();
  const nowIso = new Date(w.nowMs).toISOString();
  type Mrow = LinkMessage & { conversation_id: string };
  type Lrow = LinkAixLog & { conversation_id: string };
  type Frow = LinkFact & { conversation_id: string };
  type Trow = LinkTurn & { conversation_id: string };
  type Irow = LinkAixItem & { conversation_id: string };
  type Prow = LinkPickup & { conversation_id: string | null; property_customer_id: string | null };
  const [msgs, logs, facts, turns, items, pickups] = await Promise.all([
    pageAll<Mrow>((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated")
      .gte("created_at", since).lte("created_at", nowIso).order("created_at").order("id").range(a, b)),
    pageAll<Lrow>((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, sent_at, created_at, estimate_sent, generated_text")
      .gte("created_at", since).lte("created_at", nowIso).not("aix_type", "is", null).order("created_at").order("id").range(a, b)),
    pageAll<Frow>((a, b) => sb.from("sent_facts").select("conversation_id, kind, status, sent_at, detail")
      .gte("sent_at", since).lte("sent_at", nowIso).in("kind", ["pickup_declared", "properties_sent"]).order("sent_at").order("id").range(a, b)),
    pageAll<Trow>((a, b) => sb.from("line_watch_turns").select("conversation_id, customer_turn_at, brain_action, brain_check_pattern, staff_first_at, brain_at, staff_aix, staff_texts")
      .gte("customer_turn_at", new Date(w.fromMs - 4 * DAY).toISOString()).lte("customer_turn_at", nowIso).order("customer_turn_at").order("id").range(a, b)),
    pageAll<Irow>((a, b) => sb.from("aix_action_items").select("conversation_id, action, check_pattern, status, created_at, done_at, resolution_note, dismissed_reason")
      .gte("created_at", since).lte("created_at", nowIso).order("created_at").order("id").range(a, b)),
    pageAll<Prow>((a, b) => sb.from("property_pickups").select("conversation_id, property_customer_id, created_at, sent_at, expired_at, status, verdict, summary_text, search_conditions")
      .gte("created_at", since).lte("created_at", nowIso).order("created_at").order("id").range(a, b)),
  ]);

  const msgBy = groupBy(msgs, (r) => r.conversation_id);
  const ids = [...msgBy.keys()].filter((id) => !isTestConversation(id));
  const convs: Array<LinkConversation> = [];
  const memos: Array<{ conversation_id: string; items: LinkMemoItem[] | null }> = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const [c, m] = await Promise.all([
      sb.from("conversations").select("id, customer_name, status, status_manual_back_at").in("id", chunk),
      sb.from("customer_memos").select("conversation_id, items").in("conversation_id", chunk),
    ]);
    if (c.error) throw new Error(c.error.message);
    convs.push(...((c.data ?? []) as LinkConversation[]));
    if (!m.error) memos.push(...((m.data ?? []) as typeof memos)); // メモの表が読めない環境はメモ無しで数える
  }

  // ブレインの物件の見立て（profile_snapshot）は property_customer_id でしか引けない → 会話の物件の顧客から
  const pcToConv = new Map<string, string>();
  for (const p of pickups) if (p.property_customer_id && p.conversation_id) pcToConv.set(p.property_customer_id, p.conversation_id);
  const pcIds = [...pcToConv.keys()];
  const judgments: Array<LinkJudgment & { property_customer_id: string }> = [];
  for (let i = 0; i < pcIds.length; i += 100) {
    judgments.push(...await pageAll<LinkJudgment & { property_customer_id: string }>((a, b) => sb.from("property_brain_judgments")
      .select("property_customer_id, created_at, profile_snapshot").in("property_customer_id", pcIds.slice(i, i + 100))
      .gte("created_at", since).eq("rank", 1).order("created_at").order("id").range(a, b), 20_000));
  }

  const logBy = groupBy(logs, (r) => r.conversation_id);
  const factBy = groupBy(facts, (r) => r.conversation_id);
  const turnBy = groupBy(turns, (r) => r.conversation_id);
  const itemBy = groupBy(items, (r) => r.conversation_id);
  const pickBy = groupBy(pickups, (r) => r.conversation_id);
  const judgBy = groupBy(judgments, (r) => pcToConv.get(r.property_customer_id));
  const memoBy = new Map(memos.map((m) => [m.conversation_id, Array.isArray(m.items) ? m.items : []]));
  return convs.map((conv) => ({
    conv,
    messages: msgBy.get(conv.id) ?? [],
    aixLogs: logBy.get(conv.id) ?? [],
    facts: factBy.get(conv.id) ?? [],
    turns: turnBy.get(conv.id) ?? [],
    aixItems: itemBy.get(conv.id) ?? [],
    pickups: pickBy.get(conv.id) ?? [],
    judgments: judgBy.get(conv.id) ?? [],
    memoItems: memoBy.get(conv.id) ?? [],
  }));
}

export async function runLinkWatch(sb: SupabaseClient, w: LinkWindow, o: { examplesPerType?: number } = {}): Promise<LinkWatchSummary> {
  return watchLinks(await loadLinkWatchInputs(sb, w), w, o);
}
