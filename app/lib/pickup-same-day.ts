// app/lib/pickup-same-day.ts — 物件ピックアップの回（吹き出し）をまたいで、同じ日（JST）の物件を1回の AIX【物件ピックアップした】で送る（純関数・PICKUP_SEND_SAME_DAY・既定 on）
//
// 2026-11-24 作業員A（竹内さん 11/24 午後・強い指示「AIXツールで物件送る際、今日という1日なら、またいでチェックボックスつけて物件ピックアップで押して送れるようにする。
//   今は同じ日でも物件取得した時間によってまたいで送ることが出来ないので、この点を改善する」・竹内さんの了承で既定 on・止める =off）。
//   今の形: 回は前の回から30分以内か拡張の round_id が同じ時だけ1つにまとまる（pickup-card-view.groupPickupRounds）。チェックは物件の id ごとに全体で持つが、
//   「📤 AIXで送る」は押した回の物件だけを見ていた＝10時の回と15時の回を一緒に送れなかった。
//   直し: 押した回と同じ JST の日に始まった回で、チェックの付いた物件を、押した回に足して送る（回の表示は今のまま）。
//     ・束ね方は 30分以内にまとまった回と同じ形（batch_id を「,」でつなぐ・parts に元の回・物件に元の回の batch_id）＝送る道（/api/property-pickups/send の split(",")・
//       トーク側の AIX の送付・送った印 mark_sent・sent_facts／sent_properties の記録）は今のまとまった回と同じ道を通る
//     ・ほかの回にチェックが無ければ、押した回をそのまま返す（今と1字も変わらない）
//     ・別の日の回にチェックがある時は止める（日をまたいで一緒に送らない）
//   日の境: 回の始まり（created_at）の JST の日。0時をまたいで続いた回はその回が始まった日の回
// テスト: app/lib/__tests__/pickup-same-day.test.ts
type Env = Record<string, string | undefined>;
export function pickupSendSameDayOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  // 画面（ブラウザ）は NEXT_PUBLIC_ をそのまま書いた所だけビルドで埋まる
  const pub = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_PICKUP_SEND_SAME_DAY : undefined;
  return (env.PICKUP_SEND_SAME_DAY ?? pub ?? "").trim().toLowerCase() !== "off";
}
/** JST の日（YYYY-MM-DD） */
export function jstDayOf(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + 9 * 3600e3).toISOString().slice(0, 10) : "";
}
type ItemLike = { id: number; status?: string | null; batch_id?: string | null };
type RoundLike<I extends ItemLike> = { batch_id: string; created_at: string; items: I[]; parts?: RoundLike<I>[]; conversation_id?: string | null };
export type SameDayPlan<R> = {
  /** 送る回（ほかの回にチェックが無ければ押した回そのもの） */
  round: R;
  /** 足した回（押した回を先頭に）: 回の始まり・選んだ件数 */
  from: Array<{ batch_id: string; at: string; n: number }>;
  /** 別の日の回でチェックが付いている物（あれば止める） */
  otherDay: Array<{ batch_id: string; at: string; n: number }>;
};
/** 押した回に、同じ JST の日の回でチェックの付いた未送信の物件を足す */
/**
 * manual: スタッフが手で付けたチェック（画面の既定のチェックは回ごとに上位10件に付く＝ほかの回の既定のチェックを足さない）。
 *   ほかの回からは「チェックが付いていて、手で付けた」物だけを足す・止める（押した回は今のまま checked で見る）
 */
export function sameDaySendRound<I extends ItemLike, R extends RoundLike<I>>(base: R, rounds: ReadonlyArray<R>, checked: Readonly<Record<number, boolean>>, opts: { on?: boolean; manual?: Readonly<Record<number, boolean>> } = {}): SameDayPlan<R> {
  const on = opts.on ?? pickupSendSameDayOn();
  const pend = (it: I) => (it.status ?? "pending") === "pending";
  const pickedBase = (r: R) => r.items.filter((it) => checked[it.id] && pend(it));
  const pickedIn = (r: R) => r.items.filter((it) => checked[it.id] && pend(it) && (!opts.manual || opts.manual[it.id]));
  const baseN = pickedBase(base).length;
  if (!on) return { round: base, from: [{ batch_id: base.batch_id, at: base.created_at, n: baseN }], otherDay: [] };
  const day = jstDayOf(base.created_at);
  const others = rounds.filter((r) => r.batch_id !== base.batch_id && pickedIn(r).length > 0);
  const same = others.filter((r) => jstDayOf(r.created_at) === day);
  const otherDay = others.filter((r) => jstDayOf(r.created_at) !== day).map((r) => ({ batch_id: r.batch_id, at: r.created_at, n: pickedIn(r).length }));
  if (!same.length) return { round: base, from: [{ batch_id: base.batch_id, at: base.created_at, n: baseN }], otherDay };
  const withBatch = (r: R, its: I[]) => its.map((it) => ({ ...it, batch_id: it.batch_id ?? r.batch_id }));
  const merged = {
    ...base,
    batch_id: [base.batch_id, ...same.map((r) => r.batch_id)].join(","),
    items: [...withBatch(base, base.items), ...same.flatMap((r) => withBatch(r, pickedIn(r)))],
    parts: [...(base.parts ?? [base]), ...same.flatMap((r) => r.parts ?? [r])],
  } as R;
  return { round: merged, from: [{ batch_id: base.batch_id, at: base.created_at, n: baseN }, ...same.map((r) => ({ batch_id: r.batch_id, at: r.created_at, n: pickedIn(r).length }))], otherDay };
}
const hm = (iso: string) => { const d = new Date(Date.parse(iso) + 9 * 3600e3); return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
const md = (iso: string) => { const d = new Date(Date.parse(iso) + 9 * 3600e3); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
/** 送る前の1行（2つ以上の回から送る時だけ）: 「今日の2回から計5件を送ります（10:05の回 3件・15:20の回 2件）」 */
export function sameDayConfirmLine(p: SameDayPlan<unknown>): string | null {
  if (p.from.length < 2) return null;
  const total = p.from.reduce((s, x) => s + x.n, 0);
  return `同じ日の${p.from.length}回から計${total}件を送ります（${p.from.map((x) => `${hm(x.at)}の回 ${x.n}件`).join("・")}）`;
}
/** 別の日の回にチェックがある時に止める文 */
export function otherDayStopLine(p: SameDayPlan<unknown>): string | null {
  if (!p.otherDay.length) return null;
  return `日をまたいだ物件は一緒に送れません。${p.otherDay.map((x) => `${md(x.at)} ${hm(x.at)}の回 ${x.n}件`).join("・")}のチェックを外すか、その回で送ってください`;
}
