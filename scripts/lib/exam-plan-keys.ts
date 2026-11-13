// scripts/lib/exam-plan-keys.ts — 試験の答案（scripts/brain-exam/results/<label>.jsonl の brain）に残すブレインの欄の一覧と planOf（純関数・作業員22・2026-11-13 に brain-exam.ts から移した）
//
// 新しいブレインの欄を試験で数える時はここに足す（足さないと答案に残らず、物差しが0件になる）。
// 2026-11-13 作業員22: 統括の記録の5つ（conductor_allocation・check_order・check_order_type・conductor_brief・judge_next）を足した
//   （w22-alloc-shadow8 で CONDUCTOR_ALLOCATION・CHECK_ORDER_TABLE を shadow にしたのに、答案に配分と型が1つも残らなかった）。
// テスト: scripts/test-exam-plan-keys.ts
export const PLAN_KEYS = ["current_property", "reply_mode", "action", "check_pattern", "alt_actions", "two_stage", "first_contact_pickup", "reply_direction", "key_topics", "avoid_topics", "customer_questions", "next_steps", "reply_opener", "far_move_in", "appeal_timing", "hesitancy_pattern", "customer_concern", "turn_contract", "asks", "request_ledger",
  // 2026-10-28 2択（採点の brainPathCode が読む・保存した行から採点し直す時に落ちていた）
  "two_choice_mode", "two_choice_aix", "two_choice_check_pattern", "two_choice_reply_kind", "two_choice_preferred", // 11/12 作業員7: 先の側（EXAM_TWO_CHOICE_PREFERRED の採点）
  // 2026-11-03 統括の土台（作業員2）: 通しの試験 scripts/exam-handoff.ts が読む欄（どれも既定 off の時は無い）
  "need", "plan_ahead", "three_layer", "main_point", "flow_signals", "material_conflicts", "conductor_roles", "recheck_digest", "aix_recheck", "aix_desk", "decisions_1103",
  // 2026-11-10 作業員7: 送る物の並び（TWO_MESSAGE_SEQUENCE）。旧は答案に残しておらず seq-dig の10本で並びを1つも数えられなかった（scripts/lib/send-seq-score.ts が読む）
  "send_sequence", "send_sequence_reply_count",
  // 2026-11-11 作業員14: 一通の読み（TURN_READ=on の turn_read）と気持ち（customer_mindset）。旧は答案に無く、読みが直ったかを試験で数えられなかった
  "turn_read", "customer_mindset", "turn_focus", "turn_topics",
  // 2026-11-12 作業員7: この番の目的・中期の狙い・仕込み・先読みの深さ（BRAIN_TURN_AIMS）
  "turn_aims",
  // 2026-11-12 作業員10（案A・BRAIN_SEVEN_FIELDS）: 竹内さんの7つの欄・潜在の4欄（文の統括の物差し scripts/audit-compose-understanding.ts が答案から読む）
  "seven_read", "latent_read",
  // 2026-11-12 作業員17（BRAIN_JUDGE_BASIS）: 判断の根拠のメモ（scripts/judge-basis-score.ts が読む）。conductor_focus は judge_basis が無い答案でも重点を数える元
  "judge_basis", "conductor_focus",
  // 2026-11-13 作業員22: 統括の記録（配分 CONDUCTOR_ALLOCATION・判断の順番の型 CHECK_ORDER_TABLE・統括の指示書 CONDUCTOR_BRIEF・判断の根拠の次の行き先 BRAIN_JUDGE_BASIS_NEXT）。
  //   scripts/allocation-score.ts・judge-basis-score.ts が答案から読む（どれも既定 off の時は無い＝答案は今と同じ）
  "conductor_allocation", "check_order", "check_order_type", "conductor_brief", "judge_next",
  // 2026-11-13 作業員22: 決めた事が書き手まで届いたか（DELIVERY_CHECK=shadow）。欄ごと・下の欄ごとの届きを答案に残す
  "delivery_check", "material_on_hand", "material_missing"] as const;
export function planOf(meta: Record<string, unknown> | null): Record<string, unknown> {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  for (const k of PLAN_KEYS) { const v = meta[k]; if (v !== undefined && v !== null && !(Array.isArray(v) && !v.length) && v !== "") out[k] = v; }
  return out;
}
