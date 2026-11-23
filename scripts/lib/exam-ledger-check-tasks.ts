// scripts/lib/exam-ledger-check-tasks.ts — 試験の写しに「空室確認のタスク」（line_tasks の property_check だけ）を入れる（純関数・既定 off）
//
// 2026-11-23 作業員A（統括役の頼み・試験で確かめられない部品の穴）: brain-exam-add は line_tasks を写さない（通知・画面に出るため）。
//   そのため CHECK_RESULT_STATE（作業員G・app/lib/check-result-state.ts）は試験でいつも none＝on と off で文が同じ＝試験では効かない。
//   行動台帳の「pending の物件出しのタスク＝ピックアップの約束」も試験では立たない（本番と台帳が食い違う番がある・11/23 ①の組の確かめで 6675・8936）。
// 決まり（写す側に倒さない）:
//   - 写すのは task_type=property_check だけ・番の時刻より前に作られた行だけ・新しい 10行まで
//   - 番の時点に巻き戻す: 番より後に閉じた行は「開いていた」（status=pending・result／resolved_at／completed_at は null）
//   - 列は id・task_type・status・created_at・resolved_at・completed_at・result だけ。result は英小文字の決まった値（available 等）の時だけ残す
//   - 自由文の result_note は写さない・customer_name は "YUMA"・行の JSON が申込の書類・個人の値に当たれば行ごと落とす
//   - 入れるのは EXAM_LEDGER_CHECK_TASKS=on・借りたテスト用の会話（LINE につながっていない YUMA2〜）の時だけ（brain-exam.ts）。
//     ⚠ 開いた行は担当者の画面（/api/line-tasks の一覧）と朝の報告（cron/morning-report）に出うる＝問題ごとに消す（deleteOwnLedger）・走り始めに借りた会話の分を消す（purgeLeasedLedger）
// テスト: npx tsx scripts/lib/__tests__/exam-ledger-check-tasks.test.ts

export type CheckTaskRaw = Record<string, unknown>;
export type CheckTaskLedgerRow = { ago: number; row: Record<string, unknown> };

export const CHECK_TASK_LIMIT = 10;
export const CHECK_TASK_COLUMNS = ["id", "task_type", "status", "created_at", "resolved_at", "completed_at", "result"] as const;
const RESULT_VALUE_RE = /^[a-z_]{1,40}$/;

/** 写す・入れるか（既定 off＝今までの問題の写しも試験も変わらない） */
export function examLedgerCheckTasksOn(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.EXAM_LEDGER_CHECK_TASKS ?? "").trim().toLowerCase() === "on";
}

const t = (v: unknown): number => (typeof v === "string" ? Date.parse(v) : NaN);

/**
 * 番の時刻 at の時点の空室確認のタスクを選んで、写す形にする（古い順）。
 * isBlocked は申込の書類・個人の値の網（app/lib/test-pii-guard.applicationMaterialReason を渡す）
 */
export function pickCheckTaskRows(rows: ReadonlyArray<CheckTaskRaw>, at: string, isBlocked: (s: string) => boolean = () => false): CheckTaskLedgerRow[] {
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return [];
  const picked = rows
    .filter((r) => r.task_type === "property_check" && Number.isFinite(t(r.created_at)) && t(r.created_at) <= atMs)
    .sort((a, b) => t(b.created_at) - t(a.created_at))
    .slice(0, CHECK_TASK_LIMIT);
  const out: CheckTaskLedgerRow[] = [];
  for (const r of picked) {
    if (isBlocked(JSON.stringify(r))) continue;
    const closedAt = [t(r.resolved_at), t(r.completed_at)].filter(Number.isFinite);
    const closedAfter = closedAt.length > 0 && closedAt.every((x) => x > atMs);
    const openAtTurn = closedAfter || (r.status === "pending" && !closedAt.length);
    const row: Record<string, unknown> = {};
    for (const k of CHECK_TASK_COLUMNS) row[k] = r[k] ?? null;
    if (openAtTurn) { row.status = "pending"; row.result = null; row.resolved_at = null; row.completed_at = null; }
    else {
      for (const k of ["resolved_at", "completed_at"] as const) if (Number.isFinite(t(row[k])) && t(row[k]) > atMs) row[k] = null;
      if (row.result != null && !(typeof row.result === "string" && RESULT_VALUE_RE.test(row.result))) row.result = null;
    }
    row.customer_name = "YUMA";
    out.push({ ago: Math.round((atMs - t(r.created_at)) / 60_000), row });
  }
  return out.reverse();
}

/** 借りた会話へ入れる行（id は振り直し・会話をテスト用に・時刻は sceneTime で場面の時刻へ） */
export function checkTaskInsertRows(rows: ReadonlyArray<CheckTaskLedgerRow>, conv: string, sceneTime: (agoMin: number, k: number) => string, atMs: number): Array<Record<string, unknown>> {
  return rows.map((lr, k) => {
    const o: Record<string, unknown> = { ...lr.row };
    delete o.id;
    delete o.result_note;
    o.conversation_id = conv;
    o.customer_name = "YUMA";
    o.created_at = sceneTime(lr.ago, k);
    for (const col of ["resolved_at", "completed_at"] as const) {
      const v = o[col];
      if (typeof v === "string" && Number.isFinite(Date.parse(v))) o[col] = sceneTime(Math.max(0, Math.round((atMs - Date.parse(v)) / 60_000)), k);
    }
    return o;
  });
}
