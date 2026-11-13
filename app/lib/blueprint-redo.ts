// app/lib/blueprint-redo.ts — やり直しの輪: 最終チェックの4つ目の段（final-check-blueprint-match・作業員9）の印が付いた時、統括に戻して1回だけやり直す（純関数）
//
// 2026-11-13 作業員5（統括役の頼み②・深さの後）: 点検役の Claude は「設計図に当たらない文」を見つけたら、どう直すかを決めてから1回だけ書き直す。
//   統括には「印を見て、文ごとに何をするかを決め直す」段が無かった（印は見張りに出るだけ）。
//   形: 印の種類ごとに統括が一手を決める（消す／条件を絞る／対象を直す）→ 書き直しの口（final-check.runGroundedRevision）で1回だけ → 直した文にもう一度印を当て、前と後を記録する。
//   統括の重点（meta.conductor_focus）がある時は、その重点に沿って直すよう一手の先頭に書く（重点が無ければ今まで通り）。
//   出口の決まり（CLAUDE.md「出口は誤削除0でなければ入れない」）: 最初は shadow＝書き直した文は記録だけで、下書きは変えない。
//   印が「other」だけの番はやり直さない（行に当たらない理由が分からない文を消させない）。
//   切替: FC_BLUEPRINT_REDO=shadow（既定 off）。FC_BLUEPRINT_MARK=on の時だけ動く（印が無いと輪が回らない）。
// テスト: app/lib/__tests__/blueprint-redo.test.ts
import type { UnmatchedKind, UnmatchedMark } from "./final-check-blueprint-match";

export type BlueprintRedoMode = "off" | "shadow";
export function blueprintRedoMode(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): BlueprintRedoMode {
  return (env.FC_BLUEPRINT_REDO ?? "").trim().toLowerCase() === "shadow" ? "shadow" : "off";
}

export type RedoStep = "drop" | "narrow_conditions" | "fix_object";
/** 印の種類 → 統括の一手（other は決めない＝やり直さない） */
const STEP_OF: Partial<Record<UnmatchedKind, RedoStep>> = {
  fact_addition: "drop", latent_no_material: "drop", condition_repeat: "narrow_conditions", object_mismatch: "fix_object",
};
const STEP_TEXT: Record<RedoStep, { message: string; suggestion: string }> = {
  drop: {
    message: "文の設計図のどの行にも当たらない付け足しの文（資料の事実の付け足し・材料の無い潜在の文）",
    suggestion: "この文を消す。他の文は変えない。",
  },
  narrow_conditions: {
    message: "前の条件の全部の繰り返し（設計図の行は今の番で要る条件だけ）",
    suggestion: "条件は今の番で変わった物・聞かれた物だけを残し、他の条件の言い直しを消す。",
  },
  fix_object: {
    message: "設計図の行に無い物件名（対象の取り違え）",
    suggestion: "今の番の対象の物件だけを書く。行に無い物件名を消すか、対象の物件名に直す。",
  },
};

/** CheckIssue と同じ形（final-check を読み込まない＝循環を作らない） */
export type RedoIssue = { pass: "rule_check"; severity: "warning"; code: string; message: string; evidence: string; suggestion: string };
export type RedoPlan = { steps: RedoStep[]; kinds: UnmatchedKind[]; issues: RedoIssue[]; focus: string | null };

/**
 * 統括が印を見て一手を決める。やり直すのは1回だけ（redone=true なら null）・印が無い／other だけなら null。
 * focus: 統括の重点（meta.conductor_focus.focus）。ある時は一手の先頭に「重点に沿って」を書く。
 */
export function conductorRedoPlan(marks: ReadonlyArray<UnmatchedMark> | null | undefined, o: { redone?: boolean; focus?: { focus?: string | null; why?: string | null } | null } = {}): RedoPlan | null {
  if (o.redone || !marks?.length) return null;
  const f = String(o.focus?.focus ?? "").trim().slice(0, 40);
  const head = f ? `統括の重点「${f}」に沿って直す。` : "";
  const issues: RedoIssue[] = [], steps: RedoStep[] = [], kinds: UnmatchedKind[] = [];
  for (const m of marks) {
    const step = STEP_OF[m.kind];
    if (!step || !m.sentence.trim()) continue;
    steps.push(step); kinds.push(m.kind);
    issues.push({ pass: "rule_check", severity: "warning", code: `BLUEPRINT_REDO_${step.toUpperCase()}`, message: STEP_TEXT[step].message, evidence: m.sentence.slice(0, 200), suggestion: `${head}${STEP_TEXT[step].suggestion}` });
  }
  return issues.length ? { steps, kinds, issues: issues.slice(0, 4), focus: f || null } : null;
}

/** 見張りの materials に入れる1行（前と後の印の数・書き直したか・字数） */
export function blueprintRedoLog(conversationId: string | null | undefined, plan: RedoPlan, before: string, after: string | null, marksAfter: ReadonlyArray<UnmatchedMark> | null): Record<string, unknown> {
  return {
    tag: "fc:blueprint-redo", mode: "shadow", conversationId: conversationId ?? null,
    steps: plan.steps, kinds: plan.kinds, focus: plan.focus, n_before: plan.issues.length,
    revised: after != null, n_after: after != null ? (marksAfter ?? []).filter((m) => STEP_OF[m.kind]).length : null,
    len_before: before.length, len_after: after?.length ?? null, head_after: after ? after.trim().slice(0, 80) : null,
  };
}
