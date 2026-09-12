// app/lib/llm-usage-log.ts
// Anthropic 呼び出しのトークン使用量（プロンプトキャッシュの効き）を全経路で同じ形の1行で出す（純関数＋console.log）
//
// 2026-09-13 RAG 監査: usage を出していたのはブレインと返信生成の2経路だけで、最終チェック・AIX・セーブデータ作成のキャッシュ効果は測れなかった。
//   さらに経路で「input=」の意味が違った（Anthropic SDK の input_tokens は非キャッシュ分だけ・LangChain の input は合計）→ 読み違いが起きていた。
//   ここでは Anthropic の usage（input_tokens＝非キャッシュ分／cache_read_input_tokens／cache_creation_input_tokens）を
//   read / write / uncached / total にそろえて出す。集計は Vercel ログの tag "llm:usage" で行う。

export type AnthropicUsageLike = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
} | null | undefined;

export type UsageLine = { tag: "llm:usage"; route: string; read: number; write: number; uncached: number; total: number; out: number; hit: boolean } & Record<string, unknown>;

/** Anthropic SDK / fetch の usage を統一形にする（input_tokens は非キャッシュ分） */
export function toUsageLine(route: string, usage: AnthropicUsageLike, extra?: Record<string, unknown>): UsageLine {
  const read = Number(usage?.cache_read_input_tokens ?? 0) || 0;
  const write = Number(usage?.cache_creation_input_tokens ?? 0) || 0;
  const uncached = Number(usage?.input_tokens ?? 0) || 0;
  const out = Number(usage?.output_tokens ?? 0) || 0;
  return { tag: "llm:usage", route, read, write, uncached, total: read + write + uncached, out, hit: read > 0, ...(extra ?? {}) };
}

export function logLlmUsage(route: string, usage: AnthropicUsageLike, extra?: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify(toUsageLine(route, usage, extra)));
  } catch {
    // ログ失敗で本処理を止めない
  }
}
