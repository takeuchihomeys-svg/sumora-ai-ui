// app/lib/route-station-unify.ts — 地図の駅と判断の記録の駅を1つにそろえる（純関数・LLM/DB なし）（竹内さん 11/27「地図弱い部分あるか・細分化して強化・ちゃんと連携されているのか」・#687 の土台）
// 2026-11-27 作業員A（統括役の頼み）: 地図の駅（locateApplyRoute）が、判断の記録の駅（前の判断の sg＝guide-measure の before/after）より手前に残る番が 60日で 14（本線 153 のうち）。
//   その 14番で竹内さん本人の一手が次の石に当たるのは、記録の駅で 9・地図の駅で 4＝記録の駅の方が竹内さんの動きに合う。ずれは全部 問い合わせ・ヒアリング・ピックアップの駅（序盤）
//   そろえ方: 本線で、記録の駅が地図の駅より先なら記録の駅を使う（戻す向きには使わない・分かれ道の番は触らない）
//   スイッチ ROUTE_STATION_FROM_RECORD: 既定 off（地図の駅のまま）／on
import { MAIN_ROUTE, type RouteNodeId } from "./apply-route-map";

export function routeStationFromRecordOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.ROUTE_STATION_FROM_RECORD ?? "").trim().toLowerCase() === "on";
}
const idx = (n: string | null | undefined) => MAIN_ROUTE.indexOf(String(n ?? "") as RouteNodeId);
/** そろえた駅（純関数）: 本線どうしで記録の駅が先なら記録・それ以外は地図のまま。changed＝そろえた番 */
export function unifyStation(mapNode: string | null | undefined, recordNode: string | null | undefined, branch?: string | null): { node: string | null; changed: boolean } {
  const m = mapNode ?? null;
  if (branch || idx(m) < 0 || idx(recordNode) < 0) return { node: m, changed: false };
  if (idx(recordNode) > idx(m) && idx(recordNode) < MAIN_ROUTE.indexOf("applying")) return { node: String(recordNode), changed: true };
  return { node: m, changed: false };
}
