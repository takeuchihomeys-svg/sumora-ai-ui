// 2026-11-25 作業員L（竹内さんの決め 11/25 昼・統括役の頼み）: 予算の振り分け（LLM_BUDGET_ROUTE・既定 on）でも、個人情報の歯止めの番はどの係でも OpenAI に回さない
//   申込以降の印・時刻の線の印（blocked・印なし）・本文の審査の事情 → Claude。案 A: 書き手・本番のブレインは Claude のまま・brain-sweep のブレインと書き手以外の係だけ OpenAI
// 実行: npx tsx app/lib/__tests__/llm-budget-on-privacy.test.ts
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy";
delete process.env.LLM_BUDGET_ROUTE; // 既定（on）
process.env.CLAUDE_SWITCH_AT_USD = "300";

const calls = { openai: 0, anthropic: 0 };
const stub = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  if (url.includes("api.openai.com")) {
    calls.openai++;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }), { status: 200 });
  }
  // 今月の Claude の使用額（llm_usage_logs の読み）: 線（$300）を超える1行（入力 2億トークン×$2/M＝$400）
  if (url.includes("/rest/v1/llm_usage_logs") && !url.includes("insert")) return new Response(JSON.stringify([{ id: 1, model: "claude-sonnet-5-5", input_uncached: 200_000_000, cache_read: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0, output_tokens: 0, created_at: "2026-11-20T00:00:00Z", status: 200 }]), { status: 200, headers: { "content-type": "application/json" } });
  if (!url.includes("api.anthropic.com")) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  calls.anthropic++;
  return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 1 } }), { status: 200 });
}) as typeof fetch;
const reset = () => { calls.openai = 0; calls.anthropic = 0; };

async function main() {
  const { budgetRoleOf, readBudgetConfig, CLAUDE_SWITCH_AT_USD_DEFAULT } = await import("../llm-budget-route");
  // 決まり（純関数）
  assert.equal(readBudgetConfig({}).mode, "on", "既定 on");
  assert.equal(readBudgetConfig({ LLM_BUDGET_ROUTE: "off" }).mode, "off", "=off で止まる");
  assert.equal(readBudgetConfig({}).switchAtUsd, CLAUDE_SWITCH_AT_USD_DEFAULT);
  assert.equal(CLAUDE_SWITCH_AT_USD_DEFAULT, 316.71);
  assert.equal(budgetRoleOf("reply_generate"), null, "書き手は Claude（DeepSeek）のまま");
  assert.equal(budgetRoleOf("aix_template"), null);
  assert.equal(budgetRoleOf("final_check_revision"), null, "文を書き直す確かめは入れない");
  assert.equal(budgetRoleOf("brain_fresh", { httpRoute: "/api/generate-draft-bg-async" }), null, "本番のブレインは Claude");
  assert.equal(budgetRoleOf("brain_fresh", { httpRoute: "/api/cron/brain-sweep" }), "brain", "brain-sweep のブレインだけ");
  assert.equal(budgetRoleOf("reply_writer_warm", { httpRoute: "/api/cron/brain-sweep" }), null, "温める呼び出しは Claude");
  assert.equal(budgetRoleOf("webhook_image_vision", { claudeModel: "claude-haiku-4-5" }), null, "画像は Claude");
  assert.equal(budgetRoleOf("final_check_rule_check", { claudeModel: "claude-haiku-4-5-20251001" }), "light");
  assert.equal(budgetRoleOf("final_check_context_check", { claudeModel: "claude-sonnet-5-5" }), "final_check");
  assert.equal(budgetRoleOf("learn_weekly", { claudeModel: "claude-sonnet-5-5" }), "learn");
  assert.equal(budgetRoleOf("conductor_intake"), "conductor");

  // 出口の包み（実際に入れて通す）
  const alt = await import("../llm-alt-provider");
  const recorder = await import("../llm-usage-recorder");
  const { formatCutoffMark } = await import("../post-apply");
  globalThis.fetch = stub;
  alt.installAltProvider({ ...process.env, OPENAI_API_KEY: "dummy", LLM_USAGE_RECORD: "off" } as Record<string, string>);
  process.env.OPENAI_API_KEY = "dummy";
  const send = (action: string, headers: Record<string, string> = {}, text = "お客様: 条件を整理して下さい") => globalThis.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", [recorder.LLM_ACTION_HEADER]: action, ...headers },
    body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 50, system: "テスト", messages: [{ role: "user", content: text }] }),
  });
  const CONV = { [recorder.LLM_CONVERSATION_HEADER]: "conv-test" };

  reset(); await send("conductor_intake");
  assert.deepEqual(calls, { openai: 1, anthropic: 0 }, "線を超えた・会話の無い統括の受け口は OpenAI");
  reset(); await send("conductor_intake", { [recorder.LLM_POST_APPLY_HEADER]: "1" });
  assert.deepEqual(calls, { openai: 0, anthropic: 1 }, "★ 申込以降の印 → Claude");
  reset(); await send("conductor_intake", { ...CONV, [recorder.LLM_CUTOFF_HEADER]: formatCutoffMark({ kind: "blocked" }) });
  assert.deepEqual(calls, { openai: 0, anthropic: 1 }, "★ 時刻の線 blocked → Claude");
  reset(); await send("conductor_intake", { ...CONV });
  assert.deepEqual(calls, { openai: 0, anthropic: 1 }, "★ 会話の呼び出しで線の印なし → Claude");
  reset(); await send("conductor_intake", { ...CONV, [recorder.LLM_CUTOFF_HEADER]: "all" }, "お客様: 過去に自己破産していて審査が不安です");
  assert.deepEqual(calls, { openai: 0, anthropic: 1 }, "★ 本文に審査の事情 → Claude");
  reset(); await send("reply_generate");
  assert.equal(calls.openai, 0, "書き手は OpenAI に回さない");
  reset(); await send("brain_fresh");
  assert.equal(calls.openai, 0, "本番のブレイン（brain-sweep でない）は OpenAI に回さない");
  console.log("llm-budget-on-privacy: ok");
}
main().catch((e) => { console.error(e); process.exit(1); });
