// app/lib/route-station-daily.ts — 申込までの地図の駅ごとの毎朝の物差しと、一番弱い駅の上位3つ・細分化（台帳 #687・純関数・LLM なし）
// 2026-11-25 作業員A（竹内さん 11/25 深夜「今どこかちゃんと把握して申込に向かって進んでいるのかの部分や、地図の部分を細分化して強化していく」・統括役の頼み）
//   入力: 竹内さん本人の番の地図の照らし（audit-route-progress-takeuchi の行: node・branch・agree・outcome…）と、今どこの読み違い（route-misread-move の駅ごと）
//   駅ごとに3つの物差し（n つき）:
//     here   … 今どこの当たり（統括が読んだ駅と、その後の実際の一手で照らした駅が合う割合・読み違いの物差しの 1−外れ）
//     progress … 申込へ進めた割合（その番の後で次の駅へ進んだ・advanced の割合。止まった stuck・戻った back・離れた left は進めていない）
//     next   … 次の一手が竹内さん本人と合う割合（地図の候補と竹内さんの一手の向きが合う: aix_match・promise_match・reply_match・reply_invite＝route-station-cells と同じ）
//   弱さ＝(1−next)×0.4＋(1−progress)×0.3＋(1−here)×0.3（無い物差しは重みを他に配る）× log(1＋番の数)。上位3つを毎朝出す
//   細分化は route-station-cells（駅×番の型×駅の中の状態／送った物の段・n≥10 で竹内さん本人の過半数の形がある升だけ直しの候補）
import { stationCellsOf, type CellRow } from "./route-station-cells";

export type StationRow = CellRow & { outcome?: string | null };
export type StationMetric = { station: string; n: number; next: number | null; progress: number | null; here: number | null; hereN: number; weak: number };
// route-station-cells の GOOD と同じ（返信で誘う reply_invite も合う側＝数え方をそろえる）
const MATCH = new Set(["aix_match", "promise_match", "reply_match", "reply_invite"]);
export const stationKey = (node: string | null, branch: string | null) => (branch ? `分:${branch}` : node ?? "?");
const r1 = (x: number) => Math.round(x * 1000) / 10;

/** 駅ごとの3つの物差しと弱さ（here は駅 → { n, miss }・無ければ null） */
export function stationMetricsOf(rows: ReadonlyArray<StationRow>, here: ReadonlyMap<string, { n: number; miss: number }> = new Map()): StationMetric[] {
  const by = new Map<string, StationRow[]>();
  for (const r of rows) { const k = stationKey(r.node, r.branch); by.set(k, [...(by.get(k) ?? []), r]); }
  const out: StationMetric[] = [];
  for (const [station, rs] of by) {
    const n = rs.length;
    const next = n ? rs.filter((r) => MATCH.has(r.agree)).length / n : null;
    const withOut = rs.filter((r) => r.outcome);
    const progress = withOut.length ? withOut.filter((r) => r.outcome === "advanced").length / withOut.length : null;
    const h = here.get(station);
    const hereV = h && h.n ? 1 - h.miss / h.n : null;
    const parts: Array<[number, number | null]> = [[0.4, next], [0.3, progress], [0.3, hereV]];
    const have = parts.filter(([, v]) => v !== null);
    const wsum = have.reduce((s, [w]) => s + w, 0);
    const bad = wsum ? have.reduce((s, [w, v]) => s + w * (1 - (v as number)), 0) / wsum : 0;
    out.push({ station, n, next: next === null ? null : r1(next), progress: progress === null ? null : r1(progress), here: hereV === null ? null : r1(hereV), hereN: h?.n ?? 0, weak: Math.round(bad * Math.log1p(n) * 1000) / 1000 });
  }
  return out.sort((a, b) => b.weak - a.weak);
}

/** 一番弱い駅の上位 k（番の少ない駅は minN 未満なら外す） */
export function weakStations(ms: ReadonlyArray<StationMetric>, k = 3, minN = 5): StationMetric[] {
  return ms.filter((m) => m.n >= minN).slice(0, k);
}

/** 弱い駅の細分化（直しの候補の升・無ければ「数を待つ」） */
export function weakStationCells(rows: ReadonlyArray<StationRow>, stations: ReadonlyArray<string>): Array<{ station: string; candidates: string[]; wait: boolean }> {
  const cells = stationCellsOf(rows, stations, "rt_sub");
  return stations.map((st) => {
    const cs = cells.filter((c) => c.station === st && c.verdict === "candidate");
    return { station: st, candidates: cs.map((c) => `${c.rt}｜${c.sub}→${c.proposal?.act ?? "?"}（n ${c.n}・${c.top?.rate ?? "?"}%）`), wait: cs.length === 0 };
  });
}

/** quality_daily の行（駅ごとの3つの物差し＋弱い駅の順位）。metric は route:station:<駅>:<next|progress|here> */
export function stationQualityRows(ms: ReadonlyArray<StationMetric>, day: string, source: string): Array<{ day: string; metric: string; scope: string; value: number | null; n: number; source: string }> {
  const out: Array<{ day: string; metric: string; scope: string; value: number | null; n: number; source: string }> = [];
  for (const m of ms) {
    out.push({ day, metric: `route:station:${m.station}:next`, scope: "takeuchi", value: m.next, n: m.n, source });
    out.push({ day, metric: `route:station:${m.station}:progress`, scope: "takeuchi", value: m.progress, n: m.n, source });
    if (m.here !== null) out.push({ day, metric: `route:station:${m.station}:here`, scope: "takeuchi", value: m.here, n: m.hereN, source });
  }
  weakStations(ms).forEach((m, i) => out.push({ day, metric: `route:weak_station:${i + 1}`, scope: "takeuchi", value: m.weak, n: m.n, source: `${source}・${m.station}` }));
  return out;
}
