// scripts/lib/prod-yardstick-db.ts — 本番の物差しの DB の読み（読むだけ・LLM なし）。毎晩の cron（app/api/cron/prod-yardstick）と手元の台本（scripts/prod-yardstick-night.ts）が同じ物を使う
//   2026-11-05 作業員8（統括役の了承の 2・3）。1000行ずつの頁で読む（点検表 3）
import type { SupabaseClient } from "@supabase/supabase-js";
import { isTestConversation } from "../../app/lib/test-conversations";
import { staffFirstMove, aixLogsFromWatch, staffMoveExclusion, ackSceneOf } from "../../app/lib/staff-first-move";
import { yardstickAixLogFillOn, fillStaffAix, type AixLogLite } from "./prod-yardstick";
import { countByScene, sceneDrift, beyondCandidates, yardstickTwoFramesOn, brainFrames, staffFrames, judgeTwoFrames, countTwoFrames, type YardTurn, type SceneDrift, type TwoFrameCount } from "./prod-yardstick";

/** AIX の系統（audit-prod-as-exam と同じ見方） */
export function aixFamily(k: string | null | undefined): string {
  const s = String(k ?? "");
  if (!s) return "返信";
  if (/property_check|acknowledge_check/.test(s)) return "確認";
  if (/estimate|cost_/.test(s)) return "見積";
  if (/property_send|property_recommend|new_arrival/.test(s)) return "物件";
  if (/viewing|meeting/.test(s)) return "内覧";
  if (/application|apply/.test(s)) return "申込";
  if (/zenryoku|support/.test(s)) return "サポート";
  return s;
}

export type WatchRow = { id: number; conversation_id: string; customer_turn_at: string; scene_key: string | null; brain_action: string | null; decision_id: string | null; staff_aix: Array<{ aix_type?: string; at?: string; check_pattern?: string | null }> | null; verdict: string | null };

export async function readWatchTurns(sb: SupabaseClient, sinceIso: string, max = 10000): Promise<WatchRow[]> {
  const out: WatchRow[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, scene_key, brain_action, decision_id, staff_aix, verdict")
      .gte("customer_turn_at", sinceIso).order("customer_turn_at", { ascending: true }).range(i, i + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as WatchRow[]));
    if ((data ?? []).length < 1000 || out.length >= max) break;
  }
  return out.filter((w) => !isTestConversation(w.conversation_id) && w.verdict && w.verdict !== "na");
}

export async function readStaffMsgs(sb: SupabaseClient, convs: string[], sinceIso: string): Promise<Map<string, Array<{ at: number; writer: string | null; isAix: boolean }>>> {
  const m = new Map<string, Array<{ at: number; writer: string | null; isAix: boolean }>>();
  for (let i = 0; i < convs.length; i += 100) {
    for (let j = 0; ; j += 1000) {
      const { data, error } = await sb.from("messages").select("conversation_id, created_at, staff_writer, is_aix_generated").in("conversation_id", convs.slice(i, i + 100))
        .neq("sender", "customer").gte("created_at", sinceIso).order("created_at", { ascending: true }).range(j, j + 999);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const a = m.get(r.conversation_id as string) ?? [];
        a.push({ at: Date.parse(r.created_at as string), writer: (r.staff_writer as string | null) ?? null, isAix: !!r.is_aix_generated });
        m.set(r.conversation_id as string, a);
      }
      if ((data ?? []).length < 1000) break;
    }
  }
  return m;
}

export type YardstickOut = {
  at: string; days: number; turns: { before: number; after: number };
  /** 今の窓で当たり外れから外した番（後で送った AIX・お礼の番の約束の果たし） */
  excluded?: { late_aix: number; ack_fulfil_aix: number };
  down: Array<{ scene: string; before: SceneDrift["before"]; after: SceneDrift["after"]; pBefore: number; pAfter: number }>;
  few: number; beyond: number; drift: SceneDrift[];
  /** 2026-11-12 作業員1（弱い所 268）: 今の窓の竹内さんの番を「今の通／後の通」の2枠で（YARDSTICK_TWO_FRAMES=on の時だけ） */
  twoFrames?: Array<{ scene: string } & TwoFrameCount>;
};

/** 会話ごとの AIX の記録（aix_usage_logs・頁で読む）。見張りの staff_aix が空の番の補い（YARDSTICK_AIX_LOG_FILL） */
export async function readAixLogs(sb: SupabaseClient, convs: string[], sinceIso: string): Promise<Map<string, AixLogLite[]>> {
  const m = new Map<string, AixLogLite[]>();
  for (let i = 0; i < convs.length; i += 100) {
    for (let j = 0; ; j += 1000) {
      const { data, error } = await sb.from("aix_usage_logs").select("conversation_id, created_at, aix_type").in("conversation_id", convs.slice(i, i + 100))
        .gte("created_at", sinceIso).order("created_at", { ascending: true }).range(j, j + 999);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Array<{ conversation_id: string; created_at: string; aix_type: string | null }>) {
        if (!r.aix_type) continue;
        const a = m.get(r.conversation_id) ?? []; a.push({ at: Date.parse(r.created_at), aixType: r.aix_type, checkPattern: null }); m.set(r.conversation_id, a);
      }
      if ((data ?? []).length < 1000) break;
    }
  }
  return m;
}
/** 見張りの番の decision_id → brain_decision_logs.decision_source（2段の種類を読む） */
export async function readDecisionSources(sb: SupabaseClient, ids: string[]): Promise<Map<string, string | null>> {
  const m = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from("brain_decision_logs").select("id, decision_source").in("id", ids.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ id: string; decision_source: string | null }>) m.set(String(r.id), r.decision_source);
  }
  return m;
}

/** 前の窓（days 日）と今の窓の竹内さんの番の当たりを場面ごとに比べる */
export async function runYardstick(sb: SupabaseClient, opts: { days: number; nowMs?: number }): Promise<{ out: YardstickOut; turns: WatchRow[] }> {
  const now = opts.nowMs ?? Date.now();
  const cut = new Date(now - opts.days * 86_400_000).toISOString();
  const since = new Date(now - 2 * opts.days * 86_400_000).toISOString();
  const turns = await readWatchTurns(sb, since);
  const msgs = await readStaffMsgs(sb, [...new Set(turns.map((w) => w.conversation_id))], since);
  // 2026-11-13 作業員8b: 見張りの staff_aix が空の番は aix_usage_logs で補う（既定 off・YARDSTICK_AIX_LOG_FILL=on）
  const aixFill = yardstickAixLogFillOn() ? await readAixLogs(sb, [...new Set(turns.map((w) => w.conversation_id))], since) : null;
  const staffAixOf = (w: WatchRow) => { const watch = aixLogsFromWatch(w.staff_aix); return aixFill ? fillStaffAix(watch, aixFill.get(w.conversation_id) ?? [], Date.parse(w.customer_turn_at)) : watch; };
  // 2026-11-07 作業員1: 後で送った AIX（約束の果たし）・お礼の番の約束の果たしは当たり外れから外して別に数える（staffMoveExclusion・WATCH_COUNT_LATE_AIX=off で前の数え）
  const excluded = { late_aix: 0, ack_fulfil_aix: 0 };
  const toYard = (w: WatchRow): YardTurn[] => {
    const fm = staffFirstMove(Date.parse(w.customer_turn_at), msgs.get(w.conversation_id) ?? [], staffAixOf(w));
    const ex = staffMoveExclusion(Date.parse(w.customer_turn_at), fm, { ackOnly: ackSceneOf(w.scene_key) });
    if (ex) { if (w.customer_turn_at >= cut) excluded[ex]++; return []; }
    return [{ scene: w.scene_key, brain: aixFamily(w.brain_action), staff: aixFamily(fm?.kind === "aix" ? fm.aix : null), writer: fm?.writer ?? "unknown", at: w.customer_turn_at, principleOk: null }];
  };
  const before = turns.filter((w) => w.customer_turn_at < cut).flatMap(toYard), after = turns.filter((w) => w.customer_turn_at >= cut).flatMap(toYard);
  const drift = sceneDrift(countByScene(before), countByScene(after));
  let twoFrames: YardstickOut["twoFrames"];
  if (yardstickTwoFramesOn()) {
    const now = turns.filter((w) => w.customer_turn_at >= cut);
    const src = await readDecisionSources(sb, [...new Set(now.map((w) => w.decision_id).filter((x): x is string => !!x))]);
    const rows = now.flatMap((w) => {
      const tAt = Date.parse(w.customer_turn_at);
      const ms = msgs.get(w.conversation_id) ?? [];
      const logs = staffAixOf(w);
      const fm = staffFirstMove(tAt, ms, logs);
      if ((fm?.writer ?? "unknown") !== "takeuchi") return [];
      const moves = ms.filter((m) => m.at >= tAt).map((m) => ({ at: m.at, family: m.isAix ? aixFamily(logs.filter((a) => Math.abs(a.at - m.at) <= 10 * 60_000).sort((a, b) => Math.abs(a.at - m.at) - Math.abs(b.at - m.at))[0]?.aixType ?? "aix_unknown") : "返信" }));
      return [{ scene: w.scene_key, judge: judgeTwoFrames(brainFrames(aixFamily(w.brain_action), w.decision_id ? src.get(String(w.decision_id)) ?? null : null), staffFrames(tAt, moves)) }];
    });
    twoFrames = [...countTwoFrames(rows)].map(([scene, c]) => ({ scene, ...c })).sort((a, b) => b.n - a.n);
  }
  return {
    turns,
    out: {
      at: new Date(now).toISOString(), days: opts.days, turns: { before: before.length, after: after.length }, excluded,
      down: drift.filter((d) => d.verdict === "down").map((d) => ({ scene: d.scene, before: d.before, after: d.after, pBefore: +d.pBefore.toFixed(3), pAfter: +d.pAfter.toFixed(3) })),
      few: drift.filter((d) => d.verdict === "few").length, beyond: beyondCandidates(after).length, drift,
      ...(twoFrames ? { twoFrames } : {}),
    },
  };
}
