// app/lib/auto-search-plan-server.ts（サーバー専用・DB を読むだけ・書かない）
// 自動便の状態の判定（auto-search-plan.classifyAutoSearchState）の材料を読む:
//   実際にお客様へ届けた送付（sent_properties・isProposalSend・お客様 or 会話で読む）／お客様の最後の発言（messages.sender=customer）／
//   条件の最後の変更（property_condition_history）／サイトごとの前回の検索（search_audits・search-update-days-server と同じ）。
// last_property_sent_at は読まない（merge-pdfs が自動検索の回でも今に書く＝状態の判定に使うと自分で「最近送った人」を作り直す）。
// 送付が読めない時は first_proposal_at=undefined（その人は off）。全体が読めない時は投げる（呼ぶ側が今までの選び方に戻す）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { isProposalSend, type SentLite } from "./pickup-ad-priority";
import { lastCompleteSearches } from "./search-update-days-server";
import type { AutoSearchStateInput } from "./auto-search-plan";

/** 発言・条件の変更を見る範囲（止まっている判定は8日・対象外は30日なので余裕を持って） */
const LOOKBACK_DAYS = 45;
const CHUNK = 50;

type Cust = { id: string; status?: string | null; created_at?: string | null; desired_area?: string | null; area?: string | null };

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** お客様 → 会話（conversations.property_customer_id） */
async function conversationsOf(sb: SupabaseClient, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const part of chunks(ids, CHUNK)) {
    const { data, error } = await sb.from("conversations").select("id, property_customer_id").in("property_customer_id", part);
    if (error) throw new Error(`会話を読めない: ${error.message}`);
    for (const r of (data ?? []) as Array<{ id: string; property_customer_id: string | null }>) {
      if (!r.property_customer_id) continue;
      const l = out.get(r.property_customer_id) ?? [];
      l.push(String(r.id));
      out.set(r.property_customer_id, l);
    }
  }
  return out;
}

type SentRow = SentLite & { property_customer_id: string | null; conversation_id: string | null };

/** 送付の行（お客様 or 会話）。お客様に届けた送付（delivery=customer／古い行の null）だけ・ページを送って全部読む */
async function sendsOf(sb: SupabaseClient, ids: string[], convIds: string[]): Promise<SentRow[]> {
  const out: SentRow[] = [];
  const seen = new Set<string>();
  const readAll = async (col: "property_customer_id" | "conversation_id", vals: string[]) => {
    for (const part of chunks(vals, CHUNK)) {
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from("sent_properties").select("id, property_customer_id, conversation_id, sent_at, channel, delivery, source")
          .in(col, part).order("sent_at", { ascending: true }).range(from, from + 999);
        if (error) throw new Error(`送付を読めない: ${error.message}`);
        const rows = (data ?? []) as Array<SentRow & { id: string }>;
        for (const r of rows) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          if (r.delivery == null || r.delivery === "customer") out.push(r);
        }
        if (rows.length < 1000) break;
      }
    }
  };
  await readAll("property_customer_id", ids);
  if (convIds.length) await readAll("conversation_id", convIds);
  return out;
}

/** 会話ごとのお客様の最後の発言（LOOKBACK_DAYS の中）。20会話ずつ新しい順に読み、上限に当たった会話は1件ずつ読み直す */
async function lastCustomerMessages(sb: SupabaseClient, convIds: string[], nowMs: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const since = new Date(nowMs - LOOKBACK_DAYS * 86400_000).toISOString();
  for (const part of chunks(convIds, 20)) {
    const { data, error } = await sb.from("messages").select("conversation_id, created_at")
      .in("conversation_id", part).eq("sender", "customer").gte("created_at", since)
      .order("created_at", { ascending: false }).limit(1000);
    if (error) throw new Error(`発言を読めない: ${error.message}`);
    const rows = (data ?? []) as Array<{ conversation_id: string; created_at: string }>;
    for (const r of rows) if (!out.has(String(r.conversation_id))) out.set(String(r.conversation_id), r.created_at);
    if (rows.length >= 1000) {
      for (const c of part.filter((x) => !out.has(x))) {
        const { data: one } = await sb.from("messages").select("created_at").eq("conversation_id", c).eq("sender", "customer")
          .gte("created_at", since).order("created_at", { ascending: false }).limit(1);
        const v = (one as Array<{ created_at: string }> | null)?.[0]?.created_at;
        if (v) out.set(c, v);
      }
    }
  }
  return out;
}

async function lastConditionChangesOf(sb: SupabaseClient, ids: string[], nowMs: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const since = new Date(nowMs - LOOKBACK_DAYS * 86400_000).toISOString();
  for (const part of chunks(ids, CHUNK)) {
    const { data, error } = await sb.from("property_condition_history").select("property_customer_id, created_at")
      .in("property_customer_id", part).gte("created_at", since).order("created_at", { ascending: false }).limit(2000);
    if (error) throw new Error(`条件の履歴を読めない: ${error.message}`);
    for (const r of (data ?? []) as Array<{ property_customer_id: string | null; created_at: string | null }>) {
      const id = String(r.property_customer_id ?? "");
      if (!id || !r.created_at) continue;
      if (!out.has(id) || out.get(id)! < r.created_at) out.set(id, r.created_at);
    }
  }
  return out;
}

/**
 * 2026-09-30 午後の便の選び方: 今日（JST の0時から）の検索で「通す」になった候補の数（property_pickups verdict=pass）。
 *   読めない時は null を返す（呼ぶ側は pass_today=undefined＝午後は回す）
 */
async function passTodayOf(sb: SupabaseClient, ids: string[], nowMs: number): Promise<Map<string, number> | null> {
  try {
    const mid = new Date(Date.parse(`${new Date(nowMs + 9 * 3600_000).toISOString().slice(0, 10)}T00:00:00+09:00`)).toISOString();
    const out = new Map<string, number>();
    for (const part of chunks(ids, CHUNK)) {
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from("property_pickups").select("id, property_customer_id")
          .in("property_customer_id", part).eq("verdict", "pass").gte("created_at", mid).order("created_at", { ascending: true }).range(from, from + 999);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as Array<{ property_customer_id: string | null }>;
        for (const r of rows) if (r.property_customer_id) out.set(String(r.property_customer_id), (out.get(String(r.property_customer_id)) ?? 0) + 1);
        if (rows.length < 1000) break;
      }
    }
    return out;
  } catch (e) {
    console.warn("[auto-search-plan] 今日の候補を読めない（午後は回す）:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

const maxIso = (a: string | null | undefined, b: string | null | undefined) => (!a ? b ?? null : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b);

/** 状態の判定の材料をまとめて読む（候補のお客様＝対象外の状態・条件なしの人も含めてよい＝判定が off にする） */
export async function loadStateInputs(sb: SupabaseClient, customers: ReadonlyArray<Cust>, nowMs: number = Date.now()): Promise<AutoSearchStateInput[]> {
  const live = customers.filter((c) => c?.id);
  const ids = live.map((c) => String(c.id));
  if (!ids.length) return [];
  const convOf = await conversationsOf(sb, ids);
  const convIds = [...new Set([...convOf.values()].flat())];
  const custOfConv = new Map<string, string>();
  for (const [cid, cs] of convOf) for (const v of cs) custOfConv.set(v, cid);
  const [sends, lastMsg, changes, lastSearch, passToday] = await Promise.all([
    sendsOf(sb, ids, convIds),
    lastCustomerMessages(sb, convIds, nowMs),
    lastConditionChangesOf(sb, ids, nowMs),
    lastCompleteSearches(sb, ids, { nowMs }),
    passTodayOf(sb, ids, nowMs),
  ]);
  const first = new Map<string, string>();
  const last = new Map<string, string>();
  for (const s of sends) {
    if (!s.sent_at || !isProposalSend(s) || !Number.isFinite(Date.parse(s.sent_at))) continue;
    const owners = new Set<string>();
    if (s.property_customer_id) owners.add(String(s.property_customer_id));
    if (s.conversation_id && custOfConv.has(String(s.conversation_id))) owners.add(custOfConv.get(String(s.conversation_id))!);
    for (const o of owners) {
      if (!first.has(o) || Date.parse(first.get(o)!) > Date.parse(s.sent_at)) first.set(o, s.sent_at);
      if (!last.has(o) || Date.parse(last.get(o)!) < Date.parse(s.sent_at)) last.set(o, s.sent_at);
    }
  }
  return live.map((c) => {
    const id = String(c.id);
    let msg: string | null = null;
    for (const cv of convOf.get(id) ?? []) msg = maxIso(msg, lastMsg.get(cv) ?? null);
    return {
      id, status: c.status ?? null, created_at: c.created_at ?? null,
      has_condition: !!(c.desired_area || c.area),
      first_proposal_at: first.get(id) ?? null,
      last_proposal_at: last.get(id) ?? null,
      last_customer_msg_at: msg,
      last_condition_change_at: changes.get(id) ?? null,
      last_search_by_site: lastSearch.get(id) ?? null,
      pass_today: passToday ? passToday.get(id) ?? 0 : undefined,
    };
  });
}

/** 1人分の「最初にご提案を届けた時刻」（広げての chain の新規／送った後の見分け）。読めない時は undefined */
export async function firstProposalAtFor(sb: SupabaseClient, customerId: string): Promise<string | null | undefined> {
  try {
    const convOf = await conversationsOf(sb, [customerId]);
    const sends = await sendsOf(sb, [customerId], convOf.get(customerId) ?? []);
    let best: string | null = null;
    for (const s of sends) if (s.sent_at && isProposalSend(s) && (!best || Date.parse(s.sent_at) < Date.parse(best))) best = s.sent_at;
    return best;
  } catch (e) {
    console.warn("[auto-search-plan] 送付を読めない:", e instanceof Error ? e.message : String(e));
    return undefined;
  }
}
