// app/lib/conductor-combine.ts — 統括の順番の表の「combine」（何通・どの順・各通の受け持ち）を、判断の後に1回だけ決めて meta に置く（作業員5・11/05・既定 off・純関数）
//
// 竹内さんの決定（KB 3701b532）: AIX と返信の組み合わせ（何通・順番・各通の役目＝答える／信頼／訴求）は統括が決める。
//   中身は作業員7の two-message-plan.planForConductor。重点（P0 575a7cd5・meta.conductor_focus）は「訴求できる場面か」にだけ使う（canAppealFromFocus）。
//   返信か AIX か（判断のブレインの action）は決め直さない＝後の役は前の役が決めた事を決め直さない（0dbfbc97）。
//   置き場は meta.two_message_plan（1つの正・テンプレート・画面・書き手は planFromMeta で読むだけ）。digest は tm（組み立て）と or（使った順番）。
// 切替: CONDUCTOR_COMBINE=on（既定 off＝meta に何も足さない＝今と同じ）
import { planForConductor, type PlanAsk, type TwoMessagePlan } from "./two-message-plan";
import { FOCUS_KINDS, focusOrder, orderDigest, type Focus } from "./conductor-focus";

type Env = Record<string, string | undefined>;
export const conductorCombineOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.CONDUCTOR_COMBINE ?? "").trim().toLowerCase() === "on";

export type CombinePatch = { two_message_plan: TwoMessagePlan; two_message_plan_digest: string | null; conductor_order: string | null; combine_check?: unknown };
/** 判断の後の meta から、組み立てと使った順番を作る（meta は変えない・呼ぶ側が足す）。返信の番も AIX の番も作る */
export function combineFromMeta(meta: Record<string, unknown> | null | undefined, o: { scene?: string | null; firstContact?: boolean; imageOnly?: boolean } = {}): CombinePatch | null {
  if (!meta) return null;
  const tc = meta.turn_contract as { asks?: unknown } | null | undefined;
  const asks = Array.isArray(tc?.asks) ? (tc!.asks as PlanAsk[]).filter((a) => a && typeof a === "object" && typeof (a as PlanAsk).route === "string" && typeof (a as PlanAsk).quote === "string") : null;
  const finalAix = meta.reply_mode === "auto_reply" ? null : (typeof meta.action === "string" && meta.action ? meta.action : null);
  const cf = meta.conductor_focus as { focus?: unknown; keepPromise?: unknown } | null | undefined;
  const focus = typeof cf?.focus === "string" && (FOCUS_KINDS as readonly string[]).includes(cf.focus) ? (cf.focus as Focus) : null;
  const r = planForConductor({ asks, finalAix, firstContact: o.firstContact, imageOnly: o.imageOnly, focus });
  const order = focus ? orderDigest(focusOrder(o.scene ?? null, focus, { keep: cf?.keepPromise === true })) : null;
  return { two_message_plan: r.plan, two_message_plan_digest: r.digest, conductor_order: order, ...(r.check ? { combine_check: r.check } : {}) };
}
