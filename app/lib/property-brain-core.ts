import Anthropic from "@anthropic-ai/sdk";
import {
  buildPropertyBrainContext,
  formatContextForPrompt,
  type PropertyBrainContext,
  type CustomerConditions,
  type SentPropertyRecord,
} from "./property-brain-rag";

// ── 出力型定義 ───────────────────────────────────────────────────────────────

// Chrome拡張が直接受け取れる検索パラメータ
export interface SearchParameters {
  areaMode: "station" | "ward" | "both" | "auto";
  stationNames: string[];   // 駅名リスト
  cityCodes: string[];      // リアプロ市区コード
  routeIds: string[];       // リアプロ路線ID
  rentMin: number | null;
  rentMax: number | null;
  floorPlans: string[];     // 間取りリスト
  floorAreaMin: number | null;
  walkMinutes: number | null;
  buildingAgeMax: number | null;
  petAllowed: boolean | null;
  // 過去送付済み（重複送付防止）
  excludePropertyKeys: string[];  // "物件名_号室" 形式
}

// 条件診断
export interface ConditionDiagnosis {
  issues: string[];    // 矛盾・不足・注意点
  searchReadiness: "ready" | "needs_more_info" | "contradictory";
}

// ブレイン出力
export interface PropertyBrainOutput {
  searchParams: SearchParameters;
  diagnosis: ConditionDiagnosis;
  recommendedAction: "search_now" | "ask_more" | "hold";
  reasoning: string;
}

// ── 静的プロンプト（prompt cache 対象） ──────────────────────────────────────
// ルール・スコアリング基準・出力フォーマット定義は変わらないため完全静的
const STATIC_SYSTEM_PROMPT = `あなたは大阪府の賃貸不動産検索専門AIです。
顧客の条件・送付履歴・エリア知識を受け取り、最適な物件検索パラメータと条件診断を返します。

【出力フォーマット】JSONのみ（説明文不要）:
{
  "searchParams": {
    "areaMode": "station" | "ward" | "both" | "auto",
    "stationNames": [],
    "cityCodes": [],
    "routeIds": [],
    "rentMin": null,
    "rentMax": null,
    "floorPlans": [],
    "floorAreaMin": null,
    "walkMinutes": null,
    "buildingAgeMax": null,
    "petAllowed": null,
    "excludePropertyKeys": []
  },
  "diagnosis": {
    "issues": [],
    "searchReadiness": "ready" | "needs_more_info" | "contradictory"
  },
  "recommendedAction": "search_now" | "ask_more" | "hold",
  "reasoning": "判断理由（1〜2文）"
}

【条件整理ルール（静的）】
1. エリアモード判定:
   - 駅名のみ → "station" / 市区のみ → "ward" / 混在 → "both" / 不明 → "auto"
   - エリア知識（RAG）の resolvedStations があれば "station" を優先
2. 家賃矛盾チェック:
   - rentMin > rentMax → issues に追加、searchReadiness = "contradictory"
   - rentMax が未設定かつ rentMin も未設定 → issues に "家賃条件未設定" を追加
3. 間取り正規化:
   - "1K・1DK" → ["1K","1DK"] / "2LDK以上" → ["2LDK","3LDK","4LDK"]
   - "ワンルーム" → ["1R"] / "ファミリー" → ["2LDK","3LDK","4LDK","3DK","4DK"]
4. 物件除外（重複送付防止）:
   - 送付履歴の全物件を "物件名_号室" 形式で excludePropertyKeys に含める
   - ただし recruitment_status = "open" かつ customer_reaction = "interested" は再送可（除外しない）
5. 検索推奨判定:
   - 最終送付から7日以上 or 送付なし → "search_now"
   - 連続未返信2件以上（propertySendCount >= 2）→ "hold"（催促リスク）
   - それ以外 → 条件が揃っていれば "search_now"、未設定多数なら "ask_more"
6. 条件不足の検出:
   - エリア未設定 → issues に追加
   - 家賃上限のみで下限なしは許容（issues には追加しない）

【スコアリング基準（物件選定時の参考）】
- 顧客が "interested" を示した物件の条件（家賃帯・エリア・間取り）を優先
- "rejected" 物件の共通点をNGパターンとして認識
- 同じ物件名+号室への重複送付は禁止（ただし上記4の例外あり）

【エリアコード参照（静的）】
areaMode="ward" のとき cityCodes に含めるリアプロコードは resolve-area API が担当。
このブレインは searchParams.cityCodes を空で返してよい（API呼び出しで補完される）。`;

// ── 動的コンテキスト構築 ────────────────────────────────────────────────────
function buildDynamicPrompt(ctx: PropertyBrainContext): string {
  const contextText = formatContextForPrompt(ctx);

  // 送付履歴から除外キーを計算（静的ルール4をブレインに事前提示）
  const excludeHint = ctx.sentHistory
    .filter(s =>
      !(s.recruitmentStatus === "open" && s.customerReaction === "interested")
    )
    .map(s => `${s.propertyName}_${s.roomNo}`)
    .join(", ");

  return (
    contextText +
    (excludeHint
      ? `\n\n【除外候補（重複防止）】\n${excludeHint}`
      : "") +
    "\n\n上記を踏まえて検索パラメータと診断を返してください。"
  );
}

// ── 送付日数ユーティリティ ───────────────────────────────────────────────────
function daysSinceLastSent(lastSentAt: string | null): number {
  if (!lastSentAt) return 999;
  const diff = Date.now() - new Date(lastSentAt).getTime();
  return Math.floor(diff / 86_400_000);
}

// ── メイン: 検索パラメータ生成 ──────────────────────────────────────────────
export async function runPropertyBrain(
  customerId: string
): Promise<PropertyBrainOutput | null> {

  // Phase 1: RAGコンテキスト組み立て
  const ctx = await buildPropertyBrainContext(customerId);
  if (!ctx) return null;

  // hold 判定はAI呼び出し前にルールベースで先行判断（コスト節約）
  const daysSince = daysSinceLastSent(ctx.customer.lastPropertySentAt);
  if (ctx.customer.propertySendCount >= 2 && daysSince < 3) {
    return {
      searchParams: buildFallbackParams(ctx),
      diagnosis: {
        issues: [`連続未返信${ctx.customer.propertySendCount}件。催促リスクのため検索を保留。`],
        searchReadiness: "needs_more_info",
      },
      recommendedAction: "hold",
      reasoning: `連続未返信が${ctx.customer.propertySendCount}件続いているため、一旦様子見を推奨。`,
    };
  }

  // Phase 2: Claude Sonnet に渡す
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultHeaders: { "anthropic-beta": "prompt-caching-2024-07-31" },
  });

  const dynamicPrompt = buildDynamicPrompt(ctx);

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: STATIC_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    messages: [{ role: "user", content: dynamicPrompt }],
  });

  const raw = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";

  // JSON抽出（```json ブロック対応）
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    console.error("[property-brain] JSON parse error. raw:", raw.slice(0, 200));
    return null;
  }

  let parsed: PropertyBrainOutput;
  try {
    parsed = JSON.parse(jsonMatch[1]);
  } catch {
    console.error("[property-brain] JSON.parse failed:", jsonMatch[1].slice(0, 200));
    return null;
  }

  return parsed;
}

// ── フォールバック: AI呼び出しをスキップして最低限のパラメータを返す ──────────
function buildFallbackParams(ctx: PropertyBrainContext): SearchParameters {
  const c = ctx.customer;
  return {
    areaMode: (c.areaMode as SearchParameters["areaMode"]) ?? "auto",
    stationNames: ctx.areaKnowledge.resolvedStations,
    cityCodes: [],
    routeIds: [],
    rentMin: c.rentMin,
    rentMax: c.rentMax,
    floorPlans: c.floorPlan ? c.floorPlan.split(/[・、,]/).map(s => s.trim()) : [],
    floorAreaMin: c.floorAreaMin,
    walkMinutes: c.walkMinutes,
    buildingAgeMax: c.buildingAge,
    petAllowed: c.pet,
    excludePropertyKeys: ctx.sentHistory.map(s => `${s.propertyName}_${s.roomNo}`),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 条件更新ブレイン: お客さんのメッセージから条件変更を検出してDBに反映する
// Haiku（extractConditionsFromCasualReply）が明示条件を担当。
// このブレインは「暗黙・相対・文脈依存」の条件変更を Sonnet-5 で補完する。
// ════════════════════════════════════════════════════════════════════════════

export interface ConditionUpdates {
  // undefined = 変更なし（フィールド省略）/ null = クリア / 値 = 更新
  desired_area?: string;
  area_mode?: "station" | "ward" | "both" | "auto";
  rent_min?: number | null;
  rent_max?: number | null;
  floor_plan?: string | null;
  floor_area_min?: number | null;
  floor_area_max?: number | null;
  walk_minutes?: number | null;
  building_age?: number | null;
  pet?: boolean | null;
  move_in_time?: string | null;
  commute_station?: string | null;
  commute_minutes?: number | null;
  other_requests?: string | null;
  ng_points?: string | null;
}

// 静的プロンプト（prompt cache 対象: ルールは変わらないため毎回キャッシュから取得）
const CONDITION_BRAIN_SYSTEM_PROMPT = `あなたは賃貸物件検索の条件管理AIです。
お客さんのメッセージ・現在の登録条件・過去の送付履歴を受け取り、
条件の更新提案をJSONで返します。

【出力フォーマット】JSONのみ（説明文不要）:
{
  "updates": {
    "rent_max": 数値またはnull,
    "floor_area_min": 数値またはnull,
    ...更新するフィールドのみ記載
  },
  "contradiction": "矛盾の説明（なければnull）",
  "no_update": true/false,
  "reasoning": "判断理由（1文）"
}

【更新対象フィールド】
rent_min / rent_max: 家賃下限・上限（円）
floor_plan: 間取り（例: "1LDK" "1K・1DK" "2LDK以上"）
floor_area_min / floor_area_max: 広さ下限・上限（㎡）
walk_minutes: 駅徒歩分数（分）
building_age: 築年数上限（年）
pet: ペット可否（true/false）
move_in_time: 入居時期（テキスト）
commute_station: 通勤先駅名
commute_minutes: 通勤所要分数（分）
desired_area: 希望エリア（テキスト）
other_requests: その他要望
ng_points: NG条件

【判断ルール】
1. 明示的変更: 「家賃6万以下に変えたい」→ rent_max: 60000 を更新
2. 相対的変更: 「もう少し予算上げられます」→ 現在の rent_max から+1〜2万で更新
3. 暗黙的変更: 「前に見た物件より広めで」→ 送付履歴の最大面積を参考に floor_area_min を更新
4. 追加要望: 「やっぱりペット可がいい」→ pet: true を更新
5. 矛盾検出: 「家賃3万で2LDK」→ updates は空、contradiction に矛盾内容を記載
6. 変更なし: 挨拶・質問・感謝のみ → no_update: true、updates は空オブジェクト

【絶対ルール】
・確信が持てないフィールドは省略する（推測での更新禁止）
・お客さんが言っていないことを追加しない
・「駅近がいい」だけでは walk_minutes の数値を設定しない（明示がない）
・現在すでに設定されている条件と同じ値は省略してよい`;

// 矛盾検出時のスタッフLINE通知
async function notifyContradiction(
  customerName: string,
  contradiction: string,
  messageText: string
): Promise<void> {
  const { supabase } = await import("@/app/lib/supabase");
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN;
  let groupId: string | null = process.env.LINE_STAFF_GROUP_ID ?? process.env.LINE_GROUP_ID ?? null;
  if (!groupId) {
    const { data } = await supabase.from("hanbancyo_settings").select("value").eq("key", "group_id").maybeSingle();
    groupId = (data?.value as string) ?? null;
  }
  if (!groupId || !token) return;

  const body = JSON.stringify({
    to: groupId,
    messages: [{
      type: "text",
      text: `⚠️ 条件矛盾を検出\nお客様: ${customerName}\nメッセージ: 「${messageText.slice(0, 50)}」\n矛盾: ${contradiction}`,
    }],
  });
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body,
  }).catch(() => {});
}

// メイン: 条件更新ブレイン
export async function runConditionBrain(
  convId: string,
  messageText: string
): Promise<ConditionUpdates | null> {
  const { supabase } = await import("@/app/lib/supabase");

  // ── 顧客ID取得 ────────────────────────────────────────────────────────────
  const { data: conv } = await supabase
    .from("conversations")
    .select("property_customer_id")
    .eq("id", convId)
    .maybeSingle();
  const customerId = conv?.property_customer_id as string | null;
  if (!customerId) return null;

  // ── RAGコンテキスト組み立て ───────────────────────────────────────────────
  const ctx = await buildPropertyBrainContext(customerId);
  if (!ctx) return null;

  // 明らかに条件変更と無関係なメッセージは即スキップ（コスト節約）
  const hasConditionSignal =
    /家賃|エリア|駅|間取り|広さ|㎡|築|ペット|入居|通勤|徒歩|予算|もう少し|上げ|下げ|変え|やっぱり|希望|条件/.test(messageText);
  if (!hasConditionSignal) return null;

  // ── Claude Sonnet-5 呼び出し ─────────────────────────────────────────────
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultHeaders: { "anthropic-beta": "prompt-caching-2024-07-31" },
  });

  const contextText = formatContextForPrompt(ctx);
  const dynamicPrompt =
    contextText +
    `\n\n【今回のお客さんのメッセージ】\n「${messageText}」\n\n` +
    "上記メッセージに基づき、更新すべき条件をJSONで返してください。";

  let raw = "";
  try {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 512,
      system: [
        {
          type: "text",
          text: CONDITION_BRAIN_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [{ role: "user", content: dynamicPrompt }],
    });
    raw = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
  } catch (e) {
    console.error("[conditionBrain] Sonnet-5 call failed:", e);
    return null;
  }

  // ── JSONパース ────────────────────────────────────────────────────────────
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    console.warn("[conditionBrain] JSON parse failed. raw:", raw.slice(0, 100));
    return null;
  }
  let parsed: { updates?: Record<string, unknown>; contradiction?: string; no_update?: boolean; reasoning?: string };
  try {
    parsed = JSON.parse(jsonMatch[1]);
  } catch {
    console.warn("[conditionBrain] JSON.parse failed");
    return null;
  }

  if (parsed.no_update) {
    console.log(`[conditionBrain] no_update: ${parsed.reasoning ?? ""}`);
    return null;
  }

  const updates = parsed.updates ?? {};
  const hasUpdates = Object.keys(updates).length > 0;

  // ── 矛盾通知（updates に関係なく実行）───────────────────────────────────
  if (parsed.contradiction) {
    console.warn(`[conditionBrain] 矛盾検出: ${parsed.contradiction}`);
    await notifyContradiction(
      ctx.customer.customerName,
      parsed.contradiction,
      messageText
    );
  }

  if (!hasUpdates) return null;

  // ── DBに反映（更新フィールドのみ）────────────────────────────────────────
  const dbUpdate: Record<string, unknown> = { ...updates, updated_at: new Date().toISOString() };

  const { error } = await supabase
    .from("property_customers")
    .update(dbUpdate)
    .eq("id", customerId);

  if (error) {
    console.error("[conditionBrain] DB更新失敗:", error.message);
    return null;
  }

  console.log(`[conditionBrain] 条件更新完了 (${customerId}):`, updates, `| 理由: ${parsed.reasoning ?? ""}`);
  return updates as ConditionUpdates;
}

// ── エクスポート: RAGコンテキスト単体取得（デバッグ・テスト用） ───────────────
export { buildPropertyBrainContext, formatContextForPrompt };
export type { PropertyBrainContext, CustomerConditions, SentPropertyRecord };
