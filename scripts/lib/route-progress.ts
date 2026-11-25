// scripts/lib/route-progress.ts — 申込までの地図（apply-route-map）を竹内さん本人の番に当てた時の「一手の向き」と「地図の候補との一致」を決める純関数（LLM なし・DB なし・費用0）
//
// 2026-11-23 作業員R（台帳 #608・竹内さん 11/23「申込までの道筋をブレインは理解してちゃんと申込に向かって動くようになっているのか…地図の部分ちゃんと把握しているのか」）。
//   進んだ／止まったの数え方は作業員L の scripts/lib/guide-measure.ts（guideTurnsOf・--promise-wait --viewing-wait）にそろえる。ここは地図の側だけ:
//   ① 竹内さんの一手（AIX の種類／返信の締めの型）が、地図のどの駅へ向かう一手か（actTarget）
//   ② その一手が、地図の今の駅から見て 前へ（申込へ近づく）／同じ駅／後ろへ／動かない（答え・待ち）のどれか（actDirection）
//   ③ 地図の「申込へ向けた次の一手の候補」と竹内さんの一手が合うか（routeAgreement）
import { MAIN_ROUTE, type ApplyRouteLocation, type RouteNodeId } from "../../app/lib/apply-route-map";

/** 竹内さんの一手 → 向かう駅（null＝駅を動かす一手ではない: 答え・問い・待ち・電話 など） */
export const ACT_TARGET: Readonly<Record<string, RouteNodeId | "promise" | null>> = {
  "aix:condition_hearing": "hearing",
  "aix:property_send": "proposing", "aix:property_recommendation": "proposing",
  "aix:property_check_result": "interested",
  "aix:estimate_sheet": "estimate", "aix:cost_explain": "estimate", "aix:cost_breakdown": "estimate",
  "aix:viewing_invite": "viewing_arrange", "aix:meeting_place": "viewing_scheduled", "aix:greeting_viewing": "viewing_scheduled",
  "aix:application_push": "apply_prep", "aix:guarantor_info": "apply_prep",
  "reply:invite_apply": "apply_prep", "reply:invite_viewing": "viewing_arrange", "reply:invite_estimate": "estimate", "reply:ask_schedule": "viewing_arrange",
  "reply:promise": "promise",
};
export function actTarget(act: string): RouteNodeId | "promise" | null {
  return Object.prototype.hasOwnProperty.call(ACT_TARGET, act) ? ACT_TARGET[act] : null;
}
const idx = (n: RouteNodeId | null) => (n ? MAIN_ROUTE.indexOf(n) : -1);

export type ActDirection = "forward" | "same" | "back" | "promise" | "hold";
/**
 * 一手の向き（地図の今の駅から見て）。promise＝探す・確認する・見積る約束（2段の1段目）。hold＝駅を動かさない一手（答え・問い・待ち）
 *   駅が分からない時は、向かう駅があれば forward（申込へ向けて何かを置いた）として数えない＝ null を返す
 */
export function actDirection(node: RouteNodeId | null, act: string): ActDirection | null {
  const t = actTarget(act);
  if (t === "promise") return "promise";
  if (t == null) return "hold";
  if (!node || idx(node) < 0) return null;
  const d = idx(t) - idx(node);
  return d > 0 ? "forward" : d === 0 ? "same" : "back";
}

/** 約束の返信が果たす AIX（2段の1段目） */
const PROMISE_FULFILS = ["property_send", "property_recommendation", "property_check_result", "estimate_sheet"];
export type Agreement = "aix_match" | "promise_match" | "reply_match" | "reply_invite" | "push_missed" | "pushed_off_map" | "other_aix" | "no_next";
/**
 * 地図の次の一手の候補 vs 竹内さんの一手
 *   aix_match      候補の AIX と同じ AIX を送った
 *   promise_match  候補の AIX を果たす約束の返信（2段の1段目）
 *   reply_match    候補が返信（AIX なし）で、竹内さんも返信で駅を動かさなかった
 *   push_missed    候補は AIX（申込へ進める一手）なのに、竹内さんは答え・待ちで動かさなかった（地図が先を急いだ／竹内さんが待った）
 *   pushed_off_map 候補は返信なのに、竹内さんは駅を動かす一手を置いた（地図が待ちすぎ）
 *   other_aix      候補と違う AIX
 *   no_next        地図に候補が無い（位置が分からない）
 */
/**
 * 2026-11-25 作業員A（#687・統括役の頼み・弱い駅「分:他社物件の持ち込み」「物件ピックアップ」を1番ずつ読んだ数え方の漏れ）: 同じ一手の仲間の AIX
 *   ① 物件の束【物件ピックアップした】⇄1件【物件オススメ】（どちらも約束を果たす物件の AIX・ACK_PICKUP_AIX_PATH の道の1行と同じ）
 *   ② 持ち込みの物件の駅で【見積書送る】＝募集状況を確かめた結果を最大限割引の御見積書で送った（竹内さんの決め 10/07「持ち込みは募集状況＋最大限割引の御見積書の両方」・地図の駅の戻り道と同じ）
 *   止める ROUTE_AGREE_STRICT=on（前の数え方）
 */
export function sameStepAix(want: readonly string[], aix: string, branch: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  if (want.includes(aix)) return true;
  if ((env.ROUTE_AGREE_STRICT ?? "").trim().toLowerCase() === "on") return false;
  const P = ["property_send", "property_recommendation"];
  if (P.includes(aix) && want.some((w) => P.includes(w))) return true;
  if (branch === "brought_property" && aix === "estimate_sheet" && want.includes("property_check_result")) return true;
  return false;
}
export function routeAgreement(loc: (Pick<ApplyRouteLocation, "next"> & { branch?: string | null }) | null, act: string): Agreement {
  const want = loc?.next?.aix ?? null;
  if (!loc || !loc.next || want == null) return "no_next";
  const isAix = act.startsWith("aix:");
  const t = actTarget(act);
  if (isAix && sameStepAix(want, act.slice(4), loc.branch ?? null)) return "aix_match";
  if (t === "promise" && want.some((w) => PROMISE_FULFILS.includes(w))) return "promise_match";
  if (!want.length) return !isAix && t == null ? "reply_match" : "pushed_off_map";
  if (!isAix && t == null) return "push_missed";
  return isAix ? "other_aix" : "reply_invite"; // 返信で内覧・申込・見積へ誘った（AIX ではなく一言で誘う）
}
