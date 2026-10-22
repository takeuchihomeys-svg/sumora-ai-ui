// app/lib/brain-decision-ledger.ts — ブレインの判断の行（brain_decision_logs）に「結果の台帳」と結ぶための項目を足す（純関数・LLM なし）。
//   計画 memory/plan_outcome_ledger.md 段2（2026-10-08）: 今ある出力を残すだけ。判断の中身・文面は変えない。
//   列: building_key・room_no（判断した物件＝current_property を建物の鍵と号室に）・scene_key（ブレインの材料を絞る場面＝reply-scene）・brain_version（デプロイのコミット）
//   digest: tc（2択の表示）・pp（ピックアップの約束が残っている）・cp（会話の実態の段階）・cs（締めの戦略の頭 60字）
//   ※ scene_key は brain-scene の場面（reply-scene の ack/question/conditions…）。見張り（line_watch_turns.scene_key）の「AIX:〇〇／返信:〇〇」とは別の分け方
import { splitPropertyName } from "./customer-state";
import { resolveReplyScene } from "./reply-scene";

export type BrainDecisionLedgerCols = { building_key: string | null; room_no: string | null; scene_key: string | null; brain_version: string | null };

/** デプロイの版（Vercel のコミットの頭7字・無ければ local） */
export function brainVersionOf(env: Record<string, string | undefined>): string {
  const sha = (env.VERCEL_GIT_COMMIT_SHA ?? "").trim();
  return sha ? sha.slice(0, 7) : "local";
}

export function brainDecisionLedgerCols(meta: Record<string, unknown>, turnText: string | null | undefined, env: Record<string, string | undefined>): BrainDecisionLedgerCols {
  const prop = typeof meta.current_property === "string" ? meta.current_property : null;
  const ref = prop ? splitPropertyName(prop) : null;
  const text = String(turnText ?? "");
  return {
    building_key: ref?.buildingKey ?? null,
    room_no: ref?.room ?? null,
    scene_key: text.trim() ? resolveReplyScene({ customerText: text }).scene : null,
    brain_version: brainVersionOf(env),
  };
}

/** digest に足す短い項目（無い物は入れない） */
export function brainDecisionDigestExtra(meta: Record<string, unknown>): { tc?: boolean; pp?: boolean; cp?: string; cs?: string; dc?: Record<string, unknown>; fs?: Record<string, unknown> } {
  const out: { tc?: boolean; pp?: boolean; cp?: string; cs?: string; dc?: Record<string, unknown>; fs?: Record<string, unknown> } = {};
  // 2026-10-15 追加の調査（brain-deep-check）をかけた番だけ（2回目の呼び出しの割合・変わった率を数える）
  if (meta.deep_check && typeof meta.deep_check === "object") out.dc = meta.deep_check as Record<string, unknown>;
  // 2026-10-22 慣れた事は速く・難しい事はじっくり（BRAIN_FAST_SLOW=on の番だけ・難しさ・戻り道・2回目の割れを数える）
  if (meta.fast_slow && typeof meta.fast_slow === "object") out.fs = meta.fast_slow as Record<string, unknown>;
  if (meta.two_choice_mode === true) out.tc = true;
  if (meta.pending_pickup === true) out.pp = true;
  if (typeof meta.checkpoint_stage === "string" && meta.checkpoint_stage.trim()) out.cp = meta.checkpoint_stage.trim().slice(0, 20);
  if (typeof meta.closing_strategy === "string" && meta.closing_strategy.trim()) out.cs = meta.closing_strategy.trim().slice(0, 60);
  return out;
}
