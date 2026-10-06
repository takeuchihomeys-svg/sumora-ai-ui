// app/lib/closing-target-server.ts — 決め手の条件（closing-target.ts）を DB から読んで作る（サーバー専用・読むだけ・書かない）
//
// 2026-10-07 竹内さん（H0N0KA.・ゆいと）。作り方は closing-target.ts（純関数）。ここは材料を集めるだけ:
//   ・会話（お客様の行に紐付いた一番新しい会話）の直近 28日の発言（像は21日・気に入った部屋は発言の前 7日）
//   ・今の登録の条件（家賃の上限・間取り・広さ・徒歩・築年・エリア・駅か区か）
//   ・気に入った部屋の空いている事実（広さ・駅・築年・敷礼）を売上サポの行（property_pickups・同じお客様・30日）で埋める
// 2つ目の探し物（子の行＝物置など・parent_customer_id あり）は親の会話の不満を自分の像にしない（住まいの不満で物置の検索を絞らない）→ null
import type { SupabaseClient } from "@supabase/supabase-js";
import { bestBuildingMatch } from "@/app/lib/candidate-facts";
import { closingTargetEnabled, closingTargetFromConversation, fillFavoriteFromPickup, type ClosingTargetState, type CurrentConditions, type ConvMessage } from "@/app/lib/closing-target";

const PC_COLS = "id, rent_max, floor_plan, floor_area_min, walk_minutes, building_age, desired_area, preferences, area_mode, parent_customer_id";

/** お客様（か会話）の今の決め手の条件。無ければ null（止めている時・子の行・発言が無い時も null） */
export async function loadClosingTargetState(
  db: SupabaseClient,
  ids: { propertyCustomerId?: string | null; conversationId?: string | null },
  opts: { now?: Date } = {},
): Promise<ClosingTargetState | null> {
  if (!closingTargetEnabled()) return null;
  try {
    let pcId = ids.propertyCustomerId ?? null;
    let convId = ids.conversationId ?? null;
    if (!pcId && convId) {
      const { data } = await db.from("conversations").select("property_customer_id").eq("id", convId).maybeSingle();
      pcId = (data as { property_customer_id?: string | null } | null)?.property_customer_id ?? null;
    }
    if (!pcId) return null;
    const { data: pc } = await db.from("property_customers").select(PC_COLS).eq("id", pcId).maybeSingle();
    if (!pc) return null;
    if ((pc as { parent_customer_id?: string | null }).parent_customer_id) return null;
    if (!convId) {
      const { data } = await db.from("conversations").select("id").eq("property_customer_id", pcId).order("updated_at", { ascending: false }).limit(1).maybeSingle();
      convId = (data as { id?: string } | null)?.id ?? null;
    }
    if (!convId) return null;
    const now = opts.now ?? new Date();
    const since = new Date(now.getTime() - 28 * 86400_000).toISOString();
    const [{ data: msgs }, { data: pickups }] = await Promise.all([
      db.from("messages").select("sender, text, created_at").eq("conversation_id", convId).in("sender", ["customer", "staff"]).gte("created_at", since).lte("created_at", now.toISOString())
        .order("created_at", { ascending: true }).limit(600),
      db.from("property_pickups").select("property_name, room_no, summary_text, terms, location, equipment, created_at").eq("property_customer_id", pcId)
        .gte("created_at", new Date(now.getTime() - 45 * 86400_000).toISOString()).order("created_at", { ascending: false }).limit(300),
    ]);
    const rows = (pickups ?? []) as Array<{ property_name: string | null; room_no: string | null; summary_text: string | null; terms: unknown; location: unknown; equipment: unknown }>;
    return closingTargetFromConversation({
      messages: (msgs ?? []) as ConvMessage[],
      current: pc as CurrentConditions,
      now,
      enrichFavorite: (fav) => fillFavoriteFromPickup(fav, bestBuildingMatch(fav.name, fav.room, rows, (r) => r.property_name, (r) => r.room_no)),
    });
  } catch (e) {
    console.warn("[closing-target] 読めない（像なしで続ける）:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
