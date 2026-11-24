// npx tsx app/lib/__tests__/llm-budget-route.test.ts
// 2026-11-24 作業員L（台帳 #670）: 月の Claude の使用額で係ごとに Claude ⇄ OpenAI
import assert from "node:assert/strict";
import { budgetRoleOf, readBudgetConfig, budgetDecision, spendWindowStart, claudeMonthSpendUsd, monthSpendLine, BUDGET_ROLE_TABLE } from "../llm-budget-route";
import { addRow } from "../llm-budget-route-server";
import { readAltConfig } from "../llm-alt-provider";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const NOW = Date.parse("2026-11-24T03:00:00Z");
const ON = { LLM_BUDGET_ROUTE: "on", CLAUDE_SWITCH_AT_USD: "316.7", CLAUDE_SPEND_BASE_USD: "291.71", CLAUDE_SPEND_BASE_AT: "2026-11-24T01:19:00Z" };

t("係: ブレイン・統括・書き手・最終チェック・軽い係。表に無い名札と *_claude は null", () => {
  assert.equal(budgetRoleOf("brain_fresh"), "brain");
  assert.equal(budgetRoleOf("conductor_intake"), "conductor");
  assert.equal(budgetRoleOf("reply_generate"), "writer");
  assert.equal(budgetRoleOf("final_check_verify"), "final_check");
  assert.equal(budgetRoleOf("classify_condition"), "light");
  assert.equal(budgetRoleOf("brain_fresh_claude"), null);
  assert.equal(budgetRoleOf("property_send"), null); // AIX の本文は表に無い＝Claude のまま
  assert.equal(budgetRoleOf(null), null);
});

t("既定は off（env が無ければ何も変わらない）・線が無ければ切り替えない", () => {
  const cfg = readBudgetConfig({});
  assert.equal(cfg.mode, "off");
  assert.equal(cfg.switchAtUsd, null);
  assert.equal(cfg.claudeCreditUsd, 200);
  assert.equal(cfg.openaiCreditUsd, 100);
  assert.equal(budgetDecision("brain_fresh", 999, cfg).route, "claude");
  assert.equal(budgetDecision("brain_fresh", 999, readBudgetConfig({ LLM_BUDGET_ROUTE: "on" })).route, "claude");
});

t("線の手前は Claude・線を超えたら表のモデル（失敗は Claude に戻す）", () => {
  const cfg = readBudgetConfig(ON);
  assert.equal(budgetDecision("brain_fresh", 300, cfg).route, "claude");
  const d = budgetDecision("brain_fresh", 316.7, cfg);
  assert.equal(d.route, "openai");
  assert.equal(d.model, "gpt-6.2-sol");
  assert.equal(d.fallbackToClaude, true);
  assert.equal(budgetDecision("classify_condition", 320, cfg).model, "gpt-6-luna");
  assert.equal(budgetDecision("property_send", 320, cfg).route, "claude");
  assert.equal(budgetDecision("brain_fresh", null, cfg).route, "claude"); // 使用額が読めない時は Claude
});

t("係のモデルを env で替える・shadow は決めるだけ", () => {
  const cfg = readBudgetConfig({ ...ON, LLM_BUDGET_ROLE_MODELS: "brain=gpt-6.2-astra,writer=gpt-6.1-terra,bad=x" });
  assert.equal(budgetDecision("brain_full", 400, cfg).model, "gpt-6.2-astra");
  assert.equal(budgetDecision("reply_generate", 400, cfg).model, "gpt-6.1-terra");
  assert.equal(budgetDecision("brain_full", 400, readBudgetConfig({ ...ON, LLM_BUDGET_ROUTE: "shadow" })).shadow, true);
});

t("数え始め: 基準の時刻が今月なら基準から（基準＋その後×補正）・無ければ月初から", () => {
  const cfg = readBudgetConfig({ ...ON, CLAUDE_COST_FACTOR: "1.1" });
  assert.deepEqual(spendWindowStart(cfg, NOW), { since: "2026-11-24T01:19:00.000Z", useBase: true });
  assert.equal(Math.round(claudeMonthSpendUsd(cfg, { useBase: true, sinceUsd: 10 }) * 100) / 100, 302.71);
  assert.deepEqual(spendWindowStart(cfg, Date.parse("2026-12-02T00:00:00Z")), { since: "2026-12-01T00:00:00.000Z", useBase: false });
  assert.deepEqual(spendWindowStart(readBudgetConfig({}), NOW), { since: "2026-11-01T00:00:00.000Z", useBase: false });
});

t("行の費用を会社ごとに（Claude・OpenAI・DeepSeek）", () => {
  const s = { claudeUsd: 0, openaiUsd: 0, deepseekUsd: 0 };
  const row = (model: string, input: number, out: number) => ({ id: 1, model, created_at: "2026-11-24T04:00:00Z", input_uncached: input, cache_read: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0, output_tokens: out });
  addRow(s, row("claude-sonnet-5-5", 1_000_000, 0));
  addRow(s, row("gpt-6.2-sol", 1_000_000, 100_000));
  addRow(s, row("deepseek-v4-pro", 1_000_000, 0));
  assert.equal(s.claudeUsd, 2);
  assert.equal(s.openaiUsd, 3);
  assert.ok(s.deepseekUsd > 0);
});

t("毎朝の1枚: 月末の見込み（日割り）と特典を超えるか", () => {
  const l = monthSpendLine({ provider: "claude", spendUsd: 291.71, creditUsd: 200, nowMs: NOW });
  assert.equal(l.overCredit, true);
  assert.ok(l.forecastUsd > 350 && l.forecastUsd < 380);
});

t("表の係は全部 失敗の時に Claude に戻す（下書きが出ないのを避ける）", () => {
  for (const spec of Object.values(BUDGET_ROLE_TABLE)) assert.equal(spec.fallbackToClaude, true);
});

t("包み: 別クラウドの設定が無くても LLM_BUDGET_ROUTE=on/shadow と鍵があれば OpenAI を主に入れる（actions は空）・off は何もしない", () => {
  const c = readAltConfig({ LLM_BUDGET_ROUTE: "on", OPENAI_API_KEY: "sk-test" });
  assert.equal(c?.provider, "openai");
  assert.equal(c?.actions.size, 0);
  assert.equal(c?.allowAutoSend, false);
  assert.equal(readAltConfig({ LLM_BUDGET_ROUTE: "shadow", OPENAI_API_KEY: "sk-test" })?.provider, "openai");
  assert.equal(readAltConfig({ OPENAI_API_KEY: "sk-test" }), null);
  assert.equal(readAltConfig({ LLM_BUDGET_ROUTE: "on" }), null);
});

console.log(`llm-budget-route: ${n} ok`);
