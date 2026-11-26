// app/lib/linkage-gap-reply-rows.ts — 連携の切れ目の一覧の「返信の土台」の行（作業員L の持ち分・linkage-gap-matrix が import して連ねる）
// 2026-11-26 作業員A が空の配列で置いた（L が埋める・ぶつからないよう別ファイル）。形は linkage-gap-matrix の GapSource と同じ
import type { GapSource } from "./linkage-gap-matrix";
export const LINKAGE_GAP_REPLY_ROWS: readonly GapSource[] = [];
