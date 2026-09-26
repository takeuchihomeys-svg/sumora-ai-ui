// app/lib/deepseek-scope.ts
// 「DeepSeek に渡す時刻の線」をリクエストの間だけ持つ箱（サーバー専用・AsyncLocalStorage）。
//
// 2026-09-26 竹内「申込の間の部分は DeepSeek に渡さず、申込落ちてステータスを切り替えたら、切り替えたところ以降渡せば個人情報防げる」
//   返信生成・AIX は入口で線（post-apply.ts deepseekSafeCutoff）を引いて材料を切り、ここに「判定を通った印」を置く。
//   fetch の出口（llm-alt-provider）はヘッダの印が無い時にここを見る — 返信生成の中の判定・最終チェック（名札もヘッダも無い）も同じ印で守られる。
//   箱の中なのに印が無い呼び出し（線を引く前の呼び出し）は DeepSeek に回さない（二重の鍵）。
//
// ⚠ instrumentation（fetch の包み）とルートは別の束（bundle）になりうるので、AsyncLocalStorage は globalThis に1つだけ置く
//   （モジュールごとに new すると、ルートが置いた箱を出口が見られず「印なし」で全部 Claude に戻る＝静かに壊れる）。
import { AsyncLocalStorage } from "node:async_hooks";
import type { CutoffMark } from "./post-apply";

export type DeepseekScope = {
  conversationId: string | null;
  /** 判定を通った印。null ＝ まだ線を引いていない（出口は DeepSeek に回さない） */
  mark: CutoffMark | null;
  /** 出口の網の材料（線より前のお客様の発言の断片）。mark が cut の時だけ使う。1リクエストで1回だけ読む */
  netChunks?: () => Promise<string[]>;
};

const KEY = "__sumoraDeepseekScope";
function store(): AsyncLocalStorage<DeepseekScope> {
  const g = globalThis as unknown as Record<string, AsyncLocalStorage<DeepseekScope> | undefined>;
  if (!g[KEY]) g[KEY] = new AsyncLocalStorage<DeepseekScope>();
  return g[KEY]!;
}

/** 箱を開けて fn を走らせる（印はまだ無い＝ setDeepseekScope で置くまで DeepSeek に回らない） */
export function runInDeepseekScope<T>(fn: () => T): T {
  return store().run({ conversationId: null, mark: null }, fn);
}

export function currentDeepseekScope(): DeepseekScope | undefined {
  return store().getStore();
}

/** 今の箱に印を置く（箱の外では何もしない） */
export function setDeepseekScope(p: Partial<DeepseekScope>): void {
  const s = store().getStore();
  if (s) Object.assign(s, p);
}

/** 1回だけ読む（失敗は例外のまま＝出口で DeepSeek に回さない側へ倒す） */
export function onceAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
}
