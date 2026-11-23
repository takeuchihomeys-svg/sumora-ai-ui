// npx tsx app/lib/__tests__/deepseek-read-auto-usage.test.ts
// 2026-11-23 作業員N2（台帳 #601 の二重の記録）: callDeepSeekRead は中の記録を読み直しが済んでから待ちに入れる・callDeepSeek は onAutoUsage があればそちらへ渡す
import assert from "node:assert/strict";
import { callDeepSeek, callDeepSeekRead, type AutoUsageInputLite } from "../vision-alt-provider";

process.env.DEEPSEEK_API_KEY = "test-key";
process.env.DEEPSEEK_AUTO_USAGE = "off"; // 本物の書き込みの口は使わない（待ちに入れる所の順番だけ見る）
let calls = 0;
const replies = ["読めない返事", '{"ok":true}'];
globalThis.fetch = (async () => {
  const text = replies[Math.min(calls, replies.length - 1)];
  calls++;
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 100, completion_tokens: 10 + calls, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 } }), { status: 200 });
}) as typeof fetch;

(async () => {
  // callDeepSeek: onAutoUsage があればその口に1行渡す
  const got: AutoUsageInputLite[] = [];
  calls = 1;
  const r = await callDeepSeek("sys", "本文", { onAutoUsage: (x) => got.push(x), action: "test_action" });
  assert.ok(r);
  assert.equal(got.length, 1);
  assert.equal(got[0].action, "test_action");
  assert.equal(got[0].usage.output_tokens, 12);

  // callDeepSeekRead: 1回目が読めない→読み直し。attempts は2つ・値は2回目
  calls = 0;
  const parse = (t: string) => { try { return JSON.parse(t) as { ok: boolean }; } catch { return null; } };
  const out = await callDeepSeekRead("sys", "本文", { maxTokens: 100, timeoutMs: 5_000, action: "test_read" }, parse);
  assert.equal(out.attempts.length, 2);
  assert.equal(out.value?.ok, true);
  assert.equal(calls, 2);
  console.log("deepseek-read-auto-usage: ok");
})().catch((e) => { console.error(e); process.exit(1); });
