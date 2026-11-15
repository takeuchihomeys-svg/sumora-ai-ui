// app/lib/prop-brain-score-category.ts
// 物件の判定（property-brain judgeProperty）の札を「採点の項目」に分ける（純関数）。
// 2026-11-15 作業員K: スタッフの🌟と今の点の1位がずれた回を、どの項目（合い方・家賃帯・AD・新着・駅・設備・築年）で
//   ずれたかに分けて数えるため（scripts/audit-prop-brain-score.ts）。点そのものは変えない。

export const SCORE_CATEGORIES = [
  "合い方（間取り・広さ）", "家賃帯", "AD", "新着・送付済み", "駅・エリア", "設備", "築年・構造", "初期費用", "入居時期", "ペット", "その他",
] as const;
export type ScoreCategory = (typeof SCORE_CATEGORIES)[number];

/** 札 → 項目。先に当たった物を採る（並びに意味がある） */
const RULES: Array<[RegExp, ScoreCategory]> = [
  [/^(AD_|PROFIT_)/, "AD"],
  [/^RENT_/, "家賃帯"],
  [/^(ALREADY_SENT|SEARCH_PINPOINT|HOOK_LEAN|NEW_ARRIVAL)/, "新着・送付済み"],
  [/^(FLOOR_PLAN_|SQM_|ROOM_JO_|LDK_JO_|FIT_ALL)/, "合い方（間取り・広さ）"],
  [/^(WALK_|AREA_|COMMUTE_|STATION_)/, "駅・エリア"],
  [/^(EQUIP_|CONDITION_|IMAGE_)/, "設備"],
  [/^(BUILDING_AGE|AGE_|STRUCTURE_)/, "築年・構造"],
  [/^(ZERO_ZERO|RENEWAL_|FREE_RENT|CONTRACT_|INITIAL_)/, "初期費用"],
  [/^MOVE_IN/, "入居時期"],
  [/^PET_/, "ペット"],
];

export function categoryOfCode(code: string): ScoreCategory {
  for (const [re, cat] of RULES) if (re.test(code)) return cat;
  return "その他";
}
