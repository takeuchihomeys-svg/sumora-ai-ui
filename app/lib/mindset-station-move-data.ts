// app/lib/mindset-station-move-data.ts — scripts/audit-mindset-station-move.ts --write が書く（手で直さない・数だけ）
// 2026-11-26: 空で置いた（今夜の 60日の読みで書く）
import type { StationMoveCell } from "./mindset-station-move";
export const MINDSET_STATION_MOVE_META = { days: 0, builtAt: "", turns: 0, min: 5 };
export const MINDSET_STATION_MOVE_DATA: StationMoveCell[] = [];
