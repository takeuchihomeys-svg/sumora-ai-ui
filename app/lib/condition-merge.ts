export type ConditionFields = {
  desired_area?: string | null;
  floor_plan?: string | null;
  rent_min?: number | null;
  rent_max?: number | null;
  walk_minutes?: number | null;
  move_in_time?: string | null;
  building_age?: number | null;
  floor_area_min?: number | null;
  initial_cost_limit?: number | null;
  preferences?: string | null;
  ng_points?: string | null;
  other_requests?: string | null;
};

export function mergeConditions(
  existing: ConditionFields,
  parsed: ConditionFields,
  intent: "FORMAL" | "ADD" | "REPLACE" | "EXCLUDE",
  excludeTargets?: string[],
): ConditionFields {
  // FORMAL: 全上書き（従来動作と同等）
  if (intent === "FORMAL") return { ...parsed };

  if (intent === "EXCLUDE") {
    const result = { ...existing };
    // desired_area から除外対象を削除
    if (excludeTargets?.length && existing.desired_area) {
      const areas = existing.desired_area
        .split(/[・、,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const kept = areas.filter(
        (a) => !excludeTargets.some((ex) => a.includes(ex) || ex.includes(a)),
      );
      result.desired_area = kept.length > 0 ? kept.join("・") : null;
    }
    // 追加NG条件を既存 ng_points に追記（重複回避）
    if (parsed.ng_points) {
      const prev = existing.ng_points ?? "";
      result.ng_points = prev ? `${prev}・${parsed.ng_points}` : parsed.ng_points;
    }
    if (parsed.preferences) {
      const prev = existing.preferences ?? "";
      result.preferences = prev ? `${prev}・${parsed.preferences}` : parsed.preferences;
    }
    return result;
  }

  if (intent === "ADD") {
    const result = { ...existing };
    // テキスト系: 既存 + 追加（重複駅は除外）
    if (parsed.desired_area) {
      const prev = existing.desired_area ?? "";
      const newAreas = parsed.desired_area
        .split(/[・、,]+/)
        .map((s) => s.trim())
        .filter((a) => a && !prev.includes(a));
      result.desired_area = newAreas.length
        ? prev
          ? `${prev}・${newAreas.join("・")}`
          : newAreas.join("・")
        : prev || null;
    }
    if (parsed.floor_plan) {
      const prev = existing.floor_plan ?? "";
      result.floor_plan =
        prev && !prev.includes(parsed.floor_plan)
          ? `${prev}・${parsed.floor_plan}`
          : parsed.floor_plan;
    }
    if (parsed.preferences) {
      const prev = existing.preferences ?? "";
      result.preferences = prev ? `${prev}・${parsed.preferences}` : parsed.preferences;
    }
    if (parsed.ng_points) {
      const prev = existing.ng_points ?? "";
      result.ng_points = prev ? `${prev}・${parsed.ng_points}` : parsed.ng_points;
    }
    if (parsed.other_requests) {
      const prev = existing.other_requests ?? "";
      result.other_requests = prev ? `${prev}。${parsed.other_requests}` : parsed.other_requests;
    }
    // 数値系: 新値があれば上書き
    if (parsed.rent_max != null) result.rent_max = parsed.rent_max;
    if (parsed.rent_min != null) result.rent_min = parsed.rent_min;
    if (parsed.walk_minutes != null) result.walk_minutes = parsed.walk_minutes;
    if (parsed.floor_area_min != null) result.floor_area_min = parsed.floor_area_min;
    if (parsed.building_age != null) result.building_age = parsed.building_age;
    if (parsed.initial_cost_limit != null) result.initial_cost_limit = parsed.initial_cost_limit;
    if (parsed.move_in_time) result.move_in_time = parsed.move_in_time;
    return result;
  }

  // REPLACE: AIが非nullで返したフィールドのみ上書き（最小破壊）
  const result = { ...existing };
  for (const [k, v] of Object.entries(parsed)) {
    if (v != null) (result as Record<string, unknown>)[k] = v;
  }
  return result;
}
