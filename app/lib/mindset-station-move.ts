// app/lib/mindset-station-move.ts — 今の気持ち × 地図の駅 → 竹内さん本人の次の一手（表は mindset-station-move-data・純関数・台帳 #795 ③）
// 2026-11-26 作業員L（竹内さん 11/26「地図のなかで相手を読む部分…」「ここ細分化して連携できるように」・統括役の割り振り）
//   地図の駅・次の石・逆算の計画は、今まで気持ちを読んでいなかった（つながり 0）。前の判断の気持ち（meta.customer_mindset.state）と今の駅から、
//   竹内さん本人がその組み合わせで多かった一手を1行（事実の数だけ・決めるのはブレイン）。行の形は作業員A の次の石（route-next-stone）に重ねる。
//   切替: ROUTE_MINDSET_LINE=on（既定 off・ブレインの材料に入る）。表が空・マスが無い時は空文字＝今と同じ
import { MINDSET_STATION_MOVE_DATA } from "./mindset-station-move-data";

type Env = Record<string, string | undefined>;
export type StationMoveCell = { station: string; state: string; stone: { to: string[]; reply: string[]; aix: string[] }; move: string; n: number; share: number };
export const routeMindsetLineOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.ROUTE_MINDSET_LINE ?? "").trim().toLowerCase() === "on";

/** 使った目印（digest.msm）: その駅×気持ちの表の1位の一手を a:<AIX の種類> か r:<返信の形> で（マスが無ければ空・純関数） */
export function mindsetStationTopMark(station: string | null | undefined, state: string | null | undefined, cells: ReadonlyArray<StationMoveCell> = MINDSET_STATION_MOVE_DATA): string {
  if (!station || !state) return "";
  const top = cells.find((c) => c.station === station && c.state === state);
  if (!top) return "";
  return top.move.startsWith("AIX:") ? `a:${top.move.slice(4).split("/")[0]}` : `r:${top.move.replace(/^返信:/, "")}`;
}
/**
 * 連鎖の型の行（作業員A の chain-patterns の形・#795 ③）: 駅＋気持ち → 竹内さんの一手（純関数）。
 *   表は駅×気持ちごとに上位3つの一手しか持たないので、駅だけの多数の割合（stationShare）は上に寄せた見積もり
 *   （上位3つに無い気持ちのマスでは、その一手の数を「3位の数」と「残り」の小さい方まで有りとする）＝lift は小さめに出る（控えめ）。
 *   部品の名は "気持ち:<状態>"（A の特徴に足せば当てはまる・足すまでは当てはまらず今と同じ）。
 */
export function chainRowsFromCells(cells: ReadonlyArray<StationMoveCell> = MINDSET_STATION_MOVE_DATA, minN = 5, minLift = 20): Array<{ key: string; parts: string[]; move: string; share: number; n: number; stationShare: number; lift: number }> {
  const code = (m: string) => (m.startsWith("AIX:") ? `aix:${m.slice(4).split("/")[0]}` : `reply:${m.replace(/^返信:/, "")}`);
  const byCell = new Map<string, StationMoveCell[]>();
  for (const c of cells) { const k = `${c.station}|${c.state}`; byCell.set(k, [...(byCell.get(k) ?? []), c]); }
  const tot = (xs: StationMoveCell[]) => (xs[0] && xs[0].share > 0 ? Math.round((xs[0].n * 100) / xs[0].share) : 0);
  const out: Array<{ key: string; parts: string[]; move: string; share: number; n: number; stationShare: number; lift: number }> = [];
  for (const [k, xs] of byCell) {
    const [station, state] = k.split("|");
    const top = xs[0]; const n = tot(xs);
    if (!top || n < minN) continue;
    let sN = 0, sTot = 0;
    for (const [k2, ys] of byCell) {
      if (!k2.startsWith(`${station}|`)) continue;
      const t = tot(ys); sTot += t;
      const hit = ys.find((y) => y.move === top.move);
      if (hit) sN += hit.n; else sN += Math.min(ys[ys.length - 1]?.n ?? 0, Math.max(0, t - ys.reduce((a, y) => a + y.n, 0)));
    }
    const stationShare = sTot ? Math.round((sN / sTot) * 1000) / 10 : 0;
    const lift = Math.round((top.share - stationShare) * 10) / 10;
    if (lift >= minLift) out.push({ key: `${station}+気持ち:${state}`, parts: [station, `気持ち:${state}`], move: code(top.move), share: top.share, n, stationShare, lift });
  }
  return out.sort((x, y) => y.lift * y.n - x.lift * x.n);
}
export function mindsetStationLine(station: string | null | undefined, state: string | null | undefined, cells: ReadonlyArray<StationMoveCell> = MINDSET_STATION_MOVE_DATA): string {
  if (!station || !state) return "";
  const xs = cells.filter((c) => c.station === station && c.state === state).slice(0, 3);
  if (!xs.length) return "";
  return `【気持ちと駅（竹内さん本人の番の数）】前の判断の気持ち「${state}」でこの駅の竹内さんの一手: ${xs.map((c) => `${c.move.replace(/^AIX:/, "AIX【").replace(/^(AIX【[^】]*)$/, "$1】")} ${c.share}%（${c.n}）`).join("・")}`;
}
