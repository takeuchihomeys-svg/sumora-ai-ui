// app/lib/aix-action-text.ts
// 売上番長グループの「AIX要対応」の文面（純関数・DB 依存なし）。登録・完了・送信は aix-action-items.ts
import { AIX_BUTTON_LABELS } from "@/app/lib/aix-taxonomy";
import { jstDayStartMs, jstMDHm } from "@/app/lib/jst-date";

// check_pattern → 「確認した（条件・交渉）」の確認対象（aix-taxonomy の CHECK_PATTERN_TOPICS と同じ語）
const CHECK_PATTERN_TOPIC: Record<string, string> = {
  nearby_parking: "近隣月極駐車場",
  mgmt_initial_cost: "初期費用・礼金等の交渉",
  mgmt_guarantor: "保証会社・審査",
  mgmt_pet: "ペット可否",
  vacate_date: "退去予定日",
  mgmt_move_in: "入居可能日",
  mgmt_parking: "駐車場",
  mgmt_equipment: "設備",
};

/** 押すべき AIX ボタンの表記（例: AIX【物件確認した（募集状況）】／AIX【確認した（条件・交渉）→入居可能日】） */
export function aixButtonText(action: string, checkPattern?: string | null): string {
  if (action === "property_check_result" && checkPattern && CHECK_PATTERN_TOPIC[checkPattern]) {
    return `AIX【確認した（条件・交渉）→${CHECK_PATTERN_TOPIC[checkPattern]}】`;
  }
  return `AIX【${AIX_BUTTON_LABELS[action] ?? action}】`;
}

// 2026-09-12 竹内（Sky・AKANE・まさゆき事例「全然関係ないお客さんの名前が出て AIX の指示が入っている」）:
//   AIX要対応は「今やり取りしているお客様の、まだ返していない発言」への指示。何日も前の発言を今日分析し直しても
//   その会話は今の要対応ではない（申込中の積み残しを sweep が一斉に拾った／機能開始時に古い判断から登録した）。
//   スタッフ返信までの時間（直近60日 1,978件）: 中央値39分・p95=21時間・48時間超は1.8% → 48時間を「今の要対応」の上限にする
export const AIX_NOTICE_FRESH_MS = 48 * 60 * 60 * 1000;

/** ブレインが見たお客様の発言（analyzed_msg_ts）が「今の要対応」にできる新しさか。時刻不明は判断できないので通す */
export function isFreshAixTurn(analyzedMsgTs: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!analyzedMsgTs) return true;
  const t = new Date(analyzedMsgTs).getTime();
  if (!Number.isFinite(t)) return true;
  return nowMs - t <= AIX_NOTICE_FRESH_MS;
}

/** 1件通知の本文 */
export function buildAixActionNotice(customerName: string, action: string, checkPattern?: string | null): string {
  return `🟣【AIX要対応】\n${customerName || "お客様"}さん → ${aixButtonText(action, checkPattern)}`;
}

export type AixActionItemRow = {
  id: string;
  conversation_id: string;
  customer_name: string | null;
  action: string;
  check_pattern: string | null;
  status: "pending" | "done" | "dismissed";
  done_aix_type: string | null;
  done_at: string | null;
  created_at: string;
};

/** 定時一覧の本文（未対応 → 今日の完了 の順。未対応も今日の完了も無ければ null＝送らない） */
export function buildAixActionList(items: AixActionItemRow[], nowMs: number = Date.now()): string | null {
  const todayStart = jstDayStartMs(nowMs);
  const pending = items.filter((i) => i.status === "pending")
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const doneToday = items.filter((i) => i.status === "done" && i.done_at && new Date(i.done_at).getTime() >= todayStart)
    .sort((a, b) => new Date(a.done_at ?? 0).getTime() - new Date(b.done_at ?? 0).getTime());
  if (pending.length === 0 && doneToday.length === 0) return null;
  const name = (i: AixActionItemRow) => `${i.customer_name || "お客様"}さん`;
  // 完了は実際に送った AIX を表示（ブレインの指示と違うボタンを押した場合もそのまま見える）
  const doneButton = (i: AixActionItemRow) =>
    i.done_aix_type && i.done_aix_type !== i.action ? aixButtonText(i.done_aix_type) : aixButtonText(i.action, i.check_pattern);
  return [
    `【AIX要対応リスト】${jstMDHm(nowMs)}`,
    "",
    ...pending.map((i) => `・${name(i)} → ${aixButtonText(i.action, i.check_pattern)}`),
    ...doneToday.map((i) => `✅${name(i)} → ${doneButton(i)}`),
    "",
    pending.length === 0 ? "🎉 AIX要対応 全件完了！" : `残り ${pending.length}件（✅=AIX送信済み　・=未対応）`,
  ].join("\n");
}
