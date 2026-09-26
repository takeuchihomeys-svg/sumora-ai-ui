// app/lib/__tests__/llm-test-mode.test.ts
// 2026-09-26 竹内「この形でおこなう」: テスト用の LLM の切り替え（LLM_TEST_MODE=deepseek-all）は
//   ローカル（開発サーバ・scripts）でだけ効き、本番（Vercel・NODE_ENV=production）では絶対に動かない。
// 実行: npx tsx app/lib/__tests__/llm-test-mode.test.ts（全 PASS で exit 0）
import { readFileSync } from "node:fs";
import {
  isTestModeAllowed, readTestMode, testModeBlockedReason, isBrainCall, isTestModeTarget, usageEnvLabel,
  TEST_MODE_BRAIN_SYSTEM_MARKERS,
} from "../llm-test-mode";
import { readAltConfig, shouldRouteAlt, routedByTestMode, resolveRouteName, willRouteAlt, toOpenAIBody, jsonSchemaInstruction, stripWholeCodeFence } from "../llm-alt-provider";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

const LOCAL = { NODE_ENV: "development", LLM_TEST_MODE: "deepseek-all", DEEPSEEK_API_KEY: "k" };

console.log("── ★ 本番（Vercel・NODE_ENV=production）では絶対に効かない（鍵2）");
{
  t("VERCEL=1 → false", isTestModeAllowed({ ...LOCAL, VERCEL: "1" }) === false);
  t("VERCEL_ENV=production → false", isTestModeAllowed({ ...LOCAL, VERCEL_ENV: "production" }) === false);
  t("VERCEL_ENV=preview → false", isTestModeAllowed({ ...LOCAL, VERCEL_ENV: "preview" }) === false);
  t("VERCEL_ENV=development（vercel dev）→ false", isTestModeAllowed({ ...LOCAL, VERCEL_ENV: "development" }) === false);
  t("VERCEL_URL がある → false", isTestModeAllowed({ ...LOCAL, VERCEL_URL: "x.vercel.app" }) === false);
  t("NODE_ENV=production（next start）→ false", isTestModeAllowed({ ...LOCAL, NODE_ENV: "production" }) === false);
  t("NODE_ENV=Production（大文字）→ false", isTestModeAllowed({ ...LOCAL, NODE_ENV: "Production" }) === false);
  t("AWS_LAMBDA_FUNCTION_NAME がある → false", isTestModeAllowed({ ...LOCAL, AWS_LAMBDA_FUNCTION_NAME: "f" }) === false);
  // 本番の Vercel に誤って LLM_TEST_MODE が入った形
  const prod = { LLM_TEST_MODE: "deepseek-all", VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production", LLM_ALT_PROVIDER: "deepseek", LLM_ALT_ACTIONS: "reply_generate", DEEPSEEK_API_KEY: "k" };
  t("本番に誤って入っても readTestMode は null", readTestMode(prod) === null);
  t("本番の readAltConfig は testMode=null（今までの設定のまま）", readAltConfig(prod)?.testMode === null);
  t("本番の readAltConfig の actions は reply_generate だけ", JSON.stringify([...(readAltConfig(prod)?.actions ?? [])]) === JSON.stringify(["reply_generate"]));
  t("本番: 名札なしの判定（classify）は回さない", shouldRouteAlt(readAltConfig(prod), "classify") === false);
  t("本番: 最終チェックらしき呼び出しも回さない", shouldRouteAlt(readAltConfig(prod), resolveRouteName(null, "以下の各記述について、情報源に根拠があるかどうか")) === false);
  t("本番: LLM_TEST_MODE だけ（ALT なし）なら readAltConfig は null（何もしない）", readAltConfig({ LLM_TEST_MODE: "deepseek-all", VERCEL: "1", NODE_ENV: "production", DEEPSEEK_API_KEY: "k" }) === null);
  t("本番の env ラベルは production のまま", usageEnvLabel(prod) === "production");
  t("本番で入っていたら理由を1行出せる", (testModeBlockedReason(prod) ?? "").includes("無視"));
}

console.log("── ★ 鍵1: 明示しないと何もしない");
{
  t("未設定 → null", readTestMode({ NODE_ENV: "development" }) === null);
  t("off → null", readTestMode({ NODE_ENV: "development", LLM_TEST_MODE: "off" }) === null);
  t("書き間違い → null", readTestMode({ NODE_ENV: "development", LLM_TEST_MODE: "deepseek" }) === null);
  t("書き間違いは理由を出す", (testModeBlockedReason({ LLM_TEST_MODE: "deepseek" }) ?? "").includes("知らない値"));
  t("未設定なら理由も出さない", testModeBlockedReason({}) === null);
  t("開発サーバ（development）→ deepseek-all", readTestMode(LOCAL) === "deepseek-all");
  t("scripts（NODE_ENV 無し）→ deepseek-all", readTestMode({ LLM_TEST_MODE: "deepseek-all" }) === "deepseek-all");
  t("手元の env ラベルは local:deepseek-all", usageEnvLabel(LOCAL) === "local:deepseek-all");
  t("手元で切り替え無しは local のまま", usageEnvLabel({ NODE_ENV: "development" }) === "local");
}

console.log("── ★ ブレインは対象外（Claude のまま）");
{
  for (const name of ["brain_fresh", "brain_full", "brain-warm", "brain_fresh_claude", "brain"]) {
    t(`名札 ${name} はブレイン`, isBrainCall(name, null));
    t(`名札 ${name} は切り替えの対象外`, isTestModeTarget("deepseek-all", name, null) === false);
  }
  t("最終チェック（名札なし・classify）は対象", isTestModeTarget("deepseek-all", "classify", "以下の各記述について、情報源に根拠があるかどうか") === true);
  t("返信本文（reply_generate）は対象", isTestModeTarget("deepseek-all", "reply_generate", "【指示の優先順位（競合時はこの順で解決すること）】ハードゲート") === true);
  t("切り替え無しなら何も対象にしない", isTestModeTarget(null, "classify", null) === false);
  // 実ファイルの文面と照合（プロンプトの冒頭を変えたらここで落ちる＝静かに対象に入らない）
  const brainCore = readFileSync("app/lib/brain-core.ts", "utf8");
  const checkpointHead = brainCore.match(/const CHECKPOINT_STATIC_SYSTEM = `([^\n]*)/)?.[1] ?? "";
  const strategyHead = brainCore.match(/const STRATEGY_SYSTEM = `([^\n]*)/)?.[1] ?? "";
  t("brain-core のセーブデータ作りの system 先頭がブレイン扱い", !!checkpointHead && isBrainCall("classify", checkpointHead), checkpointHead.slice(0, 40));
  t("brain-core の戦略の整理の system 先頭がブレイン扱い", !!strategyHead && isBrainCall(resolveRouteName(null, strategyHead), strategyHead), strategyHead.slice(0, 40));
  t("brain-core の名札 brain_fresh / brain_full が残っている", brainCore.includes('"brain_fresh" : "brain_full"'));
  t("見分けの語が3つ", TEST_MODE_BRAIN_SYSTEM_MARKERS.length === 3);
}

console.log("── ★ llm-alt-provider への組み込み");
{
  const cfg = readAltConfig({ ...LOCAL });
  t("LLM_ALT_* 無しでも切り替えだけで有効（DeepSeek 本家）", cfg?.provider === "deepseek" && cfg?.testMode === "deepseek-all");
  t("DeepSeek の鍵が無ければ null（何もしない）", readAltConfig({ NODE_ENV: "development", LLM_TEST_MODE: "deepseek-all" }) === null);
  t("名札なし（判定・最終チェック）を回す", shouldRouteAlt(cfg, "classify", "以下の各記述について") === true);
  t("AIX（property_send）も回す", shouldRouteAlt(cfg, "property_send") === true);
  t("brain_fresh は回さない", shouldRouteAlt(cfg, "brain_fresh") === false);
  t("brain_full は回さない", shouldRouteAlt(cfg, "brain_full") === false);
  t("ブレインの system（スモラAI）は回さない", shouldRouteAlt(cfg, resolveRouteName(null, "あなたはスモラAI。与えられた会話履歴を読んで"), "あなたはスモラAI。与えられた会話履歴を読んで") === false);
  t("セーブデータ作りは回さない", shouldRouteAlt(cfg, "classify", "あなたは不動産賃貸仲介のLINE会話の記録係です。") === false);
  t("切り替えだけが理由か（routedByTestMode）", routedByTestMode(cfg, "classify") === true);
  const both = readAltConfig({ ...LOCAL, LLM_ALT_PROVIDER: "deepseek", LLM_ALT_ACTIONS: "reply_generate,brain_fresh" });
  t("LLM_ALT_ACTIONS に brain_fresh を明示した時は今までどおり回す（影の比較用）", shouldRouteAlt(both, "brain_fresh") === true);
  const normal = readAltConfig({ NODE_ENV: "development", LLM_ALT_PROVIDER: "deepseek", LLM_ALT_ACTIONS: "reply_generate", DEEPSEEK_API_KEY: "k" });
  t("切り替え無しの手元は今までどおり（classify は回さない）", shouldRouteAlt(normal, "classify") === false && normal?.testMode === null);
  t("切り替え無しの手元は reply_generate だけ回す", shouldRouteAlt(normal, "reply_generate") === true);
  t("willRouteAlt: 切り替えありで名札なしはマスクする側（回る）", willRouteAlt(null, {}, { ...LOCAL }) === true);
  t("willRouteAlt: 申込以降は回さない（個人情報の歯止めは切り替えでも同じ）", willRouteAlt(null, { postApply: true }, { ...LOCAL }) === false);
  t("willRouteAlt: brain_fresh は回さない", willRouteAlt("brain_fresh", {}, { ...LOCAL }) === false);
}

console.log("── ★ 構造化出力（final-check の json_schema）を JSON モードに移すのは切り替えの時だけ");
{
  const schema = { type: "object", properties: { issues: { type: "array" } } };
  const body = { model: "claude-haiku-4-5", max_tokens: 100, messages: [{ role: "user", content: "check" }], output_config: { format: { type: "json_schema", schema } } };
  const prodBody = toOpenAIBody(body, "deepseek-v4-pro", { disableThinking: true });
  t("本番の形（フラグなし）は今までどおり response_format を付けない", prodBody !== null && !("response_format" in prodBody));
  t("本番の形は system も足さない", JSON.stringify(prodBody?.messages) === JSON.stringify([{ role: "user", content: "check" }]));
  const testBody = toOpenAIBody(body, "deepseek-v4-pro", { disableThinking: true, jsonSchemaToJsonMode: true });
  t("切り替えの形は response_format: json_object", JSON.stringify(testBody?.response_format) === JSON.stringify({ type: "json_object" }));
  const msgs = (testBody?.messages ?? []) as Array<{ role: string; content: string }>;
  t("切り替えの形はスキーマを system に書き足す（JSON の語を含む）", msgs[0]?.role === "system" && msgs[0].content.includes("JSON Schema") && msgs[0].content.includes("\"issues\""));
  t("output_config が無ければ何も足さない", !("response_format" in (toOpenAIBody({ ...body, output_config: undefined }, "m", { jsonSchemaToJsonMode: true }) ?? {})));
  t("jsonSchemaInstruction: json_schema 以外は null", jsonSchemaInstruction({ output_config: { format: { type: "text" } } }) === null);
  t("```json 囲みを外す", stripWholeCodeFence("```json\n{\"issues\":[]}\n```") === "{\"issues\":[]}");
  t("囲みが無ければそのまま", stripWholeCodeFence("{\"issues\":[]}") === "{\"issues\":[]}");
  t("文の途中のコードは触らない", stripWholeCodeFence("前置き\n```json\n{}\n```") === "前置き\n```json\n{}\n```");
  const fc = readFileSync("app/lib/final-check.ts", "utf8");
  t("final-check はまだ output_config の json_schema を使っている（使わなくなったらこの橋渡しを見直す）", /output_config: \{ format: \{ type: "json_schema"/.test(fc));
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
