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

import { LLM_ACTION_HEADER, LLM_AUTO_SEND_HEADER, LLM_POST_APPLY_HEADER, LLM_CONVERSATION_HEADER, LLM_CUTOFF_HEADER, recordAltUsage, systemFullKey } from "./llm-usage-recorder";
import { DRAFT_SKIP_STATUSES } from "./conversation-status";
import { parseCutoffMark, countCutoffLeaks, type CutoffMark } from "./post-apply";
import { currentDeepseekScope } from "./deepseek-scope";
import { readTestMode, isTestModeAllowed, isTestModeTarget, testModeBlockedReason, type LlmTestMode } from "./llm-test-mode";

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
   * 自動返信オンの会話も切り替えるか。
   *
   * 2026-09-19 竹内「ここの自動返信の部分も慣れて問題なければ切り変えていくから、
   *   性質理解して穴を防げるようになったら切り替えていく方向性でいく形で」→ 既定 false で作った。
   *
   * 2026-09-21 竹内「自動返信の部分もDeepsheekに切り替える。そうすれば変にAPI消費することもないので」
   *   → **既定を true に反転**（竹内さんの判断）。
   *   ⚠ 環境変数では開けない（Vercel の環境変数は権限が無くて読み書きできない・403）。
   *     設計知見「環境変数は『入れれば動く』ではなく『入れなくても正しく動く』既定値にする」に従い、
   *     コードの既定を変える。戻す時は LLM_ALT_AUTO_SEND=off。
   *   ⚠ 切り替わるのは LLM_ALT_ACTIONS に書いてある経路だけ。ここは「自動返信だからという理由で
   *     止めるかどうか」の歯止めであって、対象を増やすものではない。
   *   ⚠ 申込以降（DRAFT_SKIP_STATUSES）の歯止めと、失敗時の Anthropic フォールバックはそのまま。
   */
  allowAutoSend: boolean;
  /**
   * テスト用の切り替え（llm-test-mode.ts・2026-09-26 竹内「この形でおこなう」）。
   * "deepseek-all" の時は、LLM_ALT_ACTIONS に書いていない呼び出しも**ブレイン以外は全部** DeepSeek に回し、失敗しても Claude に戻さない。
   * 本番（Vercel・NODE_ENV=production）では readTestMode が必ず null を返す＝常に null（今までどおり）。
   */
  testMode: LlmTestMode | null;
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
  // 2026-09-26 テスト用の切り替え（LLM_TEST_MODE=deepseek-all）。本番（Vercel・NODE_ENV=production）では必ず null＝下は今までと同じ
  const testMode = readTestMode(env);
  // テスト用の切り替えだけで LLM_ALT_PROVIDER が無い時は DeepSeek 本家（鍵は LLM_ALT_DEEPSEEK_KEY / DEEPSEEK_API_KEY）
  const provider = (env.LLM_ALT_PROVIDER ?? "").trim().toLowerCase() || (testMode ? "deepseek" : "");
  const actionsRaw = (env.LLM_ALT_ACTIONS ?? "").trim();
  if (!actionsRaw && !testMode) return null;
  const actions = new Set(actionsRaw.split(",").map((s) => s.trim()).filter(Boolean));
  if (actions.size === 0 && !testMode) return null;
  // 2026-09-23 竹内「これなら質落ちるから毎回の分析もクロードの方が良いね」:
  //   ブレインは**毎回の分析（brain_fresh）も会話全体の分析（brain_full）も Claude のまま**。既定では回さない。
  //   一度 DeepSeek に回して実測した結果（scripts/shadow-brain-deepseek.ts・10会話・同じ入力で両方を走らせた）:
  //     ・Claude との一致は action 9/10・段階 10/10・返信モード 9/10。費用は 1回 $0.054 → $0.007。
  //     ・しかし **DeepSeek 自身の揺れの方が大きい**（同じ入力の2回目との自分同士の一致 action 7/10・intent 4/10。
  //       Claude は 9/10・8/10）。一致率90%は実力差ではなく揺れの幅の中だった。
  //     ・返信の方向に **していない約束を書く**（家賃交渉を確認する／物件を仮押さえ 等）。竹内さんの
  //       「成約データにない創作文を入れない」に反する。一致率はこの壊れ方を一切捕まえない。
  //     ・返信の方向が空で返る回があった（10件中1件）。
  //   → 質を優先して Claude に戻す。試す時だけ LLM_ALT_ACTIONS に brain_fresh を書く（影の比較スクリプトはこれを使う）。
  //   詳しい数字は memory/dept_line_reply.md、判断の型は設計知見「モデルを替える前に『揺れ』を測る」
  const fallbackToAnthropic = (env.LLM_ALT_FALLBACK ?? "on") !== "off";
  // 2026-09-21 竹内「自動返信の部分もDeepsheekに切り替える」→ 既定 on。戻す時は LLM_ALT_AUTO_SEND=off
  const allowAutoSend = (env.LLM_ALT_AUTO_SEND ?? "on").trim().toLowerCase() !== "off";
  if (provider === "azure") {
    const endpoint = (env.AZURE_AI_ENDPOINT ?? "").trim();
    const apiKey = (env.AZURE_AI_KEY ?? "").trim();
    const model = (env.AZURE_AI_MODEL ?? "").trim();
    if (!endpoint || !apiKey || !model) return null;
    return { provider: "azure", endpoint, apiKey, model, actions, fallbackToAnthropic, allowAutoSend, testMode };
  }
  if (provider === "bedrock") {
    const region = (env.BEDROCK_REGION ?? "").trim();
    const model = (env.BEDROCK_DEEPSEEK_MODEL_ID ?? "").trim();
    if (!region || !model || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return null;
    return { provider: "bedrock", endpoint: region, apiKey: "", model, actions, fallbackToAnthropic, allowAutoSend, testMode };
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
    return { provider: "deepseek", endpoint: DEEPSEEK_ENDPOINT, apiKey, model, actions, fallbackToAnthropic, allowAutoSend, testMode };
  }
  return null;
}

/**
 * この呼び出しを別クラウドに回すか。
 * action は呼び出し側が付ける x-sumora-llm-action。返信生成・ブレインは action を持たないので、
 * system プロンプトの先頭で見分けて仮の名前を割り当てる（下の resolveRouteName）。
 */
/**
 * 物件の判断・読み取りの action（2026-09-25 竹内「分析 DeepSeek で必ず行う。クロードに切り替えない。物件判断のところ」）。
 * 今は全部 vision-alt-provider.callDeepSeekRead で直接 DeepSeek を呼び、この fetch の包みは通らない。
 * 将来この名札で Anthropic 宛てに書かれても、別クラウドに回した後は**失敗しても・変換できなくても Claude に倒さない**（LLM_ALT_FALLBACK に関係なく）。
 * お客様への返信（reply_generate）・AIX の本文（property_send / property_recommendation 等）・ブレインは入れない（今のまま）
 */
export const NO_CLAUDE_FALLBACK_ACTIONS: ReadonlySet<string> = new Set([
  "property_rank", "pickup_image_analysis", "pickup_image_analysis_auto", "condition_summary",
  "property_brain_image", "property_image_detail", "property_image_read",
  // 2026-09-25 検索の点検の見立て（search-audit-diagnose.ts・竹内「DeepSeek の API で行う」）
  "search_audit",
]);

export function shouldRouteAlt(cfg: AltProviderConfig | null, routeName: string | null, systemHead: string | null = null): boolean {
  if (!cfg || !routeName) return false;
  if (cfg.actions.has(routeName)) return true;
  // 2026-09-23: ブレインは層で名札を分けた（brain_fresh / brain_full）。設定に古い "brain" と書いてあれば両方を指す
  if (routeName.startsWith("brain_") && cfg.actions.has("brain")) return true;
  return routedByTestMode(cfg, routeName, systemHead);
}

/**
 * テスト用の切り替え（LLM_TEST_MODE=deepseek-all）**だけ**が理由で回すか。
 * ブレイン（brain_fresh / brain_full / 戦略の整理 / セーブデータ）は対象外（llm-test-mode.isBrainCall）。
 * 鍵を重ねる: 設定を読んだ時（readTestMode）＋ここで実行中の環境をもう一度（isTestModeAllowed(process.env)）。
 */
export function routedByTestMode(cfg: AltProviderConfig | null, routeName: string | null, systemHead: string | null = null): boolean {
  if (!cfg?.testMode || !routeName) return false;
  if (!isTestModeAllowed(process.env)) return false;
  return isTestModeTarget(cfg.testMode, routeName, systemHead);
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
 * 「DeepSeek に渡す時刻の線」の二重の鍵（純関数）。2026-09-26 竹内「申込の間の部分は DeepSeek に渡さず、切り替えたところ以降渡せば個人情報防げる」
 *   入口（返信生成・AIX）が線（post-apply.ts deepseekSafeCutoff）で材料を切り、印（ヘッダ x-sumora-llm-deepseek-cutoff か deepseek-scope の箱）を置く。
 *   出口はその印を見る:
 *     blocked                          … 回さない（申込中・判定が読めない・線より前の発言への返信）
 *     会話の呼び出し（会話 ID・箱あり）で印なし … 回さない（線を引かずに来た呼び出し＝入口の取りこぼし）
 *     会話の無い呼び出し（物件の読み取り等）   … 今までどおり
 */
export type CutoffGate = "route" | "claude:blocked" | "claude:no_mark";
export function cutoffGateDecision(o: { conversationId: string | null; inScope: boolean; mark: CutoffMark | null }): CutoffGate {
  if (o.mark?.kind === "blocked") return "claude:blocked";
  if ((o.conversationId || o.inScope) && !o.mark) return "claude:no_mark";
  return "route";
}

/** 出口の網に当てる本文（system と messages の文字だけ・画像は含まない） */
export function altBodyText(body: AnthropicBody): string {
  const parts: string[] = [flattenContent(body.system) ?? ""];
  for (const m of body.messages ?? []) parts.push(flattenContent(m.content) ?? "");
  return parts.join("\n");
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
  const will = shouldRouteAlt(cfg, resolveRouteName(action, null));
  // 2026-09-24 YUMA テストで見つけた穴（静かに壊れる）: 開発サーバでコードを直すと（HMR）globalThis.fetch が包み直され、
  //   ここでは「回す」と判断して名前も伏せるのに、実際の呼び出しは Claude に行っていた（DeepSeek のはずの12回が Sonnet）。
  //   回すと判断した時に包みが外れていれば包み直す。
  //   ⚠ 開発サーバだけ（2026-09-24 反証）: 本番では Next.js 16 が最初のリクエストで globalThis.fetch を自分の包み（patch-fetch・印を写さない）で
  //     上書きするので、一番外に印が無い＝「外れた」と誤判定して包みを二重にする。二重だと DeepSeek が失敗した時に
  //     外側→内側で DeepSeek を2回試し（最大 90秒×2）、alt_failed も2行になる。本番の包みは内側に残っていて回っているので触らない
  if (will && process.env.NODE_ENV !== "production" && !isAltFetchInstalled()) {
    console.warn("[llm-alt] fetch の包みが外れていたので包み直します（開発サーバの HMR 等）");
    installed = false;
    installAltProvider(env);
  }
  return will;
}

const ALT_FETCH_MARK = "__sumoraAltProvider";
function isAltFetchInstalled(): boolean {
  return !!(globalThis.fetch as unknown as Record<string, unknown>)[ALT_FETCH_MARK];
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
  /** Anthropic の構造化出力（final-check・suggest-template が json_schema で使う） */
  output_config?: { format?: { type?: string; schema?: unknown } };
};

/**
 * 2026-09-26 テスト用の切り替えで見つけた穴（YUMA 実測）: final-check は Anthropic の構造化出力（output_config の json_schema）で
 *   JSON を強制しているが、OpenAI 互換への変換はこれを捨てていた → DeepSeek は ```json で囲んだり `issues: []` と書いたりして
 *   JSON.parse が3本とも失敗（fail-open＝最終チェックが素通り）。
 *   → テスト用の切り替えの時だけ、スキーマを指示文に書き足して DeepSeek の JSON モード（response_format: json_object）で返させる。
 *   本番の経路（LLM_ALT_ACTIONS で回す物）は今までどおり触らない（本番の動きを変えない）。
 */
export function jsonSchemaInstruction(body: AnthropicBody): string | null {
  const f = body.output_config?.format;
  if (!f || f.type !== "json_schema" || f.schema == null) return null;
  return `\n\n【出力形式（必須）】次の JSON Schema に従う JSON オブジェクトを1つだけ出力する。\`\`\` で囲まない・前置きや説明を書かない。\n${JSON.stringify(f.schema)}`;
}

/** 応答の全体が ``` で囲まれていたら外す（テスト用の切り替えの読み切りの形だけで使う） */
export function stripWholeCodeFence(text: string): string {
  const m = text.trim().match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  return m ? m[1].trim() : text;
}

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
  opts: { disableThinking?: boolean; allowStream?: boolean; jsonSchemaToJsonMode?: boolean } = {},
): Record<string, unknown> | null {
  // 2026-09-19 竹内「返信の部分も deepseek に切り替えよかな」: 変換（createSseConverter）を
  //   用意した相手だけ 1文字ずつの形を通す。用意していない相手（Bedrock 等）は今までどおり対象外。
  if (body.stream && !opts.allowStream) return null;
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
  // テスト用の切り替えの時だけ: 構造化出力（json_schema）を JSON モード＋指示文に移す（jsonSchemaInstruction の説明）
  const schemaNote = opts.jsonSchemaToJsonMode && !body.stream ? jsonSchemaInstruction(body) : null;
  if (schemaNote) {
    if (messages[0]?.role === "system") messages[0].content += schemaNote;
    else messages.unshift({ role: "system", content: schemaNote.trim() });
  }
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
    ...(schemaNote ? { response_format: { type: "json_object" } } : {}),
    // 1文字ずつの形。usage は最後の chunk で受け取る（include_usage）
    ...(body.stream && opts.allowStream ? { stream: true, stream_options: { include_usage: true } } : {}),
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

// ── ストリーミングの変換（OpenAI 互換 → Anthropic）────────────────────────────
// 2026-09-19 竹内「返信の部分も deepseek に切り替えよかな」:
//   返信文の生成は .stream() で呼ぶので、今までは対象外にしていた（body.stream で null）。
//   ここを通すには、DeepSeek が返す OpenAI 形式の SSE を **Anthropic 形式の SSE に組み直す**必要がある
//   （呼び出し側は LangChain の ChatAnthropic で、Anthropic のイベント名しか読めない）。
//   文字が1文字ずつ出てくる見た目はそのまま保たれる。
//
// 変換は純関数（createSseConverter）にしてテストで固定する。ここがズレると
// 「生成が途中で止まる・空になる」という形で静かに壊れる。

/** Anthropic の SSE 1件分を組み立てる */
function sseEvent(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

/**
 * OpenAI 互換の SSE を Anthropic の SSE に変換する。
 *   push(line) … 受け取った 1 行を渡すと、出すべき Anthropic の SSE を返す（無ければ空配列）
 *   end()      … 終端のイベントを返す
 * usage は DeepSeek が最後の chunk（stream_options.include_usage）で返すので、message_delta に載せる。
 */
export function createSseConverter(model: string) {
  let started = false;
  let finish = "end_turn";
  let out = 0, inUncached = 0, inCached = 0;
  let closed = false;
  const startEvents = (): string[] => {
    started = true;
    return [
      sseEvent("message_start", {
        message: {
          id: `alt_${Date.now().toString(36)}`, type: "message", role: "assistant", model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }),
      sseEvent("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    ];
  };
  return {
    push(line: string): string[] {
      const t = line.trim();
      if (!t.startsWith("data:")) return [];
      const data = t.slice(5).trim();
      if (!data || data === "[DONE]") return [];
      let j: {
        choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
        usage?: { completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; prompt_tokens?: number };
      };
      try { j = JSON.parse(data); } catch { return []; }
      const res: string[] = [];
      if (j.usage) {
        out = j.usage.completion_tokens ?? out;
        inCached = j.usage.prompt_cache_hit_tokens ?? inCached;
        inUncached = j.usage.prompt_cache_miss_tokens ?? j.usage.prompt_tokens ?? inUncached;
      }
      const c = j.choices?.[0];
      if (c?.finish_reason) finish = c.finish_reason === "length" ? "max_tokens" : "end_turn";
      const text = c?.delta?.content;
      if (typeof text === "string" && text.length > 0) {
        if (!started) res.push(...startEvents());
        res.push(sseEvent("content_block_delta", { index: 0, delta: { type: "text_delta", text } }));
      }
      return res;
    },
    end(): string[] {
      if (closed) return [];
      closed = true;
      const res: string[] = [];
      if (!started) res.push(...startEvents()); // 1文字も来なかった時も形を壊さない
      res.push(sseEvent("content_block_stop", { index: 0 }));
      res.push(sseEvent("message_delta", { delta: { stop_reason: finish, stop_sequence: null }, usage: { output_tokens: out } }));
      res.push(sseEvent("message_stop", {}));
      return res;
    },
    usage: () => ({ input_tokens: inUncached, output_tokens: out, cache_read_input_tokens: inCached }),
  };
}

/**
 * OpenAI 互換のエンドポイント（Azure AI Foundry / DeepSeek 本家）を呼ぶ。
 * 本文の形が同じなので、宛先と鍵の渡し方だけ変えれば同じ変換処理が使える。
 */
async function callOpenAICompatible(
  cfg: AltProviderConfig,
  body: AnthropicBody,
  originalFetch: typeof fetch,
  // 2026-09-23 竹内「おこなう」: 1文字ずつの形は**読み切れなくても必ず1行残す**（errorType に切れ方を入れる）。
  //   旧: 最後まで読み切った時だけ書いていたので、途中で切れる・受け手が閉じると行が無く、費用の検算で数が合わなかった
  onUsage?: (u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number }, errorType: string | null) => void,
): Promise<Response | null> {
  // 1文字ずつの形は DeepSeek だけ通す（Anthropic の SSE に組み直す変換を用意しているため）
  const allowStream = cfg.provider === "deepseek";
  // テスト用の切り替えの時だけ構造化出力を JSON モードに移す（本番の経路は今までどおり）
  const testShape = !!cfg.testMode;
  const payload = toOpenAIBody(body, cfg.model, { disableThinking: cfg.provider === "deepseek", allowStream, jsonSchemaToJsonMode: testShape });
  if (!payload) return null;
  const res = await originalFetch(cfg.endpoint, {
    method: "POST",
    headers: cfg.provider === "deepseek"
      ? { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` }
      // Azure は api-key / Authorization のどちらでも通るので両方送る
      : { "Content-Type": "application/json", "api-key": cfg.apiKey, Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`${cfg.provider} ${res.status}: ${(await res.text()).slice(0, 200)}`);

  // ── 1文字ずつの形: OpenAI の SSE を読みながら Anthropic の SSE を書き出す ──
  if (body.stream && allowStream) {
    if (!res.body) throw new Error(`${cfg.provider}: streaming の本文が無い`);
    const conv = createSseConverter(cfg.model);
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const reader = res.body.getReader();
    // 記録は1回だけ（読み切り・途中で切れた・受け手が閉じた、のどれか1つ）
    let reported = false;
    const report = (errorType: string | null) => {
      if (reported) return;
      reported = true;
      try { onUsage?.(conv.usage(), errorType); } catch { /* 記録の失敗で応答を止めない */ }
    };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let buf = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            // 行が完成した分だけ処理する（chunk の途中で切れた行は次に持ち越す）
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              for (const ev of conv.push(line)) controller.enqueue(enc.encode(ev));
            }
          }
          for (const ev of conv.push(buf)) controller.enqueue(enc.encode(ev));
          for (const ev of conv.end()) controller.enqueue(enc.encode(ev));
          report(null);
        } catch (e) {
          // 途中で切れた時も形は閉じる（呼び出し側の parser を壊さない）。行も残す（読めた分の usage＋切れ方）
          try { for (const ev of conv.end()) controller.enqueue(enc.encode(ev)); } catch { /* 閉じ済み */ }
          console.warn("[llm-alt] stream error:", String(e));
          report("stream_error");
        } finally {
          try { controller.close(); } catch { /* 受け手が先に閉じた */ }
        }
      },
      cancel() {
        // 受け手（SDK・タイムアウト）が先に閉じた時。DeepSeek 側の読み込みも止め、行は残す
        reader.cancel().catch(() => { /* 既に終わっている */ });
        report("stream_cancelled");
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
  }
  const json = await res.json() as Parameters<typeof fromOpenAIResponse>[0];
  // テスト用の切り替えの時だけ: 全体が ```json で囲まれた応答を外す（Claude 前提の JSON.parse がそのまま読めるように）
  if (testShape && json.choices?.[0]?.message && typeof json.choices[0].message.content === "string") {
    json.choices[0].message.content = stripWholeCodeFence(json.choices[0].message.content);
  }
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
  if (installed && isAltFetchInstalled()) return true;
  // LLM_TEST_MODE が入っているのに効かせない時（本番・知らない値）は1行だけ知らせる。経路は今までどおり
  const blocked = testModeBlockedReason(env);
  if (blocked) console.warn("[llm-test-mode] 無視:", blocked);
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
    if (cfg.testMode && isPostApplyCall(headers)) console.warn("[llm-test-mode] 申込以降の会話は Claude のまま（個人情報の歯止め・YUMA は status_manual_back_at を最新に）");
    if (isPostApplyCall(headers)) return original(input as RequestInfo, init);
    const sysHead = flattenContent(body.system);
    // 記録の sys_key_full は Anthropic 宛ての行と同じハッシュ（全文をそのまま入れない・2026-09-26 まで 75,016字の全文が入っていた）
    const sysKeyFull = systemFullKey(body.system);
    const routeName = resolveRouteName(headers.get(LLM_ACTION_HEADER), sysHead);
    if (!shouldRouteAlt(cfg, routeName, sysHead)) return original(input as RequestInfo, init);

    // 2026-09-26 竹内「申込の間の部分は DeepSeek に渡さず、切り替えたところ以降渡せば個人情報防げる」: 二重の鍵。
    //   入口が線を引いた印（ヘッダ優先・無ければリクエストの箱）が無い会話の呼び出し・blocked は回さない。
    //   cut（線より後だけに切った）の時は、線より前のお客様の発言が本文に残っていないかを網で見る（入口の取りこぼしの最後の歯止め）
    const scope = currentDeepseekScope();
    const mark = parseCutoffMark(headers.get(LLM_CUTOFF_HEADER)) ?? scope?.mark ?? null;
    const convForGate = headers.get(LLM_CONVERSATION_HEADER) ?? scope?.conversationId ?? null;
    const gate = cutoffGateDecision({ conversationId: convForGate, inScope: !!scope, mark });
    if (gate !== "route") {
      console.warn("[llm-alt] 時刻の線の印なし・渡さない会話 → Claude のまま", JSON.stringify({ route: routeName, gate, conversationId: convForGate }));
      return original(input as RequestInfo, init);
    }
    if (mark?.kind === "cut") {
      let leaks = -1;
      try { leaks = countCutoffLeaks(altBodyText(body), scope?.netChunks ? await scope.netChunks() : []); } catch { leaks = -1; }
      if (leaks !== 0) {
        // -1 ＝ 網の材料が読めない（fail-closed）
        console.warn("[llm-alt] 線より前のお客様の発言が本文に残っている → Claude のまま", JSON.stringify({ route: routeName, leaks, conversationId: convForGate }));
        return original(input as RequestInfo, init);
      }
    }
    // 開発環境だけ: DeepSeek に送る本文を書き出す（線より前の中身が入っていないかを目で確かめる用・本番では VERCEL_ENV が付くので動かない）
    if (process.env.DEBUG_PROMPT_DIR && !process.env.VERCEL_ENV) {
      try {
        const fs = await import("node:fs");
        fs.writeFileSync(`${process.env.DEBUG_PROMPT_DIR}/alt-${routeName}-${Date.now()}.txt`, `mark=${mark ? JSON.stringify(mark) : "none"} conversation=${convForGate ?? "-"}\n\n${altBodyText(body)}`, "utf8");
      } catch { /* 書けなくても止めない */ }
    }

    const started = Date.now();
    const conversationId = headers.get(LLM_CONVERSATION_HEADER);
    try {
      const writeUsage = (usage: Record<string, number>, ms: number, errorType: string | null = null) => recordAltUsage({
        model: cfg.model, action: routeName, conversationId,
        usage, status: 200, errorType, durationMs: ms, stream: !!body.stream,
        sysHead, sysKeyFull, maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : null,
      });
      const res = cfg.provider === "bedrock"
        ? await callBedrock(cfg, body)
        // 1文字ずつの形は応答を読み切ってから usage が分かるので、コールバックで受ける（切れた時も errorType 付きで1行）
        : await callOpenAICompatible(cfg, body, original, (u, errorType) => writeUsage(u as unknown as Record<string, number>, Date.now() - started, errorType));
      if (!res) {
        // 物件の判断・読み取りは変換できなくても Claude に倒さない（呼び出し側が「読み取れなかった」の印を付ける）
        if (routeName && NO_CLAUDE_FALLBACK_ACTIONS.has(routeName)) throw new Error(`${routeName}: DeepSeek に送れない形（Claude には倒さない）`);
        // テスト用の切り替えでも画像つきは DeepSeek（文字だけ）に送れないので Claude のまま。ログで分かるようにする
        if (cfg.testMode) console.warn("[llm-test-mode] DeepSeek に送れない形（画像つき等）→ Claude のまま", JSON.stringify({ route: routeName }));
        return original(input as RequestInfo, init); // 画像等は今までどおり
      }
      const ms = Date.now() - started;
      console.log("[llm-alt]", JSON.stringify({ route: routeName, provider: cfg.provider, model: cfg.model, stream: !!body.stream, ms, ...(cfg.testMode ? { testMode: cfg.testMode } : {}) }));
      // 2026-09-19 本番の検証で見つけた穴: fetch の出口の記録は Anthropic 宛てだけを見るので、
      //   別クラウドに回った分は1行も残らなかった（費用も質も後から追えない）。ここで自分で書く。
      //   1文字ずつの形は上のコールバックで書くので、ここでは読み切りの形だけ
      if (!body.stream) {
        try {
          const clone = res.clone();
          clone.json().then((j: { usage?: Record<string, number> }) => writeUsage(j.usage ?? {}, ms)).catch(() => { });
        } catch { /* 記録の失敗で応答を止めない */ }
      }
      return res;
    } catch (e) {
      console.warn("[llm-alt] failed:", String(e));
      // 失敗も1行残す（フォールバックの回数が後から数えられる）
      recordAltUsage({
        model: cfg.model, action: routeName, conversationId, usage: {},
        status: 0, errorType: "alt_failed", durationMs: Date.now() - started,
        sysHead, sysKeyFull, maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : null,
      });
      if (!cfg.fallbackToAnthropic) throw e;
      // 2026-09-26 テスト用の切り替えの間は**失敗しても Claude に戻さない**（失敗は失敗として出す）。
      //   理由: 戻すと、費用が黙って Claude に漏れる＋「DeepSeek で回したつもりの結果」が実は Claude の結果になり、試行錯誤の比較が混ざる。
      //   最終チェック等の呼び出し側はそれぞれ失敗時の扱い（fail-open 等）を持っているので、テストではそれがそのまま見える。
      //   本番（testMode は常に null）はここを通らない＝今までどおり Anthropic にフォールバック
      if (cfg.testMode) throw e;
      if (routeName && NO_CLAUDE_FALLBACK_ACTIONS.has(routeName)) throw e; // 物件の判断・読み取りは Claude に倒さない
      return original(input as RequestInfo, init); // 失敗したら今までどおり Anthropic で返す
    }
  }) as typeof fetch;
  (globalThis.fetch as unknown as Record<string, unknown>)[ALT_FETCH_MARK] = true;
  installed = true;
  console.log("[llm-alt] installed", JSON.stringify({ provider: cfg.provider, model: cfg.model, actions: [...cfg.actions], ...(cfg.testMode ? { testMode: cfg.testMode } : {}) }));
  if (cfg.testMode) console.warn(`[llm-test-mode] ${cfg.testMode}: ブレイン以外の Claude 呼び出しを ${cfg.provider}（${cfg.model}）に回す・失敗しても Claude に戻さない（ローカル専用）`);
  return true;
}
