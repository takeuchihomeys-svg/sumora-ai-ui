// npx tsx app/lib/__tests__/exam-brain-openai.test.ts
// 2026-11-24 作業員L（台帳 #670）: 試験だけブレインを OpenAI に回す切り替え（EXAM_BRAIN_PROVIDER=openai）と OpenAI の本文・単価
import assert from "node:assert/strict";
import { examBrainTarget, isBrainRouteName, readProviderTarget, toOpenAIBody, OPENAI_CHAT_ENDPOINT, createSseConverter, openaiGuardOf, WRITER_GPT_NOTE } from "../llm-alt-provider";
import { altPriceOf, altUsageUsd } from "../llm-price";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const LOCAL = { OPENAI_API_KEY: "sk-test", EXAM_BRAIN_PROVIDER: "openai" };

t("ブレインの名札だけ（Claude に固定した *_claude は外す）", () => {
  assert.equal(isBrainRouteName("brain_fresh"), true);
  assert.equal(isBrainRouteName("brain_full"), true);
  assert.equal(isBrainRouteName("brain"), true);
  assert.equal(isBrainRouteName("brain_fresh_claude"), false);
  assert.equal(isBrainRouteName("reply_generate"), false);
  assert.equal(isBrainRouteName(null), false);
});

t("試験だけ: 手元で EXAM_BRAIN_PROVIDER=openai の時だけ相手を返す（本番・鍵なし・未設定は null）", () => {
  const x = examBrainTarget(LOCAL);
  assert.equal(x?.provider, "openai");
  assert.equal(x?.endpoint, OPENAI_CHAT_ENDPOINT);
  assert.equal(x?.model, "gpt-6.2-sol");
  assert.equal(examBrainTarget({ ...LOCAL, EXAM_BRAIN_MODEL: "gpt-6-luna" })?.model, "gpt-6-luna");
  assert.equal(examBrainTarget({ ...LOCAL, VERCEL: "1" }), null);
  assert.equal(examBrainTarget({ ...LOCAL, NODE_ENV: "production" }), null);
  assert.equal(examBrainTarget({ EXAM_BRAIN_PROVIDER: "openai" }), null);
  assert.equal(examBrainTarget({ OPENAI_API_KEY: "sk-test" }), null);
});

t("相手 openai（本番の振り分け用・鍵が無ければ null）", () => {
  assert.equal(readProviderTarget({ OPENAI_API_KEY: "sk-test" }, "openai")?.model, "gpt-6.2-sol");
  assert.equal(readProviderTarget({}, "openai"), null);
});

t("OpenAI の本文: max_completion_tokens（思考の分で2倍・最低 8192）・temperature を送らない・思考の強さ", () => {
  const body = { model: "claude-x", max_tokens: 3000, temperature: 0.2, system: "あなたはブレイン", messages: [{ role: "user", content: "判断して" }] };
  const p = toOpenAIBody(body as never, "gpt-6.2-sol", { openai: { reasoningEffort: "low" } })!;
  assert.equal(p.max_completion_tokens, 8192);
  assert.equal(p.max_tokens, undefined);
  assert.equal(p.temperature, undefined);
  assert.equal(p.reasoning_effort, "low");
  assert.equal((p.messages as Array<{ role: string }>)[0].role, "system");
  const q = toOpenAIBody({ ...body, max_tokens: 6000 } as never, "gpt-6-luna", { openai: {} })!;
  assert.equal(q.max_completion_tokens, 12000);
  assert.equal(q.reasoning_effort, undefined);
});

t("単価: 公式の表（入力/キャッシュ/出力）", () => {
  assert.deepEqual(altPriceOf("gpt-6.2-sol"), { in: 2, read: 0.1, out: 10, peakDouble: false });
  assert.equal(altPriceOf("gpt-6.2-astra")?.out, 40);
  assert.equal(altPriceOf("gpt-6-luna")?.in, 0.1);
  assert.equal(altPriceOf("gpt-6.1-terra")?.read, 0.05);
  // 100万の入力（うち 50万キャッシュ）と 10万の出力: 0.5×2 + 0.5×0.1 + 0.1×10 = 2.05
  assert.equal(Math.round(altUsageUsd({ model: "gpt-6.2-sol", input_uncached: 500_000, cache_read: 500_000, output_tokens: 100_000 }) * 100) / 100, 2.05);
});

t("係ごとの prompt_cache_key・試験の欄の言い添え（JSON モード）", () => {
  const body = { model: "claude-x", max_tokens: 3000, system: "あなたはブレイン", messages: [{ role: "user", content: "判断して" }] };
  const p = toOpenAIBody(body as never, "gpt-6-luna", { openai: { cacheKey: "sumora-brain_fresh", jsonKeys: ["reply_mode", "action"] } })!;
  assert.equal(p.prompt_cache_key, "sumora-brain_fresh");
  assert.deepEqual(p.response_format, { type: "json_object" });
  assert.match((p.messages as Array<{ content: string }>)[0].content, /reply_mode, action/);
  const q = toOpenAIBody(body as never, "gpt-6-luna", { openai: {} })!;
  assert.equal(q.prompt_cache_key, undefined);
  assert.equal(q.response_format, undefined);
  assert.equal((q.messages as Array<{ content: string }>)[0].content, "あなたはブレイン");
});

t("1文字ずつの形: OpenAI の cached_tokens を命中に（新規＝入力−命中）", () => {
  const c = createSseConverter("gpt-6.2-sol");
  c.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "はい" } }] })}`);
  c.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } } })}`);
  const u = c.usage();
  assert.equal(u.cache_read_input_tokens, 800);
  assert.equal(u.input_tokens, 200);
  const d = createSseConverter("deepseek-v4-pro");
  d.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 } })}`);
  assert.deepEqual([d.usage().cache_read_input_tokens, d.usage().input_tokens], [600, 400]);
});

t("OpenAI 用の待ち時間（未設定は今まで通り）", () => {
  const g = { enabled: true, firstTokenMs: 15_000, totalMs: 60_000, breakerFailures: 2, breakerCooldownMs: 300_000 };
  assert.deepEqual(openaiGuardOf(g, {}), g);
  const o = openaiGuardOf(g, { OPENAI_FIRST_TOKEN_MS: "45000", OPENAI_TIMEOUT_MS: "120000" });
  assert.deepEqual([o.firstTokenMs, o.totalMs], [45_000, 120_000]);
  assert.equal(openaiGuardOf({ ...g, enabled: false }, { OPENAI_FIRST_TOKEN_MS: "45000" }).firstTokenMs, 15_000);
});

t("書き手の GPT 用の言い添えは system の最後（先頭は変えない）", () => {
  const body = { model: "claude-x", max_tokens: 3000, system: "あなたは書き手", messages: [{ role: "user", content: "書いて" }] };
  const p = toOpenAIBody(body as never, "gpt-6-luna", { openai: { writerNote: WRITER_GPT_NOTE } })!;
  const sys = (p.messages as Array<{ content: string }>)[0].content;
  assert.ok(sys.startsWith("あなたは書き手"));
  assert.match(sys, /全然大丈夫です/);
  assert.match(sys, /短くまとめすぎない/);
});

console.log(`exam-brain-openai: ${n} ok`);
