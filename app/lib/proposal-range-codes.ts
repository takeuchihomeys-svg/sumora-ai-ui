// app/lib/proposal-range-codes.ts — 「このお客様に広げて提案してよい範囲」の判定の札（純・軽い＝駅の表を持たない・property-brain から読む）
//   範囲そのものを決めるのは proposal-range.ts（ブレインの判断を材料に）。ここは範囲 → 判定の札・広さ／間取りの帯だけ。
//   2026-10-13 竹内「お客さんに広げて提案できるところの範囲」。戻す: PROPOSAL_RANGE=off（範囲を渡さない）・PROPOSAL_SIZE_WIDE=off（広さ −10㎡・広い1LDK の帯を戻す）

export const PROPOSAL_RANGE_VERSION = "proposal-range@2026-10-13";

const envOf = (env?: Record<string, string | undefined>) => env ?? (typeof process !== "undefined" ? process.env : {});
export function proposalRangeEnabled(env?: Record<string, string | undefined>): boolean {
  return String(envOf(env).PROPOSAL_RANGE ?? "").trim().toLowerCase() !== "off";
}
/** 広さの −10㎡（30㎡以上の希望）と「部屋数が1つ少ない広い LDK」の帯（既定 on） */
export function proposalSizeWideEnabled(env?: Record<string, string | undefined>): boolean {
  return String(envOf(env).PROPOSAL_SIZE_WIDE ?? "").trim().toLowerCase() !== "off";
}

export type ProposalLevel = "tight" | "standard" | "broad";

export type ProposalRange = {
  v: 1;
  version: typeof PROPOSAL_RANGE_VERSION;
  level: ProposalLevel;
  /** 家賃の上限を超える物件を提案してよいか */
  rentOver: boolean;
  /** 築年の広げた帯を提案してよいか */
  ageWide: boolean;
  /** 広さの −10㎡（30㎡以上の希望）・部屋数が1つ少ない広い LDK を提案してよいか */
  sizeWide: boolean;
  /** 段と軸を決めた材料（画面・ログ・訴求の材料に出す） */
  reasons: string[];
};

export const PROPOSAL_POINTS: Record<string, number> = {
  PROPOSAL_AREA_OUT: -10, PROPOSAL_AREA_EDGE: -3, PROPOSAL_AREA_WIDE_OK: 3, PROPOSAL_AREA_CLOSE_OK: 2,
  PROPOSAL_RENT_OUT: -12, PROPOSAL_AGE_OUT: -5,
};
export const PROPOSAL_JA: Record<string, string> = {
  PROPOSAL_AREA_OUT: "このお客様に広げて提案する範囲の外（場所をはっきり言っている・保留）",
  PROPOSAL_AREA_EDGE: "希望の場所の少し外（場所をはっきり言っている）",
  PROPOSAL_AREA_WIDE_OK: "希望の場所の外だが、このお客様には広げて提案してよい",
  PROPOSAL_AREA_CLOSE_OK: "隣の区・4km だが、このお客様には広げて提案してよい",
  PROPOSAL_RENT_OUT: "家賃が決め手のお客様に上限を超える物件（保留）",
  PROPOSAL_AGE_OUT: "築年が決め手のお客様に築年の広げた帯",
};
export const PROPOSAL_HOLD_CODES: ReadonlySet<string> = new Set(["PROPOSAL_AREA_OUT", "PROPOSAL_RENT_OUT"]);
export const PROPOSAL_POSITIVE_CODES: ReadonlySet<string> = new Set(["PROPOSAL_AREA_WIDE_OK", "PROPOSAL_AREA_CLOSE_OK"]);

/**
 * 今の判定の札（codes）とこのお客様の範囲から足す札（純）。AREA_MUST_NG（絶対のエリアの外）がもう付いた物には場所の札を足さない
 */
export function proposalRangeCodes(range: ProposalRange | null | undefined, codes: ReadonlyArray<string>): string[] {
  if (!range) return [];
  const has = (c: string) => codes.includes(c);
  const out: string[] = [];
  if (range.level === "tight" && !has("AREA_MUST_NG")) {
    if (has("AREA_CLOSE") || has("AREA_FAR") || has("AREA_ANCHOR_FAR")) out.push("PROPOSAL_AREA_OUT");
    else if (has("AREA_STATION_2STOPS") || has("AREA_NEAR") || has("AREA_REGION_MATCH")) out.push("PROPOSAL_AREA_EDGE");
  } else if (range.level === "broad") {
    if (has("AREA_FAR") || has("AREA_ANCHOR_FAR")) out.push("PROPOSAL_AREA_WIDE_OK");
    else if (has("AREA_CLOSE")) out.push("PROPOSAL_AREA_CLOSE_OK");
  }
  if (!range.rentOver && (has("RENT_WIDE") || has("RENT_SLIGHTLY_OVER"))) out.push("PROPOSAL_RENT_OUT");
  if (!range.ageWide && has("BUILDING_AGE_WIDE")) out.push("PROPOSAL_AGE_OUT");
  return out;
}

/**
 * 広げて提案してよい広さの幅（30㎡以上の希望は −10㎡・未満は −5㎡）。dept_search_tool.md の決まり「30㎡未満 → −5㎡まで／30㎡以上 → −10㎡まで」。
 *   実送信の当て直し（120日）: 希望30㎡以上で −5〜−10㎡ 32部屋の刺さり 19%（希望以上 176部屋 17%と同じ）
 */
export function wideSqmMargin(sqmMin: number, sizeWide = true, env?: Record<string, string | undefined>): number {
  if (!sizeWide || !proposalSizeWideEnabled(env)) return 5;
  return sqmMin >= 30 ? 10 : 5;
}

/** 「部屋数が1つ少ない LDK」でも広ければ提案してよい広さ（実送信 2LDK 希望の 1LDK: 30㎡以上 39部屋 刺さり 13（33%）・未満 6部屋 1） */
export const FEWER_ROOM_LDK_MIN_SQM = 30;
