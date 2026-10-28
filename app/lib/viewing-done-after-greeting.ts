// app/lib/viewing-done-after-greeting.ts — 竹内さんの指摘 #5（10/28）
//   「AIX の挨拶で内覧後（挨拶（内覧後））を送って完了したら、連動してここ（カレンダー・今日のやること の【内覧】の行）も✅されるようにする」
//   AIX【内覧挨拶】の 内覧後（app_sub_mode が after…）を送ったら、その会話の今日（日本時間）の内覧の予定（calendar_events・event_type=viewing・未完了）を
//   is_done=true にし、その予定から入れた申込ツールのカレンダーの行（daily_tasks の dt_sumora_cal_<id>）も done=true にする（申込ツールのコードは触らない＝DB の行だけ）。
//   スイッチ VIEWING_DONE_ON_AFTER_GREETING=on（既定 off）。失敗しても AIX の記録は止めない
import { jstYmd } from "./jst-date";

export function viewingDoneOnAfterGreetingOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.VIEWING_DONE_ON_AFTER_GREETING ?? "").trim().toLowerCase() === "on";
}

/** 内覧後の挨拶の記録か（log-aix-usage の aix_type と app_sub_mode） */
export function isAfterViewingGreeting(aixType: string | null | undefined, subMode: string | null | undefined): boolean {
  return aixType === "greeting_viewing" && /^after(?::|$)/.test(String(subMode ?? ""));
}

export type ViewingEventRow = { id: number | string; event_type: string | null; start_at: string | null; is_done: boolean | null };

/** 済みにする予定: 内覧・未完了・開始が今日（日本時間）で、今より前に始まった物（これからの内覧は触らない） */
export function pickViewingEventsDoneAfterGreeting(rows: ReadonlyArray<ViewingEventRow>, nowMs: number): Array<number | string> {
  const today = jstYmd(nowMs);
  return rows
    .filter((r) => r.event_type === "viewing" && !r.is_done && r.start_at && Number.isFinite(Date.parse(r.start_at))
      && jstYmd(Date.parse(r.start_at)) === today && Date.parse(r.start_at) <= nowMs)
    .map((r) => r.id);
}
