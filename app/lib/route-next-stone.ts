// app/lib/route-next-stone.ts — 申込までの地図の「次の石」（駅ごとに一歩先の段）と、一手がその石に向かったか・飛ばしたかの分け（純関数・DB/LLM なし）
// 2026-11-26 作業員A（竹内さん 11/26 昼「すぐに申込に近づけるのではなくて、内覧誘いや初期費用の見積書等、申込に向けた流れちゃんと細分化して理解して動くことが出来ているのか？」・統括役の頼み）
//   今の主の数（一手の後に駅が申込に近づいた割合 45.6%）は、飛ばして申込へ押す一手も良く数え、一歩ずつ進めた番と区別できない。
//   次の石の出所: 成約データの太い道（route-backplan の THICK_PATH・L の deal_outcomes）の1手先と、竹内さん本人の60日の番で駅が進んだ一手の向かう駅。
import type { RouteNodeId } from "./apply-route-map";
import { MAIN_ROUTE } from "./apply-route-map";

export type Stone = { to: RouteNodeId[]; label: string };
/** 駅 → 次の石（ここに向かう一手が「一歩ずつ」。これより先へ向かう一手は「飛ばした」） */
export const NEXT_STONE: Partial<Record<RouteNodeId, Stone>> = {
  inquiry: { to: ["hearing", "pickup"], label: "条件の聞き取り・探す約束" },
  hearing: { to: ["pickup", "proposing"], label: "探す約束・物件出し" },
  pickup: { to: ["proposing"], label: "物件を送る" },
  proposing: { to: ["interested", "estimate"], label: "気に入った物件の確かめ・初期費用の見積（予告）" },
  interested: { to: ["estimate", "viewing_arrange"], label: "初期費用の見積書・内覧の誘い" },
  estimate: { to: ["viewing_arrange", "apply_prep"], label: "内覧の調整か申込のご案内（内覧なしの道）" },
  viewing_arrange: { to: ["viewing_scheduled"], label: "内覧の日時を決める・集合場所" },
  viewing_scheduled: { to: ["viewed"], label: "当日のご挨拶・内覧" },
  viewed: { to: ["apply_prep"], label: "申込のご案内" },
  apply_prep: { to: ["applying"], label: "申込の手続き" },
};
// skip は2つに分ける（60日の竹内さん本人の番: 先へ飛んだ 26 のうち 25 は内覧・見積の誘いを先に置く仕込み・申込へ飛んだのは内覧予定からの1番だけ）
//   plant_ahead … 次の石より先の内覧・見積へ誘う（竹内さんの先の仕込み・急ぎすぎではない）
//   skip_apply …… 次の石より先で申込のご案内・申込へ（急ぎすぎ）
/**
 * 2026-11-26 作業員A（竹内さん 11/26「AIX のことも組み合わせて分析」）: 次の石を進める一手（返信の一言／AIX）と、辞書（aix-dictionary）・境目（aix-boundary）の行。
 *   出所: 60日の竹内さん本人の番で次の石へ向かった一手（多い順）。竹内さんは石を返信（約束・誘い）で進める事が多く、AIX は約束を果たす2段目か、手元に物がある時
 *   （例: 提案中は 約束 10・内覧の誘い 6・見積書 3／ヒアリングは 約束 13・おすすめ 3／見積の後は 内覧の誘い 4・約束 2）
 */
export type StoneTool = { reply: string[]; aix: string[]; boundary: string[] };
export const STONE_TOOLS: Partial<Record<RouteNodeId, StoneTool>> = {
  inquiry: { reply: ["promise", "invite_estimate"], aix: ["condition_hearing"], boundary: [] },
  hearing: { reply: ["promise"], aix: ["property_recommendation", "property_send"], boundary: ["pickup_ack_ready", "pickup_ack_not_ready"] },
  pickup: { reply: ["promise", "invite_viewing"], aix: ["property_recommendation", "property_send"], boundary: ["pickup_ack_ready", "pickup_ack_not_ready"] },
  proposing: { reply: ["promise", "invite_viewing"], aix: ["estimate_sheet", "property_check_result"], boundary: ["check_ack_wait", "check_question", "check_brought_new", "check_ack_plus", "general_explain"] },
  interested: { reply: ["promise", "invite_viewing", "invite_estimate"], aix: ["estimate_sheet", "viewing_invite"], boundary: [] },
  estimate: { reply: ["invite_viewing", "promise"], aix: ["viewing_invite", "application_push"], boundary: [] },
  viewing_arrange: { reply: ["promise", "ask_schedule"], aix: ["viewing_invite", "meeting_place"], boundary: [] },
  viewing_scheduled: { reply: [], aix: ["meeting_place", "greeting_viewing"], boundary: [] },
  viewed: { reply: ["invite_apply"], aix: ["application_push"], boundary: [] },
};
/** 同じ石で AIX の種類だけ違う（石は合っている・AIX の選び違い）か（純関数） */
export function aixKindMissOf(node: RouteNodeId | string | null | undefined, takeuchiAct: string, brainAct: string, target: (a: string) => RouteNodeId | "promise" | null): boolean {
  if (!takeuchiAct.startsWith("aix:") || !brainAct.startsWith("aix:") || takeuchiAct === brainAct) return false;
  const a = target(takeuchiAct), b = target(brainAct);
  return !!a && a === b && stoneMoveOf(node, a) !== "unknown";
}
export type StoneMove = "next_stone" | "promise" | "plant_ahead" | "skip_apply" | "same" | "back" | "hold" | "unknown";
export const STONE_JA: Record<StoneMove, string> = { next_stone: "次の石へ", promise: "次の石の約束（2段）", plant_ahead: "先の仕込み（内覧・見積へ誘う）", skip_apply: "申込へ飛ばした", same: "同じ駅", back: "戻った", hold: "動かさない（答え・待ち）", unknown: "決められない" };
const idx = (n: RouteNodeId | string | null | undefined) => MAIN_ROUTE.indexOf(String(n ?? "") as RouteNodeId);
/** 一手の向かう駅（target: 駅・"promise"・null）が、今の駅の次の石に向かったか（純関数） */
export function stoneMoveOf(node: RouteNodeId | string | null | undefined, target: RouteNodeId | "promise" | null | undefined): StoneMove {
  const st = NEXT_STONE[String(node ?? "") as RouteNodeId];
  if (!st || idx(node) < 0) return "unknown";
  if (target === "promise") return "promise";
  if (target == null) return "hold";
  if (st.to.includes(target)) return "next_stone";
  const d = idx(target) - idx(node);
  if (d === 0) return "same";
  if (d < 0) return "back";
  if (idx(target) <= Math.max(...st.to.map(idx))) return "next_stone";
  return target === "apply_prep" || target === "applying" ? "skip_apply" : "plant_ahead";
}
/** 一歩ずつの割合（次の石へ＋約束 ／ 駅が決まる番のうち・動かさないも分母に入れる） */
export function stoneShare(ms: readonly StoneMove[]): { step: number; plant: number; skip: number; n: number } {
  const n = ms.filter((m) => m !== "unknown").length;
  return { step: ms.filter((m) => m === "next_stone" || m === "promise").length, plant: ms.filter((m) => m === "plant_ahead").length, skip: ms.filter((m) => m === "skip_apply").length, n };
}
/** 逆算の計画の材料の「次の石」の1行（ROUTE_NEXT_STONE_LINE=on の時だけ使う案・既定 off・まだ配線しない） */
export function nextStoneLineOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.ROUTE_NEXT_STONE_LINE ?? "").trim().toLowerCase() === "on";
}
export function nextStoneLine(node: RouteNodeId | string | null | undefined): string {
  const st = NEXT_STONE[String(node ?? "") as RouteNodeId];
  return st ? `【次の石（申込へは一歩ずつ・材料）】今の駅の次は ${st.label}。申込のご案内へ飛ばさず、まずここへ（竹内さん本人は一歩ずつ進める）` : "";
}
