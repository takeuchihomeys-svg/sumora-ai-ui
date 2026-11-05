// app/lib/conductor-focus-server.ts — 今の番に近い、竹内さんの過去の番の重点を引く（作業員5・11/05・既定 off・CONDUCTOR_FOCUS=shadow の時だけ呼ぶ）
//   KB P0 575a7cd5 ④: ベクトルは数の重みのためではなく「竹内さんの近い過去の番で何が重点だったか」を引くために使う。
//   今の番の状況の文は過去の番と同じ関数（conductor-focus.turnSituationTextV2）で作る（KB P1 977cbded ①）。
//   引くのは match_conductor_focus（サーバーの鍵だけ・時間順で前の番だけ・同じ会話とお客様を外す）。
//   束の線: 手元の確かめ（11/05・980番）で、束 0.2・5件以上＋束の外は場面の値が一番良かった（場面の値 42.0% → 46.2%）＝既定の線。決めるのは統括（この1行は参考）
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateEmbedding } from "@/app/lib/knowledge-utils";
import { nearShapeLine } from "@/app/lib/two-message-plan";
import { nearestFocus, sceneMajorityFocus, FOCUS_KINDS, type Focus, type NearFocus } from "@/app/lib/conductor-focus";

export const FOCUS_BAND = 0.2;
export const FOCUS_MIN_N = 5;

/** 近い番の重点と、近い番の竹内さんの組み合わせの型の参考の1行（作業員7 nearShapeLine・planForConductor の参考だけ・決め直さない） */
export type NearTurns = { near: NearFocus | null; shape: { line: string; digest: string } | null };
export async function nearFocusForTurn(sb: SupabaseClient, o: { conversationId: string; propertyCustomerId: string | null; turnAt: string; scene: string; situationV2: string }): Promise<NearTurns | null> {
  try {
    const emb = await generateEmbedding(o.situationV2);
    if (!emb) return null;
    const { data, error } = await sb.rpc("match_conductor_focus", {
      query_embedding: JSON.stringify(emb), p_before: o.turnAt, p_exclude_conv: o.conversationId, p_exclude_pc: o.propertyCustomerId,
      match_count: 30, max_distance: 0.3, p_writer: "takeuchi",
    });
    if (error) return null;
    const all = ((data ?? []) as Array<{ source_key: string; scene: string; focus: string; distance: number; actual: { shape?: string } | null }>);
    const shape = nearShapeLine(all.filter((r) => r.distance <= FOCUS_BAND).map((r) => ({ shape: r.actual?.shape ?? null, dist: r.distance })));
    const rows = all.filter((r) => (FOCUS_KINDS as readonly string[]).includes(r.focus));
    // 束の外は場面の多い重点（引いた近い番のうち同じ場面の物から・無ければ null）
    const sceneFocus = sceneMajorityFocus(rows.filter((r) => r.scene === o.scene).map((r) => r.focus as Focus));
    return { near: nearestFocus(rows.map((r) => ({ id: r.source_key, focus: r.focus as Focus, dist: r.distance })), { band: FOCUS_BAND, minN: FOCUS_MIN_N, sceneFocus }), shape };
  } catch {
    return null;
  }
}
