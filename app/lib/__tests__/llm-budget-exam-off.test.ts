// 2026-11-25 作業員L（統括役の頼み）: 予算の振り分け（LLM_BUDGET_ROUTE・既定 on）は試験の再生（LLM_TEST_MODE＝試験の係）には効かない
//   線を超えた使用額でも、試験の切り替えの間は OpenAI に回さない（試験の相手は EXAM_BRAIN_PROVIDER 等の試験だけの切り替えで決める）
// 実行: npx tsx app/lib/__tests__/llm-budget-exam-off.test.ts
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy";
process.env.OPENAI_API_KEY = "dummy";
process.env.CLAUDE_SWITCH_AT_USD = "300";
delete process.env.LLM_BUDGET_ROUTE; // 既定（on）

const calls = { openai: 0, deepseek: 0, anthropic: 0 };
globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const okJson = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("api.openai.com")) { calls.openai++; return okJson({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }); }
  if (url.includes("api.deepseek.com")) { calls.deepseek++; return okJson({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }); }
  if (url.includes("/rest/v1/llm_usage_logs")) return okJson([{ id: 1, model: "claude-sonnet-5-5", input_uncached: 200_000_000, cache_read: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0, output_tokens: 0, created_at: "2026-11-20T00:00:00Z", status: 200 }]);
  if (url.includes("api.anthropic.com")) { calls.anthropic++; return okJson({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }); }
  return okJson([]);
}) as typeof fetch;

async function main() {
  const alt = await import("../llm-alt-provider");
  const recorder = await import("../llm-usage-recorder");
  // 試験の係と同じ切り替え（全部 DeepSeek・Claude は止める）
  alt.installAltProvider({ ...process.env, LLM_TEST_MODE: "deepseek-all", DEEPSEEK_API_KEY: "dummy", LLM_USAGE_RECORD: "off" } as Record<string, string>);
  process.env.LLM_TEST_MODE = "deepseek-all";
  process.env.DEEPSEEK_API_KEY = "dummy";
  await globalThis.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", [recorder.LLM_ACTION_HEADER]: "conductor_intake" },
    body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 20, system: "テスト", messages: [{ role: "user", content: "お客様: 条件を整理して下さい" }] }),
  }).catch(() => null);
  assert.equal(calls.openai, 0, "試験の再生では OpenAI に回さない（線を超えていても）");
  console.log("llm-budget-exam-off: ok", JSON.stringify(calls));
}
main().catch((e) => { console.error(e); process.exit(1); });
