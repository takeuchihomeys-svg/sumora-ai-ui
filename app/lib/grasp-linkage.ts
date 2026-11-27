// app/lib/grasp-linkage.ts — 「現状の把握」と「進め方」の葉 × 出す側 の連携の表（持つ・使う・反映）（純関数・DB/LLM なし）
// 2026-11-27 作業員L（竹内さん 11/27「現状の把握とこれからどう進めるか把握する力を細分化して土台を固めて強化」「連携できるところも細かく連携すれば把握する能力も上がる」・統括役の割り振り）:
//   葉（12）ごとに、読むのに使える出す側を並べ、出す側ごとに 持つ（試験の写し＝problems.json の ledger・登録の条件 pc に記録がある）／使う（ブレインの材料の印 material_marks が付いた）／
//   反映（判断の欄に出た）を数える。2026-11-27: 中心の材料の塊の印（core_*・brain-core の CORE_MATERIAL_MARKS・記録だけ）を足した＝この印の付いた答えから「使う」が数えられる。印の無い出す側は「使う」を数えられない＝印を足すのが先（統括役の決め③）。作業員A の受け持ち表（conductor-ownership）の部品のキー（mark）と同じ名で持つ。
//   形は linkage-gap-matrix（出す側×受け取る側）と同じ考え: ここは 受け取る側＝ブレインの葉。数えるのは scripts/audit-grasp-linkage.ts（手元の json・費用0）
export type GraspLeaf = "station" | "substate" | "temp_doubt" | "open_promise" | "sent_reaction" | "move_in" | "waiting_for" | "next_line" | "next_move" | "ahead" | "timing" | "reply_or_aix";
export const GRASP_LEAF_JA: Record<GraspLeaf, string> = {
  station: "駅", substate: "細かい状態", temp_doubt: "温度・迷い", open_promise: "果たしていない約束", sent_reaction: "送った物と反応", move_in: "入居の時期と期限",
  waiting_for: "お客様が待っている物", next_line: "次に来る LINE の見込み", next_move: "次の一手", ahead: "2〜3手先", timing: "時期", reply_or_aix: "返信か AIX か",
};
export const GRASP_GROUP: Record<GraspLeaf, "現状の把握" | "進め方"> = { station: "現状の把握", substate: "現状の把握", temp_doubt: "現状の把握", open_promise: "現状の把握", sent_reaction: "現状の把握", move_in: "現状の把握", waiting_for: "現状の把握", next_line: "現状の把握", next_move: "進め方", ahead: "進め方", timing: "進め方", reply_or_aix: "進め方" };
/** 判断の欄（試験の結果の brain.*）のうち、その葉が出る所 */
export const LEAF_REFLECT: Record<GraspLeaf, string[]> = {
  station: ["situation_now"], substate: ["situation_now"], temp_doubt: ["customer_mindset", "hesitancy_pattern", "customer_emotion"], open_promise: ["ask_ledger", "turn_contract"],
  sent_reaction: ["our_send_uptake"], move_in: [], waiting_for: ["now_vs_later", "customer_questions"], next_line: ["next_send_link"],
  next_move: ["turn_contract", "reply_mode"], ahead: ["conductor_brief"], timing: ["appeal_timing"], reply_or_aix: ["reply_mode"],
};
/** 出す側: 持つ＝写しの表（ledger）か登録の条件の欄（pc）・使う＝材料の印（無ければ null＝数えられない）・読める葉 */
export type GraspSource = { id: string; name: string; table?: string; pcField?: string; derived?: boolean; marks: string[]; leaves: GraspLeaf[]; note?: string };
export const GRASP_SOURCES: readonly GraspSource[] = [
  { id: "promise_ledger", name: "約束の台帳（こちらの約束・期限）", derived: true, marks: ["core_promise", "check_promise_flow", "pickup_promise_flow", "now_fulfillable", "fulfil_turn"], leaves: ["open_promise", "waiting_for", "next_move", "timing"], note: "会話の通から作る（写しの表は無い）" },
  { id: "sent_properties", name: "物件の台帳（オススメした物件）", table: "sent_properties", marks: ["core_sent_props"], leaves: ["sent_reaction", "station", "next_move"], note: "【すでに送付済みの物件】は材料に入るが印が無い（pickup_why は選んだ理由の部品で別）" },
  { id: "property_pickups", name: "物件の台帳（ピックアップ・待ちの物件）", table: "property_pickups", marks: ["pickup_why_pending", "pickup_promise_flow"], leaves: ["waiting_for", "open_promise", "next_move"] },
  { id: "sent_image_properties", name: "物件の台帳（お客様が送ってきた物件）", table: "sent_image_properties", marks: ["pickup_why_sip"], leaves: ["sent_reaction", "waiting_for"] },
  { id: "estimate_records", name: "見積の記録", table: "estimate_records", marks: ["core_estimate_records", "intake_estimate"], leaves: ["sent_reaction", "station", "ahead", "next_move"], note: "ブレインの【送った御見積書】は印なし・入口の1行だけ印あり" },
  { id: "viewings", name: "内覧の記録", table: "viewings", marks: ["core_viewings"], leaves: ["station", "timing", "next_move"] },
  { id: "viewing_history", name: "内覧の履歴", table: "viewing_history", marks: ["core_viewings"], leaves: ["station", "sent_reaction"] },
  { id: "aix_usage_logs", name: "AIX の送った行", table: "aix_usage_logs", marks: ["core_aix_history"], leaves: ["sent_reaction", "open_promise", "reply_or_aix"], note: "AIX の送った行は会話と台帳の材料に入るが印が無い（our_parts_wide・exchange は既定 off の別の部品）" },
  { id: "sent_facts", name: "送った事実の帳面", table: "sent_facts", marks: ["core_ledger"], leaves: ["sent_reaction", "waiting_for"] },
  { id: "move_in_card", name: "入居の札（登録の条件の入居の時期）", pcField: "move_in_time", marks: ["core_cond"], leaves: ["move_in", "timing", "ahead"] },
  { id: "customer_summary", name: "顧客の要約（登録の条件の ai_summary）", pcField: "ai_summary", marks: [], leaves: ["temp_doubt", "substate", "move_in"] },
  { id: "route_map", name: "申込までの地図（駅・状態・逆算）", derived: true, marks: ["station_state", "route_backplan", "route_substate", "route_path_line"], leaves: ["station", "substate", "ahead", "next_move"] },
  { id: "deal_outcomes", name: "成約の台帳（成約データの道）", derived: true, marks: ["deal_flow_pre_apply"], leaves: ["ahead", "timing"], note: "写しには無い＝本番の記録で" },
  { id: "reaction_mindset", name: "反応の予想・気持ち×駅（#795）", derived: true, marks: ["mindset_station"], leaves: ["temp_doubt", "next_line", "next_move"] },
  { id: "aix_state_card", name: "AIX の札（AIX_STATE_CARD）", derived: true, marks: ["aix_state_card"], leaves: ["reply_or_aix", "substate"] },
  { id: "topic_state", name: "話題の状態（topic_state・ack_confirm）", derived: true, marks: ["topic_state", "ack_confirm"], leaves: ["substate", "waiting_for"] },
];
export type GraspRow = { id: string; ledger?: Record<string, unknown> | null; pc?: Record<string, unknown> | null; marks?: Record<string, unknown> | null; brain?: Record<string, unknown> | null };
export type GraspCount = { source: string; name: string; leaves: GraspLeaf[]; has: number; use: number | null; gap: number | null; noMark: boolean; derived: boolean; reflect: Partial<Record<GraspLeaf, number>> };
const hasRows = (v: unknown) => (Array.isArray(v) ? v.length > 0 : !!v && typeof v === "object" && Object.keys(v as object).length > 0);
const present = (v: unknown) => v != null && !(typeof v === "string" && !v.trim()) && !(Array.isArray(v) && !v.length);
/** 出す側ごとの 持つ・使う・穴（持つのに使わない）と、葉ごとの反映の数（純関数）。rows＝竹内さん本人の番の問題（写し）＋その番の結果（印・判断の欄） */
export function graspCounts(rows: readonly GraspRow[], srcs: readonly GraspSource[] = GRASP_SOURCES): GraspCount[] {
  return srcs.map((s) => {
    const holds = rows.filter((r) => s.derived ? true : s.table ? hasRows((r.ledger ?? {})[s.table]) : s.pcField ? present((r.pc ?? {})[s.pcField]) : false);
    const noMark = !s.marks.length;
    const used = noMark ? null : holds.filter((r) => s.marks.some((k) => Number((r.marks ?? {})[k] ?? 0) > 0)).length;
    const reflect: Partial<Record<GraspLeaf, number>> = {};
    for (const lf of s.leaves) reflect[lf] = holds.filter((r) => LEAF_REFLECT[lf].some((f) => present((r.brain ?? {})[f]))).length;
    return { source: s.id, name: s.name, leaves: s.leaves, has: holds.length, use: used, gap: used == null ? null : holds.length - used, noMark, derived: !!s.derived, reflect };
  });
}
/** 穴の順（純関数）: 記録があるのに材料に入っていない（印なしは「使う」が数えられない＝持つ数をそのまま穴の大きさに・印の足しが先）。
 *   会話から作る出す側（derived）は記録の有無が写しで決められない＝穴の順には入れない（作った部品が既定 off か場面が立たないかは受け持ち表で見る） */
export function graspGapRank(cs: readonly GraspCount[]): Array<{ source: string; name: string; size: number; kind: "材料に入らない" | "印なし（使うが数えられない）"; leaves: GraspLeaf[] }> {
  return cs.filter((c) => !c.derived && c.has > 0 && (c.noMark || (c.gap ?? 0) > 0))
    .map((c) => ({ source: c.source, name: c.name, size: c.noMark ? c.has : c.gap ?? 0, kind: c.noMark ? "印なし（使うが数えられない）" as const : "材料に入らない" as const, leaves: c.leaves }))
    .sort((a, b) => b.size - a.size);
}
