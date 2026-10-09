// app/lib/aix-branch-match.ts — AIX の枝の名前（property_check_result_available・property_send_new_arrival 等）を元の AIX に寄せる（純関数）
//
// 2026-10-08 竹内さん「自動的にする」（学習の抜け）: aix-weekly-learning の編集差分は aix_action の完全一致で引いていたため、
//   枝の名前で残った送信（直近60日で property_check_result_available 110・property_send_new_arrival 129・application_push_format 38 等）を学んでいなかった。
//   → 元の AIX（一番長く当たる物）に寄せて一緒に学ぶ。戻す: AIX_LEARN_BRANCHES=off（完全一致だけ）
export function aixLearnBranchesEnabled(env: Record<string, string | undefined>): boolean {
  return (env.AIX_LEARN_BRANCHES ?? "").trim().toLowerCase() !== "off";
}

/** action が属する元の AIX（bases の中で action と同じか「元_」で始まる一番長い物）。無ければ null */
export function aixBranchBase(action: string | null | undefined, bases: ReadonlyArray<string>): string | null {
  const a = (action ?? "").trim();
  if (!a) return null;
  let best: string | null = null;
  for (const b of bases) {
    if ((a === b || a.startsWith(`${b}_`)) && (!best || b.length > best.length)) best = b;
  }
  return best;
}

/** action が base の枝（または base そのもの）か。より長い別の元（例 property_send に対する property_send_xxx が別の元として並ぶ時）には譲る */
export function aixBelongsTo(action: string | null | undefined, base: string, bases: ReadonlyArray<string>): boolean {
  return aixBranchBase(action, bases) === base;
}
