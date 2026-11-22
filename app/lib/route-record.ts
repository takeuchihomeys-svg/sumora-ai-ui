// app/lib/route-record.ts — 申込までの地図の駅を、番ごとに meta.apply_route に残す口と、段の語を1つにそろえる表（純関数・作業員M・2026-11-21・台帳 #467）
//
// 竹内さん「打ち合わせしているように地図の部分も細かくちゃんと行う・細分化して強化する」（KB f64e0f5d・11/12 の申込までの地図の2段）。
//   見つけた切れ: apply-route-map の駅（12）・分かれ道（15）は毎番求めてブレインの材料とログに出すだけで、meta に残っていなかった。
//   そのうえ「今どの段か」の語が3系統で別々（conversations.status・meta.checkpoint_stage・conductor-focus の段）。
//   → APPLY_ROUTE_RECORD=on の時だけ meta.apply_route（駅・分かれ道・次の一手）に残し、段の語は地図の駅の id に寄せる（stationOf）。
// スイッチ APPLY_ROUTE_RECORD（既定 on・2026-11-21 統括役の了承・=off で止める）。記録だけ＝プロンプトと道は変えない。
// テスト: app/lib/__tests__/route-record.test.ts
import { ROUTE_NODES, type RouteNodeId } from "./apply-route-map";
import { SUBSTATES, DEPTH_JA, type Substate, type Plant } from "./apply-route-substate";
import type { PlantFact } from "./next-move-detail";
import { SUBSTATE_PHRASING, type SubstatePhrasing } from "./route-substate-phrasing";

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
  // 2026-11-23 作業員M（台帳 #620）: customer-state の段の語（判断の記録 digest.sg＝meta.customer_stage_now）も同じ表で駅に寄せる（apply-route-map の STAGE_TO_NODE と同じ写し方）
  first: "inquiry", viewing_arranging: "viewing_arrange", estimate_sent: "estimate",
};
/**
 * 2026-11-23 作業員M（台帳 #620・作業員R の数え 104/192＝54%）: 地図の駅と「段の語」が同じ所を指すか。語の系統が違う（digest.sg は customer-state の語・地図は駅の id）ので、
 *   生の文字列で比べると searching・viewing_arranging・estimate_sent・first が全部「違う」に数えられる。ここで寄せてから比べる。
 *   searching（物件検索中）は地図が台帳で 条件ヒアリング／ピックアップ／提案中 に分ける（apply-route-map.resolveRouteNode）＝この3つはどれでも同じ駅と数える。
 */
export const SEARCHING_NODES: readonly RouteNodeId[] = ["hearing", "pickup", "proposing"];
export function sameStation(node: string | null | undefined, stageWord: string | null | undefined): boolean | null {
  const w = String(stageWord ?? "").trim();
  if (!node || !w) return null;
  if (w === "searching") return (SEARCHING_NODES as readonly string[]).includes(node);
  const n = STATUS_TO_NODE[w];
  return n ? n === node : node === w;
}
export function stationOf(i: { applyRouteNode?: string | null; status?: string | null; checkpointStage?: string | null }): { node: RouteNodeId | null; from: "apply_route" | "status" | "checkpoint_stage" | null } {
  const isNode = (v: string | null | undefined): v is RouteNodeId => !!v && Object.prototype.hasOwnProperty.call(ROUTE_NODES, v);
  if (isNode(i.applyRouteNode)) return { node: i.applyRouteNode, from: "apply_route" };
  const st = String(i.status ?? "").trim();
  if (STATUS_TO_NODE[st] && isNode(STATUS_TO_NODE[st])) return { node: STATUS_TO_NODE[st], from: "status" };
  const cs = String(i.checkpointStage ?? "").trim();
  if (STATUS_TO_NODE[cs] && isNode(STATUS_TO_NODE[cs])) return { node: STATUS_TO_NODE[cs], from: "checkpoint_stage" };
  return { node: null, from: null };
}

// ── 地図 → 統括の指示書（ROUTE_TO_BRIEF・既定 off・2026-11-21 作業員M・台帳 #467 の (1)・竹内さん「統括がちゃんと使うことができるように」）──
//   駅・駅の中の細かい状態・目的・中期・長期・仕込み・先読みの深さを、統括の指示書（conductor_brief.route と aim.mid・aim.keyPoint・next.plants の空いている所）に入れる。
//   線（KB c5fd146d・11/12 の凍結 #6 の理由）: 状態の候補をブレインの材料・出力に置くと道が次の一手を進める側へ寄った（q065・q425）。
//     → ここは道を決めた後（指示書は analyzeConversationCore の後に組む）だけ。ブレインの層の要約（conductorBriefDigest）には入れない＝次の番のブレインにも届かない。
//   埋めるのは空いている欄だけ（ブレイン・判断の根拠・型の表の値を上書きしない）。状態は地図の駅と合う時だけ使う（合わない時は記録だけ・at_match=false）。

export function routeToBriefOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.ROUTE_TO_BRIEF ?? "").trim().toLowerCase() === "on";
}
/** 地図の仕込みの型 → 次の一手の先回りの事実の id（ask_send は事実でなくお願いなので渡さない） */
export const PLANT_TO_FACT: Readonly<Record<Plant, PlantFact | null>> = {
  scarcity: "one_room_only", hold_before_viewing: "hold_by_apply", support: "full_support", cost: "max_discount",
  screening: "independent_guarantor", timing: "move_in_date", ask_send: null,
};
/**
 * 状態を使ってよいか（#467 の (2) の「当たる状態だけ使う線」）。既定は全部の状態（few を除く）。
 *   ROUTE_SUBSTATE_DENY=<id,id>（22時以降の竹内さんの実送信の数えで外れた状態を外す）・few（例が4未満）は ROUTE_SUBSTATE_FEW=on の時だけ使う
 */
/**
 * 当たる状態の既定（2026-11-21 作業員M・scripts/audit-route-substate-takeuchi.ts・竹内さんの198通・網の当たり 62/198）:
 *   proposing_considering 網16・誘導先が表の先に入る 100% ／ apply_screening_worry 網13・69%・仕込み 77% ／ apply_intent 網4・100%。
 *   ほかは網の当たりが4未満（hearing_many_conditions・proposing_detail_question・apply_timing は網に型が無く 0）か、誘導先の一致が5割未満
 *   （proposing_liked_one 29%・cost_over_budget 43%・brought_vacancy は仕込み 29%）＝使わない。⚠ 198通は表を作った元の番（甘く出る）・夜に別の番で測り直す
 *   ROUTE_SUBSTATE_ALLOW=<id,id> で置き換える（"all" で全部）
 */
// 2026-11-21 夜 作業員M（DeepSeek の割り当て l1・竹内さんの番 500・測る半分 270番で測り直し）: 当たり（網が言ったうち正しい割合）が7割以上の状態だけ。
//   1版の網: proposing_considering 75%・apply_intent 100%・cost_installment 100%（apply_screening_worry は 31%＝198通の数えより大きく下がったので外す）
//   2版の網（ROUTE_SUBSTATE_NET_V2=on）: hearing_many_conditions 98%（46番）・proposing_considering 90%・viewing_dates 71%・cost_installment 100%・apply_intent 100%
//   （brought_vacancy 61%・apply_screening_worry 57%・proposing_liked_one 43%・cost_over_budget 33%・proposing_detail_question 29% は外す）
export const SUBSTATE_ALLOW_DEFAULT: readonly string[] = ["proposing_considering", "apply_intent", "cost_installment"];
export const SUBSTATE_ALLOW_DEFAULT_V2: readonly string[] = ["hearing_many_conditions", "proposing_considering", "viewing_dates", "cost_installment", "apply_intent"];
export function substateUsable(s: Pick<Substate, "id" | "few">, env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  const allowRaw = (env.ROUTE_SUBSTATE_ALLOW ?? "").trim();
  if (allowRaw.toLowerCase() !== "all") {
    const allow = allowRaw ? allowRaw.split(",").map((x) => x.trim()).filter(Boolean) : (env.ROUTE_SUBSTATE_NET_V2 ?? "").trim().toLowerCase() === "on" ? SUBSTATE_ALLOW_DEFAULT_V2 : SUBSTATE_ALLOW_DEFAULT;
    if (!allow.includes(s.id)) return false;
  }
  const deny = new Set((env.ROUTE_SUBSTATE_DENY ?? "").split(",").map((x) => x.trim()).filter(Boolean));
  if (deny.has(s.id)) return false;
  if (s.few && (env.ROUTE_SUBSTATE_FEW ?? "").trim().toLowerCase() !== "on") return false;
  return true;
}
export type RouteBriefSection = {
  node: string | null; branch: string | null; next: string | null;
  substate: { id: string; label: string; n: number; few: boolean; at_match: boolean; usable: boolean } | null;
  turn_aim: string | null; mid_aim: string | null; long_aim: string | null;
  plants: PlantFact[]; depth: 1 | 2 | 3 | null; depth_why: string | null;
  /** 2026-11-21 夜（#467 の (3)）: 竹内さんのその状態の言い回しの型と潜在の4つ（route-substate-phrasing・使える状態の時だけ） */
  phrasing?: SubstatePhrasing | null;
};
const o2 = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const s2 = (v: unknown, n: number): string | null => (typeof v === "string" && v.trim() ? Array.from(v.trim()).slice(0, n).join("") : null);
/** meta.apply_route（駅・分かれ道・substate の id）から指示書の route の欄（無ければ null） */
export function routeBriefSection(meta: Record<string, unknown> | null | undefined, env?: Env): RouteBriefSection | null {
  const ar = o2(o2(meta)?.apply_route);
  if (!ar) return null;
  const node = s2(ar.node, 30), branch = s2(ar.branch, 30);
  const sub = typeof ar.substate === "string" ? SUBSTATES.find((x) => x.id === ar.substate) ?? null : null;
  const atMatch = !!sub && (sub.at === node || sub.at === branch);
  const usable = !!sub && atMatch && substateUsable(sub, env);
  const use = usable ? sub : null;
  return {
    node, branch, next: s2(ar.next, 40),
    substate: sub ? { id: sub.id, label: sub.label, n: sub.n, few: !!sub.few, at_match: atMatch, usable } : null,
    turn_aim: use ? use.turnAim.slice(0, 30) : null,
    mid_aim: use && use.midAim !== "—" ? use.midAim.slice(0, 40) : null,
    long_aim: use ? use.longAim.slice(0, 30) : null,
    plants: use ? use.plants.map((p) => PLANT_TO_FACT[p]).filter((x): x is PlantFact => !!x) : [],
    depth: use ? use.depth : null,
    depth_why: use ? `${DEPTH_JA[use.depth]}（${use.depthWhy.slice(0, 40)}）` : null,
    phrasing: use ? SUBSTATE_PHRASING[use.id] ?? null : null,
  };
}
/** 書き手（AIX の2通目は作業員L の AIX_SECOND_DECIDED の塊から呼ぶ想定）へ渡す1塊・値のまま・状態が使えない番は空 */
export function routeAimNoteForWriter(brief: unknown): string {
  const r = o2(o2(brief)?.route) as RouteBriefSection | null;
  if (!r || !r.substate?.usable) return "";
  const L = [
    `- 今の状態（地図）: ${r.substate.label}${r.node ? `（駅 ${r.node}）` : ""}`,
    r.turn_aim ? `- この番の目的: ${r.turn_aim}` : "",
    r.mid_aim ? `- 中期（2〜3番先）: ${r.mid_aim}` : "",
    r.depth_why ? `- 先読み: ${r.depth_why}` : "",
  ].filter(Boolean);
  return `\n【申込までの地図の今の状態（道は決まった後・値のまま使う）】\n${L.join("\n")}`;
}
