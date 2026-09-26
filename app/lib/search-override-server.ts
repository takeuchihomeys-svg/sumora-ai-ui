// app/lib/search-override-server.ts
// メモ欄の検索の指示 → DeepSeek の物件検索 AI が「一時調整」の形に要約（1回・推論なし・温度0）→ 文に根拠のある値だけ残す。
// 2026-09-27 竹内「こちらからの文を DeepSeek の物件検索 AI が要約して、拡張ツールに渡す形。ゆくゆくは拡張ツールの AIX モードで使えるように」
//
// 決まり:
//   ・きっかけ語が無ければ DeepSeek を呼ばない（looksLikeSearchInstruction＝ふつうのメモは0円）
//   ・渡すのはメモの文（電話・メールは伏せる）と登録の条件の欄だけ。名前・電話・会話・申込の情報は入れない
//     （会話を渡さないので、申込中のお客様でも会話の中身は DeepSeek に行かない）
//   ・callDeepSeekRead（deepseek-flash・推論なし・温度0・max 300・12秒・崩れたら同じ前置きで1回だけ読み直す）。Claude には倒さない
//   ・固定の前置き（SEARCH_OVERRIDE_SYSTEM_PROMPT）が先頭・材料が後ろ＝前置きキャッシュが当たる
//   ・DeepSeek が読めなかった時は決定論（parseDeterministic）で読み、ai=false で返す（同じ validateOverride を通す）
import { callDeepSeekRead } from "@/app/lib/vision-alt-provider";
import { DEEPSEEK_FLASH_MODEL } from "@/app/lib/llm-alt-provider";
import {
  SEARCH_OVERRIDE_ACTION, SEARCH_OVERRIDE_PROMPT_VERSION, SEARCH_OVERRIDE_SYSTEM_PROMPT,
  buildUserContent, looksLikeSearchInstruction, parseModelJson,
  type OverrideSummary, type RegisteredConditions,
} from "@/app/lib/search-override";
import { parseDeterministic, validateOverride } from "@/app/lib/search-override-read";

export type SummarizeOutcome = OverrideSummary & {
  /** DeepSeek を呼んだ回数（0＝きっかけ語なし） */
  calls: number;
  usage: { input: number; output: number; cacheHit: number };
  /** 決定論の読み（点検用・DeepSeek との食い違いを見る） */
  deterministic: OverrideSummary;
};

export async function summarizeSearchMemo(
  memo: string,
  reg: RegisteredConditions | null,
  opts: { apiKey?: string; conversationId?: string | null } = {},
): Promise<SummarizeOutcome> {
  const det = validateOverride(parseDeterministic(memo, reg), memo, reg);
  const usage = { input: 0, output: 0, cacheHit: 0 };
  if (!looksLikeSearchInstruction(memo)) {
    return { is_search: false, override: null, unclear: [], dropped: [], ai: false, calls: 0, usage, deterministic: det };
  }
  const read = await callDeepSeekRead(
    SEARCH_OVERRIDE_SYSTEM_PROMPT,
    buildUserContent(memo, reg),
    { maxTokens: 300, timeoutMs: 12_000, apiKey: opts.apiKey, model: DEEPSEEK_FLASH_MODEL },
    parseModelJson,
    { retryIf: (elapsed) => elapsed < 10_000, retryTimeoutMs: (elapsed) => Math.max(2_000, 14_000 - elapsed) },
  );
  for (const a of read.attempts) {
    usage.input += a.res?.usage.input ?? 0;
    usage.output += a.res?.usage.output ?? 0;
    usage.cacheHit += a.res?.usage.cacheHit ?? 0;
    void import("@/app/lib/llm-usage-recorder").then(({ recordAltUsage }) => recordAltUsage({
      model: a.res?.model ?? DEEPSEEK_FLASH_MODEL, action: SEARCH_OVERRIDE_ACTION, conversationId: opts.conversationId ?? null,
      usage: { input_tokens: Math.max(0, (a.res?.usage.input ?? 0) - (a.res?.usage.cacheHit ?? 0)), output_tokens: a.res?.usage.output ?? 0, cache_read_input_tokens: a.res?.usage.cacheHit ?? 0 },
      status: a.res ? 200 : 0, errorType: a.ok ? null : (a.res ? "empty_or_unparsable" : "no_response"),
      durationMs: a.ms, sysHead: `【検索の一時調整${a.retry ? "・読み直し" : ""}】${SEARCH_OVERRIDE_PROMPT_VERSION}`, sysKeyFull: null, maxTokens: 300,
    })).catch(() => {});
  }
  if (read.value) {
    const v = validateOverride(read.value, memo, reg);
    return { ...v, ai: true, calls: read.attempts.length, usage, deterministic: det };
  }
  // DeepSeek が2回とも読めなかった → 決定論の読み（文に根拠のある物だけ・同じ関所）
  return { ...det, unclear: [...det.unclear, "AI の要約が取れなかったので決まった読み方だけで読みました"], calls: read.attempts.length, usage, deterministic: det };
}
