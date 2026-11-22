// npx tsx app/lib/__tests__/deepseek-auto-usage.test.ts
// 2026-11-23 作業員N2（台帳 #601）: callDeepSeek の中の記録は、呼ぶ側が同じ番を記録したら書かない（二重にしない）・記録しない呼ぶ側の時だけ書く
import assert from "node:assert/strict";
import { autoUsageKey, cancelPendingAutoUsage, recordAltUsageAuto, deepseekAutoUsageOn, type AltUsageInput } from "../llm-usage-recorder";

const base = (out: number, hit: number, action = "deepseek:auto"): AltUsageInput => ({ model: "deepseek-flash", action, conversationId: null, usage: { input_tokens: 100, output_tokens: out, cache_read_input_tokens: hit }, status: 200, errorType: null, durationMs: 10, sysHead: null, sysKeyFull: null, maxTokens: 100 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  assert.equal(deepseekAutoUsageOn({}), true, "既定 on");
  assert.equal(deepseekAutoUsageOn({ DEEPSEEK_AUTO_USAGE: "off" }), false);
  // 入力の数の入れ方が違っても、出力とキャッシュに当たった数が同じなら同じ鍵
  assert.equal(autoUsageKey({ output_tokens: 12, cache_read_input_tokens: 300 }), autoUsageKey({ output_tokens: 12, cache_read_input_tokens: 300 }));

  // ① 呼ぶ側が記録しない → 少し待ってから中の記録が書かれる
  const w1: AltUsageInput[] = [];
  recordAltUsageAuto(base(11, 0), { holdMs: 30, write: (x) => w1.push(x) });
  await sleep(60);
  assert.equal(w1.length, 1);

  // ② 中の記録が待っている間に呼ぶ側が同じ番を記録 → 中の記録は書かない
  const w2: AltUsageInput[] = [];
  recordAltUsageAuto(base(22, 5), { holdMs: 50, write: (x) => w2.push(x) });
  assert.equal(cancelPendingAutoUsage({ input_tokens: 95, output_tokens: 22, cache_read_input_tokens: 5 }), true);
  await sleep(80);
  assert.equal(w2.length, 0);

  // ③ 呼ぶ側が先に記録 → 後から来た中の記録は書かない
  const w3: AltUsageInput[] = [];
  assert.equal(cancelPendingAutoUsage({ output_tokens: 33, cache_read_input_tokens: 7 }), false);
  recordAltUsageAuto(base(33, 7), { holdMs: 30, write: (x) => w3.push(x) });
  await sleep(60);
  assert.equal(w3.length, 0);

  // ④ 別の番（数が違う）は取り消さない
  const w4: AltUsageInput[] = [];
  recordAltUsageAuto(base(44, 0), { holdMs: 30, write: (x) => w4.push(x) });
  assert.equal(cancelPendingAutoUsage({ output_tokens: 45, cache_read_input_tokens: 0 }), false);
  await sleep(60);
  assert.equal(w4.length, 1);
  console.log("deepseek-auto-usage: ok");
})().catch((e) => { console.error(e); process.exit(1); });
