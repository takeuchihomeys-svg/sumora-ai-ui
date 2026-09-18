// app/lib/bedrock-router.ts
// Anthropic 宛ての呼び出しを AWS Bedrock（DeepSeek）へ振り向ける層。
//
// 2026-09-19 竹内「このツールってクラウド経由でdeepsheekのAPI使えば費用かなり抑えれる可能性あるかな？」
//   → 「AWSのクラウド経由する」（お客様の個人情報を中国のサーバーに送らないため。DeepSeek はオープンウェイトなので
//      Bedrock（米国リージョン）でホストされた物を使える）
//
// 【なぜ fetch を包むのか】
//   LLM の呼び出しは 77 ファイルに散っていて、fetch で直接叩く所・SDK 経由の所が混在している。
//   既に instrumentation.ts が globalThis.fetch を2層（絵文字の片割れ除去・使用量の記録）で包んでいるので、
//   同じ出口に3層目を足せば**呼び出し側のコードを1行も変えずに**切り替えられる（設計知見「LLM 呼び出しの出口の型」）。
//
// 【安全側の既定（fail-closed）】
//   ・環境変数が1つでも欠けていたら**何もしない**（今までどおり Anthropic）
//   ・切り替えるのは LLM_BEDROCK_ACTIONS に書いた経路だけ（"all" で全部・空なら無効）
//   ・Bedrock が失敗したら Anthropic にフォールバックする（BEDROCK_FALLBACK=off で止められる）
//   ・使用量の記録（llm_usage_logs）は外側の層がそのまま書く。model 名で見分けられる
//
// 【対応している形】
//   Anthropic Messages API（system ブロック＋messages＋max_tokens）→ Bedrock Converse → Anthropic 形式の応答。
//   画像（Vision）と streaming は**対象外**（そのまま Anthropic へ流す）。

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { LLM_ACTION_HEADER } from "./llm-usage-recorder";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

export type BedrockRouterConfig = {
  region: string;
  modelId: string;
  /** 切り替える action（"all" なら全部）。空なら無効 */
  actions: Set<string>;
  fallbackToAnthropic: boolean;
};

/** 環境変数の形（テストから作った物も渡せるよう緩めにする。process.env もこの形に収まる） */
export type EnvLike = Record<string, string | undefined>;

/** 環境変数から設定を読む。欠けていたら null（＝何もしない） */
export function readBedrockConfig(env: EnvLike = process.env): BedrockRouterConfig | null {
  const region = (env.BEDROCK_REGION ?? "").trim();
  const modelId = (env.BEDROCK_DEEPSEEK_MODEL_ID ?? "").trim();
  const actionsRaw = (env.LLM_BEDROCK_ACTIONS ?? "").trim();
  const hasCreds = !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
  if (!region || !modelId || !actionsRaw || !hasCreds) return null;
  const actions = new Set(actionsRaw.split(",").map((s) => s.trim()).filter(Boolean));
  if (actions.size === 0) return null;
  return { region, modelId, actions, fallbackToAnthropic: (env.BEDROCK_FALLBACK ?? "on") !== "off" };
}

/** この呼び出しを Bedrock に回すか（action は呼び出し側が付ける x-sumora-llm-action） */
export function shouldRouteToBedrock(cfg: BedrockRouterConfig | null, action: string | null): boolean {
  if (!cfg) return false;
  if (cfg.actions.has("all")) return true;
  return !!action && cfg.actions.has(action);
}

type AnthropicBlock = { type?: string; text?: string };
type AnthropicMessage = { role?: string; content?: string | AnthropicBlock[] };
type AnthropicBody = {
  model?: string;
  system?: string | AnthropicBlock[];
  messages?: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
};

/** Anthropic の content（文字列 or ブロック配列）を平文にする。画像ブロックがあれば null（対象外） */
export function flattenContent(content: string | AnthropicBlock[] | undefined): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type && b.type !== "text") return null; // image 等は対象外
    if (typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/** Anthropic のリクエスト本文 → Bedrock Converse の引数。対象外なら null */
export function toConverseInput(body: AnthropicBody, modelId: string): {
  modelId: string;
  system?: Array<{ text: string }>;
  messages: Array<{ role: "user" | "assistant"; content: Array<{ text: string }> }>;
  inferenceConfig: { maxTokens?: number; temperature?: number };
} | null {
  if (body.stream) return null; // ストリーミングは対象外
  const systemText = flattenContent(body.system);
  if (systemText === null) return null;
  const messages: Array<{ role: "user" | "assistant"; content: Array<{ text: string }> }> = [];
  for (const m of body.messages ?? []) {
    const text = flattenContent(m.content);
    if (text === null) return null; // 画像つきは対象外
    const role = m.role === "assistant" ? "assistant" : "user";
    messages.push({ role, content: [{ text }] });
  }
  if (messages.length === 0) return null;
  return {
    modelId,
    ...(systemText ? { system: [{ text: systemText }] } : {}),
    messages,
    inferenceConfig: {
      ...(typeof body.max_tokens === "number" ? { maxTokens: body.max_tokens } : {}),
      ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    },
  };
}

/** Bedrock Converse の応答 → Anthropic Messages API の応答（呼び出し側は違いに気付かない） */
export function toAnthropicResponse(out: {
  output?: { message?: { content?: Array<{ text?: string }> } };
  usage?: { inputTokens?: number; outputTokens?: number };
  stopReason?: string;
}, modelId: string): Record<string, unknown> {
  const text = (out.output?.message?.content ?? []).map((c) => c?.text ?? "").join("");
  const stopMap: Record<string, string> = { end_turn: "end_turn", max_tokens: "max_tokens", stop_sequence: "stop_sequence" };
  return {
    id: `bedrock_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model: modelId,
    content: [{ type: "text", text }],
    stop_reason: stopMap[out.stopReason ?? "end_turn"] ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: out.usage?.inputTokens ?? 0,
      output_tokens: out.usage?.outputTokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

let client: BedrockRuntimeClient | null = null;
function getClient(region: string): BedrockRuntimeClient {
  if (!client) client = new BedrockRuntimeClient({ region });
  return client;
}

/** globalThis.fetch を包む（instrumentation.ts から。二重に包まない） */
let installed = false;
export function installBedrockRouter(env: EnvLike = process.env): boolean {
  if (installed) return true;
  const cfg = readBedrockConfig(env);
  if (!cfg) return false; // 設定が無ければ何もしない＝今までどおり Anthropic
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (!url || !url.startsWith(ANTHROPIC_MESSAGES_URL)) return original(input as RequestInfo, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const action = headers.get(LLM_ACTION_HEADER);
    if (!shouldRouteToBedrock(cfg, action)) return original(input as RequestInfo, init);

    let body: AnthropicBody | null = null;
    try { body = typeof init?.body === "string" ? JSON.parse(init.body) as AnthropicBody : null; } catch { body = null; }
    const converse = body ? toConverseInput(body, cfg.modelId) : null;
    if (!converse) return original(input as RequestInfo, init); // 画像・ストリーミング等は今までどおり

    const started = Date.now();
    try {
      const out = await getClient(cfg.region).send(new ConverseCommand(converse));
      const payload = toAnthropicResponse(out as Parameters<typeof toAnthropicResponse>[0], cfg.modelId);
      console.log("[bedrock-router]", JSON.stringify({ action, model: cfg.modelId, ms: Date.now() - started,
        in: (payload.usage as { input_tokens?: number })?.input_tokens, out: (payload.usage as { output_tokens?: number })?.output_tokens }));
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    } catch (e) {
      console.warn("[bedrock-router] failed:", String(e));
      if (!cfg.fallbackToAnthropic) throw e;
      return original(input as RequestInfo, init); // 失敗したら今までどおり Anthropic で返す
    }
  }) as typeof fetch;
  installed = true;
  console.log("[bedrock-router] installed", JSON.stringify({ region: cfg.region, modelId: cfg.modelId, actions: [...cfg.actions] }));
  return true;
}
