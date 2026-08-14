// app/lib/ground-truth.ts
// final-check anomaly_scan 用の正解データ取得（チェックポイント + property_customers）
// 絶対に throw しない・GT_TIMEOUT_MS で諦める（fail-open — 送信を絶対に止めない）
import { supabase } from "@/app/lib/supabase";

export interface GroundTruth {
  checkpointFacts?: string;      // 確認済み事実（最新チェックポイント・最高権威）
  customerConditionsDb?: string; // property_customers のDB保存条件
}

const GT_TIMEOUT_MS = 1500;

export async function fetchGroundTruth(
  conversationId: string | null | undefined,
): Promise<GroundTruth> {
  if (!conversationId) return {};
  try {
    return await Promise.race([
      fetchInner(conversationId),
      new Promise<GroundTruth>((resolve) => setTimeout(() => resolve({}), GT_TIMEOUT_MS)),
    ]);
  } catch (e) {
    console.warn("[ground-truth] fetch failed (fail-open):",
      e instanceof Error ? e.message : e);
    return {};
  }
}

async function fetchInner(conversationId: string): Promise<GroundTruth> {
  const [cpRes, convRes] = await Promise.all([
    supabase
      .from("conversation_checkpoints")
      .select("checkpoint_index, summary")
      .eq("conversation_id", conversationId)
      .order("checkpoint_index", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("conversations")
      .select("property_customer_id")
      .eq("id", conversationId)
      .maybeSingle(),
  ]);

  let checkpointFacts: string | undefined;
  if (!cpRes.error && cpRes.data?.summary) {
    checkpointFacts = (cpRes.data.summary as string).slice(0, 2000);
  }

  let customerConditionsDb: string | undefined;
  const pcId = convRes.error ? null : (convRes.data?.property_customer_id as string | null);
  if (pcId) {
    const { data: pc, error: pcErr } = await supabase
      .from("property_customers")
      .select("customer_name, rent_min, rent_max, max_rent, desired_area, area, town_names, floor_plan, layout, move_in_time, walk_minutes, building_age, initial_cost_limit, pet, commute_station, commute_minutes, exclusion_areas, ng_points, other_requests")
      .eq("id", pcId)
      .maybeSingle();
    if (!pcErr && pc) {
      const p: string[] = [];
      if (pc.customer_name) p.push(`顧客名: ${pc.customer_name}`);
      if (pc.rent_min != null || pc.rent_max != null) p.push(`家賃: ${pc.rent_min ?? "?"}〜${pc.rent_max ?? "?"}`);
      else if (pc.max_rent != null) p.push(`家賃上限: ${pc.max_rent}`);
      if (pc.desired_area || pc.area) p.push(`エリア: ${pc.desired_area || pc.area}`);
      if (Array.isArray(pc.town_names) && pc.town_names.length > 0) p.push(`町名: ${pc.town_names.join("・")}`);
      if (pc.floor_plan || pc.layout) p.push(`間取り: ${pc.floor_plan || pc.layout}`);
      if (pc.move_in_time) p.push(`入居時期: ${pc.move_in_time}`);
      if (pc.walk_minutes != null) p.push(`駅徒歩: ${pc.walk_minutes}分以内`);
      if (pc.building_age != null) p.push(`築年数: ${pc.building_age}年以内`);
      if (pc.initial_cost_limit != null) p.push(`初期費用上限: ${pc.initial_cost_limit}`);
      if (pc.pet === true) p.push("ペット: あり");
      if (pc.commute_station) p.push(`通勤先: ${pc.commute_station}${pc.commute_minutes != null ? `まで${pc.commute_minutes}分` : ""}`);
      if (pc.exclusion_areas) p.push(`除外エリア: ${pc.exclusion_areas}`);
      if (pc.ng_points) p.push(`NG条件: ${pc.ng_points}`);
      if (pc.other_requests) p.push(`その他: ${pc.other_requests}`);
      customerConditionsDb = p.join(" / ").slice(0, 1000) || undefined;
    }
  }
  return { checkpointFacts, customerConditionsDb };
}
