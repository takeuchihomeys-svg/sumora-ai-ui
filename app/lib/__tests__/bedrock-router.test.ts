// app/lib/__tests__/bedrock-router.test.ts
// 2026-09-19 竹内「AWSのクラウド経由する」（DeepSeek を Bedrock 経由で使い費用を下げる）
// 実行: npx tsx app/lib/__tests__/bedrock-router.test.ts（全 PASS で exit 0）
import { readBedrockConfig, shouldRouteToBedrock, toConverseInput, toAnthropicResponse, flattenContent } from "../bedrock-router";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const FULL: Record<string, string | undefined> = {
  BEDROCK_REGION: "us-east-1",
  BEDROCK_DEEPSEEK_MODEL_ID: "us.deepseek.v3-5:0",
  LLM_BEDROCK_ACTIONS: "condition_hearing",
  AWS_ACCESS_KEY_ID: "AKIA...",
  AWS_SECRET_ACCESS_KEY: "secret",
};

console.log("── ★ 設定が欠けていたら何もしない（今までどおり Anthropic）");
{
  t("全部そろっていれば有効", readBedrockConfig(FULL) !== null);
  for (const key of ["BEDROCK_REGION", "BEDROCK_DEEPSEEK_MODEL_ID", "LLM_BEDROCK_ACTIONS", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
    const env = { ...FULL } as Record<string, string | undefined>;
    delete env[key];
    t(`${key} が無ければ null（＝切り替えない）`, readBedrockConfig(env) === null);
  }
  t("空の環境では null", readBedrockConfig({}) === null);
  t("LLM_BEDROCK_ACTIONS が空文字なら null", readBedrockConfig({ ...FULL, LLM_BEDROCK_ACTIONS: "  " }) === null);
}

console.log("── 切り替えるのは指定した経路だけ");
{
  const cfg = readBedrockConfig(FULL)!;
  t("指定した action は回す", shouldRouteToBedrock(cfg, "condition_hearing"));
  t("★ 指定していない action は回さない", !shouldRouteToBedrock(cfg, "property_send"));
  t("action が無い呼び出しは回さない（返信生成は action=null）", !shouldRouteToBedrock(cfg, null));
  const all = readBedrockConfig({ ...FULL, LLM_BEDROCK_ACTIONS: "all" })!;
  t("all なら全部回す", shouldRouteToBedrock(all, "property_send") && shouldRouteToBedrock(all, null) === false || shouldRouteToBedrock(all, "x"));
  t("設定が無ければ常に false", !shouldRouteToBedrock(null, "condition_hearing"));
  const multi = readBedrockConfig({ ...FULL, LLM_BEDROCK_ACTIONS: "a, b ,c" })!;
  t("カンマ区切り（空白も許す）", shouldRouteToBedrock(multi, "b") && !shouldRouteToBedrock(multi, "d"));
}

console.log("── Anthropic の形 → Bedrock Converse の形");
{
  const body = {
    model: "claude-sonnet-5",
    system: [{ type: "text", text: "あなたはスモラの担当者です" }, { type: "text", text: "追加の指示" }],
    messages: [{ role: "user", content: "初期費用はいくらですか？" }],
    max_tokens: 800,
    temperature: 0.3,
  };
  const c = toConverseInput(body, "us.deepseek.v3-5:0")!;
  t("system は全ブロックを結合", c.system?.[0].text === "あなたはスモラの担当者です\n追加の指示", JSON.stringify(c.system));
  t("messages が移る", eq(c.messages, [{ role: "user", content: [{ text: "初期費用はいくらですか？" }] }]));
  t("max_tokens → maxTokens", c.inferenceConfig.maxTokens === 800);
  t("temperature が移る", c.inferenceConfig.temperature === 0.3);
  t("modelId が入る", c.modelId === "us.deepseek.v3-5:0");
}

console.log("── ★ 対象外はそのまま Anthropic へ（null を返す）");
{
  t("ストリーミングは対象外", toConverseInput({ stream: true, messages: [{ role: "user", content: "x" }] }, "m") === null);
  t("★ 画像つき（Vision）は対象外",
    toConverseInput({ messages: [{ role: "user", content: [{ type: "image" }, { type: "text", text: "この物件" }] }] }, "m") === null);
  t("system に画像ブロックがあっても対象外",
    toConverseInput({ system: [{ type: "image" }], messages: [{ role: "user", content: "x" }] }, "m") === null);
  t("messages が空なら対象外", toConverseInput({ messages: [] }, "m") === null);
  t("flattenContent: 画像ブロックがあれば null", flattenContent([{ type: "image" }]) === null);
  t("flattenContent: 文字列はそのまま", flattenContent("こんにちは") === "こんにちは");
}

console.log("── Bedrock の応答 → Anthropic の形（呼び出し側は違いに気付かない）");
{
  const r = toAnthropicResponse({
    output: { message: { content: [{ text: "かしこまりました！！" }, { text: "続きです" }] } },
    usage: { inputTokens: 1234, outputTokens: 56 },
    stopReason: "end_turn",
  }, "us.deepseek.v3-5:0");
  t("content[0].text に本文", eq((r.content as Array<{ text: string }>)[0].text, "かしこまりました！！続きです"));
  t("type/role が Anthropic と同じ", r.type === "message" && r.role === "assistant");
  t("★ usage が入る（llm_usage_logs がそのまま書ける）",
    eq(r.usage, { input_tokens: 1234, output_tokens: 56, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }));
  t("model は Bedrock のモデル ID（あとで費用を見分けられる）", r.model === "us.deepseek.v3-5:0");
  t("stop_reason が移る", r.stop_reason === "end_turn");
  t("max_tokens で切れた時も移る",
    toAnthropicResponse({ output: { message: { content: [{ text: "…" }] } }, stopReason: "max_tokens" }, "m").stop_reason === "max_tokens");
  t("usage が無くても落ちない", toAnthropicResponse({ output: { message: { content: [] } } }, "m").usage !== undefined);
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
