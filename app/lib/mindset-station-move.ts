// app/lib/mindset-station-move.ts — 今の気持ち × 地図の駅 → 竹内さん本人の次の一手（表は mindset-station-move-data・純関数・台帳 #795 ③）
// 2026-11-26 作業員L（竹内さん 11/26「地図のなかで相手を読む部分…」「ここ細分化して連携できるように」・統括役の割り振り）
//   地図の駅・次の石・逆算の計画は、今まで気持ちを読んでいなかった（つながり 0）。前の判断の気持ち（meta.customer_mindset.state）と今の駅から、
//   竹内さん本人がその組み合わせで多かった一手を1行（事実の数だけ・決めるのはブレイン）。行の形は作業員A の次の石（route-next-stone）に重ねる。
//   切替: ROUTE_MINDSET_LINE=on（既定 off・ブレインの材料に入る）。表が空・マスが無い時は空文字＝今と同じ
import { MINDSET_STATION_MOVE_DATA } from "./mindset-station-move-data";

type Env = Record<string, string | undefined>;
export type StationMoveCell = { station: string; state: string; stone: { to: string[]; reply: string[]; aix: string[] }; move: string; n: number; share: number };
export const routeMindsetLineOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.ROUTE_MINDSET_LINE ?? "").trim().toLowerCase() === "on";

export function mindsetStationLine(station: string | null | undefined, state: string | null | undefined, cells: ReadonlyArray<StationMoveCell> = MINDSET_STATION_MOVE_DATA): string {
  if (!station || !state) return "";
  const xs = cells.filter((c) => c.station === station && c.state === state).slice(0, 3);
  if (!xs.length) return "";
  return `【気持ちと駅（竹内さん本人の番の数）】前の判断の気持ち「${state}」でこの駅の竹内さんの一手: ${xs.map((c) => `${c.move.replace(/^AIX:/, "AIX【").replace(/^(AIX【[^】]*)$/, "$1】")} ${c.share}%（${c.n}）`).join("・")}`;
}
