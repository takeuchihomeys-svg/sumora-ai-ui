// scripts/lib/on-after.ts — 台帳 #799 ④: on にした直しの「試験での差」と「on の後の本番の一致の動き」を 7日・14日で並べる（純関数・LLM なし）
// 2026-11-26 作業員L（統括役の頼み・竹内さん 11/26「試験の質もっと上げれないか？」）:
//   試験で良く／悪化0 と出て on にした直しが、本番の一致（quality_daily の reply_match・竹内さんの番／全体）を本当に動かしたかを、on にした日ごとの組で見る。
//   同じ日に on にした直しは本番では分けられない＝組（on にした JST の日）で数える。前 7日の平均（番の数で重み）と、後 7日・14日の平均の差。
//   外れの大きい組＝試験では良くなった（better>0・確かな悪化0）のに、後 7日で 3pt 以上下がった（番 30 以上）。後の日数が足りない組は「待ち」。
export type DayVal = { value: number | null; n: number };
export type OnEvent = { itemId: number; at: string; switchName: string | null; title: string };
export type ExamSide = { better: number; worse: number; labels: string[] };
export type OnGroup = { day: string; switches: string[]; items: number[]; exam: ExamSide; before: number | null; after7: number | null; after14: number | null; d7: number | null; d14: number | null; n7: number; verdict: "miss" | "hit" | "flat" | "wait" | "no_exam" };

export const jstDayOf = (iso: string) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10);
const addDays = (d: string, k: number) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
/** [from, to) の日の平均（番の数で重み・値の無い日は飛ばす） */
export function windowMean(daily: ReadonlyMap<string, DayVal>, from: string, to: string): { mean: number | null; n: number; days: number } {
  let s = 0, n = 0, days = 0;
  for (let d = from; d < to; d = addDays(d, 1)) { const v = daily.get(d); if (!v || v.value == null || !v.n) continue; s += v.value * v.n; n += v.n; days++; }
  return { mean: n ? Math.round((s / n) * 10) / 10 : null, n, days };
}
/** on にした日ごとの組（純関数）。exam はスイッチの名前 → 試験の結果（良く・悪化・label） */
export function onGroupsOf(events: readonly OnEvent[], exam: ReadonlyMap<string, ExamSide>, daily: ReadonlyMap<string, DayVal>, today: string, o: { missPt?: number; minN?: number } = {}): OnGroup[] {
  const missPt = o.missPt ?? 3, minN = o.minN ?? 30;
  const by = new Map<string, OnEvent[]>();
  for (const e of events) { const d = jstDayOf(e.at); by.set(d, [...(by.get(d) ?? []), e]); }
  const out: OnGroup[] = [];
  for (const [day, es] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
    const switches = [...new Set(es.map((e) => e.switchName).filter((x): x is string => !!x))];
    const ex: ExamSide = { better: 0, worse: 0, labels: [] };
    for (const sw of switches) { const r = exam.get(sw); if (r) { ex.better += r.better; ex.worse += r.worse; ex.labels.push(...r.labels); } }
    const b = windowMean(daily, addDays(day, -7), day), a7 = windowMean(daily, day, addDays(day, 7)), a14 = windowMean(daily, day, addDays(day, 14));
    const d7 = b.mean != null && a7.mean != null ? Math.round((a7.mean - b.mean) * 10) / 10 : null;
    const d14 = b.mean != null && a14.mean != null && addDays(day, 14) <= today ? Math.round((a14.mean - b.mean) * 10) / 10 : null;
    const elapsed7 = addDays(day, 7) <= today;
    const verdict: OnGroup["verdict"] = !elapsed7 ? "wait" : !ex.labels.length ? "no_exam" : d7 == null || a7.n < minN ? "flat"
      : ex.better > 0 && ex.worse === 0 && d7 <= -missPt ? "miss" : ex.better > 0 && d7 >= 1 ? "hit" : "flat";
    out.push({ day, switches, items: [...new Set(es.map((e) => e.itemId))], exam: ex, before: b.mean, after7: elapsed7 ? a7.mean : null, after14: d14 == null ? null : a14.mean, d7: elapsed7 ? d7 : null, d14, n7: a7.n, verdict });
  }
  return out;
}
export const VERDICT_JA: Record<OnGroup["verdict"], string> = { miss: "⚠ 外れ（試験は良く・本番は下がった）", hit: "当たり（試験も本番も上がった）", flat: "動き小・番が少ない", wait: "待ち（7日経っていない）", no_exam: "試験の記録なし" };
