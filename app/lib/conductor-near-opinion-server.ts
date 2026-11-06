// app/lib/conductor-near-opinion-server.ts — 入口の意見の材料を引く（CONDUCTOR_NEAR_OPINION=on の時だけ呼ぶ・既定 off）
//   今の番の状況の文は、近い番の表（v1・竹内さんの番 1,095）と同じ関数 turnSituationText で作る（場面・段階・直前のこちら・伏せた発言）。
//   引くのは match_conductor_turns（サーバーの鍵だけ・竹内さんの番・同じ会話とお客様を外す）。この RPC は時刻で絞らないので、
//   引いた番の turn_at を読み、今の番より前の番だけ残す（試験の再生で未来の番を混ぜない）。埋め込み1回（約 $0.00001）＋読み3回。
//   失敗・時間切れ・線に届かない時は null（ブレインは今まで通り）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateEmbedding } from "@/app/lib/knowledge-utils";
import { turnSituationText, maskContactBits } from "@/app/lib/conductor-turn-vectors";
import { nearOpinion, nearOpinionLine, NEAR_OPINION_BAND, type NearOpinion, type NearTurnRow } from "@/app/lib/conductor-near-opinion";

export type NearOpinionResult = { op: NearOpinion | null; line: string; inBand: number };

export async function nearOpinionForTurn(sb: SupabaseClient, o: {
  conversationId: string; propertyCustomerId: string | null; turnAt: string; scene: string | null; stage: string | null;
  customerMasked: string; lastStaffKind: string | null;
}): Promise<NearOpinionResult | null> {
  try {
    const emb = await generateEmbedding(turnSituationText({ scene: o.scene, stage: o.stage, customerMasked: o.customerMasked, lastStaffKind: o.lastStaffKind }));
    if (!emb) return null;
    const { data, error } = await sb.rpc("match_conductor_turns", {
      query_embedding: JSON.stringify(emb), p_exclude_conv: o.conversationId, p_exclude_pc: o.propertyCustomerId,
      match_count: 40, max_distance: NEAR_OPINION_BAND, p_writer: "takeuchi",
    });
    if (error || !data) return null;
    const hits = data as Array<{ source_key: string; distance: number; actual: { route?: string; aix?: string | null; picker?: string | null } | null }>;
    if (!hits.length) return { op: null, line: "", inBand: 0 };
    // 今の番より前の番だけ（状況の文も一緒に読む）
    const { data: meta } = await sb.from("conductor_turn_vectors").select("source_key, turn_at, situation").in("source_key", hits.map((h) => h.source_key));
    const metaOf = new Map(((meta ?? []) as Array<{ source_key: string; turn_at: string; situation: string | null }>).map((m) => [m.source_key, m]));
    const tNow = Date.parse(o.turnAt);
    const rows: NearTurnRow[] = hits
      .filter((h) => { const m = metaOf.get(h.source_key); return !!m && Date.parse(m.turn_at) < tNow && (h.actual?.route === "aix" || h.actual?.route === "reply"); })
      .map((h) => ({ key: h.source_key, distance: h.distance, route: h.actual!.route as "aix" | "reply", aix: h.actual?.aix ?? null, picker: h.actual?.picker ?? null, situation: metaOf.get(h.source_key)?.situation ?? null }));
    const op = nearOpinion(rows);
    if (!op) return { op: null, line: "", inBand: rows.length };
    // 一番近い同じ一手の番の、竹内さんの実際の最初の文（伏せる: その会話の表示名・連絡先）
    let tText: string | null = null;
    try {
      const mid = op.exemplar.key.startsWith("msg:") ? op.exemplar.key.slice(4) : op.exemplar.key;
      const { data: msg } = await sb.from("messages").select("text, conversation_id").eq("id", mid).maybeSingle();
      const m = msg as { text: string | null; conversation_id: string } | null;
      if (m?.text) {
        const { data: conv } = await sb.from("conversations").select("customer_name").eq("id", m.conversation_id).maybeSingle();
        const { maskPII } = await import("@/app/lib/pii-mask");
        const { customerNameTokens, maskCustomerNames } = await import("@/app/lib/compose-name-mask");
        const tokens = customerNameTokens([(conv as { customer_name?: string | null } | null)?.customer_name ?? null]);
        tText = maskContactBits(maskPII(maskCustomerNames(m.text, tokens)));
        if (/^\s*\[(?:画像|スタンプ)\]\s*$/.test(tText)) tText = null;
      }
    } catch { tText = null; }
    return { op, line: nearOpinionLine(op, tText), inBand: rows.length };
  } catch {
    return null;
  }
}
