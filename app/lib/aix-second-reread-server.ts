// app/lib/aix-second-reread-server.ts（サーバー専用・DeepSeek 1回・DB は読むだけ）— 押された AIX の意味での読み直し（aix-second-reread.ts の決まりで呼ぶ）
//   申込以降・個人の値が残る時・鍵が無い・時間切れ・読めない時は reread=null（呼ぶ側は案B＝方向を渡さない）。Claude には倒さない（安い経路だけ）。
import { supabase } from "@/app/lib/supabase-server";
import { maskPIIForAlt } from "@/app/lib/pii-mask";
import { loadAltNameMask } from "@/app/lib/pii-known-names";
import { altPiiSignal } from "@/app/lib/alt-pii-gate";
import { loadDeepseekCutoff } from "@/app/lib/post-apply";
import { REREAD_SYSTEM, buildRereadUser, parseReread, type SecondReread } from "@/app/lib/aix-second-reread";

export type RereadResult = { reread: SecondReread | null; ms: number; skipped?: string };
type Msg = { sender?: string | null; text?: string | null };

/** 2通目の前のお客様の連投（最後のお客様の発言のまとまり） */
function lastCustomerBundle(recent: ReadonlyArray<Msg>): string {
  const out: string[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    if (m?.sender === "customer") out.unshift(String(m.text ?? ""));
    else if (out.length) break;
  }
  return out.join("\n");
}

export async function rereadForPressedAix(o: {
  conversationId: string | null | undefined; pressedLabel: string; meaning?: string | null; firstMessage: string;
  recent: ReadonlyArray<Msg>; customerName?: string | null; readings?: string[]; budgetMs?: number;
}): Promise<RereadResult> {
  const t0 = Date.now();
  const skip = (why: string): RereadResult => ({ reread: null, ms: Date.now() - t0, skipped: why });
  const cid = String(o.conversationId ?? "").trim();
  if (!cid) return skip("no_conversation");
  if (!(process.env.DEEPSEEK_API_KEY ?? "").trim()) return skip("no_key");
  try {
    // 申込以降・申込中（線が null）は外に出さない
    if ((await loadDeepseekCutoff(supabase as never, cid)) === null) return skip("post_apply");
    const nameMask = await loadAltNameMask(cid, [o.customerName ?? null]);
    const user = maskPIIForAlt(buildRereadUser({ pressedLabel: o.pressedLabel, meaning: o.meaning, firstMessage: o.firstMessage, customerText: lastCustomerBundle(o.recent), readings: o.readings }), nameMask);
    if (altPiiSignal(user)) return skip("pii");
    const budget = o.budgetMs ?? 6_000;
    const { callDeepSeek } = await import("@/app/lib/vision-alt-provider");
    const res = await Promise.race([
      callDeepSeek(REREAD_SYSTEM, user, { maxTokens: 300, timeoutMs: budget, thinking: false, temperature: 0 }),
      new Promise<null>((r) => setTimeout(() => r(null), budget + 500)),
    ]);
    const reread = res ? parseReread(res.text) : null;
    void import("@/app/lib/llm-usage-recorder").then(({ recordAltUsage }) => recordAltUsage({
      model: res?.model ?? "deepseek", action: "aix_second_reread", conversationId: cid,
      usage: { input_tokens: Math.max(0, (res?.usage.input ?? 0) - (res?.usage.cacheHit ?? 0)), output_tokens: res?.usage.output ?? 0, cache_read_input_tokens: res?.usage.cacheHit ?? 0 },
      status: res ? 200 : 0, errorType: reread ? null : (res ? "empty_or_unparsable" : "no_response"),
      durationMs: Date.now() - t0, sysHead: "【押された AIX の読み直し】", sysKeyFull: null, maxTokens: 300,
    })).catch(() => {});
    return reread ? { reread, ms: Date.now() - t0 } : skip(res ? "unparsable" : "timeout");
  } catch (e) {
    console.warn("[aix-second-reread] skipped:", cid, e instanceof Error ? e.message : String(e));
    return skip("error");
  }
}
