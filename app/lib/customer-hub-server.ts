// app/lib/customer-hub-server.ts — お客様ごとの共通の状態（ハブ）の材料を DB から読む（読むだけ・書かない・LLM なし）。組み立ては customer-hub.ts
//   customer-state の材料は customer-state-server.loadCustomerStateInput をそのまま使う（作り直さない）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCustomerStateInput } from "@/app/lib/customer-state-server";
import { loadReapplyInfo } from "@/app/lib/reapply-customer-server";
import { loadReactionRows, assembleReactionInput } from "@/app/lib/reaction-negatives-server";
import { buildReactionNegatives, REACTION_RULE, type ReactionState } from "@/app/lib/reaction-negatives";
import { isTestConversation } from "@/app/lib/test-conversations";
import {
  buildCustomerHub, hubContradictions, renderCustomerHub, HUB_CONTRADICTION_JA,
  type HubInput, type CustomerHub, type HubContradiction, type HubContradictionType, type HubAixItem, type HubCalendarEvent, type HubActor,
} from "@/app/lib/customer-hub";
import type { LinkPickup, LinkMemoItem } from "@/app/lib/link-brain-watch";
import { maskPII } from "@/app/lib/pii-mask";

const DAY = 86_400_000;

/** 1会話の材料（会話が無い・customer-state の材料が読めない時は null） */
/**
 * 過去の時点（試し・監査）で組む時、customer-state の材料（今の最新の行を読む）から nowMs より後の行を外す。
 *   statusAt を渡すとその時点の状態（line_watch_turns.conv_status 等）を使う（今の status は後で変わっている事がある）
 */
export function clipStateToTime(state: NonNullable<Awaited<ReturnType<typeof loadCustomerStateInput>>>, nowMs: number, statusAt?: string | null): typeof state {
  const le = (s: string | null | undefined) => { const t = s ? Date.parse(s) : NaN; return !Number.isFinite(t) || t <= nowMs; };
  return {
    ...state,
    ...(statusAt !== undefined ? { status: statusAt, isPostApply: false } : {}),
    messages: state.messages.filter((m) => le(m.createdAt)),
    aixRows: state.aixRows.filter((r) => le(r.sent_at ?? r.created_at)),
    recordedFacts: (state.recordedFacts ?? []).filter((f) => le(f.sent_at)),
    viewingHistory: state.viewingHistory.filter((v) => le((v as { created_at?: string | null }).created_at)),
    sentProperties: state.sentProperties.filter((p) => le((p as { sent_at?: string | null }).sent_at)),
    lineTasks: (state.lineTasks ?? []).filter((t) => le(t.created_at)),
  };
}

/** pointInTime=true の時だけ「その時点」で組む（試し・監査だけが渡す。本番の呼び出しは渡さない＝前と同じ読み方・同じ結果） */
export type HubLoadOptions = { statusAt?: string | null; pointInTime?: boolean };
export async function loadCustomerHubInput(sb: SupabaseClient, conversationId: string, nowMs: number = Date.now(), o: HubLoadOptions = {}): Promise<HubInput | null> {
  const past = o.pointInTime === true;
  const since30 = new Date(nowMs - 30 * DAY).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  const calQ = sb.from("calendar_events").select("id, conversation_id, customer_name, event_type, start_at, created_at, notes, is_done, title, all_day")
    .eq("conversation_id", conversationId).gte("start_at", new Date(nowMs - 60 * DAY).toISOString());
  const [conv, state, items, pickups, cal, memo] = await Promise.all([
    sb.from("conversations").select("id, customer_name, account, status, is_post_apply, status_manual_back_at, property_customer_id").eq("id", conversationId).maybeSingle(),
    loadCustomerStateInput(conversationId, { now: nowMs }).catch(() => null),
    sb.from("aix_action_items").select("id, conversation_id, customer_name, action, check_pattern, status, created_at, updated_at, done_at, done_aix_type, done_by, resolution_note, dismissed_reason")
      .eq("conversation_id", conversationId).gte("created_at", since30).lte("created_at", nowIso).order("created_at").limit(300),
    sb.from("property_pickups").select("created_at, sent_at, expired_at, status, verdict, summary_text, search_conditions")
      .eq("conversation_id", conversationId).gte("created_at", since30).lte("created_at", nowIso).order("created_at").limit(500),
    (past ? calQ.lte("created_at", nowIso) : calQ).order("start_at").limit(200),
    sb.from("customer_memos").select("items").eq("conversation_id", conversationId).maybeSingle(),
  ]);
  const c = conv.data as (HubInput["conv"] & { property_customer_id: string | null }) | null;
  if (conv.error || !c || !state) return null;
  for (const [name, r] of [["aix_action_items", items], ["property_pickups", pickups], ["calendar_events", cal]] as const) if (r.error) throw new Error(`${name}: ${r.error.message}`);

  let reactions: ReactionState | null = null;
  if (c.property_customer_id) {
    try {
      const rows = await loadReactionRows(sb, c.property_customer_id, { sinceIso: new Date(nowMs - REACTION_RULE.maxAgeDays * DAY).toISOString(), untilIso: nowIso });
      reactions = buildReactionNegatives({ ...assembleReactionInput(rows), now: new Date(nowMs) });
    } catch { reactions = null; }
  }
  const reapply = await loadReapplyInfo(sb, conversationId);
  // 過去の時点で組む時（試し・監査）は、その時点より後の行を外し、後で片付いた要対応はその時点では開いていた物に戻す
  const st = past || o.statusAt !== undefined ? clipStateToTime(state, nowMs, o.statusAt) : state;
  const aixItems = ((items.data ?? []) as HubAixItem[]).map((i) => (past && i.status !== "pending" && i.done_at && Date.parse(i.done_at) > nowMs ? { ...i, status: "pending" as const, done_at: null } : i));
  const memoItems = (memo.data as { items?: unknown } | null)?.items;
  return {
    nowMs,
    conv: { id: c.id, customer_name: c.customer_name, account: c.account ?? null, status: o.statusAt !== undefined ? o.statusAt : c.status, is_post_apply: o.statusAt !== undefined ? false : c.is_post_apply, status_manual_back_at: c.status_manual_back_at },
    state: st,
    aixItems,
    pickups: (pickups.data ?? []) as LinkPickup[],
    calendarEvents: (cal.data ?? []) as HubCalendarEvent[],
    memoItems: Array.isArray(memoItems) ? (memoItems as LinkMemoItem[]) : [],
    reactions,
    reapply,
  };
}

/** 1会話のハブ（読めなければ null） */
export async function getCustomerHub(sb: SupabaseClient, conversationId: string, nowMs: number = Date.now(), o: HubLoadOptions = {}): Promise<{ hub: CustomerHub; contradictions: HubContradiction[]; input: HubInput } | null> {
  const input = await loadCustomerHubInput(sb, conversationId, nowMs, o);
  if (!input) return null;
  const hub = buildCustomerHub(input);
  return { hub, contradictions: hubContradictions(hub, input), input };
}

export async function renderCustomerHubFor(sb: SupabaseClient, conversationId: string, nowMs: number = Date.now()): Promise<string | null> {
  const r = await getCustomerHub(sb, conversationId, nowMs);
  return r ? renderCustomerHub(r.hub, { customerName: r.input.conv.customer_name, contradictions: r.contradictions }) : null;
}

// ───────── 14日の食い違いの数え（読むだけ） ─────────
export type HubAuditSummary = {
  days: number; conversations: number; failed: number; withContradiction: number;
  byType: Partial<Record<HubContradictionType, number>>;
  convByType: Partial<Record<HubContradictionType, number>>;
  actors: Record<HubActor, number>;
  flags: { reapply: number; rankWaiting: number; claudeOnly: number };
  samples: Array<{ conv: string; type: HubContradictionType; detail: string }>;
};

/** 直近 days 日にお客様の発言があった会話（テスト用の会話を除く） */
export async function activeConversationIds(sb: SupabaseClient, sinceIso: string, untilIso: string, max = 3000): Promise<string[]> {
  const ids = new Set<string>();
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id").eq("sender", "customer").gte("created_at", sinceIso).lte("created_at", untilIso)
      .order("created_at").order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ conversation_id: string }>) if (r.conversation_id && !isTestConversation(r.conversation_id)) ids.add(r.conversation_id);
    if (!data || data.length < 1000 || ids.size >= max) break;
  }
  return [...ids].slice(0, max);
}

export async function auditCustomerHubs(sb: SupabaseClient, o: { days?: number; nowMs?: number; limit?: number; ids?: ReadonlyArray<string>; concurrency?: number; samplesPerType?: number; onProgress?: (n: number, total: number) => void } = {}): Promise<HubAuditSummary> {
  const days = o.days ?? 14, nowMs = o.nowMs ?? Date.now(), per = o.samplesPerType ?? 3;
  const ids = (o.ids ? o.ids.filter((x) => !isTestConversation(x)) : await activeConversationIds(sb, new Date(nowMs - days * DAY).toISOString(), new Date(nowMs).toISOString())).slice(0, o.limit ?? Infinity);
  const sum: HubAuditSummary = { days, conversations: 0, failed: 0, withContradiction: 0, byType: {}, convByType: {}, actors: { brain: 0, aix: 0, staff: 0, none: 0 }, flags: { reapply: 0, rankWaiting: 0, claudeOnly: 0 }, samples: [] };
  let next = 0, done = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        const r = await getCustomerHub(sb, id, nowMs);
        if (!r) { sum.failed++; continue; }
        sum.conversations++;
        sum.actors[r.hub.actor.who]++;
        if (r.hub.flags.reapply) sum.flags.reapply++;
        if (r.hub.flags.rankWaiting) sum.flags.rankWaiting++;
        if (r.hub.flags.claudeOnly) sum.flags.claudeOnly++;
        if (r.contradictions.length) sum.withContradiction++;
        const seen = new Set<HubContradictionType>();
        for (const c of r.contradictions) {
          sum.byType[c.type] = (sum.byType[c.type] ?? 0) + 1;
          if (!seen.has(c.type)) { seen.add(c.type); sum.convByType[c.type] = (sum.convByType[c.type] ?? 0) + 1; }
          if (sum.samples.filter((x) => x.type === c.type).length < per) sum.samples.push({ conv: id.slice(0, 8), type: c.type, detail: maskPII(c.detail, [r.input.conv.customer_name]).slice(0, 90) });
        }
      } catch (e) {
        sum.failed++;
        console.warn("[customer-hub] audit:", id.slice(0, 8), e instanceof Error ? e.message : String(e));
      } finally { o.onProgress?.(++done, ids.length); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker));
  return sum;
}

export function renderHubAudit(s: HubAuditSummary): string {
  const L = [`ハブの食い違い 直近${s.days}日（会話 ${s.conversations}・読めない ${s.failed}・食い違いあり ${s.withContradiction}）`];
  for (const [t, n] of Object.entries(s.byType).sort((a, b) => b[1] - a[1])) {
    L.push(`■ ${HUB_CONTRADICTION_JA[t as HubContradictionType]}: ${n}件（会話 ${s.convByType[t as HubContradictionType] ?? 0}）`);
    for (const x of s.samples.filter((y) => y.type === t)) L.push(`    例 ${x.conv} ${x.detail}`);
  }
  L.push(`誰が動く: ブレイン ${s.actors.brain}・AIX ${s.actors.aix}・スタッフ ${s.actors.staff}・なし ${s.actors.none}`);
  L.push(`印: 申込歴あり ${s.flags.reapply}・2番手並行 ${s.flags.rankWaiting}・審査の事情(Claudeだけ) ${s.flags.claudeOnly}`);
  return L.join("\n");
}
