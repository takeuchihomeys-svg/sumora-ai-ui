// app/lib/auto-star-applied.ts — 成果連動の☆（auto-star-winners）を「申込に届いた会話」にも広げる決まり（純関数・DB/LLM なし）
//
// 2026-10-08 竹内さん「自動的にする」（学習の抜け: 申込まで行った会話に☆が付かない）:
//   成功の基準は申込到達（application-reach.ts の決定①）。旧は conversations.status=closed_won の会話だけに☆を付けていたので、
//   申込まで届いた会話（deal_outcomes.applied_at）の返信は学習に入らなかった（10/08 時点で直近30日 30会話・未☆の候補 259件）。
//   → 窓の中に申込が入った会話も☆の対象にする。ただし☆を付けるのは「その会話の最初の申込の時刻より前」に作られた返信だけ
//     （申込以降は別ツールの領分・申込フォーマット等の個人情報を手本に入れない）。
//   戻す: AUTO_STAR_APPLIED=off（旧＝closed_won だけ）
export function autoStarAppliedEnabled(env: Record<string, string | undefined>): boolean {
  return (env.AUTO_STAR_APPLIED ?? "").trim().toLowerCase() !== "off";
}

/** 会話ごとの「最初の申込の時刻」（全案件の applied_at の最小）。applied_at が無い・読めない行は無視 */
export function firstAppliedAtByConversation(rows: ReadonlyArray<{ conversation_id: string; applied_at: string | null }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const t = r.applied_at ? Date.parse(r.applied_at) : NaN;
    if (!Number.isFinite(t)) continue;
    const prev = m.get(r.conversation_id);
    if (prev === undefined || t < prev) m.set(r.conversation_id, t);
  }
  return m;
}

/**
 * ☆の対象にしてよい返信か。
 *   - closed_won の会話（旧の対象）は今まで通り（時刻で切らない）
 *   - 申込に届いた会話は、最初の申込の時刻より前に作られた返信だけ
 */
export function starEligibleByApply(
  ex: { conversation_id: string; created_at: string | null },
  wonConvIds: ReadonlySet<string>,
  firstApplied: ReadonlyMap<string, number>,
): boolean {
  if (wonConvIds.has(ex.conversation_id)) return true;
  const cut = firstApplied.get(ex.conversation_id);
  if (cut === undefined) return false;
  const t = ex.created_at ? Date.parse(ex.created_at) : NaN;
  return Number.isFinite(t) && t < cut;
}
