// app/lib/substate-context.ts — 駅の中の細かい状態の網に、今の通の言葉だけでなく 送った物（物件・見積）・札・約束の流れを足す（純関数・LLM/DB なし）
// 2026-11-27 作業員A（竹内さん 11/27「現状の把握…細分化して土台を固めて強化」・統括役の頼み）: 細かい状態の一致 49%（43/87）。外れの多くは
//   「総額が予算を超える」（見積の駅の状態）を、見積をまだ送っていないヒアリングの番の「予算は○万」の言葉で当てる形（cost_over_budget 3/15）、
//   「1件に好意」（気に入ったの駅）を物件を送る前の番で当てる形（proposing_liked_one 0/8）。言葉は合っているが、その状態になれる前提（送った物）がそろっていない。
//   直し: 状態ごとに前提（見積を送った・物件を送った）を置き、前提がそろわない番は状態を作らない（網の言葉は今のまま）
//   スイッチ SUBSTATE_CONTEXT: 既定 off（今の matchSubstateOf のまま）／on
import { matchSubstateOf } from "./turn-aims-after";

export function substateContextOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SUBSTATE_CONTEXT ?? "").trim().toLowerCase() === "on";
}
export type SubstateCtx = { estimateSent: boolean; propertiesSent: boolean };
/** 状態 → 前提（そろわなければ状態を作らない） */
export const SUBSTATE_NEEDS: Readonly<Record<string, Array<keyof SubstateCtx>>> = {
  cost_over_budget: ["estimateSent"], cost_too_cheap: ["estimateSent"], cost_installment: ["estimateSent"],
  proposing_liked_one: ["propertiesSent"], proposing_detail_question: ["propertiesSent"], proposing_mismatch: ["propertiesSent"], proposing_considering: ["propertiesSent"],
  viewing_dates: ["propertiesSent"], viewing_cannot: ["propertiesSent"], viewing_no_view_doubt: ["propertiesSent"],
  apply_intent: ["propertiesSent"], apply_timing: ["propertiesSent"],
};
/** 前提つきの細かい状態（純関数）。on の時だけ前提を見る・droppedBy＝前提で落とした時の前提の名前 */
export function substateInContext(text: string | null | undefined, ctx: SubstateCtx, env?: Record<string, string | undefined>): { id: string | null; droppedBy: string | null } {
  const s = matchSubstateOf(text, env);
  if (!s) return { id: null, droppedBy: null };
  if (!substateContextOn(env)) return { id: s.id, droppedBy: null };
  const miss = (SUBSTATE_NEEDS[s.id] ?? []).find((k) => !ctx[k]);
  return miss ? { id: null, droppedBy: miss } : { id: s.id, droppedBy: null };
}

// 2026-11-27 作業員A（#804）: 出てよい駅を複数（SUBSTATE_MULTI_STATION）は apply-route-substate.ts（substatesFor と同じ所）に置いた
export { substateStationsOf, substateMultiStationOn, SUBSTATE_ALSO_AT } from "./apply-route-substate";
