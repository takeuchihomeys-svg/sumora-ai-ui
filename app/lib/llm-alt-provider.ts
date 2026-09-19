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

import { LLM_ACTION_HEADER, LLM_AUTO_SEND_HEADER, LLM_POST_APPLY_HEADER } from "./llm-usage-recorder";
import { DRAFT_SKIP_STATUSES } from "./conversation-status";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

export type AltProvider = "azure" | "bedrock" | "deepseek";

/** DeepSeek 本家 API（OpenAI 互換）。Azure と同じ変換処理がそのまま使える */
export const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
/**
 * 文生成の既定は **deepseek-v4-pro**（2026-09-19 竹内「deepseek-v4-proで文生成した方が良いね V4.1よりも」）。
 *
 * 【なぜ安い方（deepseek-flash = V4.1-Flash）にしないか】
 *   AIX の文生成を実測（30日118回）で見積もると 今の Sonnet $8.46 → Pro $3.46 / Flash $0.78。
 *   **差は月 $2.7 しかない**ので、お客様に送る文の質を優先する方が合理的。
 *
 * 【正直な但し書き】
 *   deepseek-v4-pro は V4-Pro-0813 ＝ **V4 世代**で、deepseek-flash（V4.1）より半世代古い。
 *   「新しい方が良い」とは限らず、接客文のような含みのある文はモデルが大きい方が有利なことが多い、
 *   というのが Pro を選ぶ理由。実データで比べられるようになったら測り直す。
 */
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-pro";
/** もう一方（安いが小さい）。DEEPSEEK_MODEL で切り替えられる */
export const DEEPSEEK_FLASH_MODEL = "deepseek-flash";
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
  /**
   * 自動返信オンの会話も切り替えるか（既定 false）。
   * 2026-09-19 竹内「ここの自動返信の部分も慣れて問題なければ切り変えていくから、
   *   性質理解して穴を防げるようになったら切り替えていく方向性でいく形で」
   * → 道は残すが**既定は必ず Claude**。LLM_ALT_AUTO_SEND=on にした時だけ開く。
   */
  allowAutoSend: boolean;
};

/**
 * 環境変数から設定を読む。欠けていたら null（＝何もしない）。
 *   LLM_ALT_PROVIDER=azure
 *   AZURE_AI_ENDPOINT=https://<リソース名>.services.ai.azure.com/openai/v1/chat/completions
 *   AZURE_AI_KEY=...
 *   AZURE_AI_MODEL=DeepSeek-V4-Flash   ← Foundry の「デプロイ名」（モデル名とは別物）
 *   LLM_ALT_ACTIONS=property_send,condition_hearing   ← 切り替える経路だけを書く
 *
 * ⚠ エンドポイントは「openai/v1」の経路（api-version を付けない・暗黙のバージョン管理）。
 *   2026-09-19 に Microsoft Learn で確認。古い「models/chat/completions?api-version=...」も
 *   まだ動くが、api-version を書き間違えると 404 になるので v1 の方を使う。
 *   .openai.azure.com と .services.ai.azure.com のどちらのホストでも同じものを指す。
 *   鍵は Authorization: Bearer でも api-key でも通るので、下の callAzure は両方を送っている。
 */
export function readAltConfig(env: EnvLike = process.env): AltProviderConfig | null {
  const provider = (env.LLM_ALT_PROVIDER ?? "").trim().toLowerCase();
  const actionsRaw = (env.LLM_ALT_ACTIONS ?? "").trim();
  if (!actionsRaw) return null;
  const actions = new Set(actionsRaw.split(",").map((s) => s.trim()).filter(Boolean));
  if (actions.size === 0) return null;
  const fallbackToAnthropic = (env.LLM_ALT_FALLBACK ?? "on") !== "off";
  // 自動返信は既定で**必ず Claude**。明示的に on にした時だけ開く（人の目を通さずに送るため）
  const allowAutoSend = (env.LLM_ALT_AUTO_SEND ?? "off").trim().toLowerCase() === "on";
  if (provider === "azure") {
    const endpoint = (env.AZURE_AI_ENDPOINT ?? "").trim();
    const apiKey = (env.AZURE_AI_KEY ?? "").trim();
    const model = (env.AZURE_AI_MODEL ?? "").trim();
    if (!endpoint || !apiKey || !model) return null;
    return { provider: "azure", endpoint, apiKey, model, actions, fallbackToAnthropic, allowAutoSend };
  }
  if (provider === "bedrock") {
    const region = (env.BEDROCK_REGION ?? "").trim();
    const model = (env.BEDROCK_DEEPSEEK_MODEL_ID ?? "").trim();
    if (!region || !model || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return null;
    return { provider: "bedrock", endpoint: region, apiKey: "", model, actions, fallbackToAnthropic, allowAutoSend };
  }
  // DeepSeek 本家。OpenAI 互換なので Azure と同じ変換（toOpenAIBody / fromOpenAIResponse）で通る。
  // 既に DEEPSEEK_API_KEY が物件評価・駅名解決で使われているので、鍵はそれを流用する。
  //
  // 2026-09-19 竹内「deepseek-v4-proで文生成した方が良いね」→ 既定は deepseek-v4-pro。
  //   料金（1M あたり・混雑時は倍）
  //     deepseek-v4-pro : 一致 $0.022 / 不一致 $0.66 / 出力 $1.98
  //     deepseek-flash  : 一致 $0.003 / 不一致 $0.15 / 出力 $0.6（V4.1・1M コンテキスト）
  //   ※ 旧称の deepseek-chat も通るが、どの版かが名前から分からないので既定にしない
  //
  // 鍵は LLM_ALT_DEEPSEEK_KEY が優先、無ければ DEEPSEEK_API_KEY。
  // 2026-09-19 竹内「AIX用と返信用分けた方が良いかな？」:
  //   DEEPSEEK_API_KEY は既に物件評価・駅名解決が使っており、そのまま使うと費用が混ざる。
  //   DeepSeek のキャッシュはアカウント単位なので**鍵を分けてもキャッシュは共有される**（分けて損がない）。
  if (provider === "deepseek") {
    const apiKey = (env.LLM_ALT_DEEPSEEK_KEY ?? env.DEEPSEEK_API_KEY ?? "").trim();
    const model = (env.DEEPSEEK_MODEL ?? DEEPSEEK_DEFAULT_MODEL).trim();
    if (!apiKey || !model) return null;
    return { provider: "deepseek", endpoint: DEEPSEEK_ENDPOINT, apiKey, model, actions, fallbackToAnthropic, allowAutoSend };
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

/**
 * 自動返信オンの会話の下書きか（呼び出し側が x-sumora-llm-auto-send: 1 を付ける）。
 * 2026-09-19 竹内「自動返信モードのお客さんの返信はクロードのAPI使う形でいく」。
 * **この印がある呼び出しは、LLM_ALT_ACTIONS に何を書いていても Claude のまま**（人の目を通さずに送るため）。
 */
export function isAutoSendCall(headers: Headers): boolean {
  const v = (headers.get(LLM_AUTO_SEND_HEADER) ?? "").trim();
  return v === "1" || v.toLowerCase() === "true";
}

/**
 * 申込以降の会話か（呼び出し側が x-sumora-llm-post-apply: 1 を付ける）。
 * 2026-09-19 竹内「申込以降は渡さなくて大丈夫、申込までのツールなので」
 *   申込フェーズ以降は個人情報（本人確認書類・申込書・勤務先・年収・保証人）が集中するうえ、
 *   このツールの仕事は申込までなので、別クラウドに回す必要がそもそも無い。
 * **この印がある呼び出しは、LLM_ALT_ACTIONS に何を書いていても Claude のまま**（スイッチは用意しない）。
 */
export function isPostApplyCall(headers: Headers): boolean {
  const v = (headers.get(LLM_POST_APPLY_HEADER) ?? "").trim();
  return v === "1" || v.toLowerCase() === "true";
}

/**
 * 状態が「申込以降」か。判定は conversation-status.DRAFT_SKIP_STATUSES を正とする
 * （同じ事実を2か所に置かない。あちらは「自動下書きを作らない状態」で、集合は同じ）。
 */
export function isPostApplyStatus(status: string | null | undefined): boolean {
  return DRAFT_SKIP_STATUSES.has((status ?? "").trim());
}

/**
 * この呼び出しは今の設定で別クラウドに回るか。**呼び出し側が「マスクするか」を決めるために使う**。
 *
 * 2026-09-19 竹内「お客さんの本名や電話番号は絶対にマスキングするように」:
 *   マスクは外に出す時だけ掛ける。Claude に行く時は1バイトも変えない
 *   （常にマスクすると、今まで積み上げた品質が全経路で一度に変わってしまう）。
 * fetch の出口（下の歯止め）と同じ条件をここでも見るので、判断がズレない。
 */
export function willRouteAlt(
  action: string | null,
  opts: { postApply?: boolean; autoSend?: boolean } = {},
  env: EnvLike = process.env,
): boolean {
  if (opts.postApply) return false;
  const cfg = readAltConfig(env);
  if (!cfg) return false;
  if (opts.autoSend && !cfg.allowAutoSend) return false;
  return shouldRouteAlt(cfg, resolveRouteName(action, null));
}

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
  /** AIX の callClaude は {type:"disabled"} を送っている。DeepSeek も同じ形を受け取る */
  thinking?: { type: "disabled" | "enabled" };
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

/**
 * Anthropic の本文 → OpenAI 互換（Azure AI Foundry / DeepSeek 本家）の本文。対象外なら null。
 *
 * 2026-09-19 実際に叩いて分かったこと（scripts/check-deepseek.ts）:
 *   **DeepSeek V4 は思考モードが既定でオン**（effort は high）。思考は reasoning_content に入り、
 *   本文（content）とは別だが、**max_tokens は思考ぶんも食う**。max_tokens=64 で試したら
 *   思考だけで使い切って**本文が空**になった。AIX の max_tokens は 256〜1500 なので、
 *   そのままだと空の下書きが返ることがある。
 *   → DeepSeek 宛ては thinking:{type:"disabled"} を送る。
 *     AIX の callClaude は元々 Anthropic に thinking:{type:"disabled"} を送っており、
 *     変換でそれを捨てていた＝**元からある意図をそのまま通す**形にする。
 *   ※ Azure には付けない（知らない項目で 400 を返す相手がいるため）。
 */
export function toOpenAIBody(
  body: AnthropicBody,
  model: string,
  opts: { disableThinking?: boolean } = {},
): Record<string, unknown> | null {
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
  // 呼び出し側（AIX の callClaude）が Anthropic に送っている thinking をそのまま尊重する。
  // 指定が無い時も DeepSeek 宛ては切る（既定オンなので、黙って max_tokens を食われて本文が空になる）
  const thinking = opts.disableThinking
    ? (body.thinking?.type === "enabled" ? body.thinking : { type: "disabled" as const })
    : undefined;
  return {
    model,
    messages,
    ...(typeof body.max_tokens === "number" ? { max_tokens: body.max_tokens } : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

/**
 * OpenAI 互換の応答 → Anthropic Messages API の応答（呼び出し側は違いに気付かない）。
 *
 * 2026-09-19 竹内「プロンプトキャッシュも使う」:
 *   DeepSeek のコンテキストキャッシュは**既定でオン・コードの変更は不要**（api-docs.deepseek.com/guides/kv_cache）。
 *   前置きが前回と一致した分だけ自動で安くなる（deepseek-flash: 一致 $0.003/M・不一致 $0.15/M ＝ **50倍差**）。
 *   応答の usage に prompt_cache_hit_tokens / prompt_cache_miss_tokens が入るので、
 *   Anthropic の cache_read_input_tokens に移して llm_usage_logs に残す。
 *   → 移さないと「全部が新規入力」として記録され、**キャッシュが効いているか確かめられない**。
 */
export function fromOpenAIResponse(json: {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number; completion_tokens?: number;
    prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number;
  };
}, model: string): Record<string, unknown> {
  const text = json.choices?.[0]?.message?.content ?? "";
  const finish = json.choices?.[0]?.finish_reason ?? "stop";
  const u = json.usage;
  const cacheHit = u?.prompt_cache_hit_tokens ?? 0;
  // DeepSeek は prompt_tokens = 一致 + 不一致。新規入力は「不一致」の方（無ければ従来どおり prompt_tokens）
  const uncached = u?.prompt_cache_miss_tokens ?? u?.prompt_tokens ?? 0;
  return {
    id: `alt_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: finish === "length" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: uncached,
      output_tokens: u?.completion_tokens ?? 0,
      // DeepSeek は「書き込み」を別課金しない（一致/不一致の2つだけ）
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cacheHit,
    },
  };
}

/**
 * OpenAI 互換のエンドポイント（Azure AI Foundry / DeepSeek 本家）を呼ぶ。
 * 本文の形が同じなので、宛先と鍵の渡し方だけ変えれば同じ変換処理が使える。
 */
async function callOpenAICompatible(cfg: AltProviderConfig, body: AnthropicBody, originalFetch: typeof fetch): Promise<Response | null> {
  const payload = toOpenAIBody(body, cfg.model, { disableThinking: cfg.provider === "deepseek" });
  if (!payload) return null;
  const res = await originalFetch(cfg.endpoint, {
    method: "POST",
    headers: cfg.provider === "deepseek"
      ? { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` }
      // Azure は api-key / Authorization のどちらでも通るので両方送る
      : { "Content-Type": "application/json", "api-key": cfg.apiKey, Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(50_000),
  });
  if (!res.ok) throw new Error(`${cfg.provider} ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
    // 2026-09-19 竹内「自動返信モードのお客さんの返信はクロードのAPI使う形でいく」:
    //   人の目を通さずに送る文なので、既定では**何を指定していても**別のクラウドに回さない（最優先の歯止め）。
    //   竹内「慣れて問題なければ切り変えていく」→ LLM_ALT_AUTO_SEND=on にした時だけ開く
    if (isAutoSendCall(headers) && !cfg.allowAutoSend) return original(input as RequestInfo, init);
    // 2026-09-19 竹内「申込以降は渡さなくて大丈夫、申込までのツールなので」:
    //   申込フェーズ以降は個人情報（本人確認書類・申込書・勤務先・年収・保証人）が集中し、
    //   かつこのツールの仕事は申込までなので、回す必要がそもそも無い。**スイッチは用意しない**
    if (isPostApplyCall(headers)) return original(input as RequestInfo, init);
    const routeName = resolveRouteName(headers.get(LLM_ACTION_HEADER), flattenContent(body.system));
    if (!shouldRouteAlt(cfg, routeName)) return original(input as RequestInfo, init);

    const started = Date.now();
    try {
      const res = cfg.provider === "bedrock"
        ? await callBedrock(cfg, body)
        : await callOpenAICompatible(cfg, body, original);
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
