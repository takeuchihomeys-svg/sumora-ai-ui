// app/lib/sent-like-fit.ts — お客様が「好き」を見せた物件の像（純関数・DB/LLM なし）
//
// 2026-11-15 作業員K（竹内さん 11/15「AIX ツール（物件出し）との連携を細かく具体的に」・統括役の頼み「送ってきた物件と刺さった物件を
//   judgeProperty と🌟の並べ方へ渡す口」）:
//   今はお客様が自分で送ってきた物件（customer-sent-property）は🌟の DeepSeek の文にだけ渡り、決定論の🌟の並べ方（recommend-star-rank・👑）と
//   判定の点には渡っていない。刺さった物件（sent_properties.customer_reaction='interested'）もどこの点にも入っていない。
//   ここでは2つを「像」（間取りの集まり・広さ・築年・徒歩の中央値）にまとめ、🌟の候補が像に近いほど少し足す（合い方の主軸より弱く・上限あり）。
//
// ■ 決まり
//   ・像は条件ではない（条件より弱い）。点は SENT_LIKE_RULE.max まで。保留・外す候補を🌟に上げる強さにしない
//   ・像の元が1件だけの時は半分の点（1件の値に寄せすぎない）
//   ・値の無い項目は比べない（足さない・引かない）
// スイッチ: STAR_SENT_LIKE=on の時だけ（既定 off）。当て直しは scripts/audit-star-sent-like.ts

export type SentLikeItem = {
  floorPlan?: string | null;
  areaSqm?: number | null;
  ageYears?: number | null;
  walk?: number | null;
  /** customer_sent＝お客様が送ってきた／interested＝こちらが送って刺さった */
  from: "customer_sent" | "interested";
};
export type SentLikeProfile = {
  n: number;
  plans: string[];
  areaSqm: number | null;
  ageYears: number | null;
  walk: number | null;
};

export const SENT_LIKE_RULE = {
  plan: 4,
  /** 像の広さの 90% 以上 */
  area: 4,
  areaRatio: 0.9,
  /** 像の築年 +5年 以内 */
  age: 3,
  ageSlack: 5,
  /** 像の徒歩 +3分 以内 */
  walk: 2,
  walkSlack: 3,
  max: 10,
} as const;

export function sentLikeEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.STAR_SENT_LIKE ?? "").trim().toLowerCase() === "on";
}

const toHalf = (s: string) => s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
/** 間取りの札（1LDK・2DK・1K・1R）。読めなければ null */
export function planTokenOf(s: string | null | undefined): string | null {
  const t = toHalf(String(s ?? "")).toUpperCase().replace(/\s+/g, "");
  if (/ワンルーム|^1R$|(?:^|[^0-9])1R(?:[^A-Z]|$)/.test(t)) return "1R";
  const m = t.match(/([1-5])\s*S?\s*(LDK|DK|K)/);
  return m ? `${m[1]}${m[2]}` : null;
}
function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = Math.floor(v.length / 2);
  return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2;
}

export function buildSentLikeProfile(items: ReadonlyArray<SentLikeItem>): SentLikeProfile | null {
  const xs = items.filter((x) => x.floorPlan || x.areaSqm != null || x.ageYears != null || x.walk != null);
  if (!xs.length) return null;
  const plans = [...new Set(xs.map((x) => planTokenOf(x.floorPlan)).filter((p): p is string => !!p))];
  return {
    n: xs.length,
    plans,
    areaSqm: median(xs.map((x) => Number(x.areaSqm)).filter((v) => v > 0)),
    ageYears: median(xs.map((x) => (x.ageYears == null ? NaN : Number(x.ageYears)))),
    walk: median(xs.map((x) => (x.walk == null ? NaN : Number(x.walk)))),
  };
}

export function sentLikePoints(p: SentLikeProfile | null | undefined, c: { floorPlan?: string | null; areaSqm?: number | null; buildingAge?: number | null; walkMinutes?: number | null }, rule = SENT_LIKE_RULE): { points: number; reasons: string[] } {
  if (!p) return { points: 0, reasons: [] };
  let pts = 0; const reasons: string[] = [];
  const plan = planTokenOf(c.floorPlan);
  if (plan && p.plans.includes(plan)) { pts += rule.plan; reasons.push(`送ってきた・刺さった物件と同じ間取り（${plan}）`); }
  if (p.areaSqm != null && c.areaSqm != null && c.areaSqm >= p.areaSqm * rule.areaRatio) { pts += rule.area; reasons.push("送ってきた・刺さった物件くらいの広さ"); }
  if (p.ageYears != null && c.buildingAge != null && c.buildingAge <= p.ageYears + rule.ageSlack) { pts += rule.age; reasons.push("送ってきた・刺さった物件くらいの新しさ"); }
  if (p.walk != null && c.walkMinutes != null && c.walkMinutes <= p.walk + rule.walkSlack) { pts += rule.walk; reasons.push("送ってきた・刺さった物件くらいの駅の近さ"); }
  if (p.n < 2) pts = Math.round(pts / 2);
  return { points: Math.min(rule.max, pts), reasons };
}

// ── 判定（property-brain judgeProperty）の口: 札にする（加点だけ・保留・外す候補には付けない）──
export const SENT_LIKE_POINTS: Record<string, number> = { SENT_LIKE_HIGH: 6, SENT_LIKE_LOW: 3 };
export const SENT_LIKE_JA: Record<string, string> = {
  SENT_LIKE_HIGH: "💡 お客様が送ってきた・刺さった物件によく似ている",
  SENT_LIKE_LOW: "💡 お客様が送ってきた・刺さった物件に少し似ている",
};
export function sentLikeCodes(p: SentLikeProfile | null | undefined, c: { floorPlan?: string | null; areaSqm?: number | null; buildingAge?: number | null; walkMinutes?: number | null }): string[] {
  const pts = sentLikePoints(p, c).points;
  return pts >= 6 ? ["SENT_LIKE_HIGH"] : pts >= 3 ? ["SENT_LIKE_LOW"] : [];
}
