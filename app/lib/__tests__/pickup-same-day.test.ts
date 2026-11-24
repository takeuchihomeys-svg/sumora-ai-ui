// 物件ピックアップの回をまたいで同じ日の物件を送る（app/lib/pickup-same-day.ts）
// 実行: npx tsx app/lib/__tests__/pickup-same-day.test.ts（全 PASS で exit 0）
import { sameDaySendRound, jstDayOf, sameDayConfirmLine, otherDayStopLine, pickupSendSameDayOn } from "../pickup-same-day";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
type It = { id: number; status?: string | null; batch_id?: string | null };
type R = { batch_id: string; created_at: string; items: It[]; parts?: R[]; conversation_id?: string | null };
const r = (id: string, at: string, ids: number[], extra: Partial<R> = {}): R => ({ batch_id: id, created_at: at, items: ids.map((i) => ({ id: i, status: "pending" })), conversation_id: "c1", ...extra });
// 11/24 10:05 JST と 15:20 JST（同じ日）・11/23 23:50 JST（前の日）・11/25 00:05 JST（次の日）
const A = r("A", "2026-11-24T01:05:00Z", [1, 2, 3]), B = r("B", "2026-11-24T06:20:00Z", [4, 5]), P = r("P", "2026-11-23T14:50:00Z", [6]), N = r("N", "2026-11-24T15:05:00Z", [7]);
const rounds = [P, A, B, N];

ok("既定は on・=off で止まる", pickupSendSameDayOn({}) && !pickupSendSameDayOn({ PICKUP_SEND_SAME_DAY: "off" }));
ok("JST の日の境（0時をまたぐ: 23:50 は前の日・00:05 は次の日）", jstDayOf(P.created_at) === "2026-11-23" && jstDayOf(A.created_at) === "2026-11-24" && jstDayOf(N.created_at) === "2026-11-25");
{
  const p = sameDaySendRound(A, rounds, { 1: true, 2: true }, { on: true, manual: {} });
  ok("ほかの回にチェックが無ければ押した回そのもの（今と同じ）", p.round === A && p.from.length === 1 && p.otherDay.length === 0 && sameDayConfirmLine(p) === null);
}
{
  const checked = { 1: true, 4: true, 5: true };
  const p = sameDaySendRound(A, rounds, checked, { on: true, manual: { 4: true, 5: true } });
  ok("同じ日の回の手で付けたチェックを束ねる（batch_id を「,」・parts・物件に元の回）", p.round.batch_id === "A,B" && p.round.items.map((x) => x.id).join(",") === "1,2,3,4,5" && p.round.items.find((x) => x.id === 4)?.batch_id === "B" && (p.round.parts ?? []).map((x) => x.batch_id).join(",") === "A,B", p.round);
  ok("送る前の1行（どの回から何件）", sameDayConfirmLine(p) === "同じ日の2回から計3件を送ります（10:05の回 1件・15:20の回 2件）", sameDayConfirmLine(p));
}
{
  const p = sameDaySendRound(A, rounds, { 1: true, 4: true }, { on: true, manual: {} });
  ok("画面の既定のチェック（手で付けていない）はほかの回から足さない", p.round === A);
}
{
  const p = sameDaySendRound(A, rounds, { 1: true, 6: true, 7: true }, { on: true, manual: { 6: true, 7: true } });
  ok("日をまたぐ選択は止める（前の日・次の日の回）", p.round === A && p.otherDay.map((x) => x.batch_id).join(",") === "P,N" && !!otherDayStopLine(p)?.includes("日をまたいだ物件は一緒に送れません"), p);
}
{
  const p = sameDaySendRound(A, rounds, { 1: true, 4: true }, { on: false, manual: { 4: true } });
  ok("off の時は押した回だけ（今と同じ）", p.round === A && p.otherDay.length === 0);
}
{
  const sent = r("S", "2026-11-24T03:00:00Z", [8]); sent.items[0].status = "sent";
  const p = sameDaySendRound(A, [A, sent], { 1: true, 8: true }, { on: true, manual: { 8: true } });
  ok("送信済みの物件はほかの回から足さない", p.round === A);
}
console.log(`pickup-same-day: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
