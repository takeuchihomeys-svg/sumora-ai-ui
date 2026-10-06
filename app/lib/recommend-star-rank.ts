// app/lib/recommend-star-rank.ts
// 🌟（物件オススメ＝送る束の中の「一番オススメ」1件）の並べ方。ピックアップ（束に入れる段）の点とは別。純関数・DB/LLM 依存なし。
//
// 2026-10-06 竹内さんの決定（⑰ の調査 scripts/audit-recommend-reasons.ts の後）:
//   ・束の中の一番は「合い方」が主軸: 間取りの一致・広さ（束の一番）・築年（束の一番新しい）・RC・設備の数／希望の設備・敷礼0
//   ・AD は大きな点でなく「線」（AD 1.5ヶ月以上を優先の段）
//   ・例外（竹内さん原文）「状況によって刺さる物件がない場合などは低いADの物件をオススメにするばあもある。
//     お客さんと内覧くむために、内覧組むことが優先的」＝線の上に合う物が無い時は、線の下でも合う物を🌟にしてよい
//
// 調査の数（242回・180日）: スタッフの🌟は束の中で 構造RC寄り 76%・AD 60%・設備の数 53%・築年 42%・広さ 36% が一番（ランダム 29〜34%）。
//   家賃の上限寄りは理由にならない（27%・ランダム 29%）。点の1位≠🌟の回の点差の最大は AD（+1,141点・61回）。
//
// 使い方: 束の候補（判定済みの札 codes と事実）を渡す → 並び（一番オススメが先頭）と、それぞれの理由。

export type StarCandidate = {
  /** 見分け（物件名＋号室など） */
  key: string;
  /** judgeProperty の札 */
  codes: readonly string[];
  /** 札の点（50＋Σ）＝ピックアップの点 */
  score: number;
  /** 札 → 点（AD の家族の点を外すのに使う） */
  pointsOf: (code: string) => number;
  areaSqm?: number | null;
  buildingAge?: number | null;
  /** RC / SRC / 鉄骨 / 軽量鉄骨 / 木造 */
  structure?: string | null;
  equipmentCount?: number | null;
  /** お客様の希望の設備に合う数 */
  equipWantHits?: number | null;
  /** AD（ヶ月）。null＝分からない */
  adMonths?: number | null;
  /** 保留・送らない物（審査中・NG 等）は呼ぶ側で外す。ここでは見ない */
};

export type StarRankRule = { adLine: number; overrideMargin: number; areaBest: number; ageBest: number; structureRc: number; structureWood: number; equipRankMax: number; equipWantEach: number; adNeverBelow: number };
export const STAR_RANK_RULE: Readonly<StarRankRule> = {
  /** AD の線（これ以上を優先の段に） */
  adLine: 1.5,
  /** 線の下の物を🌟にする差（合い方の点がこれ以上高ければ「刺さる」として線を越える）＝内覧を組むのが優先 */
  overrideMargin: 15,
  /** 束の中で一番広い */
  areaBest: 15,
  /** 束の中で一番新しい */
  ageBest: 8,
  /** 構造 */
  structureRc: 6,
  structureWood: -6,
  /** 設備の数（束の中の順位で 0〜） */
  equipRankMax: 6,
  /** 希望の設備に合う数 1つあたり */
  equipWantEach: 4,
  /** AD 1未満は🌟にしない（他に何も無い時だけ） */
  adNeverBelow: 1,
};

const isAdCode = (k: string) => /^(AD_|PROFIT_)/.test(k);

/** 束の中の順位（0＝一番良い・1＝一番悪い・値なし／比べる相手なし null） */
function rankIn(vals: Array<number | null | undefined>, v: number | null | undefined, dir: "high" | "low"): number | null {
  if (v == null) return null;
  const xs = vals.filter((x): x is number => x != null);
  if (xs.length < 2) return null;
  return xs.filter((x) => (dir === "high" ? x > v : x < v)).length / (xs.length - 1);
}

export type StarRanked = { key: string; fit: number; tier: "line" | "below" | "never"; reasons: string[] };

/** 合い方の点（AD の家族の点を外した札の点＋束の中の相対の足し点） */
export function starFitScores(cands: readonly StarCandidate[], rule = STAR_RANK_RULE): Array<{ fit: number; reasons: string[] }> {
  const areas = cands.map((c) => c.areaSqm), ages = cands.map((c) => c.buildingAge), eqs = cands.map((c) => c.equipmentCount);
  return cands.map((c) => {
    const reasons: string[] = [];
    let fit = c.score - c.codes.filter(isAdCode).reduce((a, k) => a + c.pointsOf(k), 0);
    if (rankIn(areas, c.areaSqm, "high") === 0) { fit += rule.areaBest; reasons.push("束の中で一番広い"); }
    if (rankIn(ages, c.buildingAge, "low") === 0) { fit += rule.ageBest; reasons.push("束の中で一番新しい"); }
    const st = String(c.structure ?? "");
    if (/^(RC|SRC)$/.test(st)) { fit += rule.structureRc; reasons.push("RC"); }
    else if (st === "木造") { fit += rule.structureWood; reasons.push("木造"); }
    const er = rankIn(eqs, c.equipmentCount, "high");
    if (er != null) fit += rule.equipRankMax * (1 - er);
    if (c.equipWantHits) { fit += rule.equipWantEach * c.equipWantHits; reasons.push(`希望の設備 ${c.equipWantHits}`); }
    return { fit, reasons };
  });
}

/**
 * 束の中の並び（一番オススメが先頭）。
 *   1) AD が線以上（adLine）の物を先に、その中は合い方の点の順
 *   2) ただし線の下（AD 不明を含む・AD1未満は除く）の物の合い方が、線の上の一番より overrideMargin 以上高ければ先頭に（内覧を組むのが優先）
 *   3) AD 1未満（adNeverBelow 未満）は最後（他に無い時だけ）
 *   同点は元の並び（呼ぶ側の点の順）を保つ
 */
export function rankStarCandidates(cands: readonly StarCandidate[], rule = STAR_RANK_RULE): StarRanked[] {
  const fits = starFitScores(cands, rule);
  const rows = cands.map((c, i) => {
    const tier: StarRanked["tier"] = c.adMonths != null && c.adMonths < rule.adNeverBelow ? "never" : c.adMonths != null && c.adMonths >= rule.adLine ? "line" : "below";
    return { key: c.key, fit: fits[i].fit, tier, reasons: fits[i].reasons, i };
  });
  const byFit = (a: typeof rows[number], b: typeof rows[number]) => b.fit - a.fit || a.i - b.i;
  const line = rows.filter((r) => r.tier === "line").sort(byFit);
  const below = rows.filter((r) => r.tier === "below").sort(byFit);
  const never = rows.filter((r) => r.tier === "never").sort(byFit);
  let head: typeof rows = [];
  if (line.length && below.length && below[0].fit - line[0].fit >= rule.overrideMargin) {
    head = [{ ...below[0], reasons: [...below[0].reasons, "AD は線の下だが合い方が大きく上（内覧を組むのが優先）"] }];
    below.shift();
  }
  const ordered = line.length ? [...head, ...line, ...below, ...never] : [...below, ...never];
  return ordered.map(({ i: _i, ...r }) => r);
}
