// app/lib/outcome-confirm.ts — 申込から30日たった案件の「結果の確認」（スタッフが選んで確定する）の決まり。純関数・DB 依存なし・LLM なし。
//   竹内さんの決定（2026-10-08）:
//     ①「申込までで成約データとして扱って大丈夫。申込までのツールなので」→ このツールの成功＝申込に届いた事。成約は申込のツールの領分の参考。
//     ②「表示されて選択するように（申込して30日経ったら確認のアナウンスが入って選択できる）」
//       → 申込から30日たった案件で、結果がまだ分からない物（進行中＝申込中のまま／推定の成約＝auto-seiyaku）に確認の帯を出し、スタッフが選ぶ。
//       選んだ結果は deal_outcomes に確定（locked）で残す。毎日の作り直し（cron/outcome-ledger）は locked の行を上書きしない＝確認が推定より優先。
//   画面（OutcomeConfirmBar）はここの型・ラベルだけ import してよい（supabase 等は持たない）。
//   計画: memory/plan_outcome_ledger.md 9章

/** 申込からこの日数たったら確認の帯を出す（決定②） */
export const CONFIRM_AFTER_DAYS = 30;
/** 「まだ手続き中」を選んだら、次に聞くまでの日数 */
export const CONFIRM_SNOOZE_DAYS = 14;

/** 確認の帯（OUTCOME_CONFIRM=off で出さない） */
export function outcomeConfirmEnabled(env: Record<string, string | undefined>): boolean {
  return (env.OUTCOME_CONFIRM ?? "").trim().toLowerCase() !== "off";
}

export const CONFIRM_CHOICES = ["won", "screening_failed", "cancelled", "pending"] as const;
export type ConfirmChoice = (typeof CONFIRM_CHOICES)[number];
export const CONFIRM_CHOICE_LABEL: Record<ConfirmChoice, string> = {
  won: "成約した",
  screening_failed: "審査落ち・切り替え",
  cancelled: "キャンセル",
  pending: "まだ手続き中",
};
export function isConfirmChoice(x: unknown): x is ConfirmChoice {
  return typeof x === "string" && (CONFIRM_CHOICES as readonly string[]).includes(x);
}

/** 確認の候補を選ぶ材料（deal_outcomes の行の一部） */
export type ConfirmCandidateRow = {
  conversation_id: string;
  episode_no: number;
  applied_at: string | null;
  result: string | null;
  result_certainty: string | null;
  result_evidence: string | null;
  locked: boolean | null;
  staff_confirmed_at?: string | null;
  confirm_snooze_until?: string | null;
  property_name?: string | null;
  room_no?: string | null;
};

export type ConfirmCandidate = {
  conversationId: string;
  episodeNo: number;
  appliedAt: string;
  daysSinceApplied: number;
  /** 今の台帳の見立て（in_progress＝申込中のまま／won_estimated＝自動の成約） */
  current: "in_progress" | "won_estimated";
  propertyLabel: string | null;
};

const DAY = 86_400_000;

/**
 * 1会話の行から、確認を聞く案件を1つ選ぶ（一番新しい案件だけ・古い案件は聞かない）。
 *   聞く: 申込に届いている・申込から30日以上・locked でない・まだ確認していない・「まだ手続き中」の待ちが過ぎた・
 *         結果が 進行中（申込中のまま）か 推定の成約（auto-seiyaku・履歴なし）
 *   聞かない: 確定の成約（スタッフ・申込のツール）・切り替え・失注（申込の後の切り替え・失注は段階の変化で分かっている）
 */
export function pickConfirmCandidate(rows: ReadonlyArray<ConfirmCandidateRow>, nowMs: number): ConfirmCandidate | null {
  if (!rows.length) return null;
  const latest = [...rows].sort((a, b) => b.episode_no - a.episode_no)[0];
  if (latest.locked || latest.staff_confirmed_at) return null;
  const applied = latest.applied_at ? Date.parse(latest.applied_at) : NaN;
  if (!Number.isFinite(applied) || nowMs - applied < CONFIRM_AFTER_DAYS * DAY) return null;
  const snooze = latest.confirm_snooze_until ? Date.parse(latest.confirm_snooze_until) : NaN;
  if (Number.isFinite(snooze) && snooze > nowMs) return null;
  let current: ConfirmCandidate["current"] | null = null;
  if (latest.result === "in_progress") current = "in_progress";
  else if (latest.result === "won" && latest.result_certainty === "estimated") current = "won_estimated";
  if (!current) return null;
  const propertyLabel = latest.property_name ? `${latest.property_name}${latest.room_no && !latest.property_name.includes(latest.room_no) ? ` ${latest.room_no}` : ""}` : null;
  return {
    conversationId: latest.conversation_id, episodeNo: latest.episode_no, appliedAt: new Date(applied).toISOString(),
    daysSinceApplied: Math.floor((nowMs - applied) / DAY), current, propertyLabel,
  };
}

/** 選んだ結果 → deal_outcomes に書く中身（pending は locked にせず、待ちの日付だけ） */
export function confirmPatch(choice: ConfirmChoice, nowMs: number): Record<string, unknown> {
  const now = new Date(nowMs).toISOString();
  if (choice === "pending") {
    return { confirm_snooze_until: new Date(nowMs + CONFIRM_SNOOZE_DAYS * DAY).toISOString(), updated_at: now };
  }
  const base = {
    locked: true, staff_confirmed_at: now, staff_confirm_choice: choice, confirm_snooze_until: null,
    // 申込に届いた事は確定（選べるのは申込に届いた案件だけ）。applied_at はそのまま残す
    result_certainty: "confirmed", result_evidence: `staff_confirm:${choice}`, updated_at: now,
  };
  if (choice === "won") return { ...base, result: "won", won_at: now, lost_at: null, lost_type: null, lost_reason: null, lost_reason_source: null, switch_reason: null, max_stage: "won", ended_at: now };
  if (choice === "screening_failed") return { ...base, result: "switched", switch_reason: "screening_rejected", won_at: null, lost_at: null, lost_type: null, lost_reason: null, lost_reason_source: null, ended_at: now };
  // cancelled: 申込の取り消し（失注の型 L6）。理由は弱い参考（決定①）なので型の決まりのまま「不明」
  return { ...base, result: "lost", lost_type: "application_cancelled", lost_reason: "unknown", lost_reason_source: "rule", lost_at: now, won_at: null, switch_reason: null, ended_at: now };
}

/** 画面の文（帯の1行目） */
export function confirmHeadline(c: Pick<ConfirmCandidate, "daysSinceApplied" | "propertyLabel" | "current">): string {
  const what = c.propertyLabel ? `「${c.propertyLabel}」の` : "";
  const now = c.current === "won_estimated" ? "（今は自動で成約の見立て）" : "";
  return `申込から${c.daysSinceApplied}日たちました。${what}結果を選んでください${now}`;
}

/** auto-seiyaku が飛ばす会話か（スタッフが「成約」以外を選んだ／「まだ手続き中」の待ちの間） */
export function autoSeiyakuBlockedByConfirm(rows: ReadonlyArray<Pick<ConfirmCandidateRow, "episode_no" | "locked" | "confirm_snooze_until"> & { staff_confirm_choice?: string | null }>, nowMs: number): boolean {
  if (!rows.length) return false;
  const latest = [...rows].sort((a, b) => b.episode_no - a.episode_no)[0];
  if (latest.staff_confirm_choice && latest.staff_confirm_choice !== "won") return true;
  const snooze = latest.confirm_snooze_until ? Date.parse(latest.confirm_snooze_until) : NaN;
  return Number.isFinite(snooze) && snooze > nowMs;
}
