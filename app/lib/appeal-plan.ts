// app/lib/appeal-plan.ts — これから送る訴求の計画（純関数・DB/LLM なし）
//
// 2026-11-15 作業員K（統括役の OK 済みの設計: 同じ訴求の記録をみんなで読む・作る順の3）。
//   今ある部品の答えを、訴求の記録（appeal-record.ts の AppealRecord）と同じ欄に1か所で並べる。新しい線は足さない（数えて線が無かった・KB P3）。
//   ・推す点の候補（candidates）は網のまま並べるだけ。どれを推すか（points）はブレインの判断（second-appeal-judge 等）が渡した物だけ（P0 9eb6aa9c）
//   ・強さ（strength）と狙う返事（aim）は、今の決まり（recommend-cta の締め・appeal-timing）の答えを NextStrength／NextDest の語彙に読み替えるだけ
//   ・今推す理由（whyNow）と前の訴求からの間（sinceLastAppealH）は、統括の situation_now（作業員L）の送った物・開いている約束から
//   語彙: strength＝next-move-types.NextStrength・aim＝NextDest（作業員16・22 の次の一手の表・作業員L の situation_now・作業員I の書き手の対応表と同じ表）
//
// 読む側（2026-11-20 既定 on・APPEAL_PLAN_READ=off で止める）: ①締め（今と同じ答えになるかの確かめ・aix-template-generate）→ ②2通目の網と判断 → ③オススメポイント の順につなぐ
import type { TopicKey } from "./recommendation-gaps";
import type { NextDest, NextStrength } from "./next-move-types";
import { compareAppealRecords, type AppealCompare, type AppealRecord, type AppealSurface, type WantLite } from "./appeal-record";

// 2026-11-20 作業員K2（統括役の決め）: 既定 on。読む側は aix_generate_log の記録（appeal_plan_check）に計画との比べを足すだけで、文と判断は変えない（試験は要らない）。
//   APPEAL_RECORD=shadow の記録は 11/19〜20 の本番で 9件（物件オススメ）＝計画と文の比べも同じ番で残す。止める APPEAL_PLAN_READ=off
export function appealPlanReadOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.APPEAL_PLAN_READ ?? "").trim().toLowerCase() !== "off";
}

/** 網の出所（今ある3つ） */
export type CandidateFrom = "facts" | "second_rank" | "star_reason";
export type AppealCandidate = { topic: TopicKey; from: CandidateFrom };

/** 締めの判断（recommend-cta.RecommendCtaDecision の要る所だけ） */
export type CtaLite = { kind: "viewing" | "apply" | "receipt"; appeal?: "strong" | "weak" | null; reason?: string | null } | null;
/** 統括の situation_now（作業員L）の要る所だけ */
export type SituationLite = {
  sent?: Array<{ at: string; aix?: string | null; kind?: string | null }> | null;
  promises_open?: Array<{ kind: string }> | null;
} | null;

export type AppealPlan = AppealRecord & {
  candidates: AppealCandidate[];
  /** 前の訴求（物件オススメ・ピックアップの送信）からの時間。分からなければ null */
  sinceLastAppealH: number | null;
  /** この訴求が答える依頼の id（作業員M の要件の帳面 ask-ledger.askIdOf と同じ id）。呼ぶ側が渡した物だけ */
  answersAsk: string[];
  /** どの部品の答えを使ったか（監査用） */
  from: { strengthAim: "recommend_cta" | "appeal_timing" | "none"; points: "brain" | "none"; whyNow: "situation_now" | "none" };
};

/** 締めの判断 → 強さと狙う返事（今の決まりの読み替えだけ） */
export function ctaToStrengthAim(cta: CtaLite): { strength: NextStrength; aim: NextDest } {
  if (!cta) return { strength: "none", aim: "none" };
  if (cta.kind === "viewing") return { strength: "invite", aim: "viewing" };      // 「ご都合よろしいお日にちにお部屋ご案内させて頂きます」
  if (cta.kind === "apply") return { strength: "strong", aim: "apply" };          // 退去予定＋申込で抑える
  return { strength: "door", aim: "door" };                                       // ご査収
}

/** appeal-timing の判定（作業員H の tsunagi-one-place.AppealDecision と同じ形: kind apply|viewing|none × level must|suggest|avoid）→ 強さと狙う返事。締めの判断が無い番だけ使う */
export type TimingLite = { kind: "apply" | "viewing" | "none"; level: "must" | "suggest" | "avoid" } | null;
export function timingToStrengthAim(t: TimingLite): { strength: NextStrength; aim: NextDest } {
  if (!t || t.kind === "none" || t.level === "avoid") return { strength: "none", aim: "none" };
  if (t.kind === "apply") return { strength: t.level === "must" ? "strong" : "invite", aim: "apply" };
  return { strength: t.level === "must" ? "invite" : "door", aim: "viewing" };
}

const APPEAL_AIX = /property_recommendation|property_send|pickup|recommend/;

export function buildAppealPlan(i: {
  surface: AppealSurface;
  nowIso: string;
  propertyKey?: string | null;
  wants?: ReadonlyArray<WantLite> | null;
  latent?: { id?: string | null; top?: string | null } | null;
  candidates?: ReadonlyArray<AppealCandidate> | null;
  /** ブレインが選んだ推す点（無ければ空＝候補だけ） */
  chosen?: ReadonlyArray<TopicKey> | null;
  cta?: CtaLite;
  /** 締めの判断が無い番（返信）の代わり: appeal-timing の判定 */
  timing?: TimingLite;
  situation?: SituationLite;
  /** 部屋の状況（退去予定・空室・新着）。資料・判定から呼ぶ側が渡す */
  roomState?: ReadonlyArray<"退去予定" | "空室" | "新着"> | null;
  /** 条件の合い方（判定の札の外れ・必須の外れ）。無ければ 0 */
  mustMiss?: ReadonlyArray<string> | null;
  /** この訴求が答える依頼の id（ask-ledger の AskEntry.id） */
  answersAsk?: ReadonlyArray<string> | null;
}): AppealPlan {
  const seen = new Set<string>();
  const candidates: AppealCandidate[] = [];
  for (const c of i.candidates ?? []) { if (!seen.has(c.topic)) { seen.add(c.topic); candidates.push(c); } }
  const points = [...new Set(i.chosen ?? [])] as TopicKey[];
  const wants = (i.wants ?? []).filter((w) => w && w.key);
  const wantFrom = new Map<string, string | null>(wants.map((w) => [w.key, w.from ?? null]));
  const why = points.filter((p) => wantFrom.has(p)).map((p) => ({ topic: p, wantFrom: wantFrom.get(p) ?? null }));
  const { strength, aim } = i.cta ? ctaToStrengthAim(i.cta) : timingToStrengthAim(i.timing ?? null);
  const now = Date.parse(i.nowIso);
  const lastAppeal = (i.situation?.sent ?? []).filter((s) => APPEAL_AIX.test(String(s.aix ?? s.kind ?? ""))).map((s) => Date.parse(s.at)).filter((t) => Number.isFinite(t) && t <= now).sort((a, b) => b - a)[0];
  const whyNow = [...new Set([...(i.roomState ?? []), ...((i.situation?.promises_open ?? []).some((p) => /new|新着|pickup/.test(p.kind)) ? ["新着"] : [])])];
  return {
    v: 1,
    surface: i.surface,
    writer: "ai",
    propertyKey: i.propertyKey ?? null,
    points,
    why,
    fit: { wantTotal: wantFrom.size, wantHit: why.length, gapFirst: (i.mustMiss ?? []).length > 0 },
    relevance: { prevRef: false, oneOfMany: false },
    whyNow,
    strength,
    aim,
    feeling: null,
    latent: i.latent?.id ? { id: String(i.latent.id), top: String(i.latent.top ?? "") } : null,
    candidates,
    sinceLastAppealH: lastAppeal != null ? Math.round(((now - lastAppeal) / 3600_000) * 10) / 10 : null,
    answersAsk: [...new Set(i.answersAsk ?? [])],
    from: { strengthAim: i.cta ? "recommend_cta" : i.timing ? "appeal_timing" : "none", points: points.length ? "brain" : "none", whyNow: i.situation ? "situation_now" : "none" },
  };
}

/** 計画と、書けた文の記録を比べる（計画どおりに書けたか）。points は計画にブレインの選びがある時だけ意味がある */
export function comparePlanToText(plan: AppealPlan, text: AppealRecord): AppealCompare & { planHasPoints: boolean } {
  return { ...compareAppealRecords(plan, text), planHasPoints: plan.points.length > 0 };
}
