// app/lib/estimate-appeal-server.ts — 見積書のお部屋の採点を読んで、2通目の締め（内覧誘導／申込誘導／ご査収）の材料にする
//
// 2026-10-08 竹内「（新着の2通目・見積書の2通目の締めは）その形で。刺さる条件（スコアリング的に刺さる条件）なら内覧または申込誘導する。空室なら内覧誘導」
//   採点の行は物件オススメの2通目と同じ（property_pickups・同じ会話・号室が一致し建物名の頭が合う行だけ＝recommend-cta.pickupForFirstMessage）。
//   刺さるかは recommend-cta.appealFromPickup（verdict=pass ∧ 全部合う ∧ 外れ寄りの札なし・AD の点は使わない）、
//   今見られるかは recommend-viewable.resolveRecommendViewable（資料の現況 → ブレインの判断）。決め方は estimate-second-message.resolveEstimateClosing
import type { SupabaseClient } from "@supabase/supabase-js";
import { appealFromPickup, pickupForFirstMessage, type PickupLookupRow } from "./recommend-cta";
import { resolveRecommendViewable, type ViewableMaterialRow } from "./recommend-viewable";
import { estimateAppealOf, estimateHeadOf } from "./estimate-second-message";

export async function loadEstimateAppeal(
  sb: SupabaseClient,
  conversationId: string | null | undefined,
  propertyLabels: readonly string[],
  brain: { notViewable: boolean; viewableFrom?: string | null },
): Promise<{ appeal: "strong" | "weak" | null; notViewable: boolean; found: number }> {
  const heads = propertyLabels.map(estimateHeadOf).filter((h): h is { name: string; room: string } => !!h);
  if (!conversationId || heads.length === 0) return { appeal: null, notViewable: false, found: 0 };
  const { data } = await sb.from("property_pickups").select("property_name, room_no, verdict, reason_codes, created_at, terms")
    .eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(300);
  const rows = (data ?? []) as Array<PickupLookupRow & ViewableMaterialRow>;
  let found = 0;
  const per = heads.map((h) => {
    const row = pickupForFirstMessage(rows, h) as (PickupLookupRow & ViewableMaterialRow) | null;
    if (row) found++;
    const a = appealFromPickup(row);
    const v = resolveRecommendViewable({ text: null, material: row, brain });
    return { appeal: a?.appeal ?? null, notViewable: v.notViewable };
  });
  return { ...estimateAppealOf(per), found };
}
