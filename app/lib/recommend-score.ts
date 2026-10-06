// app/lib/recommend-score.ts（純関数・画面とサーバーで共用・DB/LLM なし）
// 「オススメの点」— 束の中で一番点が高い物件＝👑（一番オススメ）になる1つの点。
//
// 2026-10-06 竹内さん「スコアリング一番高いのが一番オススメだから　状況によってのスコアリング変動」:
//   今の👑は recommend-star-rank.rankStarCandidates の「段（AD1.5の線の上／下／AD1未満）＋合い方の点＋線を越える差15」で決めていて、
//   売上サポの点（判定の点＝ピックアップの点）とは別の並べ方に見える。これを **1つの点** に直す:
//
//     オススメの点 ＝ 判定の点 − AD の家族の札の点（AD は大きな点にしない）
//                 ＋ AD の線の点（AD1.5ヶ月以上 +15＝「線を越える差」と同じ大きさ）
//                 ＋ 束の中の比べ（一番広い +15・一番新しい +8・RC +6／木造 −6・設備の数 0〜+6・希望の設備 +4ずつ）
//                 ＋ 状況の点（初期費用・敷礼0の希望→敷礼0 +15／2階以上の希望→一番高い階 +15／1LDK以上の希望→一番新しい +15）
//                 − AD1ヶ月未満は 1000（他に何も無い時だけ👑）
//   この点の1位は rankStarCandidates の先頭と同じ物になる（AD の線の点を「線を越える差」と同じにしたので、
//   「線の下の物の合い方が線の上の一番より15以上高ければ先頭」がそのまま点の比べになる）。同点は starTieBreak（AD → 敷礼0 → フリーレント → 敷礼の月数）。
//   ⚠ 判定の点（ピックアップの点・束に入れる段）は変えない。AD は束に入れる段（pickup-ad-priority の AD の段・判定の AD の点）で効いていて、
//      束の中の一番は合い方で決まる（scripts/audit-star-two-axis*.ts・送った束の83%が AD1.5以上）。判定の点の AD を線に変えると束が変わる
//   確かめ: scripts/audit-recommend-score.ts（同じ回で rankStarCandidates の先頭と一致するか・スタッフの🌟との一致）
//
// 2026-10-06f 竹内さん「築年数古すぎる物件はそもそもお客さんにささりにくい　結局は築年数の浅い物件でお客さん刺さることが多い」:
//   状況 oldAgeAvoid（初期費用重視の型・築年の列なし・「古くても良い」と言っていない＝star-rank-pickup.starSituationFromConditions）の時、
//   築31年以上（リノベ済み・築年不明は除く）に −15（old-building-age.OLD_AGE_RULE）。判定の点（束に入れる段）には入れない（当て直しで下がる）。
//   当て直し: scripts/audit-old-building-age.ts（🌟の記録 231回: 新だけ当たり1／旧だけ0・直した束 2／0）・audit-old-building-age-more.ts（売上サポの行 1／0・刺さった新着 初期費用の型で築31以上 0/22・築30以下 18%）
import { starFitScores, starTieBreak, STAR_RANK_RULE, STAR_SITUATION_RULE, type StarCandidate, type StarRankRule, type StarSituation, type StarSituationRule } from "./recommend-star-rank";
import { oldAgePenalty, OLD_AGE_RULE, type OldAgeRule } from "./old-building-age";

export type RecommendScorePart = { label: string; points: number };
export type RecommendScored = {
  key: string;
  /** オススメの点（束の中で比べる点・一番高い物が👑） */
  score: number;
  /** 判定の点（ピックアップの点） */
  judgeScore: number;
  /** 内訳（判定の点から AD を外した点・AD の線・束の中の比べと状況・AD1未満） */
  parts: RecommendScorePart[];
  reasons: string[];
};

export type RecommendScoreRule = {
  /** AD の線（ヶ月）とその点。点は rankStarCandidates の overrideMargin と同じにすると先頭が一致する */
  adLine: number;
  adLinePoints: number;
  /** AD1ヶ月未満（分かる時だけ）を後ろにする点 */
  adNeverBelow: number;
  adNeverPenalty: number;
  /** 2026-10-06f 築古の減点（状況 oldAgeAvoid の時だけ）。null で止める */
  oldAge: Readonly<OldAgeRule> | null;
};
export const RECOMMEND_SCORE_RULE: Readonly<RecommendScoreRule> = {
  adLine: STAR_RANK_RULE.adLine,
  adLinePoints: STAR_RANK_RULE.overrideMargin,
  adNeverBelow: STAR_RANK_RULE.adNeverBelow,
  adNeverPenalty: 1000,
  oldAge: OLD_AGE_RULE,
};

const isAdCode = (k: string) => /^(AD_|PROFIT_)/.test(k);

/**
 * 束の候補 → オススメの点（並びは入力のまま）。extra は呼ぶ側の足し点（例: 刺さった新着から学んだ特徴の加点）を候補ごとに渡す
 */
export function recommendScores(
  cands: readonly StarCandidate[],
  sit?: StarSituation | null,
  opts: { rule?: Readonly<RecommendScoreRule>; starRule?: StarRankRule; sitRule?: Readonly<StarSituationRule>; extra?: (c: StarCandidate, i: number) => { points: number; label: string } | null } = {},
): RecommendScored[] {
  const rule = opts.rule ?? RECOMMEND_SCORE_RULE;
  const fits = starFitScores(cands, opts.starRule ?? STAR_RANK_RULE, sit ?? null, opts.sitRule ?? STAR_SITUATION_RULE);
  return cands.map((c, i) => {
    const adPts = c.codes.filter(isAdCode).reduce((a, k) => a + c.pointsOf(k), 0);
    const base = c.score - adPts;
    const rel = fits[i].fit - base;
    const parts: RecommendScorePart[] = [
      { label: "判定の点（AD を除く）", points: base },
    ];
    let score = fits[i].fit;
    if (c.adMonths != null && c.adMonths >= rule.adLine) { score += rule.adLinePoints; parts.push({ label: `AD${rule.adLine}ヶ月以上`, points: rule.adLinePoints }); }
    if (rel) parts.push({ label: "束の中の比べ・状況", points: rel });
    if (c.adMonths != null && c.adMonths < rule.adNeverBelow) { score -= rule.adNeverPenalty; parts.push({ label: `AD${rule.adNeverBelow}ヶ月未満（他に無い時だけ）`, points: -rule.adNeverPenalty }); }
    if (sit?.oldAgeAvoid && rule.oldAge) {
      const op = oldAgePenalty({ buildingAge: c.buildingAge, renovated: c.renovated }, rule.oldAge);
      if (op) { score += op.points; parts.push(op); }
    }
    const ex = opts.extra?.(c, i);
    if (ex && ex.points) { score += ex.points; parts.push({ label: ex.label, points: ex.points }); }
    return { key: c.key, score, judgeScore: c.score, parts, reasons: fits[i].reasons };
  });
}

/**
 * オススメの点の順（一番オススメが先頭）。同点は AD → 敷礼0 → フリーレント → 敷礼の月数（starTieBreak）→ 線の下を先（rankStarCandidates の「差がちょうど15」で線の下が先頭になるのと同じ）→ 入力の順
 */
export function rankByRecommendScore(
  cands: readonly StarCandidate[],
  sit?: StarSituation | null,
  opts: Parameters<typeof recommendScores>[2] = {},
): RecommendScored[] {
  const rule = opts.rule ?? RECOMMEND_SCORE_RULE;
  const sc = recommendScores(cands, sit, opts);
  const line = (i: number) => (cands[i].adMonths != null && cands[i].adMonths! >= rule.adLine ? 1 : 0);
  const idx = sc.map((_, i) => i).sort((a, b) => sc[b].score - sc[a].score || line(a) - line(b) || starTieBreak(cands[a], cands[b]) || a - b);
  const out = idx.map((i) => sc[i]);
  // 線の下の物が線の上の物を越えて一番になった時は rankStarCandidates と同じ理由を付ける（内覧を組むのが優先）
  const headI = idx[0];
  const never = (i: number) => cands[i].adMonths != null && cands[i].adMonths! < rule.adNeverBelow;
  if (out.length && !line(headI) && !never(headI) && idx.some((i) => line(i))) out[0] = { ...out[0], reasons: [...out[0].reasons, "AD は線の下だが合い方が大きく上（内覧を組むのが優先）"] };
  return out;
}
