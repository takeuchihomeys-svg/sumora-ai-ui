// app/lib/staff-burst.ts — スタッフが続けて送っている途中か（純関数）
//
// 2026-10-28 調べの #5（未来穂 10/22・ギガ賃貸）: スタッフが3件の細かい説明を送っている途中（17:24:03 に1通目・17:29:54 に2通目）、
//   1通目の36秒後に画面の下書き作成（/api/generate-reply の「生成の前にブレインを1回」BRAIN_BEFORE_GENERATE）がブレインを走らせ、
//   送り途中の内容を「答えていない」と読んで「3件の月額総額を管理会社に確認」を出した（AIX の見積書3通は材料に入っていた）。
//   入口は send-line-message の宣言の後（ブレインだけ）でも brain-sweep でもなく、generate-reply の手動の生成。
// 決め: 最後の通がこちらの送信で、STAFF_BURST_WAIT_MS 以内なら「スタッフが送っている途中」＝ブレインの再分析を待たせる（前の判断で下書きを作る）。
//   切替 BRAIN_STAFF_BURST_WAIT=on の時だけ（既定 off）。テスト: app/lib/__tests__/staff-burst.test.ts
export function brainStaffBurstWaitEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_STAFF_BURST_WAIT ?? "").trim().toLowerCase() === "on";
}

/** 2通目までの間（実例 5分51秒）より少し長く */
export const STAFF_BURST_WAIT_MS = 8 * 60_000;

/** 最後の通がこちら（スタッフ・AIX）で、今から STAFF_BURST_WAIT_MS 以内か。時刻が無ければ false（待たない） */
export function staffSendingNow(messages: ReadonlyArray<{ sender: string; createdAt?: string | null }>, nowMs: number, waitMs = STAFF_BURST_WAIT_MS): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.sender === "customer" || !last.createdAt) return false;
  const t = Date.parse(last.createdAt);
  return Number.isFinite(t) && nowMs - t >= 0 && nowMs - t <= waitMs;
}
