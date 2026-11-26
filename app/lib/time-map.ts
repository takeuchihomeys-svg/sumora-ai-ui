// app/lib/time-map.ts — 時間の地図（予定表）: 入居の期限・内覧の日・約束した連絡の日・管理会社の営業日を1本に並べる（純関数・LLM/DB なし・台帳 #808 p0）
// 2026-11-27 作業員A（竹内さん 11/27「1 2 4 の地図は特に強化する」・統括役の頼み）。逆算（APPLY_ROUTE_BACKPLAN）の土台。
//   入居の時期の読み取りは作業員L の分（app/lib/move-in-line.ts の moveInFor・登録の条件を先・会話の言い直しで上書き）＝ここは MoveInInput を受け取るだけ。
//   約束の期日は作業員L の約束の台帳（openPromisesWithDue・期限前も含む）を PromiseDue の形で受け取る。
//   営業日: 土日・祝日・年末年始（12/29〜1/3）を休み。祝日は静的な表（2026〜2027・毎年足す）
//   スイッチ TIME_MAP_LINE: 既定 off（材料に入れない）／on（予定表の1行・印 time_map）。今はどこからも呼ばない（逆算の on の後に配線）
export function timeMapLineOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.TIME_MAP_LINE ?? "").trim().toLowerCase() === "on";
}
/** 入居の時期（作業員L の moveInFor の出す形に合わせる）: 日にち1つか幅か不明 */
export type MoveInInput = { kind: "date" | "range" | "unknown"; startYmd?: string | null; endYmd?: string | null; source?: "registered" | "conversation" | null };
export type ViewingInput = { ymd: string; time?: string | null };
export type PromiseDue = { kind: string; promisedAt: string; dueAt: string; overdue: boolean };
export type TimeEvent = { ymd: string; kind: "move_in" | "apply_by" | "viewing" | "promise_due" | "mgmt_next_open"; label: string; soft: boolean };

// 祝日（静的・内閣府の表から 2026〜2027）
const HOLIDAYS = new Set([
  "2026-01-01", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20", "2026-04-29", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06", "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22", "2026-09-23", "2026-10-12", "2026-11-03", "2026-11-23",
  "2027-01-01", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-21", "2027-03-22", "2027-04-29", "2027-05-03", "2027-05-04", "2027-05-05", "2027-07-19", "2027-08-11", "2027-09-20", "2027-09-23", "2027-10-11", "2027-11-03", "2027-11-23",
]);
const D = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const ymdOf = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (ymd: string, n: number) => ymdOf(new Date(D(ymd).getTime() + n * 864e5));
/** 管理会社の営業日か（土日・祝日・年末年始 12/29〜1/3 は休み） */
export function isBusinessDay(ymd: string): boolean {
  const d = D(ymd); const w = d.getUTCDay(); const md = ymd.slice(5);
  if (w === 0 || w === 6 || HOLIDAYS.has(ymd)) return false;
  if (md >= "12-29" || md <= "01-03") return false;
  return true;
}
/** その日か後の最初の営業日 */
export function nextBusinessDay(ymd: string): string { let x = ymd; for (let i = 0; i < 14 && !isBusinessDay(x); i++) x = addDays(x, 1); return x; }
/** その日か前の最後の営業日 */
export function prevBusinessDay(ymd: string): string { let x = ymd; for (let i = 0; i < 14 && !isBusinessDay(x); i++) x = addDays(x, -1); return x; }

/** 予定表（純関数）: 今日より後の日を並べる。申込の目安は入居の30〜14日前（逆算と同じ幅・言い切らない＝soft）を営業日に寄せる
 *   出所: 竹内さんの決定 10/20（KB 9b8dbfca・申込から入居まで約1ヶ月＝12月末入居なら11月末ごろ申込）・審査期間 14日（KB 5bd1480b） */
export function buildTimeMap(i: { todayYmd: string; moveIn?: MoveInInput | null; viewings?: readonly ViewingInput[]; promises?: readonly PromiseDue[] }): TimeEvent[] {
  const out: TimeEvent[] = [];
  const mi = i.moveIn;
  const moveStart = mi && mi.kind !== "unknown" ? mi.startYmd ?? null : null;
  if (moveStart) {
    out.push({ ymd: moveStart, kind: "move_in", label: mi!.kind === "range" && mi!.endYmd ? `入居の時期（${moveStart}〜${mi!.endYmd}）` : `入居の希望日（${moveStart}）`, soft: mi!.kind === "range" });
    const from = nextBusinessDay(addDays(moveStart, -30)), to = prevBusinessDay(addDays(moveStart, -14));
    if (to >= i.todayYmd) out.push({ ymd: from < i.todayYmd ? i.todayYmd : from, kind: "apply_by", label: `申込の目安（${from}〜${to}・入居の約1ヶ月前〜審査の2週間前・言い切らない）`, soft: true });
  }
  for (const v of i.viewings ?? []) if (v.ymd >= i.todayYmd) out.push({ ymd: v.ymd, kind: "viewing", label: `内覧の日（${v.ymd}${v.time ? ` ${v.time}` : ""}）`, soft: false });
  for (const p of i.promises ?? []) {
    const ymd = p.dueAt.slice(0, 10);
    out.push({ ymd: p.overdue ? i.todayYmd : ymd, kind: "promise_due", label: `約束した連絡（${p.kind}・期日 ${ymd}${p.overdue ? "・期限を過ぎている" : ""}）`, soft: false });
  }
  const mgmt = nextBusinessDay(addDays(i.todayYmd, 0));
  if (mgmt !== i.todayYmd) out.push({ ymd: mgmt, kind: "mgmt_next_open", label: `管理会社の次の営業日（${mgmt}・今日は休み）`, soft: false });
  return out.sort((a, b) => a.ymd.localeCompare(b.ymd));
}
/** 材料の1行（当たらない時は ""） */
export function timeMapLine(evs: readonly TimeEvent[], max = 5): string {
  if (!evs.length) return "";
  return `【時間の地図（予定表・決まった計算・材料・決めるのはあなた）】${evs.slice(0, max).map((e) => `${e.ymd} ${e.label}`).join("／")}`;
}
