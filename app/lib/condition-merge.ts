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

/** 自由文の条件の欄（こだわり・NG・その他）。言い直しでも丸ごと差し替えず、節ごとに足す */
export const FREE_TEXT_CONDITION_FIELDS = ["preferences", "ng_points", "other_requests"] as const;

const clauseKey = (s: string) => s.normalize("NFKC").replace(/\[[^\]]*\]/g, "").replace(/\s+/g, "").trim();

/**
 * 自由文の条件の欄を節ごとに足す（今ある節は1つも消さない・同じ節は足さない）。
 *
 * 2026-09-30 YUMA の条件の入口テストで発覚（2件とも本番の経路）:
 *   ①「エリアなんですけど天満橋の方にも広げて探してもらえますか？」→ 意図が REPLACE に倒れ、その他の欄
 *     「ガスコンロ、カウンターキッチン、リビング8帖以上、初期費用15万円以内、収納多め」が「エリアを天満橋方面にも広げて探す」の1つに置き換わった
 *   ②「あと階数は11階以上がいいです！眺めがいい部屋が良くて」→ P4 が正しく「…2階以上・11階以上[必須]」に足した直後、
 *     ブレインの橋（equip_add）がこだわりの欄を「11階以上、眺めがいい部屋」に丸ごと上書きし、バストイレ別・独立洗面台・2階以上が消えた
 *   自由文の欄の丸ごと差し替えは「誤削除」になる（分析強化の原則・出口は誤削除0）。取り消しは除外（EXCLUDE）の経路でだけ行う。
 * 区切りは「・」「、」「,」改行を同じに扱い、「・」でつなぐ（正式フォーマットは「・」・ブレインの橋は「、」で書いていて、
 *   同じ中身でも毎回履歴が1行増えていた）。「11階以上[必須]」と「11階以上」は同じ節として今ある方を残す。
 * 足す物が無ければ今の値をそのまま返す（区切りを書き換えない＝履歴を増やさない）。
 */
export function mergeFreeTextClauses(existing: string | null | undefined, extracted: string | null | undefined): string | null {
  const split = (s: string | null | undefined) => String(s ?? "").split(/[・、,，\n]/).map((x) => x.trim()).filter(Boolean);
  const cur = split(existing);
  const add = split(extracted);
  if (!add.length) return existing?.trim() ? existing : null;
  if (!cur.length) return add.filter((x, i) => add.findIndex((y) => clauseKey(y) === clauseKey(x)) === i).join("・");
  const seen = new Set(cur.map(clauseKey));
  const fresh: string[] = [];
  for (const a of add) {
    const k = clauseKey(a);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    fresh.push(a);
  }
  if (!fresh.length) return existing as string;
  return [...cur, ...fresh].join("・");
}

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
    // 2026-09-30 自由文の欄は節ごとに足す（同じ節を二重に足さない）
    for (const f of FREE_TEXT_CONDITION_FIELDS) {
      if (parsed[f]) result[f] = mergeFreeTextClauses(existing[f], parsed[f]);
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
  // 2026-09-30: 自由文の欄（こだわり・NG・その他）は差し替えでも節ごとに足す（丸ごと上書きで今の条件を消さない・mergeFreeTextClauses）
  const result = { ...existing };
  const freeText = new Set<string>(FREE_TEXT_CONDITION_FIELDS);
  for (const [k, v] of Object.entries(parsed)) {
    if (v == null) continue;
    if (freeText.has(k)) (result as Record<string, unknown>)[k] = mergeFreeTextClauses((existing as Record<string, string | null | undefined>)[k], String(v));
    else (result as Record<string, unknown>)[k] = v;
  }
  return result;
}
