// app/lib/route-record.ts — 申込までの地図の駅を、番ごとに meta.apply_route に残す口と、段の語を1つにそろえる表（純関数・作業員M・2026-11-21・台帳 #467）
//
// 竹内さん「打ち合わせしているように地図の部分も細かくちゃんと行う・細分化して強化する」（KB f64e0f5d・11/12 の申込までの地図の2段）。
//   見つけた切れ: apply-route-map の駅（12）・分かれ道（15）は毎番求めてブレインの材料とログに出すだけで、meta に残っていなかった。
//   そのうえ「今どの段か」の語が3系統で別々（conversations.status・meta.checkpoint_stage・conductor-focus の段）。
//   → APPLY_ROUTE_RECORD=on の時だけ meta.apply_route（駅・分かれ道・次の一手）に残し、段の語は地図の駅の id に寄せる（stationOf）。
// スイッチ APPLY_ROUTE_RECORD（既定 on・2026-11-21 統括役の了承・=off で止める）。記録だけ＝プロンプトと道は変えない。
// テスト: app/lib/__tests__/route-record.test.ts
import { ROUTE_NODES, type RouteNodeId } from "./apply-route-map";

type Env = Record<string, string | undefined>;
export function applyRouteRecordOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  // 2026-11-21 統括役の了承: 記録だけ（プロンプト・道・文は変えない）なので試験なしで既定 on。=off で止める
  return (env.APPLY_ROUTE_RECORD ?? "").trim().toLowerCase() !== "off";
}

/**
 * 会話の状態（conversations.status）と checkpoint_stage の語を、地図の駅の id に寄せる（1つの語彙）。
 *   meta.apply_route.node（ブレインが番ごとに求めた駅）があればそれが正。無い時だけ状態の語から寄せる（目安）。寄せられない語は null（推測で埋めない）
 */
const STATUS_TO_NODE: Record<string, RouteNodeId> = {
  hearing: "hearing", inquiry: "inquiry", new: "inquiry", first_reply: "inquiry",
  searching: "pickup", pickup: "pickup", proposing: "proposing", interested: "interested",
  estimate: "estimate", estimating: "estimate", viewing: "viewing_arrange", viewing_arrange: "viewing_arrange",
  viewing_scheduled: "viewing_scheduled", viewed: "viewed", apply_prep: "apply_prep", applying: "applying", application: "applying", screening: "applying",
  contract: "won", closed_won: "won", won: "won",
};
export function stationOf(i: { applyRouteNode?: string | null; status?: string | null; checkpointStage?: string | null }): { node: RouteNodeId | null; from: "apply_route" | "status" | "checkpoint_stage" | null } {
  const isNode = (v: string | null | undefined): v is RouteNodeId => !!v && Object.prototype.hasOwnProperty.call(ROUTE_NODES, v);
  if (isNode(i.applyRouteNode)) return { node: i.applyRouteNode, from: "apply_route" };
  const st = String(i.status ?? "").trim();
  if (STATUS_TO_NODE[st] && isNode(STATUS_TO_NODE[st])) return { node: STATUS_TO_NODE[st], from: "status" };
  const cs = String(i.checkpointStage ?? "").trim();
  if (STATUS_TO_NODE[cs] && isNode(STATUS_TO_NODE[cs])) return { node: STATUS_TO_NODE[cs], from: "checkpoint_stage" };
  return { node: null, from: null };
}
