// app/lib/unknowns-intake-server.ts — 分からない事の表の抜けていた入口の読み（サーバーの鍵・夜の cron link-brain-watch から・LLM なし・$0）
//   2026-11-05 作業員1（KB 3892c30c・統括役の指示 ①②）。読みはどれも窓の分だけ・1000行ずつの頁（本番の DB は1回 1000行で切れる）。
import type { SupabaseClient } from "@supabase/supabase-js";
import type { UnknownHit } from "./brain-unknowns";
import { prodMissHits, selfReportHits, unknownsPostApplyGateOn, selfReportPostApply, rejectionSwitchKeep, isRejectionMessage, type ProdTurn, type DigestSelfReport } from "./unknowns-intake";
import { loadTurnApplicationRecords } from "./turn-application-gate-server";
import { turnApplicationReason } from "./turn-application-gate";
import { DRAFT_SKIP_STATUSES } from "./conversation-status";
import { staffFirstMove, aixLogsFromWatch, staffMoveExclusion, ackSceneOf } from "./staff-first-move";
import { isTestConversation } from "./test-conversations";

const PAGE = 1000;
const MAX_ROWS = 20_000;

/** ② ブレインの自己申告（digest.mm・digest.mx）を窓の分だけ */
export async function loadSelfReportHits(sb: SupabaseClient, fromIso: string, toIso: string): Promise<UnknownHit[]> {
  const rows: Array<DigestSelfReport & { status: string | null }> = [];
  for (let off = 0; off < MAX_ROWS; off += PAGE) {
    const { data, error } = await sb.from("brain_decision_logs").select("conversation_id, created_at, conversation_status, mm:digest->mm, mx:digest->mx")
      .gte("created_at", fromIso).lt("created_at", toIso).order("created_at", { ascending: true }).range(off, off + PAGE - 1);
    if (error) throw new Error(`brain_decision_logs: ${error.message}`);
    const pg = (data ?? []) as Array<{ conversation_id: string | null; created_at: string; conversation_status: string | null; mm: unknown; mx: unknown }>;
    for (const r of pg) if (!r.conversation_id || !isTestConversation(r.conversation_id)) rows.push({ conversationId: r.conversation_id, at: r.created_at, mm: r.mm, mx: r.mx, status: r.conversation_status });
    if (pg.length < PAGE) break;
  }
  // 2026-11-13 申込以降の番は入れない（BRAIN_UNKNOWNS_POST_APPLY_GATE=on の時だけ・会話ごとに申込の記録を1回読む＝夜の窓で十数会話）
  if (!unknownsPostApplyGateOn()) return selfReportHits(rows);
  const recs = new Map<string, Awaited<ReturnType<typeof loadTurnApplicationRecords>>>();
  // 2026-11-14 作業員G: 審査落ちの切り替えの番は数える（否決の通の時刻を会話ごとに1回・語で絞って最大30通）
  const fails = new Map<string, string[]>();
  const loadFails = async (cid: string): Promise<string[]> => {
    if (fails.has(cid)) return fails.get(cid)!;
    let ats: string[] = [];
    try {
      const { data } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", cid)
        .or("text.ilike.%否決%,text.ilike.%落ち%,text.ilike.%通ら%,text.ilike.%通りませ%,text.ilike.%承認%,text.ilike.%期待に添え%").order("created_at", { ascending: false }).limit(30);
      ats = ((data ?? []) as Array<{ sender: string | null; text: string | null; created_at: string }>).filter(isRejectionMessage).map((m) => m.created_at);
    } catch { ats = []; }
    fails.set(cid, ats);
    return ats;
  };
  const kept: DigestSelfReport[] = [];
  let dropped = 0, switchKept = 0;
  for (const r of rows) {
    if (!(Array.isArray(r.mm) && r.mm.length) && !(Array.isArray(r.mx) && r.mx.length)) continue;
    let gate: string | null = null;
    if (r.conversationId) {
      if (!recs.has(r.conversationId)) recs.set(r.conversationId, await loadTurnApplicationRecords(sb, r.conversationId));
      gate = turnApplicationReason(recs.get(r.conversationId), r.at);
    }
    if (selfReportPostApply(r.status, gate, DRAFT_SKIP_STATUSES)) {
      const rec = r.conversationId ? recs.get(r.conversationId) : undefined;
      const times = (rec?.records ?? []).flatMap((x) => [x.first, x.last]);
      if (r.conversationId && rec && !rec.unreadable && rejectionSwitchKeep(times, await loadFails(r.conversationId), r.at)) { switchKept++; kept.push(r); continue; }
      dropped++; continue;
    }
    kept.push(r);
  }
  console.log(JSON.stringify({ tag: "unknowns:self-report-post-apply-gate", rows: rows.length, dropped, switchKept, kept: kept.length }));
  return selfReportHits(kept);
}

/**
 * ① 本番の竹内さん本人の番の外れ。番は「窓の1日前」の分（スタッフの返事が出揃ってから数える）＝窓をずらせば二重に数えない。
 *   一手は staff-first-move（番の後の最初の送信・AIX ならその近くに押した AIX の種類）。2択はどちらかが同じなら外れにしない。
 */
export async function loadProdMissHits(sb: SupabaseClient, fromIso: string, toIso: string): Promise<UnknownHit[]> {
  const lagFrom = new Date(Date.parse(fromIso) - 86_400_000).toISOString(), lagTo = new Date(Date.parse(toIso) - 86_400_000).toISOString();
  type W = { id: number; conversation_id: string; customer_turn_at: string; brain_action: string | null; decision_id: string | null; staff_aix: unknown; scene_key?: string | null };
  const turns: W[] = [];
  for (let off = 0; off < MAX_ROWS; off += PAGE) {
    const { data, error } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, brain_action, decision_id, staff_aix, scene_key")
      .gte("customer_turn_at", lagFrom).lt("customer_turn_at", lagTo).not("decision_id", "is", null).order("id", { ascending: true }).range(off, off + PAGE - 1);
    if (error) throw new Error(`line_watch_turns: ${error.message}`);
    const pg = (data ?? []) as W[];
    turns.push(...pg.filter((w) => !isTestConversation(w.conversation_id)));
    if (pg.length < PAGE) break;
  }
  if (!turns.length) return [];
  // 2択（digest.tc === true）
  const tc = new Set<string>();
  const ids = [...new Set(turns.map((w) => String(w.decision_id)))];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from("brain_decision_logs").select("id, tc:digest->tc, tw:digest->tw").in("id", ids.slice(i, i + 200));
    if (error) throw new Error(`brain_decision_logs tc: ${error.message}`);
    for (const d of (data ?? []) as Array<{ id: string; tc: unknown; tw?: unknown }>) if (d.tw === true || d.tc === true || d.tc === "true") tc.add(String(d.id)); // 2026-11-06 2択の印は tw（旧の行は tc=true）
  }
  // こちらの送信（書き手・AIX か）。会話100ずつ・1000行ずつの頁
  const convs = [...new Set(turns.map((w) => w.conversation_id))];
  const staff = new Map<string, Array<{ at: number; writer: string | null; isAix: boolean }>>();
  const sendTo = new Date(Date.parse(lagTo) + 86_400_000).toISOString();
  for (let i = 0; i < convs.length; i += 100) {
    for (let off = 0; off < MAX_ROWS; off += PAGE) {
      const { data, error } = await sb.from("messages").select("conversation_id, created_at, staff_writer, is_aix_generated")
        .in("conversation_id", convs.slice(i, i + 100)).neq("sender", "customer").gte("created_at", lagFrom).lt("created_at", sendTo)
        .order("created_at", { ascending: true }).range(off, off + PAGE - 1);
      if (error) throw new Error(`messages: ${error.message}`);
      const pg = (data ?? []) as Array<{ conversation_id: string; created_at: string; staff_writer: string | null; is_aix_generated: boolean | null }>;
      for (const m of pg) { const a = staff.get(m.conversation_id) ?? []; a.push({ at: Date.parse(m.created_at), writer: m.staff_writer ?? null, isAix: !!m.is_aix_generated }); staff.set(m.conversation_id, a); }
      if (pg.length < PAGE) break;
    }
  }
  // 2026-11-07 作業員1: 後で送った AIX・お礼の番の約束の果たしはブレインの外れに入れない（staffMoveExclusion・WATCH_COUNT_LATE_AIX=off で前の数え）
  const prod: ProdTurn[] = turns.flatMap((w) => {
    const fm = staffFirstMove(Date.parse(w.customer_turn_at), staff.get(w.conversation_id) ?? [], aixLogsFromWatch(w.staff_aix as never));
    if (staffMoveExclusion(Date.parse(w.customer_turn_at), fm, { ackOnly: ackSceneOf(w.scene_key) })) return [];
    return [{ turnId: w.id, conversationId: w.conversation_id, at: w.customer_turn_at, brainAction: w.brain_action, twoChoice: tc.has(String(w.decision_id)),
      staffWriter: fm?.writer ?? null, staffMove: fm ? { kind: fm.kind, aix: fm.aix } : null }];
  });
  return prodMissHits(prod);
}

/** 毎朝の見張りの1行の数（開いている数と24時間で新しく増えた数）。cron の結果に残し、手元の hazard-audit が cron_run_logs から読む */
export async function unknownsOpenCounts(sb: SupabaseClient, nowMs = Date.now()): Promise<{ weak_open: number; weak_new24h: number; unknown_rows: number; unknown_new24h: number; owner_open: number; weak_tier_guess?: number; weak_no_next?: number; weak_tier_check?: number }> {
  const since = new Date(nowMs - 86_400_000).toISOString();
  const cnt = async (q: PromiseLike<{ count: number | null; error: { message: string } | null }>) => { const r = await q; if (r.error) throw new Error(r.error.message); return r.count ?? 0; };
  return {
    weak_open: await cnt(sb.from("brain_weaknesses").select("id", { count: "exact", head: true }).in("status", ["open", "in_progress"])),
    weak_new24h: await cnt(sb.from("brain_weaknesses").select("id", { count: "exact", head: true }).gte("first_seen", since)),
    unknown_rows: await cnt(sb.from("brain_unknowns").select("id", { count: "exact", head: true })),
    unknown_new24h: await cnt(sb.from("brain_unknowns").select("id", { count: "exact", head: true }).gte("first_at", since)),
    owner_open: await cnt(sb.from("owner_questions").select("id", { count: "exact", head: true }).eq("status", "open")),
    // 2026-11-13 作業員1: 入る時点の印（推定の印のままの行・具体の次の一手が空の行・要確認）＝統括役が持ち主に次の一手を書かせる
    weak_tier_guess: await cnt(sb.from("brain_weaknesses").select("id", { count: "exact", head: true }).in("status", ["open", "in_progress"]).eq("evidence->>tier_guess", "true")),
    weak_no_next: await cnt(sb.from("brain_weaknesses").select("id", { count: "exact", head: true }).in("status", ["open", "in_progress"]).is("evidence->>next", null)),
    weak_tier_check: await cnt(sb.from("brain_weaknesses").select("id", { count: "exact", head: true }).in("status", ["open", "in_progress"]).eq("evidence->>tier", "要確認")),
  };
}
