// scripts/lib/exam-snapshot-need.ts — スイッチが効くのに要る行が試験の写し（problems.json の ledger）に有るか・on の回で部品の印が出たか（純関数・LLM/DB なし）
// 2026-11-27 作業員A（台帳 #683・作業員L の #803 試験の辞書 scripts/lib/exam-dictionary.ts が import する・表は1つ）
//   ① SNAPSHOT_NEED: スイッチ → 要る行（複数は全部要る＝AND）。snapshotHas で problems.json の ledger[table]（{ ago, row }）を見る
//   ② reachGateOf: on にした回で目当ての材料の印（material_marks）が出た問題だけを比べる。届いた数が少なければ結果を出さず「届かず」（統括役 11/27 の頼み）
//      11/26 の晩の a-cpf 4本で約束の流れの1行（check_promise_flow）が届いたのは q203・q468 の2回だけ＝効くはずの問題で部品が動かないまま比べていた
export type SnapshotNeed = { table: string; where?: Record<string, string>; min: number };
export const SNAPSHOT_NEED: Record<string, SnapshotNeed[]> = {
  BRAIN_PICKUP_PROMISE_FLOW: [{ table: "property_pickups", where: { status: "pending" }, min: 0 }, { table: "aix_usage_logs", min: 0 }],
  PICKUP_WHY_TO_BRAIN: [{ table: "property_pickups", where: { status: "sent" }, min: 1 }],
  PICKUP_WHY_PENDING_MATCH: [{ table: "property_pickups", where: { status: "pending" }, min: 1 }, { table: "aix_usage_logs", where: { aix_type: "property_send" }, min: 1 }],
  SIP_JUDGE: [{ table: "sent_image_properties", min: 1 }],
  AIX_STATE_CARD: [{ table: "aix_usage_logs", min: 1 }],
  BRAIN_CHECK_PROMISE_FLOW: [{ table: "aix_usage_logs", min: 0 }],
};
/** 写しに要る行が有るか（純関数・min 0 の行は表が写っていれば良い） */
export function snapshotHas(needs: readonly SnapshotNeed[], ledger: Record<string, unknown> | null | undefined): boolean {
  if (!ledger) return false;
  return needs.every((n) => {
    const rows = ledger[n.table];
    if (!Array.isArray(rows)) return false;
    const hit = rows.filter((r) => { const row = ((r as { row?: Record<string, unknown> })?.row ?? {}) as Record<string, unknown>; return Object.entries(n.where ?? {}).every(([k, v]) => String(row[k] ?? "").split("/")[0] === v); });
    return hit.length >= n.min;
  });
}
/** スイッチ → on の回で目当ての材料の印（material_marks の欄）。印の無い部品は無い＝「判定できない（印を足すのが先）」 */
export const SWITCH_TARGET_MARK: Record<string, string> = {
  BRAIN_CHECK_PROMISE_FLOW: "check_promise_flow", BRAIN_PICKUP_PROMISE_FLOW: "pickup_promise_flow", APPLY_ROUTE_BACKPLAN: "route_backplan",
  AIX_BOUNDARY_LINE: "aix_boundary", AIX_DICTIONARY_LINE: "aix_dictionary", CHAIN_INSIGHT_LINE: "chain_insight", AIX_STATE_CARD: "aix_state_card",
  PICKUP_WHY_TO_BRAIN: "pickup_why", PICKUP_WHY_PENDING_MATCH: "pickup_why_pending", STATION_STATE_LINE: "station_state",
  MOVE_IN_LINE: "move_in_line", CUSTOMER_KARTE: "customer_karte", BRAIN_ESTIMATE_REACTION: "estimate_reaction", // 2026-11-28 作業員L（見積の後の反応の型を足した番だけ）
  BRAIN_MATERIAL_PARALLEL: "material_parallel", SEARCH_CHOICE_TWO_MODE_SPLIT: "search_choice_two_mode", CONDUCTOR_INTAKE_STAFF_REFRESH: "intake_staff_refresh", BRAIN_MATERIAL_MISS_NOTE: "material_miss_note", ACK_SOFT_NEXT: "ack_soft_next", // 2026-11-27 作業員L（#818 案 A） // 2026-11-27 作業員L（材料の読みを並べる・プロンプトは同じ＝記録の印だけ）
  COND_PICKUP_SENT_FIRST: "cond_pickup_sent_first", TWO_STAGE_SCREENING_NO_REWRITE: "screening_no_rewrite_turn", // 2026-11-27 作業員L（印を足す順の1番目） // 2026-11-27 作業員L（#806 お客様のカルテ） // 2026-11-27 作業員L（入居の時期と期限の1行）
  // 2026-11-27: 印なしだった3部品に印を足した（brain-core・on の時だけ）
  UNANSWERED_ASKS_LINE: "unanswered", // 2026-11-27 #814 まだ答えていない事
  PROMISE_CHECK_NO_SENT_CLOSE: "overdue_check_strict", PROMISE_CALL_VIEW_FULFIL: "overdue_call_view", // 2026-11-28 作業員L（#856・#669・期日超えの約束の材料に入った番だけ）
  CONDUCTOR_DEAL_FLOW_LINE: "deal_flow_intake", DEAL_FLOW_PRE_APPLY_LINE: "deal_flow_pre_apply", // 2026-11-28 作業員L（#728 ③ 成約データの1行・入口と申込準備の手前の駅）
  TIME_MAP_LINE: "time_map", // 2026-11-27 #808（配線は逆算の on の後）
  BACKPLAN_TO_WRITER: "backplan_to_writer", BACKPLAN_NEXT_STONE: "backplan_next_stone",
  ACK_PICKUP_AIX_PATH: "ack_pickup_path", BRAIN_RULE6_OPEN_PROMISE: "rule6_open_turn", APPLY_ROUTE_NEXT_BY_TURN: "route_next_by_turn",
  // 2026-11-27 作業員A（統括役の頼み・L の switch-mark-coverage で止まった2本と、今朝「印なし」だった2本）
  SUBSTATE_CONTEXT: "substate_context", // 細かい状態を前提つきで読んだ番（外した番は substate_context_dropped も）
  ROUTE_STATION_FROM_RECORD: "route_station_unify", // まだ配線していない（route-station-unify.ts）。配線する時に同じ名前の印を付ける
  FIRST_CONTACT_READY_TWO_STAGE: "first_contact_two_stage", // 初回で条件が揃った番にピックアップの約束の2段を作った番
  BRAIN_MSG_WINDOW_UNITS: "msg_window_units", // 束ねた画像の行＋いつもの窓より多く読めた通の数（0＝off と同じ材料）
};
export type ReachRow = { id: string; marks: Record<string, unknown> | null | undefined };
export type ReachVerdict = { mark: string | null; reached: string[]; notReached: string[]; verdict: "比べる" | "届かず" | "印なし" };
/** on の回の行（問題 id と brain.material_marks）から、目当ての印が出た問題だけを比べる（純関数）。届いた問題が minReached より少なければ「届かず」 */
export function reachGateOf(sw: string, onRows: readonly ReachRow[], targets: readonly string[], minReached = 3): ReachVerdict {
  const mark = SWITCH_TARGET_MARK[sw] ?? null;
  if (!mark) return { mark: null, reached: [], notReached: [...targets], verdict: "印なし" };
  const reached = targets.filter((id) => onRows.some((r) => r.id === id && Number((r.marks ?? {})[mark] ?? 0) > 0));
  const notReached = targets.filter((id) => !reached.includes(id));
  return { mark, reached, notReached, verdict: reached.length >= minReached ? "比べる" : "届かず" };
}
