// 2026-11-27 作業員L（竹内さんの決め 11/25「審査関係も OpenAI に回って大丈夫・DeepSeek には渡さない」・11/27「入口の読みだけ OpenAI を許す」）
//   試験（LLM_TEST_MODE=deepseek-all）の出口の包み: 名札 conductor_intake が審査の事情の網に当たった番だけ OpenAI へ（LLM_TEST_ALLOW_INTAKE_OPENAI=on）。
//   ① DeepSeek には決して出さない ② 他の名札は今まで通り止める ③ スイッチが無ければ今まで通り止める ④ 網に当たらない番は今まで通り DeepSeek
// 実行: npx tsx app/lib/__tests__/exam-intake-openai.test.ts（偽物の fetch・LLM も DB も使わない）
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy";
process.env.LLM_TEST_MODE = "deepseek-all";
delete process.env.VERCEL; delete process.env.VERCEL_ENV; delete process.env.VERCEL_URL; delete process.env.NODE_ENV;
process.env.OPENAI_API_KEY = "dummy";
process.env.DEEPSEEK_API_KEY = "dummy";

const calls = { openai: 0, deepseek: 0, anthropic: 0 };
const models: string[] = [];
const stub = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const okJson = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("api.openai.com")) { calls.openai++; try { models.push(String((JSON.parse(String(init?.body ?? "{}")) as { model?: string }).model)); } catch { /* */ } return okJson({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }); }
  if (url.includes("api.deepseek.com")) { calls.deepseek++; return okJson({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }); }
  if (url.includes("api.anthropic.com")) { calls.anthropic++; return okJson({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 1 } }); }
  return okJson([]);
}) as typeof fetch;
const reset = () => { calls.openai = 0; calls.deepseek = 0; calls.anthropic = 0; models.length = 0; };

async function main() {
  const alt = await import("../llm-alt-provider");
  const recorder = await import("../llm-usage-recorder");
  const { BUDGET_ROLE_TABLE } = await import("../llm-budget-route");
  globalThis.fetch = stub;
  assert.ok(alt.installAltProvider({ ...process.env, LLM_ALT_PROVIDER: "deepseek", LLM_USAGE_RECORD: "off" } as Record<string, string>), "試験の包みが入る");
  const YUMA2 = "d040f80a-4fae-4fd0-abca-66eb2630906f";
  const send = (action: string, text: string) => globalThis.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", [recorder.LLM_ACTION_HEADER]: action, [recorder.LLM_CONVERSATION_HEADER]: YUMA2 },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 50, system: "テスト", messages: [{ role: "user", content: text }] }),
  });
  const SENS = "【お客様の今の番】\n夜の仕事をしているので審査が心配です";
  const PLAIN = "【お客様の今の番】\n梅田まで30分以内で探しています";
  const blocked = async (p: Promise<Response>) => { try { await p; return false; } catch (e) { return e instanceof Error && /LLM_TEST_MODE=deepseek-all/.test(e.message); } };

  // スイッチなし: 今まで通り止める（DeepSeek にも OpenAI にも出さない）
  delete process.env.LLM_TEST_ALLOW_INTAKE_OPENAI;
  reset();
  assert.equal(await blocked(send("conductor_intake", SENS)), true, "スイッチなし: 止める");
  assert.deepEqual(calls, { openai: 0, deepseek: 0, anthropic: 0 });

  // スイッチ on: 入口の読みの審査の事情の番だけ OpenAI（統括の係のモデル）
  process.env.LLM_TEST_ALLOW_INTAKE_OPENAI = "on";
  reset();
  const r = await send("conductor_intake", SENS);
  assert.equal(r.status, 200);
  assert.deepEqual(calls, { openai: 1, deepseek: 0, anthropic: 0 }, "OpenAI に1回・DeepSeek に出さない");
  assert.equal(models[0], BUDGET_ROLE_TABLE.conductor.model, "本番の統括の係と同じモデル");

  // 他の名札は今まで通り止める
  reset();
  assert.equal(await blocked(send("brain_full", SENS)), true, "brain_full は止める");
  assert.deepEqual(calls, { openai: 0, deepseek: 0, anthropic: 0 });

  // 網に当たらない入口の読みは今まで通り DeepSeek
  reset();
  await send("conductor_intake", PLAIN);
  assert.deepEqual(calls, { openai: 0, deepseek: 1, anthropic: 0 }, "網に当たらない番は DeepSeek のまま");

  console.log("exam-intake-openai ok 9");
}
main().catch((e) => { console.error(e); process.exit(1); });
