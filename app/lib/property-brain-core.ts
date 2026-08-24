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
    temperature: 0,
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

// ── エクスポート: RAGコンテキスト単体取得（デバッグ・テスト用） ───────────────
export { buildPropertyBrainContext, formatContextForPrompt };
export type { PropertyBrainContext, CustomerConditions, SentPropertyRecord };
