// app/lib/brain-scene.ts — ブレイン（AIX-META を作る判断）の材料を場面で絞る（3巡目・2026-10-07 竹内さん
//   「ブレインもこのように動的な部分限定してつかえば質が上がって費用も抑えることが出来るのでは？　設計知見と協力して徹底的に調査する」）。
//
// 返信の場面の整理（reply-scene.ts）と同じ判定（お客様の今の番の文だけ・決定論）で場面を1つ決め、ブレインの「毎回変わる側」（キャッシュの効かない
//   ユーザーの材料）から、その場面の判断に関係ない物を入れない。キャッシュの効く system（静的・DB 由来）は触らない（鍵を割らない）。
//   測った事（10/07・再生 99回の brain:blocks の平均）: 毎回の材料 12,571字のうち アクション別ルール 4,134（候補の AIX の上位15行・場面に関係なく同じ）・
//   成約／失注パターン（全体分析だけ）2,697・関連ナレッジ 1,266・成約した会話の返信例 398。本番の brain_fresh（14日 1,100回）は 1回 約 $0.049 で
//   キャッシュの効かない入力（平均 10.8k トークン）が約4割。
// 絞る物（入れない物だけを書く＝漏れても今より悪くならない側。台帳・場面の証拠・約束・内覧の流れ・物件・条件・履歴は全場面で残す）:
//   ①アクション別ルール: その場面で選ばれうる AIX のルールだけ（上位15行のまま中身が場面に合う）。other は全部
//   ②成約・失注パターン（winning）・成約した会話の返信例（contractExamples）: 会話全体の戦略の材料。短いお礼・質問・初期費用・内覧・申込・物件を送ってきた番は入れない
//   ③関連ナレッジ（RAG）: 短いお礼の番は入れない（話題を閉じる番・ack-topic-scope と同じ考え）
// 戻す: BRAIN_SCENE_MATERIALS=off（既定 off＝本番は今まで通り。再生で前後を比べて上がる場面だけ竹内さんと決めて on にする）
//   テストは analyzeConversation の opts.sceneMaterials="on"|"off"（環境変数より優先）
import type { ReplyScene } from "./reply-scene";

/** 場面ごとに選ばれうる AIX（アクション別ルールを絞る）。null＝全部 */
export const BRAIN_SCENE_ACTIONS: Record<ReplyScene, readonly string[] | null> = {
  // 約束の後のお礼（約束を果たす AIX）・内覧当日のお礼
  ack: ["property_send", "property_recommendation", "property_check_result", "estimate_sheet", "viewing_invite", "meeting_place", "greeting_viewing"],
  considering: ["property_recommendation", "property_send", "viewing_invite", "application_push", "followup_revive", "zenryoku_support"],
  question: ["property_check_result", "acknowledge_check", "estimate_sheet", "viewing_invite", "application_push", "condition_hearing"],
  conditions: ["property_send", "property_recommendation", "condition_hearing", "property_check_result", "zenryoku_support"],
  property_share: ["property_check_result", "estimate_sheet", "acknowledge_check", "property_recommendation", "viewing_invite"],
  cost: ["estimate_sheet", "property_check_result", "property_recommendation", "application_push"],
  viewing: ["viewing_invite", "meeting_place", "greeting_viewing", "application_push", "property_check_result"],
  apply: ["application_push", "applying", "property_check_result", "estimate_sheet"],
  other: null,
};

export type BrainMaterialKey = "winning" | "contractExamples" | "ragKnowledge";
export const BRAIN_SCENE_DROP: Record<ReplyScene, readonly BrainMaterialKey[]> = {
  ack: ["winning", "contractExamples", "ragKnowledge"],
  considering: [],
  question: ["winning", "contractExamples"],
  conditions: ["contractExamples"],
  property_share: ["winning", "contractExamples"],
  cost: ["winning", "contractExamples"],
  viewing: ["winning", "contractExamples"],
  apply: ["winning", "contractExamples"],
  other: [],
};

export function brainSceneMaterialsEnabled(env: Record<string, string | undefined>, override?: "on" | "off" | null): boolean {
  if (override === "on") return true;
  if (override === "off") return false;
  return (env.BRAIN_SCENE_MATERIALS ?? "").toLowerCase() === "on";
}

/** アクション別ルール（優先度の高い順）を場面の AIX に絞って上位 limit 行。off・other・絞って0行の時は元の上位 limit 行（壊れない側） */
export function sceneActionRules<T extends { action_type: string | null }>(rows: readonly T[], scene: ReplyScene | null | undefined, enabled: boolean, limit = 15): T[] {
  const want = enabled && scene ? BRAIN_SCENE_ACTIONS[scene] : null;
  if (!want) return rows.slice(0, limit);
  const kept = rows.filter((r) => !!r.action_type && want.includes(r.action_type));
  return (kept.length ? kept : rows).slice(0, limit);
}

export function keepBrainMaterial(scene: ReplyScene | null | undefined, key: BrainMaterialKey, enabled: boolean): boolean {
  if (!enabled || !scene) return true;
  return !BRAIN_SCENE_DROP[scene].includes(key);
}
