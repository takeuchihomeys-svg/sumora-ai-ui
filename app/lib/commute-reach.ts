// app/lib/commute-reach.ts（純関数・静的データ・DB 依存なし。osaka-geo の表が大きいので画面から import しない）
// サーバー側の「通勤の条件 → 目的の駅に N 分以内で着く駅」。決め方は commute-reach-core.ts（拡張と同じ関数）。
// 到達時間の表（app/lib/commute-reach-table.ts・自動生成）は主な目的の駅ごとの写し。表に無い目的の駅は transit-route でその場で出す。
//
// 2026-09-29 竹内「梅田まで電車で30分等の時、梅田駅の沿線は選択されるが、梅田駅に30分の駅が選択される場面が抜かれてしまっている」
import { LINES, STATION_LINES, normStation } from "./osaka-geo";
import { transit, commuteAsksInText, stationsWithin } from "./transit-route";
import { planCommuteReach, reachAudit, reachSummary, readTargets, type ReachTransit, type ReachDeps, type ReachInput, type ReachOpts, type ReachPlan } from "./commute-reach-core";
import { COMMUTE_REACH_TABLE, COMMUTE_REACH_TABLE_MAX_MINUTES, COMMUTE_REACH_TABLE_MAX_TRANSFERS } from "./commute-reach-table";
export type { ReachPlan, ReachAudit, ReachTarget, ReachStation, ReachSegment } from "./commute-reach-core";
export { reachAudit, reachSummary, readTargets };

/** サーバーの路線のつながり（駅名はそろえた名前のまま） */
export function serverTransit(): ReachTransit {
  const t = transit();
  return {
    commuteAsks: (text) => commuteAsksInText(text),
    groupOf: (w) => t.groupOf(w),
    linesOf: (s) => t.linesOf(s),
    stationsWithin: (dest, mins, opts) => stationsWithin(dest, mins, opts),
    extNames: (s) => [s],
  };
}
export const SERVER_DEPS: ReachDeps = {
  extLinesOf: (w) => STATION_LINES.get(normStation(w)) ?? null,
  lineOrderOf: (line) => LINES[line] ?? [],
};

/** 通勤の条件から検索に入れる駅（サーバー用・そろえた駅名）。通勤の分が読めない時は null */
export function commuteReachPlan(input: ReachInput, opts: ReachOpts = {}): ReachPlan | null {
  return planCommuteReach(input, serverTransit(), SERVER_DEPS, opts);
}

/**
 * 到達時間の表から「目的の駅に N 分以内で着く駅」（表に無い目的・表の上限を超える分は transit-route でその場で出す）。
 * 戻り値は分の短い順。目的の駅そのものは含めない。
 */
export function stationsReachable(target: string, minutes: number, maxTransfers = COMMUTE_REACH_TABLE_MAX_TRANSFERS): Array<{ station: string; minutes: number; transfers: number }> | null {
  const t = transit();
  const g = t.groupOf(target);
  if (!g) return null;
  const rows = COMMUTE_REACH_TABLE[g.key];
  if (rows && minutes <= COMMUTE_REACH_TABLE_MAX_MINUTES && maxTransfers === COMMUTE_REACH_TABLE_MAX_TRANSFERS) {
    return rows.filter((r) => r[1] <= minutes).map((r) => ({ station: r[0], minutes: r[1], transfers: r[2] }));
  }
  const w = stationsWithin(g.key, minutes, { maxTransfers });
  return w ? w.stations.map((s) => ({ station: s.station, minutes: s.minutes, transfers: s.transfers })) : null;
}
