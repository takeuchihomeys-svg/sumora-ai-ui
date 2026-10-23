// app/lib/link-conductor-server.ts — つなぎのブレイン 段3 司令塔の材料を読み、決める（読むだけ・書かない）。決め方は link-conductor.ts
//   ハブ（customer-hub-server.getCustomerHub）を読んで conductCustomer に渡すだけ。flash（DeepSeek）は迷いの時だけ・候補の札と段階だけを渡す
//   （お客様の文・名前は渡さない。審査の事情がある会話は聞かない＝PII → Claude だけ）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCustomerHub } from "@/app/lib/customer-hub-server";
import {
  conductCustomer, renderConductorBrainNote, linkConductorBrainEnabled, tieBreakPrompt, parseTieBreak, countDecisions,
  type ConductorDecision, type ConductorTieBreaker, type ConductorCounts,
} from "@/app/lib/link-conductor";
import type { CustomerHub, HubContradiction, HubInput } from "@/app/lib/customer-hub";
import { hubBrainNote, linkHubBrainEnabled } from "@/app/lib/link-hub-brain";
import { isTestConversation } from "@/app/lib/test-conversations";
import { currentReplayFloor } from "@/app/lib/test-replay-floor";

/** 非同期の flash（迷いの時だけ呼ばれる） */
export type AsyncTieBreaker = (q: Parameters<ConductorTieBreaker>[0]) => Promise<number | null>;

/** 迷った時だけ非同期の flash に聞いて決める（迷わなければ呼ばない） */
export async function conductWithFlash(hub: CustomerHub, contradictions: ReadonlyArray<HubContradiction>, input: HubInput, flash?: AsyncTieBreaker | null): Promise<{ decision: ConductorDecision; flashCalled: boolean }> {
  const box: { q: Parameters<ConductorTieBreaker>[0] | null } = { q: null };
  const first = conductCustomer(hub, contradictions, input, { tieBreaker: flash ? (q) => { box.q = q; return null; } : null });
  if (!flash || !first.hesitant || !box.q) return { decision: first, flashCalled: false };
  let pick: number | null = null;
  try { pick = await flash(box.q); } catch { pick = null; }
  if (pick == null) return { decision: first, flashCalled: true };
  return { decision: conductCustomer(hub, contradictions, input, { tieBreaker: () => pick }), flashCalled: true };
}

/** DeepSeek flash の迷い決め（鍵が無ければ null＝点の順）。usage を受け取る口つき */
export function deepseekTieBreaker(o: { onUsage?: (u: { input: number; output: number; cacheHit: number }) => void } = {}): AsyncTieBreaker | null {
  if (!(process.env.DEEPSEEK_API_KEY ?? "").trim()) return null;
  return async (q) => {
    const { callDeepSeekRead } = await import("@/app/lib/vision-alt-provider");
    const p = tieBreakPrompt(q);
    const r = await callDeepSeekRead(p.system, p.user, { maxTokens: 80, timeoutMs: 20_000 }, (t) => parseTieBreak(t, q.candidates.length));
    for (const a of r.attempts) if (a.res) o.onUsage?.({ input: a.res.usage.input, output: a.res.usage.output, cacheHit: a.res.usage.cacheHit ?? 0 });
    return r.value;
  };
}

/** 1会話の決定（読めなければ null） */
export async function getConductorDecision(sb: SupabaseClient, conversationId: string, nowMs: number = Date.now(), o: { flash?: AsyncTieBreaker | null; statusAt?: string | null; pointInTime?: boolean } = {}): Promise<{ decision: ConductorDecision; hub: CustomerHub; contradictions: HubContradiction[]; input: HubInput; flashCalled: boolean } | null> {
  const r = await getCustomerHub(sb, conversationId, nowMs, { ...(o.statusAt !== undefined ? { statusAt: o.statusAt } : {}), ...(o.pointInTime ? { pointInTime: true } : {}) });
  if (!r) return null;
  const { decision, flashCalled } = await conductWithFlash(r.hub, r.contradictions, r.input, o.flash ?? null);
  return { decision, hub: r.hub, contradictions: r.contradictions, input: r.input, flashCalled };
}

/**
 * LINE のブレインの材料（LINK_CONDUCTOR_BRAIN=on の時だけ・既定 off＝1文字も変わらない）。読めない・時間切れは空。
 *   ここは flash を使わない（決まった計算だけ・$0）
 */
export async function conductorBrainNoteIfEnabled(sb: SupabaseClient, conversationId: string, nowMs: number, customerName?: string | null, timeoutMs = 6_000): Promise<string> {
  if (!linkConductorBrainEnabled()) return "";
  try {
    const r = await Promise.race([getConductorDecision(sb, conversationId, nowMs), new Promise<null>((res) => setTimeout(() => res(null), timeoutMs))]);
    return r ? renderConductorBrainNote(r.decision, customerName ?? r.input.conv.customer_name) : "";
  } catch (e) {
    console.warn("[link-conductor] brain note:", e instanceof Error ? e.message : String(e));
    return "";
  }
}

/**
 * 2026-10-24 弱い所4: つなぎの芯の「今の番の前から開いている事」（要対応・約束の並び・【必ず】・連絡日）を LINE のブレインの材料に（LINK_HUB_BRAIN=on の時だけ・既定 off＝空）。
 *   決まった計算だけ・LLM なし・$0。読めない・時間切れは空。形と理由は link-hub-brain.ts。
 *   テストの会話で試験の線のファイルに hubSource がある時は、その番の時点の元の会話から組む（写しは要対応・カレンダーを持たない・読むだけ）
 */
export async function hubBrainNoteIfEnabled(sb: SupabaseClient, conversationId: string, nowMs: number, timeoutMs = 6_000): Promise<string> {
  if (!linkHubBrainEnabled()) return "";
  try {
    let src = conversationId, at = nowMs, pointInTime = false, statusAt: string | undefined;
    if (isTestConversation(conversationId)) {
      const f = currentReplayFloor();
      if (f && f.conversationId === conversationId && f.hubSource) { src = f.hubSource.conversationId; at = Date.parse(f.hubSource.at) + 1_000; pointInTime = true; statusAt = f.status ?? "proposing"; } // 番の発言の直後（+60秒だと速いスタッフの返信が入り、今の番の要対応が混ざる）・状態は試験の場面の状態（後で申込になった会話を申込以降と読まない）
    }
    const r = await Promise.race([getCustomerHub(sb, src, at, pointInTime ? { pointInTime: true, statusAt } : {}), new Promise<null>((res) => setTimeout(() => res(null), timeoutMs))]);
    return r ? hubBrainNote(r.hub, r.contradictions, r.input) : "";
  } catch (e) {
    console.warn("[link-hub-brain] brain note:", e instanceof Error ? e.message : String(e));
    return "";
  }
}

/** 会話ごとの決定（やることリスト・見張り用。時間の上限を過ぎた分は読まない） */
export async function loadConductorDecisions(sb: SupabaseClient, ids: ReadonlyArray<string>, nowMs: number, o: { budgetMs?: number; concurrency?: number } = {}): Promise<Map<string, ConductorDecision>> {
  const out = new Map<string, ConductorDecision>();
  const deadline = Date.now() + (o.budgetMs ?? 20_000);
  let next = 0;
  const worker = async () => {
    while (next < ids.length && Date.now() < deadline) {
      const id = ids[next++];
      try { const r = await getConductorDecision(sb, id, nowMs); if (r) out.set(id, r.decision); }
      catch (e) { console.warn("[link-conductor]", id.slice(0, 8), e instanceof Error ? e.message : String(e)); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 6) }, worker));
  return out;
}

export async function auditConductor(sb: SupabaseClient, ids: ReadonlyArray<string>, nowMs: number, o: { budgetMs?: number } = {}): Promise<ConductorCounts> {
  const ds = await loadConductorDecisions(sb, ids, nowMs, { budgetMs: o.budgetMs ?? 120_000, concurrency: 4 });
  return countDecisions([...ds.values()]);
}
