// app/lib/deal-flow-line.ts — 成約データ（deal_outcomes の申込 146件の流れ）を、統括の入口とブレインの地図の材料に1行で渡す（純関数・決まった数・台帳 #728 ③）
// 2026-11-26 作業員L（竹内さん 11/25「地図は成約データから分析して流れ完全に理解できているのか」「成約データは過去の申込まで行ったの全部見れば強化できる」・統括役の割り振り）
//   数は scripts/audit-deal-flow.ts（11/26 朝・deal_outcomes 518件・申込 146・成約 60・推定の申込は「申込（推定）」に分けた）と
//   scripts/audit-deal-conv-read.ts（申込に届いた 146件の申込より前の通）の結果。動く数ではない（作り直した時に表を直す＝静的な数はコードに）。
//   作業員A の station_state（駅にいた日数・成約した件の中央の日数）と重ならないよう、ここは日数を出さない: 駅からの申込到達率と、申込に届いた件のこの駅の次の段だけ。
//   申込準備の手前の駅（気に入った・内覧後・申込準備）には「申込の直前の一手は手打ちの返信が大半（質問・あいづちに答える）」を添える。
//   切替: CONDUCTOR_DEAL_FLOW_LINE=on（入口の統括の材料）・DEAL_FLOW_PRE_APPLY_LINE=on（ブレインの地図の材料・申込準備の手前の駅だけ）。どちらも既定 off
// テスト: app/lib/__tests__/deal-flow-line.test.ts

type Env = Record<string, string | undefined>;
import { applyRouteNoViewingPathOn } from "./apply-route-map";
export const DEAL_FLOW_VERSION = "df-20261126";
/** 駅 → 申込到達率（その駅を通った件のうち申込に届いた）・申込に届いた件のこの駅の次の段（多い順・件） */
export const DEAL_FLOW_BY_STATION: Readonly<Record<string, { applied: number; n: number; next?: string }>> = {
  inquiry: { applied: 146, n: 518, next: "物件の提案 52・条件 43・申込 35" },
  hearing: { applied: 36, n: 100, next: "物件の提案 37・申込 20・内覧の日時 5" }, // 条件の時刻の付いた件だけ（初回の通に条件の道は別・#728）
  pickup: { applied: 109, n: 351, next: "見積 37・申込 34・内覧の日時 25" },
  proposing: { applied: 109, n: 351, next: "見積 37・申込 34・内覧の日時 25" },
  interested: { applied: 86, n: 211 },
  estimate: { applied: 61, n: 170, next: "申込 22・内覧の日時 17・条件 11" },
  viewing_arrange: { applied: 59, n: 96 },
  viewing_scheduled: { applied: 59, n: 96, next: "内覧した 31・申込 12" },
  viewed: { applied: 45, n: 69, next: "申込 23・条件 6" },
};
/** 申込準備の手前の駅（申込の直前の一手の材料を添える） */
export const PRE_APPLY_STATIONS: ReadonlySet<string> = new Set(["interested", "viewed", "apply_prep"]);
/** 申込に届いた 146件の申込の直前の一手（audit-deal-conv-read） */
export const LAST_MOVE_BEFORE_APPLY = "申込の直前の一手は手打ちの返信 109/146（AIX は 26・申込へ 9）。直前のお客様は質問・あいづち・その他が大半（申込の意思は 19）＝聞かれた事に答えて、申込のご案内を返信で";

export const conductorDealFlowLineOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.CONDUCTOR_DEAL_FLOW_LINE ?? "").trim().toLowerCase() === "on";
export const dealFlowPreApplyLineOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.DEAL_FLOW_PRE_APPLY_LINE ?? "").trim().toLowerCase() === "on";

const pct = (a: number, b: number) => `${Math.round((a / b) * 100)}%（${a}/${b}）`;
/** 作業員A と決め（11/26）: APPLY_ROUTE_NO_VIEWING_PATH が on の時は、言っている事が近いので「申込の直前の一手」の添えは出さない（割合と次の段は残す） */
const preNoteOn = (env?: Env) => !applyRouteNoViewingPathOn(env ?? (typeof process !== "undefined" ? process.env : {}));
/** 入口の統括の材料の1行（駅が分からない・表に無い駅は空） */
export function dealFlowIntakeLine(node: string | null | undefined, env?: Env): string {
  if (!node) return "";
  const r = DEAL_FLOW_BY_STATION[node];
  const pre = PRE_APPLY_STATIONS.has(node) && preNoteOn(env);
  if (!r && !pre) return "";
  const parts: string[] = [];
  if (r) parts.push(`この駅から申込に届いた ${pct(r.applied, r.n)}`);
  if (r?.next) parts.push(`申込に届いた件のこの駅の次: ${r.next}`);
  if (pre) parts.push(LAST_MOVE_BEFORE_APPLY);
  return `【成約データ（申込146件・決まった数）】${parts.join("／")}`;
}
/** ブレインの地図の材料の1行（申込準備の手前の駅だけ・それ以外は空） */
export function dealFlowPreApplyLine(node: string | null | undefined, env?: Env): string {
  if (!node || !PRE_APPLY_STATIONS.has(node) || !preNoteOn(env)) return "";
  return `【成約データ（申込146件）】${LAST_MOVE_BEFORE_APPLY}`;
}
