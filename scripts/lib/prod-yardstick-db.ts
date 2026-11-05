// scripts/lib/prod-yardstick-db.ts — 本番の物差しの DB の読み（読むだけ・LLM なし）。毎晩の cron（app/api/cron/prod-yardstick）と手元の台本（scripts/prod-yardstick-night.ts）が同じ物を使う
//   2026-11-05 作業員8（統括役の了承の 2・3）。1000行ずつの頁で読む（点検表 3）
import type { SupabaseClient } from "@supabase/supabase-js";
import { isTestConversation } from "../../app/lib/test-conversations";
import { staffFirstMove, aixLogsFromWatch } from "../../app/lib/staff-first-move";
import { countByScene, sceneDrift, beyondCandidates, type YardTurn, type SceneDrift } from "./prod-yardstick";

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
  down: Array<{ scene: string; before: SceneDrift["before"]; after: SceneDrift["after"]; pBefore: number; pAfter: number }>;
  few: number; beyond: number; drift: SceneDrift[];
};

/** 前の窓（days 日）と今の窓の竹内さんの番の当たりを場面ごとに比べる */
export async function runYardstick(sb: SupabaseClient, opts: { days: number; nowMs?: number }): Promise<{ out: YardstickOut; turns: WatchRow[] }> {
  const now = opts.nowMs ?? Date.now();
  const cut = new Date(now - opts.days * 86_400_000).toISOString();
  const since = new Date(now - 2 * opts.days * 86_400_000).toISOString();
  const turns = await readWatchTurns(sb, since);
  const msgs = await readStaffMsgs(sb, [...new Set(turns.map((w) => w.conversation_id))], since);
  const toYard = (w: WatchRow): YardTurn => {
    const fm = staffFirstMove(Date.parse(w.customer_turn_at), msgs.get(w.conversation_id) ?? [], aixLogsFromWatch(w.staff_aix));
    return { scene: w.scene_key, brain: aixFamily(w.brain_action), staff: aixFamily(fm?.kind === "aix" ? fm.aix : null), writer: fm?.writer ?? "unknown", at: w.customer_turn_at, principleOk: null };
  };
  const before = turns.filter((w) => w.customer_turn_at < cut).map(toYard), after = turns.filter((w) => w.customer_turn_at >= cut).map(toYard);
  const drift = sceneDrift(countByScene(before), countByScene(after));
  return {
    turns,
    out: {
      at: new Date(now).toISOString(), days: opts.days, turns: { before: before.length, after: after.length },
      down: drift.filter((d) => d.verdict === "down").map((d) => ({ scene: d.scene, before: d.before, after: d.after, pBefore: +d.pBefore.toFixed(3), pAfter: +d.pAfter.toFixed(3) })),
      few: drift.filter((d) => d.verdict === "few").length, beyond: beyondCandidates(after).length, drift,
    },
  };
}
