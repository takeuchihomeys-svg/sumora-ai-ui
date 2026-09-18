// app/lib/__tests__/llm-alt-provider.test.ts
// 2026-09-19 竹内「この方向性でいく」＝ 返信文 → 分類 → ブレイン の順に DeepSeek へ替え、学習は Claude のまま。
// 実行: npx tsx app/lib/__tests__/llm-alt-provider.test.ts（全 PASS で exit 0）
import { readFileSync } from "node:fs";
import {
  readAltConfig, shouldRouteAlt, resolveRouteName, toOpenAIBody, fromOpenAIResponse, flattenContent, ROUTE_MARKERS,
} from "../llm-alt-provider";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const AZURE: Record<string, string | undefined> = {
  LLM_ALT_PROVIDER: "azure",
  AZURE_AI_ENDPOINT: "https://x.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
  AZURE_AI_KEY: "key",
  AZURE_AI_MODEL: "DeepSeek-V4-Flash",
  LLM_ALT_ACTIONS: "reply_generate",
};

console.log("── ★ 設定が欠けていたら何もしない（今までどおり Anthropic）");
{
  t("そろっていれば有効", readAltConfig(AZURE) !== null);
  for (const key of ["AZURE_AI_ENDPOINT", "AZURE_AI_KEY", "AZURE_AI_MODEL", "LLM_ALT_ACTIONS"]) {
    const env = { ...AZURE };
    delete env[key];
    t(`${key} が無ければ null（切り替えない）`, readAltConfig(env) === null);
  }
  t("空の環境では null", readAltConfig({}) === null);
  t("provider の指定が無ければ null", readAltConfig({ ...AZURE, LLM_ALT_PROVIDER: "" }) === null);
  t("知らない provider は null", readAltConfig({ ...AZURE, LLM_ALT_PROVIDER: "openai" }) === null);
  t("bedrock は AWS の鍵がそろって初めて有効",
    readAltConfig({ LLM_ALT_PROVIDER: "bedrock", BEDROCK_REGION: "us-east-1", BEDROCK_DEEPSEEK_MODEL_ID: "m", LLM_ALT_ACTIONS: "a", AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s" }) !== null
    && readAltConfig({ LLM_ALT_PROVIDER: "bedrock", BEDROCK_REGION: "us-east-1", BEDROCK_DEEPSEEK_MODEL_ID: "m", LLM_ALT_ACTIONS: "a" }) === null);
}

console.log("── ★ 順番に替えられる（返信文 → 分類 → ブレイン）");
{
  // 返信生成・ブレインは x-sumora-llm-action を持たないので、system の先頭で見分ける
  t("★ 返信文の生成 → reply_generate", resolveRouteName(null, "【指示の優先順位（競合時はこの順で解決すること）】ハードゲート…") === "reply_generate");
  t("★ ブレイン（次の1アクション） → brain", resolveRouteName(null, "あなたはスモラAI。与えられた会話履歴を読んで、スタッフが次にすべき1アクションを…") === "brain");
  t("★ ブレイン（戦略の整理） → brain", resolveRouteName(null, "あなたは賃貸仲介（スモラ）の LINE 接客の「会話全体の戦略」を整理する担当です。") === "brain");
  t("それ以外 → classify", resolveRouteName(null, "あなたは不動産営業AIのアドバイザーです。") === "classify");
  t("AIX は action の名前をそのまま使う", resolveRouteName("property_send", "なんでも") === "property_send");

  const cfg = readAltConfig(AZURE)!;   // LLM_ALT_ACTIONS=reply_generate
  t("★ 返信文だけ替わる", shouldRouteAlt(cfg, "reply_generate"));
  t("★ ブレインは替わらない（竹内さんの方針: シャドーで確かめてから）", !shouldRouteAlt(cfg, "brain"));
  t("★ 分類も替わらない", !shouldRouteAlt(cfg, "classify"));
  t("AIX も替わらない", !shouldRouteAlt(cfg, "property_send"));

  const step2 = readAltConfig({ ...AZURE, LLM_ALT_ACTIONS: "reply_generate,classify" })!;
  t("2段階目: 分類も足せる", shouldRouteAlt(step2, "classify") && !shouldRouteAlt(step2, "brain"));
  t("★ 「all」という指定は無い（全部いっぺんに替えない）", !shouldRouteAlt(readAltConfig({ ...AZURE, LLM_ALT_ACTIONS: "all" })!, "brain"));
  t("設定が無ければ常に false", !shouldRouteAlt(null, "reply_generate"));
}

console.log("── ★ 見分けの語が実際のプロンプトと合っているか（静かに壊れるのを防ぐ）");
{
  // プロンプトの冒頭を書き換えると判定が外れ、気づかないうちに切り替えの対象が変わる。
  // ここで実ファイルと照合しておけば、文面を変えた時にこのテストが落ちて気付ける。
  const replyRoute = readFileSync("app/api/generate-reply/route.ts", "utf8");
  t("★ 返信生成の system 先頭（priorityOrderNote）に『ハードゲート』がある",
    new RegExp(`priorityOrderNote\\s*=\\s*"【指示の優先順位[^"]*${ROUTE_MARKERS.reply_generate}`).test(replyRoute),
    "app/api/generate-reply/route.ts の priorityOrderNote を変えたらここも直す");

  const brainCore = readFileSync("app/lib/brain-core.ts", "utf8");
  t("★ ブレインのプロンプトに『スモラAI』か『会話全体の戦略』がある",
    ROUTE_MARKERS.brain.some((m) => brainCore.includes(m)),
    "app/lib/brain-core.ts のプロンプト冒頭を変えたらここも直す");

  const aixTemplate = readFileSync("app/api/aix-template-generate/route.ts", "utf8");
  t("★ AIX テンプレ生成に『ハルシネーション絶対禁止』がある（返信文と混ざらない）",
    aixTemplate.includes(ROUTE_MARKERS.aix_template));

  // 実データ（llm_usage_logs の sys_head）そのままで判定を確かめる
  t("★ 実データ: 返信生成 → reply_generate",
    resolveRouteName(null, "【指示の優先順位（競合時はこの順で解決すること）】ハードゲート（内覧日時・見積・物件事実制約）> 場面と返信方針") === "reply_generate");
  t("★ 実データ: AIX テンプレ生成 → aix_template（返信文と混ざらない）",
    resolveRouteName(null, "【指示の優先順位（競合時はこの順で解決すること）】 ハルシネーション絶対禁止 > 役割") === "aix_template");
  t("★ 実データ: ブレイン → brain",
    resolveRouteName(null, "あなたはスモラAI。与えられた会話履歴を読んで、スタッフが次にすべき1アクションを2") === "brain");
  t("★ 実データ: 戦略の整理 → brain",
    resolveRouteName(null, "あなたは賃貸仲介（スモラ）の LINE 接客の「会話全体の戦略」を整理する担当です。") === "brain");
  t("★ 実データ: AIX 本文生成は action 名で分かれる（system が同じでも混ざらない）",
    resolveRouteName("property_send", "あなたはスモラ（賃貸仲介）のLINE営業担当です。 お客様へのLINE返信を") === "property_send");
  t("★ 実データ: 画像の読み取りは classify（そもそも画像なので対象外になる）",
    resolveRouteName(null, "以下の画像から初期費用情報を抽出してください。JSON形式のみ返答（説明文・") === "classify");
}

console.log("── Anthropic の形 → Azure（OpenAI 互換）の形");
{
  const body = {
    system: [{ type: "text", text: "あなたはスモラの担当者です" }, { type: "text", text: "追加の指示" }],
    messages: [{ role: "user", content: "初期費用はいくらですか？" }],
    max_tokens: 800, temperature: 0.3,
  };
  const o = toOpenAIBody(body, "DeepSeek-V4-Flash") as { model: string; messages: Array<{ role: string; content: string }>; max_tokens: number; temperature: number };
  t("system は先頭の1件にまとめる", o.messages[0].role === "system" && o.messages[0].content === "あなたはスモラの担当者です\n追加の指示");
  t("user が続く", o.messages[1].role === "user" && o.messages[1].content === "初期費用はいくらですか？");
  t("model はデプロイ名", o.model === "DeepSeek-V4-Flash");
  t("max_tokens / temperature が移る", o.max_tokens === 800 && o.temperature === 0.3);
}

console.log("── ★ 対象外はそのまま Anthropic へ（null を返す）");
{
  t("ストリーミングは対象外", toOpenAIBody({ stream: true, messages: [{ role: "user", content: "x" }] }, "m") === null);
  t("★ 画像つき（Vision）は対象外",
    toOpenAIBody({ messages: [{ role: "user", content: [{ type: "image" }, { type: "text", text: "この物件" }] }] }, "m") === null);
  t("messages が空なら対象外", toOpenAIBody({ messages: [] }, "m") === null);
  t("system だけで user が無ければ対象外", toOpenAIBody({ system: "x", messages: [] }, "m") === null);
  t("flattenContent: 画像ブロックがあれば null", flattenContent([{ type: "image" }]) === null);
}

console.log("── 応答は Anthropic の形に戻す（呼び出し側は違いに気付かない）");
{
  const r = fromOpenAIResponse({
    choices: [{ message: { content: "かしこまりました！！" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1234, completion_tokens: 56 },
  }, "DeepSeek-V4-Flash");
  t("content[0].text に本文", eq((r.content as Array<{ text: string }>)[0].text, "かしこまりました！！"));
  t("type/role が Anthropic と同じ", r.type === "message" && r.role === "assistant");
  t("★ usage が入る（llm_usage_logs がそのまま書ける）",
    eq(r.usage, { input_tokens: 1234, output_tokens: 56, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }));
  t("★ model が DeepSeek（あとで費用と品質を見分けられる）", r.model === "DeepSeek-V4-Flash");
  t("length で切れたら max_tokens", fromOpenAIResponse({ choices: [{ message: { content: "…" }, finish_reason: "length" }] }, "m").stop_reason === "max_tokens");
  t("応答が空でも落ちない", fromOpenAIResponse({}, "m").content !== undefined);
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
