// app/lib/chain-patterns-reply.ts — 連鎖の型の「返信の土台」の行（作業員L の持ち分・chain-patterns が import して連ねる）
// 2026-11-26 作業員A が空の配列で置いた（L が埋める・例: 気持ち＋約束＋手本の型 → 締めの一文）。形は chain-patterns の ChainPattern と同じ
import type { ChainPattern } from "./chain-patterns";
import { chainRowsFromCells } from "./mindset-station-move";
// 2026-11-26 作業員L（#795 ③・統括役の割り振り）: 駅＋気持ち → 竹内さんの一手（表 mindset-station-move-data・60日の竹内さん本人の番から・駅だけより 20pt 以上上がる組だけ）。
//   部品の名は "気持ち:<状態>"（作業員A の特徴に足すまでは当てはまらない＝今と同じ）。lift は控えめの見積もり（chainRowsFromCells の注）
export const CHAIN_PATTERNS_REPLY: readonly ChainPattern[] = chainRowsFromCells();
