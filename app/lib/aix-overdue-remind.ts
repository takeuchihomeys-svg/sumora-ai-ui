// app/lib/aix-overdue-remind.ts — 24時間を過ぎた AIX要対応を1日1回、売上番長グループに知らせ直す（純関数・DB も LINE も持たない）
//
// 2026-10-28 竹内さんの決定（owner_questions「24時間を過ぎた要対応を1日1回知らせ直すか」→「全部いれてよい」）:
//   つなぎの見張り 14日: 要対応 161件中 40件が切れ（24時間を超えて果たした 19・果たさず48時間で片付けられた 15・24時間以上残る 6）。
//   どれもスタッフの対応の速さ（ブレインの読み違いではない）。【やることリスト】は毎時出るが、24時間を過ぎた物だけを1日1回まとめて知らせ直す。
//   形はグループの決まり（feedback_group_aix_only: 「〇〇さん → AIX【ボタン】」）に合わせる。48時間で片付く（AIX_NOTICE_FRESH_MS）ので対象は 24〜48時間の物。
// 切替: AIX_OVERDUE_REMIND=on の時だけ（既定 off）。送るのは cron/staff-todo-list（営業時間の最初の便の後）。
// テスト: app/lib/__tests__/aix-overdue-remind.test.ts
import { aixButtonText, AIX_NOTICE_FRESH_MS, type AixActionItemRow } from "./aix-action-text";
import { jstDayStartMs, jstMDHm } from "./jst-date";

export function aixOverdueRemindEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.AIX_OVERDUE_REMIND ?? "").trim().toLowerCase() === "on";
}

export const AIX_OVERDUE_MS = 24 * 60 * 60 * 1000;
export const AIX_OVERDUE_REMIND_KEY = "aix_overdue_remind_last_sent_at";

/** 24時間を過ぎて、まだ片付いていない（48時間の内の）要対応。古い順 */
export function overdueAixItems(items: ReadonlyArray<AixActionItemRow>, nowMs: number): AixActionItemRow[] {
  return items
    .filter((i) => i.status === "pending")
    .filter((i) => { const age = nowMs - Date.parse(i.created_at); return Number.isFinite(age) && age >= AIX_OVERDUE_MS && age <= AIX_NOTICE_FRESH_MS; })
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/** 知らせ直しの文（対象が無ければ null＝送らない） */
export function buildAixOverdueRemind(items: ReadonlyArray<AixActionItemRow>, nowMs: number): string | null {
  const over = overdueAixItems(items, nowMs);
  if (!over.length) return null;
  const hours = (i: AixActionItemRow) => Math.floor((nowMs - Date.parse(i.created_at)) / 3600_000);
  return [
    `【AIX要対応・24時間を過ぎています】${jstMDHm(nowMs)}`,
    "",
    ...over.map((i) => `・${i.customer_name || "お客様"}さん → ${aixButtonText(i.action, i.check_pattern)}（${hours(i)}時間）`),
    "",
    `${over.length}件。48時間を過ぎると要対応から外れます`,
  ].join("\n");
}

/** 今日（JST）まだ送っていないか */
export function overdueRemindDue(lastSentIso: string | null | undefined, nowMs: number): boolean {
  const last = Date.parse(String(lastSentIso ?? ""));
  return !Number.isFinite(last) || last < jstDayStartMs(nowMs);
}
