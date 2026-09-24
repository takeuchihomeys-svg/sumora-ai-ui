// app/lib/llm-action-scope.ts（サーバー専用・node:async_hooks。画面側から import しない）
// 同じ部品が記録する llm_usage_logs の action を、呼んだ場面ごとに付け替える（例: 画像で分析のボタン＝pickup_image_analysis・
// 売上サポに届いた時の自動＝pickup_image_analysis_auto）。記録の口（llm-usage-recorder.recordAltUsage）が globalThis の器を見る。
//
// 2026-09-25: 自動の読み取りは pickup-analyze-server.analyzePickupRow（itandi の読み取りの作業中で編集しない部品）をそのまま呼ぶ。
//   action を引数で渡せないので、非同期の文脈（AsyncLocalStorage）で「この中で記録される action の読み替え」を持つ。
import { AsyncLocalStorage } from "node:async_hooks";

export type ActionScope = { rename: Record<string, string> };
const KEY = "__sumoraLlmActionScope";
type G = typeof globalThis & { [KEY]?: AsyncLocalStorage<ActionScope> };

function storage(): AsyncLocalStorage<ActionScope> {
  const g = globalThis as G;
  if (!g[KEY]) g[KEY] = new AsyncLocalStorage<ActionScope>();
  return g[KEY] as AsyncLocalStorage<ActionScope>;
}

/** fn の中（await の先も含む）で記録される action を読み替える */
export function runWithActionRename<T>(rename: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  return storage().run({ rename }, fn);
}
