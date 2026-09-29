// app/lib/llm-price.ts
// Claude の単価表（$/100万トークン・公式 platform.claude.com の pricing）を1か所に置く。費用の監査スクリプト・評価はここから引く（純関数・DB なし）
//
// 2026-09-29 竹内「Sonnet を Sonnet 5.5 に置き換えたら費用高くなるか」: scripts の単価表は Sonnet 5 を $3/$15・Opus 5 を $15 にしていて
//   公式（Sonnet 5 は $2/$10・Opus 5 は $5/$25。Sonnet 5 の $3 への値上げは中止）とずれ、費用の報告が 1.5 倍に出ていた（設計知見
//   「新しいモデルの話は手元の知識でなく公式の料金表・モデル一覧を先に引く」）。スクリプトごとに表を持つとまたずれるので、ここを正にする。
//   キャッシュ: 5分書き＝入力×1.25・1h書き＝入力×2・読み＝入力×0.1（Opus 5.5 だけ読み $0.20＝0.05倍）。
//   DeepSeek・Qwen はピーク時間で倍になる等の決まりが別なので、ここには置かない（null を返す）。

export type LlmPrice = { in: number; write5m: number; write1h: number; read: number; out: number };

const P = (inp: number, out: number, read = inp * 0.1): LlmPrice => ({ in: inp, write5m: inp * 1.25, write1h: inp * 2, read, out });

/** 上から順に最初に当たった物（具体的な名前を先に） */
export const CLAUDE_PRICES: ReadonlyArray<{ re: RegExp; label: string; price: LlmPrice }> = [
  { re: /claude-opus-5-5/, label: "Opus 5.5", price: P(4, 20, 0.2) },
  { re: /claude-opus-5\b|claude-opus-5$|claude-opus-4-[5-8]/, label: "Opus 5 / 4.5〜4.8", price: P(5, 25) },
  { re: /claude-opus-4(-1)?\b|claude-opus-4-0|claude-3-opus/, label: "Opus 4 / 4.1", price: P(15, 75) },
  { re: /claude-(fable|mythos)-5/, label: "Fable 5 / 5.1", price: P(10, 50) },
  { re: /claude-sonnet-5-5/, label: "Sonnet 5.5", price: P(2, 10) },
  { re: /claude-sonnet-5\b|claude-sonnet-5$/, label: "Sonnet 5", price: P(2, 10) },
  { re: /claude-sonnet-4|claude-3-[57]-sonnet/, label: "Sonnet 4.x", price: P(3, 15) },
  { re: /claude-haiku-4-5|claude-haiku-4/, label: "Haiku 4.5", price: P(1, 5) },
  { re: /claude-3-5-haiku/, label: "Haiku 3.5", price: P(0.8, 4) },
];

/** Claude のモデル名 → 単価（Claude 以外・知らない名前は null） */
export function claudePriceOf(model: string | null | undefined): LlmPrice | null {
  const m = String(model ?? "");
  if (!/claude/.test(m)) return null;
  return CLAUDE_PRICES.find((x) => x.re.test(m))?.price ?? null;
}

export type UsageLike = {
  model?: string | null;
  input_uncached?: number | null;
  cache_read?: number | null;
  cache_write_5m?: number | null;
  cache_write_1h?: number | null;
  /** 5分／1h の内訳が無い古い行の書き込み合計（内訳を引いた残りを 5分書きとして数える） */
  cache_write?: number | null;
  output_tokens?: number | null;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v ?? 0) || 0);

/** llm_usage_logs の1行（または同じ形の usage）→ $。Claude 以外・知らないモデルは 0（呼ぶ側で別に数える） */
export function claudeUsageUsd(r: UsageLike, price: LlmPrice | null = claudePriceOf(r.model)): number {
  if (!price) return 0;
  const w5 = num(r.cache_write_5m), w1 = num(r.cache_write_1h);
  const wRest = Math.max(num(r.cache_write) - w5 - w1, 0);
  return (num(r.input_uncached) * price.in + (w5 + wRest) * price.write5m + w1 * price.write1h + num(r.cache_read) * price.read + num(r.output_tokens) * price.out) / 1e6;
}

/** Anthropic の応答の usage（input_tokens・cache_creation.ephemeral_*）→ UsageLike */
export function usageFromAnthropic(model: string, u: Record<string, unknown> | null | undefined): UsageLike {
  const x = u ?? {};
  const cc = (x.cache_creation ?? {}) as Record<string, unknown>;
  const w5 = num(cc.ephemeral_5m_input_tokens), w1 = num(cc.ephemeral_1h_input_tokens);
  return {
    model, input_uncached: num(x.input_tokens), cache_read: num(x.cache_read_input_tokens),
    cache_write_5m: w5, cache_write_1h: w1, cache_write: num(x.cache_creation_input_tokens), output_tokens: num(x.output_tokens),
  };
}

// ── 別クラウド（DeepSeek・Jev）の単価（2026-09-29 見張り＝screen-watch の費用の上限のために足した）──────────────
// DeepSeek（公式 api-docs.deepseek.com/quick_start/pricing を 2026-09-29 に引いた）: 表の値は混雑していない時間の単価。
//   混雑時（平日 UTC 01-04・06-10＝JST 10-13・15-19・中国の祝日を除く）は全部2倍。
//   deepseek-flash : 一致 $0.003／不一致 $0.15／出力 $0.6
//   deepseek-v4-pro: 一致 $0.022／不一致 $0.66／出力 $1.98
// Jev（typesafe.ai のトップ「$42 Per Billion input tokens」＝ $0.042/100万・出力の単価は書かれていない＝jev-client の既存の注記どおり無料で数える）
export type AltPrice = { in: number; read: number; out: number; peakDouble: boolean };
export const ALT_PRICES: ReadonlyArray<{ re: RegExp; label: string; price: AltPrice }> = [
  { re: /deepseek-v4-pro|deepseek-pro/, label: "DeepSeek pro", price: { in: 0.66, read: 0.022, out: 1.98, peakDouble: true } },
  { re: /deepseek/, label: "DeepSeek flash", price: { in: 0.15, read: 0.003, out: 0.6, peakDouble: true } },
  { re: /^jev:|jev-/, label: "Jev", price: { in: 0.042, read: 0.042, out: 0, peakDouble: false } },
];

/** DeepSeek・Jev のモデル名（llm_usage_logs.model）→ 単価。知らない名前は null */
export function altPriceOf(model: string | null | undefined): AltPrice | null {
  const m = String(model ?? "");
  return ALT_PRICES.find((x) => x.re.test(m))?.price ?? null;
}

/** DeepSeek の混雑時間か（平日 UTC 01-04・06-10） */
export function isDeepseekPeakAt(iso: string | number | Date): boolean {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return false;
  const h = d.getUTCHours(), w = d.getUTCDay();
  return w >= 1 && w <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}

/**
 * llm_usage_logs の1行（別クラウド）→ $。input_uncached＝一致しなかった入力・cache_read＝一致した入力（recordAltUsage の形）。
 *   opts.alwaysPeak＝常に混雑時の2倍で数える（上限の関所は安全側にこれを使う）。知らないモデルは 0
 */
export function altUsageUsd(r: UsageLike & { created_at?: string | null }, opts: { alwaysPeak?: boolean } = {}): number {
  const p = altPriceOf(r.model);
  if (!p) return 0;
  const base = (num(r.input_uncached) * p.in + num(r.cache_read) * p.read + num(r.output_tokens) * p.out) / 1e6;
  const peak = p.peakDouble && (opts.alwaysPeak || (r.created_at ? isDeepseekPeakAt(r.created_at) : false));
  return peak ? base * 2 : base;
}
