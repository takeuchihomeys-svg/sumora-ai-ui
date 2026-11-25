// npx tsx app/lib/__tests__/llm-budget-route.test.ts
// 2026-11-24 作業員L（台帳 #670）: 月の Claude の使用額で係ごとに Claude ⇄ OpenAI
import assert from "node:assert/strict";
import { budgetRoleOf, readBudgetConfig, budgetDecision, spendWindowStart, openaiWindowStart, claudeMonthSpendUsd, monthSpendLine, BUDGET_ROLE_TABLE } from "../llm-budget-route";
import { addRow } from "../llm-budget-route-server";
import { readAltConfig } from "../llm-alt-provider";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const NOW = Date.parse("2026-11-24T03:00:00Z");
// 2026-11-25: 前の「線を超えたら回す」の決め（LLM_BUDGET_SPLIT=off）の試験。2つの枠で配る決め（既定）は下の t で
const ON = { LLM_BUDGET_ROUTE: "on", LLM_BUDGET_SPLIT: "off", CLAUDE_SWITCH_AT_USD: "316.7", CLAUDE_SPEND_BASE_USD: "291.71", CLAUDE_SPEND_BASE_AT: "2026-11-24T01:19:00Z" };

t("係: ブレイン・統括・書き手・最終チェック・軽い係。表に無い名札と *_claude は null", () => {
  // 2026-11-25 案 A: 本番のブレインは Claude・brain-sweep のブレインだけ
  assert.equal(budgetRoleOf("brain_fresh"), null);
  assert.equal(budgetRoleOf("brain_fresh", { httpRoute: "/api/cron/brain-sweep" }), "brain");
  assert.equal(budgetRoleOf("conductor_intake"), "conductor");
  assert.equal(budgetRoleOf("reply_generate"), null); // 2026-11-25 案 A: 書き手は回さない
  assert.equal(budgetRoleOf("final_check_verify"), "final_check");
  assert.equal(budgetRoleOf("final_check_verify", { claudeModel: "claude-haiku-4-5" }), "light");
  assert.equal(budgetRoleOf("classify_condition"), "learn"); // 2026-11-25: 元のモデルが分からない時は Terra
  assert.equal(budgetRoleOf("classify_condition", { claudeModel: "claude-haiku-4-5" }), "light");
  assert.equal(budgetRoleOf("brain_fresh_claude"), null);
  assert.equal(budgetRoleOf("property_send"), null); // AIX の本文は表に無い＝Claude のまま
  assert.equal(budgetRoleOf(null), null);
});

t("2026-11-25 既定は on（=off で止まる）・線の既定 $316.71", () => {
  const cfg = readBudgetConfig({ LLM_BUDGET_SPLIT: "off" });
  assert.equal(cfg.mode, "on");
  assert.equal(readBudgetConfig({ LLM_BUDGET_ROUTE: "off" }).mode, "off");
  assert.equal(cfg.switchAtUsd, 316.71);
  assert.equal(cfg.claudeCreditUsd, 200);
  assert.equal(cfg.openaiCreditUsd, 100);
  assert.equal(budgetDecision("brain_fresh", 999, cfg).route, "claude", "本番のブレインは Claude");
  assert.equal(budgetDecision("conductor_intake", 999, readBudgetConfig({ LLM_BUDGET_ROUTE: "off" })).route, "claude", "off は回さない");
  assert.equal(budgetDecision("conductor_intake", 999, cfg).route, "openai");
  assert.equal(budgetDecision("conductor_intake", 300, cfg, { partial: true }).route, "openai", "読み切れていない時は超えたと見なす");
});

t("線の手前は Claude・線を超えたら表のモデル（失敗は Claude に戻す）", () => {
  const cfg = readBudgetConfig(ON);
  const sweep = { httpRoute: "/api/cron/brain-sweep" };
  assert.equal(budgetDecision("brain_fresh", 300, cfg, sweep).route, "claude");
  const d = budgetDecision("brain_fresh", 316.7, cfg, sweep);
  assert.equal(d.route, "openai");
  assert.equal(d.model, "gpt-6.2-sol");
  assert.equal(d.fallbackToClaude, true);
  assert.equal(budgetDecision("classify_condition", 320, cfg, { claudeModel: "claude-haiku-4-5" }).model, "gpt-6-luna");
  assert.equal(budgetDecision("learn_weekly", 320, cfg).model, "gpt-6.1-terra");
  assert.equal(budgetDecision("property_send", 320, cfg).route, "claude");
  assert.equal(budgetDecision("brain_fresh", null, cfg, sweep).route, "claude"); // 使用額が読めない時は Claude
});

t("係のモデルを env で替える・shadow は決めるだけ", () => {
  const cfg = readBudgetConfig({ ...ON, LLM_BUDGET_ROLE_MODELS: "brain=gpt-6.2-astra,writer=gpt-6.1-terra,bad=x" });
  const sweep = { httpRoute: "/api/cron/brain-sweep" };
  assert.equal(budgetDecision("brain_full", 400, cfg, sweep).model, "gpt-6.2-astra");
  assert.equal(budgetDecision("reply_generate", 400, cfg).route, "claude", "2026-11-25 案 A: 書き手は回さない");
  assert.equal(budgetDecision("brain_full", 400, readBudgetConfig({ ...ON, LLM_BUDGET_ROUTE: "shadow" }), sweep).shadow, true);
});

t("数え始め: 基準の時刻が今月なら基準から（基準＋その後×補正）・無ければ月初から", () => {
  const cfg = readBudgetConfig({ ...ON, CLAUDE_COST_FACTOR: "1.1" });
  assert.deepEqual(spendWindowStart(cfg, NOW), { since: "2026-11-24T01:19:00.000Z", useBase: true });
  assert.equal(Math.round(claudeMonthSpendUsd(cfg, { useBase: true, sinceUsd: 10 }) * 100) / 100, 302.71);
  // 2026-11-25 竹内さん「次の $200 は 12/10」: 区切りは毎月10日の JST 0時（暦の月初ではない）。12/10 になるまでは 11/10 からの区切りのまま（基準も効く）
  assert.deepEqual(spendWindowStart(cfg, Date.parse("2026-12-02T00:00:00Z")), { since: "2026-11-24T01:19:00.000Z", useBase: true }, "12/2 はまだ 11/10 の区切り");
  assert.deepEqual(spendWindowStart(cfg, Date.parse("2026-12-09T14:59:59Z")), { since: "2026-11-24T01:19:00.000Z", useBase: true }, "12/9 23:59 JST まで同じ区切り");
  assert.deepEqual(spendWindowStart(cfg, Date.parse("2026-12-09T15:00:00Z")), { since: "2026-12-09T15:00:00.000Z", useBase: false }, "12/10 0時 JST に新しい区切り（前の区切りの基準は使わない）");
  assert.deepEqual(spendWindowStart(readBudgetConfig({}), NOW), { since: "2026-11-24T01:19:00.000Z", useBase: true }, "既定の基準（$291.71・11/24 10:19 JST）");
  assert.deepEqual(spendWindowStart(readBudgetConfig({ CLAUDE_CREDIT_RESET_DAY: "1" }), Date.parse("2026-12-02T00:00:00Z")), { since: "2026-11-30T15:00:00.000Z", useBase: false }, "区切りの日は env で変えられる");
  // 12/9 までは前の区切り（基準＋その後）で線を超えたまま＝書き手以外の係は OpenAI・12/10 の数え直しで線の手前に戻る＝Claude に戻る
  const dec = readBudgetConfig({ LLM_BUDGET_SPLIT: "off" });
  const spendAt = (iso: string, sinceUsd: number) => claudeMonthSpendUsd(dec, { useBase: spendWindowStart(dec, Date.parse(iso)).useBase, sinceUsd });
  assert.equal(budgetDecision("conductor_intake", spendAt("2026-12-09T14:00:00Z", 30), dec).route, "openai", "12/9 は線を超えたまま");
  assert.equal(budgetDecision("conductor_intake", spendAt("2026-12-09T15:00:00Z", 0.5), dec).route, "claude", "12/10 の数え直しで Claude に戻る");
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
  assert.equal(readAltConfig({ OPENAI_API_KEY: "sk-test" })?.provider, "openai", "2026-11-25 既定 on: 鍵があれば包みを入れる");
  assert.equal(readAltConfig({ LLM_BUDGET_ROUTE: "off", OPENAI_API_KEY: "sk-test" }), null, "=off は何もしない");
  assert.equal(readAltConfig({ LLM_BUDGET_ROUTE: "on" }), null);
});

t("2026-11-25 2つの枠で配る（既定）: 回せる係は区切りの初めから OpenAI・OpenAI の枠の 95% で止める・Claude の線は見ない", () => {
  const cfg = readBudgetConfig({});
  assert.equal(cfg.split, true);
  assert.equal(cfg.openaiAllowanceUsd, 100, "OpenAI の枠の既定 $100");
  assert.equal(readBudgetConfig({ OPENAI_ALLOWANCE_USD: "200" }).openaiAllowanceUsd, 200, "$200 に増えたら env で");
  assert.equal(budgetDecision("conductor_intake", 5, cfg, { openaiUsd: 0 }).route, "openai", "Claude が線の手前でも回す（線を待たない）");
  assert.equal(budgetDecision("conductor_intake", 5, cfg, { openaiUsd: 94.9 }).route, "openai");
  assert.equal(budgetDecision("conductor_intake", 5, cfg, { openaiUsd: 95 }).route, "claude", "OpenAI の枠の 95% で止める");
  assert.equal(budgetDecision("conductor_intake", 5, cfg, { openaiUsd: null }).route, "claude", "OpenAI の使用額が読めない時は回さない");
  assert.equal(budgetDecision("reply_generate", 5, cfg, { openaiUsd: 0 }).route, "claude", "書き手はふだん回さない");
  assert.equal(budgetDecision("reply_generate", 5, cfg, { openaiUsd: 0, piiWriter: true }).route, "openai", "歯止めの番の書き手は回す");
  assert.equal(budgetDecision("brain_fresh", 5, cfg, { openaiUsd: 0 }).route, "claude", "本番のブレインは回さない（既定）");
  assert.equal(budgetDecision("brain_fresh", 5, readBudgetConfig({ LLM_BUDGET_EXTRA: "on" }), { openaiUsd: 0 }).route, "openai", "LLM_BUDGET_EXTRA=on で本番のブレインも");
  assert.equal(budgetDecision("conductor_intake", 999, readBudgetConfig({ LLM_BUDGET_ROUTE: "off" }), { openaiUsd: 0 }).route, "claude", "=off は回さない");
  // OpenAI の区切りは暦の月初（JST）
  assert.equal(openaiWindowStart(cfg, Date.parse("2026-11-25T03:00:00Z")), "2026-10-31T15:00:00.000Z");
  assert.equal(openaiWindowStart(cfg, Date.parse("2026-12-01T00:00:00Z")), "2026-11-30T15:00:00.000Z");
});

console.log(`llm-budget-route: ${n} ok`);
