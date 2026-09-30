// app/lib/screening-calendar-sync.ts
// こちらのカレンダー（calendar_events）の予定を、申込ツール（sumora-screening-admin）のカレンダー＝申込ツールの DB の daily_tasks に入れる時の
// 「行の鍵」と「行の中身」を1か所で決める（純関数・DB 依存なし・画面とサーバーで共用）。
//
// 2026-09-30 竹内「内覧カレンダー登録したら、申込ツールのカレンダーにも連動して入れる」
//   申込ツールのコードは触らない（CLAUDE.md）。出来るのは申込ツールの DB の daily_tasks に行を入れる事だけ
//   （接続は /api/daily-tasks＝環境変数 SCREENING_ADMIN_SUPABASE_URL / SCREENING_ADMIN_SUPABASE_ANON_KEY・前からある道）。
//
// 旧の穴:
//   ・待ち合わせ場所の送信直後に自動で作る内覧の予定は、予定の画面で「保存」を押さないと申込ツールに入らなかった
//   ・「保存」のたびに新しい id（dt_sumora_<時刻>）で入れていたので、同じ内覧を直して保存すると申込ツールに2行になった
//   ・予定を直した・消した時に申込ツールの行は古いまま残った
// 直し: 行の id を「こちらの予定の id」から決める（dt_sumora_cal_<id>）。同じ予定は何回送っても1行（あれば直す・無ければ入れる）。
//   日時を変えたら同じ行の日時が変わる。予定を消したら同じ行を消す。
//   時間確保（【時間確保】＝まだ決まっていない候補）と、ブレインが自動で置く「物件: （未確定）」の予定は入れない（決まった内覧だけ）

/** 申込ツールの daily_tasks の id（こちらの予定 1件に1行） */
export const SCREENING_SYNC_ID_PREFIX = "dt_sumora_cal_";
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 鍵として使える文字か（予定の id＝数字か UUID） */
export function isValidSyncKey(key: unknown): key is string | number {
  return (typeof key === "string" || typeof key === "number") && KEY_RE.test(String(key));
}
export function screeningTaskIdFor(key: string | number): string {
  return `${SCREENING_SYNC_ID_PREFIX}${String(key)}`;
}

const EVENT_LABEL: Record<string, string> = { viewing: "内覧", contract: "契約", key_handover: "鍵渡し", application: "申込", other: "その他" };

/** 申込ツールに入れる内覧の予定か（決まった内覧だけ。時間確保・未確定の自動の予定は入れない） */
export function shouldSyncViewingToScreening(eventType: string | null | undefined, notes: string | null | undefined): boolean {
  if (eventType !== "viewing") return false;
  const n = notes ?? "";
  if (/^\s*【時間確保】/.test(n)) return false;
  if (/物件:\s*（未確定）/.test(n)) return false;
  return true;
}

export type ScreeningTaskPayload = { sync_key: string; customer_name: string; content: string; date: string; time: string; end_time: string };

/**
 * 申込ツールの行の中身（予定の画面の「保存」が今まで入れていた形と同じ: 【内覧】タイトル — メモ）。
 *   ymd は日本時間の 'YYYY-MM-DD'・start / end は 'HH:MM'（終日・未定は空）
 */
export function buildScreeningTaskPayload(o: {
  eventId: string | number; eventType: string; title: string; customerName?: string | null; ymd: string; start?: string | null; end?: string | null; notes?: string | null;
}): ScreeningTaskPayload | null {
  if (!isValidSyncKey(o.eventId) || !/^\d{4}-\d{2}-\d{2}$/.test(o.ymd)) return null;
  const label = EVENT_LABEL[o.eventType] ?? "予定";
  const notes = (o.notes ?? "").trim();
  return {
    sync_key: String(o.eventId),
    customer_name: (o.customerName ?? "").trim(),
    content: `【${label}】${(o.title ?? "").trim()}${notes ? ` — ${notes}` : ""}`,
    date: o.ymd,
    time: /^\d{2}:\d{2}$/.test(o.start ?? "") ? String(o.start) : "",
    end_time: /^\d{2}:\d{2}$/.test(o.end ?? "") ? String(o.end) : "",
  };
}
