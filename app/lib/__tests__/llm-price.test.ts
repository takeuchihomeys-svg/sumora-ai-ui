// 2026-09-29: Claude の単価表（公式）を1か所に。scripts の表は Sonnet 5 を $3/$15 にしていて費用が 1.5 倍に出ていた
// 実行: npx tsx app/lib/__tests__/llm-price.test.ts
import { claudePriceOf, claudeUsageUsd, usageFromAnthropic } from "../llm-price";

let failed = 0;
function eq(name: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : ` expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`}`);
}
const round = (x: number) => Math.round(x * 1e6) / 1e6;

eq("Sonnet 5 は $2/$10（5分書き 2.5・1h 4・読み 0.2）", claudePriceOf("claude-sonnet-5"), { in: 2, write5m: 2.5, write1h: 4, read: 0.2, out: 10 });
eq("Sonnet 5.5 も同じ単価", claudePriceOf("claude-sonnet-5-5"), claudePriceOf("claude-sonnet-5"));
eq("Haiku 4.5（日付つき）", claudePriceOf("claude-haiku-4-5-20251001"), { in: 1, write5m: 1.25, write1h: 2, read: 0.1, out: 5 });
eq("Opus 5", claudePriceOf("claude-opus-5"), { in: 5, write5m: 6.25, write1h: 10, read: 0.5, out: 25 });
eq("Opus 5.5 は読みだけ 0.05 倍", claudePriceOf("claude-opus-5-5"), { in: 4, write5m: 5, write1h: 8, read: 0.2, out: 20 });
eq("Opus 4.8", claudePriceOf("claude-opus-4-8")?.in, 5);
eq("Sonnet 4.6 は $3", claudePriceOf("claude-sonnet-4-6")?.in, 3);
eq("DeepSeek は null（別に数える）", claudePriceOf("deepseek-v4-flash"), null);
eq("1行の費用: 入力1万・読み4万・1h書き1万・出力千（Sonnet 5）",
  round(claudeUsageUsd({ model: "claude-sonnet-5", input_uncached: 10_000, cache_read: 40_000, cache_write_1h: 10_000, output_tokens: 1_000 })),
  round((10_000 * 2 + 40_000 * 0.2 + 10_000 * 4 + 1_000 * 10) / 1e6));
eq("内訳の無い古い書き込みは 5分書きで数える", round(claudeUsageUsd({ model: "claude-sonnet-5", cache_write: 1_000 })), round(1_000 * 2.5 / 1e6));
eq("応答の usage を読む", usageFromAnthropic("claude-sonnet-5", { input_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3, cache_creation: { ephemeral_1h_input_tokens: 3 }, output_tokens: 2 }),
  { model: "claude-sonnet-5", input_uncached: 5, cache_read: 7, cache_write_5m: 0, cache_write_1h: 3, cache_write: 3, output_tokens: 2 });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
