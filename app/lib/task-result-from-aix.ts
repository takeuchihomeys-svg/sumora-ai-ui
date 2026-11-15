// app/lib/task-result-from-aix.ts — AIX【物件確認した】で選んだ確認の型から、空室確認のタスク（line_tasks）の結果（result）を決める（純関数）
//
// 2026-11-15 作業員H（統括役の頼み・案A＝竹内さんの承認済み・aix_feature_suggestions 907c74b4 adopted）:
//   /api/line-tasks/complete は result を受け取り、物件の募集状況（sent_properties.recruitment_status）にも書き戻す作りだが、
//   画面（app/page.tsx）の AIX 送信の後の完了は id と source しか送っていなかった＝ line_tasks.result は 30日で 0/247（作業員E の調べ）。
//   その結果、ブレインの【空室確認の回答結果（確定事実）】の段（brain-core・buildCheckResultsText）は一度も出ていなかった。
//   画面は AIX で選んだ確認の型（check_pattern）と物件ごとの結果（prop_statuses）を一緒に送るだけ（見た目は変えない）。
//   決めるのはサーバー（line-tasks/complete）。11/15 から既定 on（止める TASK_RESULT_FROM_AIX=off）＝全件監査（scripts/audit-task-result-from-aix.ts・60日）で
//   付けた 52件のうち送った AIX の文と食い違い 0（読めない・2つ読めた 5件は目で読んで正しい形）・送った文と違えば付けない形にしてから。
// 型の対応（aix_usage_logs の 60日の実物の値: available・unavailable・alternative・vacating・interior_photo・mgmt_*）:
//   募集中（available）→ available／募集終了・満室（unavailable）→ taken／退去予定（vacating）→ move_out_planned／
//   2番手（second・second_position）→ second_position／聞かれた部屋は無いが同じ建物の別の部屋が募集中（alternative）→ taken（メモ「同じ建物の別の部屋が募集中」）
//   募集状況でない確認（室内写真・管理会社に聞いた条件 mgmt_* 等）は結果を付けない（空室確認の答えではない）
//   物件が複数で結果が割れた時は付けない（どの物件の答えか取り違えない・メモにも書かない）
export type TaskResult = "available" | "taken" | "second_position" | "move_out_planned";
type Env = Record<string, string | undefined>;
export function taskResultFromAixOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.TASK_RESULT_FROM_AIX ?? "").trim().toLowerCase() !== "off"; // 11/15 統括役の頼み: 監査で食い違い 0 → 既定 on（止める =off）
}
const STATUS_TO_RESULT: Record<string, TaskResult> = {
  available: "available", unavailable: "taken", ended: "taken", taken: "taken", alternative: "taken",
  vacating: "move_out_planned", move_out_planned: "move_out_planned", second: "second_position", second_position: "second_position",
};
const NOTE: Partial<Record<string, string>> = { alternative: "聞かれた部屋は満室・同じ建物の別の部屋が募集中", vacating: "退去予定（募集前）", unavailable: "募集終了" };

export function taskResultFromAix(i: { aixType: string | null | undefined; checkPattern: string | null | undefined; text?: string | null; propStatuses?: ReadonlyArray<string | null | undefined> | null; propertyNames?: ReadonlyArray<string | null | undefined> | null }): { result: TaskResult; note: string | null } | null {
  if (String(i.aixType ?? "") !== "property_check_result") return null;
  const statuses = (i.propStatuses ?? []).map((s) => String(s ?? "").trim()).filter(Boolean);
  const cp = String(i.checkPattern ?? "").trim();
  const keys = statuses.length ? statuses : cp ? [cp] : [];
  if (!keys.length) return null;
  const mapped = keys.map((k) => STATUS_TO_RESULT[k] ?? null);
  if (mapped.some((m) => m === null)) return null; // 室内写真・管理会社の条件など＝空室確認の答えではない
  if (new Set(mapped).size !== 1) return null;      // 物件ごとに割れた＝取り違えないため付けない
  // 2026-11-15 作業員H（on の前の全件監査・60日 68件で食い違い 1件）: 選んだ型が「募集終了（unavailable）」なのに、送った AIX の文は「1番手のお申し込みが入っており…2番手以降でのお申込み受付」
  //   ＝型の選び方と文がずれる事がある。送った文（text）が渡された時は、文の言葉から読める結果と違えば付けない（誤り0を優先・付けない方に倒す）。
  //   同じ建物の別の部屋が募集中（alternative）は文に「募集中」が出るのが正しい形なので比べない
  if (i.text != null && !keys.includes("alternative")) {
    const tr = resultOfAixText(i.text);
    if (tr !== null && tr !== mapped[0]) return null;
  }
  const names = (i.propertyNames ?? []).map((n) => String(n ?? "").trim()).filter(Boolean);
  const noteParts = [names.length ? names.slice(0, 3).join("・") : null, NOTE[keys[0]] ?? null].filter(Boolean);
  return { result: mapped[0] as TaskResult, note: noteParts.length ? noteParts.join("：").slice(0, 200) : null };
}

/** 送った AIX の文の言葉から読める結果（読めない＝null・2つ以上＝"mixed"）。監査（scripts/audit-task-result-from-aix.ts）と同じ関数 */
export function resultOfAixText(t: string): TaskResult | "mixed" | null {
  const s = String(t ?? "").normalize("NFKC");
  const hits = new Set<TaskResult>();
  if (/2番手|二番手|先行(の)?(お)?申込|1番手(の)?(お)?申(し)?込/.test(s)) hits.add("second_position");
  if (/退去予定/.test(s)) hits.add("move_out_planned");
  if (/募集(が)?終了|満室|埋まって|成約済|募集に出て(い|お)(ない|らず|りません)/.test(s)) hits.add("taken");
  if (/募集中|空いて(おり|い)|空室(で|となって)|ご紹介(可能|出来)/.test(s)) hits.add("available");
  if (!hits.size) return null;
  return hits.size === 1 ? [...hits][0] : "mixed";
}

/** ブレインの【空室確認の回答結果（確定事実）】の段（brain-core から移した・文字は変えていない） */
export type TaskRow = { task_type: string; status: string; result: string | null; result_note: string | null };
export const TASK_RESULT_LABEL: Record<string, string> = { available: "空室あり（申込可）", taken: "申込済み・埋まった", second_position: "2番手（先行申込あり）", move_out_planned: "退去予定（募集前）" };
const TASK_LABEL: Record<string, string> = { property_check: "物件確認（空室確認）", property_send: "物件送付" };
export function buildCheckResultsText(allTasks: ReadonlyArray<TaskRow>): string {
  const resolvedWithResult = allTasks.filter((t) => t.status !== "pending" && t.result).slice(0, 3);
  return resolvedWithResult.length > 0
    ? `\n【空室確認の回答結果（確定事実）】\n${resolvedWithResult.map((t) => `- ${TASK_LABEL[t.task_type] ?? t.task_type}: ${TASK_RESULT_LABEL[t.result ?? ""] ?? t.result}${t.result_note ? `（${t.result_note.slice(0, 60)}）` : ""}`).join("\n")}\n※「募集終了」「申込済み」となった物件について「募集状況を確認します」と言ってはならない（確認済みの確定事実。再言及は誤情報になる）`
    : "";
}
