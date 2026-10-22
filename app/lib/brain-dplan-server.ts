// app/lib/brain-dplan-server.ts — D案の読み手（flash）を同時に回す（DeepSeek を直に・Claude には倒さない＝失敗した読み手の材料は削らない）
// 決め方・指示の文は app/lib/brain-dplan.ts（純関数）。
import { READER_KEYS, readerSystem, readerUser, parseReaderOut, type Materials, type ReaderKey, type ReaderResult } from "@/app/lib/brain-dplan";

export const DPLAN_READER_TIMEOUT_MS = 15_000;
export const DPLAN_READER_MAX_TOKENS = 700;

/** 読み手の名札（llm_usage_logs.action） */
export const dplanReaderAction = (k: ReaderKey) => `brain_dplan_${k}`;

export async function runDPlanReaders(p: {
  conversationId: string | null;
  materials: Materials;
  historyText: string;
  turnText: string;
  /** 本文に個人の値が残っていないかの網（当たった読み手は呼ばない） */
  piiSignal: (t: string) => string | null;
  /** 回す読み手（既定 全員・brain-core は dPlanReaders() を渡す） */
  readers?: ReadonlyArray<ReaderKey>;
}): Promise<ReaderResult[]> {
  const { callDeepSeek } = await import("@/app/lib/vision-alt-provider");
  const { DEEPSEEK_FLASH_MODEL } = await import("@/app/lib/llm-alt-provider");
  const { altPriceOf, isDeepseekPeakAt } = await import("@/app/lib/llm-price");
  const pr = altPriceOf(DEEPSEEK_FLASH_MODEL);
  const peak = isDeepseekPeakAt(new Date());
  const one = async (k: ReaderKey): Promise<ReaderResult> => {
    const t0 = Date.now();
    const sys = readerSystem(k);
    const user = readerUser(k, p.materials, p.historyText, p.turnText);
    const sig = p.piiSignal(user);
    if (sig) return { key: k, ok: false, out: null, error: `個人の値（${sig}）`, ms: 0, usd: 0, inTok: 0, outTok: 0, cacheHit: 0 };
    const res = await callDeepSeek(sys, user, { model: DEEPSEEK_FLASH_MODEL, maxTokens: DPLAN_READER_MAX_TOKENS, timeoutMs: DPLAN_READER_TIMEOUT_MS, thinking: false, temperature: 0 });
    const ms = Date.now() - t0;
    const out = res ? parseReaderOut(res.text) : null;
    const miss = res ? Math.max(0, res.usage.input - res.usage.cacheHit) : 0;
    const usd = res && pr ? ((miss * pr.in + res.usage.cacheHit * pr.read + res.usage.output * pr.out) / 1e6) * (peak && pr.peakDouble ? 2 : 1) : 0;
    if (res) {
      void import("@/app/lib/llm-usage-recorder").then(({ recordAltUsage }) => recordAltUsage({
        model: res.model, action: dplanReaderAction(k), conversationId: p.conversationId,
        usage: { input_tokens: miss, output_tokens: res.usage.output, cache_read_input_tokens: res.usage.cacheHit },
        status: 200, errorType: out ? null : "unparsable", durationMs: ms, sysHead: `【D案の読み手】${k}`, sysKeyFull: null, maxTokens: DPLAN_READER_MAX_TOKENS,
      })).catch(() => {});
    }
    return { key: k, ok: !!out, out, error: res ? (out ? null : "読めない形") : "応答なし", ms, usd, inTok: res?.usage.input ?? 0, outTok: res?.usage.output ?? 0, cacheHit: res?.usage.cacheHit ?? 0 };
  };
  return Promise.all((p.readers ?? READER_KEYS).map((k) => one(k).catch((e) => ({ key: k, ok: false, out: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 120), ms: 0, usd: 0, inTok: 0, outTok: 0, cacheHit: 0 } as ReaderResult))));
}
