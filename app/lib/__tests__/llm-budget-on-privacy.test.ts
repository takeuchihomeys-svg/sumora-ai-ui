// 2026-11-25 作業員L（竹内さんの決め 11/25 昼・統括役の頼み）: 予算の振り分け（LLM_BUDGET_ROUTE・既定 on）と個人情報の歯止め
//   ① 竹内さん「申込以降や審査関係も OpenAI に回って大丈夫」: 線を超えている間、歯止めの番（申込以降・時刻の線・審査の事情）は OpenAI に回る（LLM_BUDGET_PII_TO_OPENAI・既定 on）
//   ② DeepSeek には今まで通り回さない（線の手前・=off の時は Claude）
//   ③ 書き手（reply_generate）は歯止めの番だけ OpenAI の書き手の版（Sol medium＋v2-note）・それ以外の番は今まで通り DeepSeek
// 実行: npx tsx app/lib/__tests__/llm-budget-on-privacy.test.ts
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy";
delete process.env.LLM_BUDGET_ROUTE; // 既定（on）
delete process.env.LLM_BUDGET_PII_TO_OPENAI; // 既定（on）
process.env.CLAUDE_SWITCH_AT_USD = "300";

let spendTokens = 200_000_000; // 入力 2億トークン×$2/M＝$400（線 $300 を超える）
const calls = { openai: 0, deepseek: 0, anthropic: 0 };
const bodies: string[] = [];
const stub = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const okJson = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("api.openai.com")) { calls.openai++; bodies.push(String(init?.body ?? "")); return okJson({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }); }
  if (url.includes("api.deepseek.com")) { calls.deepseek++; return okJson({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }); }
  if (url.includes("/rest/v1/llm_usage_logs")) return okJson([{ id: 1, model: "claude-sonnet-5-5", input_uncached: spendTokens, cache_read: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0, output_tokens: 0, created_at: "2026-11-20T00:00:00Z", status: 200 }]);
  if (url.includes("api.anthropic.com")) { calls.anthropic++; return okJson({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 1 } }); }
  return okJson([]);
}) as typeof fetch;
const reset = () => { calls.openai = 0; calls.deepseek = 0; calls.anthropic = 0; bodies.length = 0; };

async function main() {
  const { budgetRoleOf, readBudgetConfig, CLAUDE_SWITCH_AT_USD_DEFAULT, budgetPiiToOpenAIOn } = await import("../llm-budget-route");
  const { resetBudgetCache } = await import("../llm-budget-route-server");
  // 決まり（純関数）
  assert.equal(readBudgetConfig({}).mode, "on", "既定 on");
  assert.equal(readBudgetConfig({ LLM_BUDGET_ROUTE: "off" }).mode, "off", "=off で止まる");
  assert.equal(CLAUDE_SWITCH_AT_USD_DEFAULT, 316.71);
  assert.equal(budgetPiiToOpenAIOn({}), true, "個人情報の番を OpenAI に回すのは既定 on");
  assert.equal(budgetPiiToOpenAIOn({ LLM_BUDGET_PII_TO_OPENAI: "off" }), false);
  assert.equal(budgetRoleOf("reply_generate"), null, "書き手はふだん回さない");
  assert.equal(budgetRoleOf("reply_generate", { piiWriter: true }), "writer", "歯止めの番の書き手だけ");
  assert.equal(budgetRoleOf("brain_fresh", { httpRoute: "/api/generate-draft-bg-async" }), null, "本番のブレインは Claude");
  assert.equal(budgetRoleOf("brain_fresh", { httpRoute: "/api/cron/brain-sweep" }), "brain");
  assert.equal(budgetRoleOf("webhook_image_vision", { claudeModel: "claude-haiku-4-5" }), null, "画像は Claude");
  assert.equal(budgetRoleOf("final_check_rule_check", { claudeModel: "claude-haiku-4-5-20251001" }), "light");

  // 出口の包み（DeepSeek も入れた本番に近い形）
  const alt = await import("../llm-alt-provider");
  const recorder = await import("../llm-usage-recorder");
  const { formatCutoffMark } = await import("../post-apply");
  globalThis.fetch = stub;
  process.env.OPENAI_API_KEY = "dummy";
  process.env.DEEPSEEK_API_KEY = "dummy";
  alt.installAltProvider({ ...process.env, LLM_ALT_PROVIDER: "deepseek", LLM_ALT_ACTIONS: "reply_generate,conductor_intake", LLM_ALT_FALLBACK: "on", LLM_USAGE_RECORD: "off" } as Record<string, string>);
  const send = (action: string, headers: Record<string, string> = {}, text = "お客様: 条件を整理して下さい") => globalThis.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", [recorder.LLM_ACTION_HEADER]: action, ...headers },
    body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 50, system: "テスト", messages: [{ role: "user", content: text }] }),
  });
  const CONV = { [recorder.LLM_CONVERSATION_HEADER]: "conv-test" };
  const POST = { [recorder.LLM_POST_APPLY_HEADER]: "1" };
  const BLOCKED = { ...CONV, [recorder.LLM_CUTOFF_HEADER]: formatCutoffMark({ kind: "blocked" }) };
  const SCREEN = "お客様: 過去に自己破産していて審査が不安です";

  // ── 線を超えている（$400 ≥ $300）・既定（OpenAI に回してよい）
  reset(); await send("conductor_intake");
  assert.deepEqual(calls, { openai: 1, deepseek: 0, anthropic: 0 }, "会話の無い統括の受け口は OpenAI");
  reset(); await send("conductor_intake", POST);
  assert.deepEqual(calls, { openai: 1, deepseek: 0, anthropic: 0 }, "★ 申込以降 → OpenAI（DeepSeek ではない）");
  reset(); await send("conductor_intake", BLOCKED);
  assert.deepEqual(calls, { openai: 1, deepseek: 0, anthropic: 0 }, "★ 時刻の線 blocked → OpenAI");
  reset(); await send("conductor_intake", { ...CONV });
  assert.deepEqual(calls, { openai: 1, deepseek: 0, anthropic: 0 }, "★ 線の印なし → OpenAI");
  reset(); await send("conductor_intake", { ...CONV, [recorder.LLM_CUTOFF_HEADER]: "all" }, SCREEN);
  assert.deepEqual(calls, { openai: 1, deepseek: 0, anthropic: 0 }, "★ 審査の事情 → OpenAI");
  reset(); await send("reply_generate", POST);
  assert.deepEqual(calls, { openai: 1, deepseek: 0, anthropic: 0 }, "★ 申込以降の書き手 → OpenAI の書き手の版");
  assert.ok(/"reasoning_effort":"medium"/.test(bodies[0] ?? ""), "書き手は Sol medium（v2-note-med）");
  reset(); await send("reply_generate", BLOCKED);
  assert.deepEqual(calls, { openai: 1, deepseek: 0, anthropic: 0 }, "★ 時刻の線 blocked の書き手 → OpenAI");
  reset(); await send("reply_generate", { ...CONV, [recorder.LLM_CUTOFF_HEADER]: "all" });
  assert.deepEqual(calls, { openai: 0, deepseek: 1, anthropic: 0 }, "歯止めの無い書き手は今まで通り DeepSeek");
  reset(); await send("brain_fresh", POST);
  assert.equal(calls.openai + calls.deepseek, 0, "本番のブレインは回さない（Claude）");

  // ── =off: 歯止めの番は今まで通り Claude（DeepSeek にも OpenAI にも出ない）
  process.env.LLM_BUDGET_PII_TO_OPENAI = "off";
  reset(); await send("conductor_intake", POST);
  assert.deepEqual(calls, { openai: 0, deepseek: 0, anthropic: 1 }, "=off: 申込以降 → Claude");
  reset(); await send("reply_generate", BLOCKED);
  assert.deepEqual(calls, { openai: 0, deepseek: 0, anthropic: 1 }, "=off: 時刻の線の書き手 → Claude");
  reset(); await send("conductor_intake", { ...CONV, [recorder.LLM_CUTOFF_HEADER]: "all" }, SCREEN);
  assert.deepEqual(calls, { openai: 0, deepseek: 0, anthropic: 1 }, "=off: 審査の事情 → Claude（前の直し）");
  delete process.env.LLM_BUDGET_PII_TO_OPENAI;

  // ── 線の手前: OpenAI に回らない＝歯止めの番は Claude・DeepSeek には決して出ない
  spendTokens = 0; resetBudgetCache(); // 基準 $291.71（既定）＋0 ＜ 線 $300
  reset(); await send("reply_generate", POST);
  assert.deepEqual(calls, { openai: 0, deepseek: 0, anthropic: 1 }, "★ 線の手前の申込以降 → Claude（DeepSeek ではない）");
  reset(); await send("reply_generate", BLOCKED);
  assert.deepEqual(calls, { openai: 0, deepseek: 0, anthropic: 1 }, "★ 線の手前の時刻の線 → Claude");
  reset(); await send("reply_generate", { ...CONV, [recorder.LLM_CUTOFF_HEADER]: "all" }, SCREEN);
  assert.equal(calls.deepseek, 0, "★ 審査の事情は DeepSeek に出さない");
  console.log("llm-budget-on-privacy: ok");
}
main().catch((e) => { console.error(e); process.exit(1); });
