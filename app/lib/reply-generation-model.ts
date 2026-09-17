// app/lib/reply-generation-model.ts
// 返信生成（/api/generate-reply の本体）の ChatAnthropic の設定を1か所に置く。
//
// 2026-09-17 竹内（返信生成の keep-warm）: プロンプトキャッシュの鍵は「model・thinking・ブロック配列の先頭からの完全一致」なので、
//   cron（app/api/cron/keep-warm）が同じ prefix を読み直す時は、返信生成と同じ設定の ChatAnthropic で送るのが一番確実。
//   設定を generate-reply/route.ts の中に置いたままだと、片方だけ直して鍵がずれる（＝読み直しが別のキャッシュを温める）ので、
//   ここに切り出して両方が同じ物を使う（設定のドリフト禁止）。文面・ブロックの並び・cache_control はこのファイルでは触らない。
import { ChatAnthropic } from "@langchain/anthropic";

/** 返信生成のモデル ID（llm_warm_prefixes.model にもこの値を残す。変えたら古い prefix は鍵が合わないので読み直しの対象から外れる） */
export const REPLY_GENERATION_MODEL = "claude-sonnet-5";

/** 返信生成と同じ beta（prompt caching）。ヘッダが違うとキャッシュの鍵は同じでも挙動の差を疑う余地が残るので共有する */
export const REPLY_GENERATION_BETAS = ["prompt-caching-2024-07-31"];

export type ReplyGenerationModelOptions = {
  /** 読み直し（keep-warm）用の上書き。max_tokens はキャッシュの鍵に入らないので、返事を「.」1つに絞って出力費用を無くす */
  maxTokens?: number;
  /** Anthropic への fetch に付ける印（x-sumora-llm-action 等）。llm-usage-recorder が読んで Anthropic に送る前に取り除く */
  defaultHeaders?: Record<string, string>;
  /** SDK の再試行回数。生成は既定 1（A-14）。読み直し（keep-warm）は 0（529 が続く時間帯に 45s×2 を直列で払わない・maxDuration 60s 内に収める） */
  maxRetries?: number;
};

// 生成: Sonnet — 品質重視
// - Sonnet 5 は temperature 等の非デフォルトサンプリングパラメータを受け付けないため渡さない
//   （旧 emotionTemperature 可変化は Sonnet 5 移行後デッドパスだったため Step1 廃止と同時に削除済み）
// - Sonnet 5 は thinking がデフォルト有効（adaptive）のため明示的に無効化する
//   （有効だとストリーミングchunkのcontentがブロック配列になりテキスト取りこぼし・
//    maxTokens=1500 を thinking が食い潰して本文が途切れるリスクがあるため）
export function createGenerationModel(opts: ReplyGenerationModelOptions = {}) {
  return new ChatAnthropic({
    model: REPLY_GENERATION_MODEL,
    maxTokens: opts.maxTokens ?? 1500,
    thinking: { type: "disabled" },
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
    // A-14: SDK 既定の再試行（2回）× 45s で全体 deadline を食い潰すため 1 回に制限
    maxRetries: opts.maxRetries ?? 1,
    // 2026-09-17 竹内（返信生成の keep-warm）: defaultHeaders は SDK が毎リクエストの headers に足す（options.headers より前）。
    //   印のヘッダは出口（llm-usage-recorder）が取り除くので Anthropic には届かない
    clientOptions: { timeout: 45_000, ...(opts.defaultHeaders ? { defaultHeaders: opts.defaultHeaders } : {}) },
    betas: REPLY_GENERATION_BETAS,
  });
}
