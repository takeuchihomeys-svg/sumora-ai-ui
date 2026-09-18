// app/lib/llm-alt-provider.ts
// Anthropic 宛ての呼び出しを、別のクラウド（Azure AI Foundry / AWS Bedrock）の DeepSeek へ振り向ける層。
//
// 2026-09-19 竹内「クラウド経由でdeepsheekのAPI使えば費用かなり抑えれる可能性あるかな？」
//   →「AWSのクラウド経由する」→「deep sheek V4.1をつかう」→「V4が使えるクラウドはあるか？」
//   → **V4 は Azure AI Foundry にあり（V4-Flash / V4-Pro）、AWS Bedrock には無い（V3.2 まで）**
//   →「この方向性でいく」（返信文 → 分類 → ブレインはシャドーで確かめてから、学習は Claude のまま）
//
// 【なぜ fetch を包むのか】
//   LLM の呼び出しは 77 ファイルに散っている（直接 fetch・SDK 経由が混在）。
//   instrumentation.ts が既に globalThis.fetch を2層（絵文字の片割れ除去・使用量の記録）で包んでいるので、
//   同じ出口に足せば**呼び出し側のコードを1行も変えずに**切り替えられる（設計知見「LLM 呼び出しの出口の型」）。
//
// 【安全側の既定（fail-closed）】
//   ・環境変数が欠けていたら**何もしない**（今までどおり Anthropic）
//   ・切り替えるのは LLM_ALT_ACTIONS に書いた経路だけ。**"all" は用意しない**（全部いっぺんに替えない）
//     返信生成・ブレインは action を持たないので、専用の名前で指定する（reply_generate / brain）
//   ・失敗したら Anthropic にフォールバック（LLM_ALT_FALLBACK=off で止められる）
//   ・画像（Vision）と streaming は対象外＝そのまま Anthropic へ
//   ・応答は Anthropic の形に戻すので、使用量の記録（llm_usage_logs）はそのまま動く（model 名で見分けられる）

import { LLM_ACTION_HEADER } from "./llm-usage-recorder";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

export type AltProvider = "azure" | "bedrock";
export type EnvLike = Record<string, string | undefined>;

export type AltProviderConfig = {
  provider: AltProvider;
  /** Azure: chat/completions の完全な URL（api-version まで含む） */
  endpoint: string;
  apiKey: string;
  /** Azure: デプロイ名（DeepSeek-V4-Flash 等）／Bedrock: モデル ID */
  model: string;
  /** 切り替える経路。空なら無効 */
  actions: Set<string>;
  fallbackToAnthropic: boolean;
};

/**
 * 環境変数から設定を読む。欠けていたら null（＝何もしない）。
 *   LLM_ALT_PROVIDER=azure
 *   AZURE_AI_ENDPOINT=https://xxx.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview
 *   AZURE_AI_KEY=...
 *   AZURE_AI_MODEL=DeepSeek-V4-Flash
 *   LLM_ALT_ACTIONS=property_send,condition_hearing   ← замена する経路だけを書く
 */
export function readAltConfig(env: EnvLike = process.env): AltProviderConfig | null {
  const provider = (env.LLM_ALT_PROVIDER ?? "").trim().toLowerCase();
  const actionsRaw = (env.LLM_ALT_ACTIONS ?? "").trim();
  if (!actionsRaw) return null;
  const actions = new Set(actionsRaw.split(",").map((s) => s.trim()).filter(Boolean));
  if (actions.size === 0) return null;
  const fallbackToAnthropic = (env.LLM_ALT_FALLBACK ?? "on") !== "off";
  if (provider === "azure") {
    const endpoint = (env.AZURE_AI_ENDPOINT ?? "").trim();
    const apiKey = (env.AZURE_AI_KEY ?? "").trim();
    const model = (env.AZURE_AI_MODEL ?? "").trim();
    if (!endpoint || !apiKey || !model) return null;
    return { provider: "azure", endpoint, apiKey, model, actions, fallbackToAnthropic };
  }
  if (provider === "bedrock") {
    const region = (env.BEDROCK_REGION ?? "").trim();
    const model = (env.BEDROCK_DEEPSEEK_MODEL_ID ?? "").trim();
    if (!region || !model || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return null;
    return { provider: "bedrock", endpoint: region, apiKey: "", model, actions, fallbackToAnthropic };
  }
  return null;
}

/**
 * この呼び出しを別クラウドに回すか。
 * action は呼び出し側が付ける x-sumora-llm-action。返信生成・ブレインは action を持たないので、
 * system プロンプトの先頭で見分けて仮の名前を割り当てる（下の resolveRouteName）。
 */
export function shouldRouteAlt(cfg: AltProviderConfig | null, routeName: string | null): boolean {
  if (!cfg || !routeName) return false;
  return cfg.actions.has(routeName);
}

/**
 * 切り替えの単位になる名前を決める。
 *   ・x-sumora-llm-action があればそれ（AIX の種類。AIX は名札を持っている）
 *   ・無ければ system の先頭で見分ける（返信生成とブレインは名札を持たないため）
 *
 * 2026-09-19 竹内の方針: 返信文 → 分類 → ブレイン の順に替える。名前を分けないと順番に替えられない。
 *
 * ⚠ 見分けの語は**実際のプロンプトの文面**に依存する。文面を変えると判定が外れて
 *   「気づかないうちに対象が変わる」（設計知見「静かに壊れる」）。
 *   → 語を定数にして、テストが実ファイル（line-reply-prompts.ts / brain-core.ts / route.ts）と
 *     照合する。プロンプトの冒頭を変えたらテストが落ちる。
 *
 * 2026-09-19 実データで見つけた誤判定: AIX テンプレート生成（/api/aix-template-generate）も
 *   「【指示の優先順位…」で始まるので、「指示の優先順位」だけで見ると**返信文と混ざる**。
 *   返信文の方は続きが「ハードゲート」、テンプレ生成は「ハルシネーション絶対禁止」なのでそこで分ける。
 */
export const ROUTE_MARKERS = {
  /** 返信生成（/api/generate-reply）の system 先頭。priorityOrderNote の1行目 */
  reply_generate: "ハードゲート",
  /** ブレイン（次の1アクション／会話全体の戦略） */
  brain: ["スモラAI", "会話全体の戦略"],
  /** AIX テンプレート生成（返信文とは別物・当面は替えない） */
  aix_template: "ハルシネーション絶対禁止",
} as const;

export function resolveRouteName(action: string | null, systemHead: string | null): string | null {
  if (action) return action;
  const head = (systemHead ?? "").slice(0, 120);
  if (!head) return "classify";
  if (ROUTE_MARKERS.brain.some((m) => head.includes(m))) return "brain";
  if (head.includes(ROUTE_MARKERS.aix_template)) return "aix_template";
  if (head.includes(ROUTE_MARKERS.reply_generate)) return "reply_generate";
  return "classify";
}

type AnthropicBlock = { type?: string; text?: string };
type AnthropicMessage = { role?: string; content?: string | AnthropicBlock[] };
export type AnthropicBody = {
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

/** Anthropic の本文 → OpenAI 互換（Azure AI Foundry）の本文。対象外なら null */
export function toOpenAIBody(body: AnthropicBody, model: string): Record<string, unknown> | null {
  if (body.stream) return null;
  const systemText = flattenContent(body.system);
  if (systemText === null) return null;
  const messages: Array<{ role: string; content: string }> = [];
  if (systemText) messages.push({ role: "system", content: systemText });
  for (const m of body.messages ?? []) {
    const text = flattenContent(m.content);
    if (text === null) return null; // 画像つきは対象外
    messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: text });
  }
  if (messages.filter((m) => m.role !== "system").length === 0) return null;
  return {
    model,
    messages,
    ...(typeof body.max_tokens === "number" ? { max_tokens: body.max_tokens } : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
  };
}

/** OpenAI 互換の応答 → Anthropic Messages API の応答（呼び出し側は違いに気付かない） */
export function fromOpenAIResponse(json: {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}, model: string): Record<string, unknown> {
  const text = json.choices?.[0]?.message?.content ?? "";
  const finish = json.choices?.[0]?.finish_reason ?? "stop";
  return {
    id: `alt_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: finish === "length" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: json.usage?.prompt_tokens ?? 0,
      output_tokens: json.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

/** Azure AI Foundry（OpenAI 互換）を呼ぶ */
async function callAzure(cfg: AltProviderConfig, body: AnthropicBody, originalFetch: typeof fetch): Promise<Response | null> {
  const payload = toOpenAIBody(body, cfg.model);
  if (!payload) return null;
  const res = await originalFetch(cfg.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": cfg.apiKey, Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(50_000),
  });
  if (!res.ok) throw new Error(`azure ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json() as Parameters<typeof fromOpenAIResponse>[0];
  return new Response(JSON.stringify(fromOpenAIResponse(json, cfg.model)), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

/** AWS Bedrock（Converse API）を呼ぶ。SDK は使う時だけ読み込む */
async function callBedrock(cfg: AltProviderConfig, body: AnthropicBody): Promise<Response | null> {
  if (body.stream) return null;
  const systemText = flattenContent(body.system);
  if (systemText === null) return null;
  const messages: Array<{ role: "user" | "assistant"; content: Array<{ text: string }> }> = [];
  for (const m of body.messages ?? []) {
    const text = flattenContent(m.content);
    if (text === null) return null;
    messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: [{ text }] });
  }
  if (messages.length === 0) return null;
  const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
  const client = new BedrockRuntimeClient({ region: cfg.endpoint });
  const out = await client.send(new ConverseCommand({
    modelId: cfg.model,
    ...(systemText ? { system: [{ text: systemText }] } : {}),
    messages,
    inferenceConfig: {
      ...(typeof body.max_tokens === "number" ? { maxTokens: body.max_tokens } : {}),
      ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    },
  }));
  const text = (out.output?.message?.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");
  const payload = {
    id: `alt_${Date.now().toString(36)}`, type: "message", role: "assistant", model: cfg.model,
    content: [{ type: "text", text }],
    stop_reason: out.stopReason === "max_tokens" ? "max_tokens" : "end_turn", stop_sequence: null,
    usage: {
      input_tokens: out.usage?.inputTokens ?? 0, output_tokens: out.usage?.outputTokens ?? 0,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    },
  };
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

/** globalThis.fetch を包む（instrumentation.ts から。二重に包まない） */
let installed = false;
export function installAltProvider(env: EnvLike = process.env): boolean {
  if (installed) return true;
  const cfg = readAltConfig(env);
  if (!cfg) return false; // 設定が無ければ何もしない＝今までどおり Anthropic
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (!url || !url.startsWith(ANTHROPIC_MESSAGES_URL)) return original(input as RequestInfo, init);

    let body: AnthropicBody | null = null;
    try { body = typeof init?.body === "string" ? JSON.parse(init.body) as AnthropicBody : null; } catch { body = null; }
    if (!body) return original(input as RequestInfo, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const routeName = resolveRouteName(headers.get(LLM_ACTION_HEADER), flattenContent(body.system));
    if (!shouldRouteAlt(cfg, routeName)) return original(input as RequestInfo, init);

    const started = Date.now();
    try {
      const res = cfg.provider === "azure" ? await callAzure(cfg, body, original) : await callBedrock(cfg, body);
      if (!res) return original(input as RequestInfo, init); // 画像・streaming 等は今までどおり
      console.log("[llm-alt]", JSON.stringify({ route: routeName, provider: cfg.provider, model: cfg.model, ms: Date.now() - started }));
      return res;
    } catch (e) {
      console.warn("[llm-alt] failed:", String(e));
      if (!cfg.fallbackToAnthropic) throw e;
      return original(input as RequestInfo, init); // 失敗したら今までどおり Anthropic で返す
    }
  }) as typeof fetch;
  installed = true;
  console.log("[llm-alt] installed", JSON.stringify({ provider: cfg.provider, model: cfg.model, actions: [...cfg.actions] }));
  return true;
}
