// app/lib/brain-fetch-spec.ts
// brain(suggested_aix_meta) → Step2フェッチ仕様の導出（純関数・同期・レイテンシゼロ）
// 現バージョン: ティア検出のみ。T1動的選択（Q1-Q4バケット）は次フェーズで有効化。
// フェイルオープン契約: spec不成立 = 従来動作と完全同一のbaseline。

import type { SuggestedAixMeta } from "@/app/lib/brain-core";
import { STATE_SEARCH_ALIASES } from "@/app/lib/line-reply-prompts";
import { STATE_TO_PHRASE_CATEGORIES } from "@/app/lib/prompt-cache";

// ── ティア定義 ──────────────────────────────────────────────────────────────
// T1: brainが最新顧客メッセージを見た後の分析（fresh）→ 将来ここで選択的フェッチを有効化
// T2: brainMetaはあるが古い（stale）→ 戦略フィールド（reply_direction等）のみ利用可
// T3: brainMetaなし → 完全baseline（フィルタリング材料ゼロ）
export type BrainTier = "T1" | "T2" | "T3";

export type BrainTierResult = {
  tier: BrainTier;
  brainFreshForMessage: boolean;
  staleAgeMs: number | null;
  reason: "fresh" | "stale_ts" | "no_ts" | "meta_null";
};

export type BrainFetchSpec = {
  tier: BrainTier;
  analysisContext: string | undefined;
  pgvectorMatchCount: number;
  states: { primary: string[]; boosted: string[] };
  knowledge: {
    embeddingQueryParts: string[];
    keywordOr: string[];
    titleTargets: string[];
    lossLimit: number;
    excludeContentRe: RegExp | null;
    excludeKeywords: string[];
    filterTopics: string[] | null;   // T1: key_topics（1-3件）由来の絞り込み候補。null=絞り込みなし
    limit: number;                    // match_reply_knowledge の match_count（baseline 100）
  };
  examples: {
    states: string[];
    customerMsgKeywords: string[];
    excludeReplyRe: RegExp | null;
    minKeepAfterExclude: number;              // excludeReplyRe適用後の最低残件数。下回ったらフィルタ放棄（フェイルオープン）
    boostStates: string[];
    pgvectorMatchCount: number;               // match_reply_examples の match_count（baseline 20）
    filterByDirection: string | null;         // T1: reply_direction 由来。null=方向性フィルタなし
  };
  phrases: { categories: string[] };
  // ── T1動的選択（クエリ単位のENABLE/SKIP・フェイルオープン: T2/T3は全enabled=baseline） ──
  lossPatterns: { enabled: boolean; limit: number };  // 失注パターン保証バケット（baseline: enabled / limit 4）
  applyingPatterns: { enabled: boolean };             // applying_pattern 保証バケット（baseline: enabled）
  viewingPatterns: { enabled: boolean };              // 内見系パターン（baseline: enabled・現状消費側なし＝将来用）
  adaptRules: { enabled: boolean };                   // adaptation_improvement_rules（baseline: enabled）
};

// 鮮度許容誤差: generate-reply の brainFreshForMessage 判定と同値（同一秒書き込みの丸め誤差吸収）
const FRESHNESS_TOLERANCE_MS = 5_000;

// analysisContext 用の文字数上限スライス（generate-reply の safeSlice と同義のローカル版）
function sliceSafe(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

// ── ティア検出 ──────────────────────────────────────────────────────────────
// generate-reply の brainFreshForMessage 判定（analyzed_msg_ts >= 最新顧客メッセージ - 5s）を
// ティア分類として再表現したもの。判定基準は必ず一致させること（乖離＝鮮度ゲートのバグ）。
export function detectBrainTier(
  brainMeta: SuggestedAixMeta | null,
  lastCustomerMsgAt: string | null | undefined,
): BrainTierResult {
  if (!brainMeta) {
    return { tier: "T3", brainFreshForMessage: false, staleAgeMs: null, reason: "meta_null" };
  }
  if (!brainMeta.analyzed_msg_ts) {
    return { tier: "T2", brainFreshForMessage: false, staleAgeMs: null, reason: "no_ts" };
  }
  if (!lastCustomerMsgAt) {
    // 比較対象なし＝古い証拠がない → fresh 扱い（既存 brainFreshForMessage と同じフェイル方向）
    return { tier: "T1", brainFreshForMessage: true, staleAgeMs: null, reason: "fresh" };
  }
  const analyzedMs = new Date(brainMeta.analyzed_msg_ts).getTime();
  const lastMsgMs = new Date(lastCustomerMsgAt).getTime();
  const staleAgeMs = lastMsgMs - analyzedMs;
  if (staleAgeMs <= FRESHNESS_TOLERANCE_MS) {
    return { tier: "T1", brainFreshForMessage: true, staleAgeMs: null, reason: "fresh" };
  }
  return { tier: "T2", brainFreshForMessage: false, staleAgeMs, reason: "stale_ts" };
}

// ── フェッチ仕様の導出 ──────────────────────────────────────────────────────
// BASELINE版: 全ティアで従来と完全同一のフル取得を返す（フィルタリングなし）。
// このバージョンの目的はティア検出＋ロギングのみ。T1選択的フィルタ（Step6）は未実装。
export function buildBrainFetchSpec(
  meta: SuggestedAixMeta | null,
  currentState: string,
  tierResult: BrainTierResult,
): BrainFetchSpec {
  const primaryStates = STATE_SEARCH_ALIASES[currentState] || [currentState];

  // analysisContext: generate-reply 内の既存IIFE（旧Step1置換・検索クエリ強化）と同じ導出。
  // 鮮度ゲート適用: T2(stale)では戦略フィールド reply_direction のみ、
  // T1(fresh)では message-local 戦術フィールドも合成する。T3はメタなし＝undefined。
  const analysisContext = (() => {
    if (!meta) return undefined;
    const parts: string[] = [];
    if (meta.reply_direction) parts.push(sliceSafe(meta.reply_direction, 60));
    if (tierResult.tier === "T1") {
      // 迷い・保留パターン → 検索キーワード化
      const hp = meta.hesitancy_pattern;
      if (hp === "thinking") parts.push("保留 検討中");
      else if (hp === "callback") parts.push("また連絡 保留");
      else if (hp === "waiting") parts.push("キャンセル 安心");
      else if (hp === "timeline") parts.push("入居時期 スケジュール");
      else if (hp === "undecided") parts.push("比較 決断");
      if (meta.future_timeline) parts.push(String(meta.future_timeline));
      // M2(AIX-METAフル活用 2026-08): 繰り返し懸念テーマを検索クエリ化。
      // 「初期費用を3回聞いている」等が分かっているのに関連ナレッジ・実例をピンポイントで
      // 引かないと、Step3の「別の角度で説明せよ」指示に材料が供給されず創作リスクになる。
      if (meta.repeated_concern) parts.push(sliceSafe(String(meta.repeated_concern), 20));
      // 複数質問（先頭3件）
      if (meta.customer_questions?.length) {
        parts.push(meta.customer_questions.slice(0, 3).join(" "));
      }
      if (meta.key_topics?.length) parts.push(meta.key_topics.join(" "));
    }
    return parts.length > 0 ? parts.join(" ") : undefined;
  })();

  // BASELINE: フル取得・除外なし・ブーストなし（従来動作と完全同一）。
  // T2/T3 は必ずこの baseline のまま返す（stale メタでのクエリ削減は最凶の regression）。
  const spec: BrainFetchSpec = {
    tier: tierResult.tier,
    analysisContext,
    pgvectorMatchCount: 100,
    states: { primary: primaryStates, boosted: [] },
    knowledge: {
      embeddingQueryParts: [],
      keywordOr: [],
      titleTargets: [],
      lossLimit: 0,
      excludeContentRe: null,
      excludeKeywords: [],
      filterTopics: null,
      limit: 100,
    },
    examples: {
      states: primaryStates,
      customerMsgKeywords: [],
      excludeReplyRe: null,
      minKeepAfterExclude: 3,
      boostStates: [],
      pgvectorMatchCount: 20,
      filterByDirection: null,
    },
    phrases: { categories: STATE_TO_PHRASE_CATEGORIES[currentState] ?? [] },
    lossPatterns: { enabled: true, limit: 4 },
    applyingPatterns: { enabled: true },
    viewingPatterns: { enabled: true },
    adaptRules: { enabled: true },
  };

  // ── T1 動的選択 ────────────────────────────────────────────────────────────
  // フェイルオープン契約: フィールド単位。不正値・未知値はそのフィールドだけ baseline に落とす。
  if (tierResult.tier !== "T1" || !meta) return spec;

  // current_property → analysisContext への追記（物件名をpgvector検索クエリに含める）
  // 話題の中心物件が分かっているのにクエリに含めないと、その物件に関する実例・ナレッジが引けない。
  if (meta.current_property) {
    spec.analysisContext = [spec.analysisContext, meta.current_property].filter(Boolean).join(" ");
  }

  // ① action によるバケット選択（actionが文字列で存在する場合のみ発動。欠損時は baseline）
  // 監査FIX(2026-08-20): brain(meta.action) が実際に出す値は AIX_BRAIN_NOTES のキー
  // （application_push / viewing_invite / followup_revive 等）。旧実装は "apply"/"viewing" 等の
  // 抽象値のみで分岐しており、実運用では全actionがelse節に落ちて lossPatterns/applyingPatterns が
  // 常時disabledになっていた（申込局面で applying_pattern が届かないregression）。
  // AIXキーを正規の分岐値としてマッピングし、旧抽象値も後方互換で受ける。
  const action = typeof meta.action === "string" ? meta.action : "";
  const APPLY_ACTIONS = ["application_push", "apply", "signing"];
  const VIEWING_ACTIONS = ["viewing_invite", "meeting_place", "greeting_viewing", "viewing", "viewing_appointment"];
  // followup_revive = 沈黙顧客の再接触 → 失注前夜の局面として失注パターンを増量する側に含める
  const CLOSE_ACTIONS = ["followup_revive", "close", "negotiation"];
  if (action) {
    if (APPLY_ACTIONS.includes(action)) {
      // 申込・契約局面: 申込到達パターンを届け、失注パターンは雑音として省く
      spec.applyingPatterns.enabled = true;
      spec.lossPatterns.enabled = false;
      // M3(AIX-METAフル活用 2026-08): 実例ランキングで申込系フェーズの実例を+0.1ブースト
      // （消費側 route.ts fetchExamples の boostStates 配管は実装済み・値はSTATE_SEARCH_ALIASESのapplying系）
      spec.examples.boostStates = ["applying", "application", "application_push", "screening", "contract"];
    } else if (VIEWING_ACTIONS.includes(action)) {
      // 内見局面: 内見系パターン優先・失注パターン省略
      spec.viewingPatterns.enabled = true;
      spec.lossPatterns.enabled = false;
      // M3: 内見系フェーズの実例を+0.1ブースト（proposingエイリアス内のviewing系ステート）
      spec.examples.boostStates = ["viewing", "viewing_invite", "meeting_place"];
    } else if (CLOSE_ACTIONS.includes(action)) {
      // クロージング・交渉・追客局面: 失注前夜 → 失注パターン増量
      spec.lossPatterns.enabled = true;
      spec.lossPatterns.limit = 5;
    } else {
      // その他の action: 失注/申込パターンはこの局面の雑音
      spec.lossPatterns.enabled = false;
      spec.applyingPatterns.enabled = false;
    }
  }

  // ①-b checkpoint_stage フォールバック/オーバーライド
  // conversations.status・チェックポイント・メッセージ文脈を総合したbrainのground-truth フェーズ判定。
  // action が欠損・未知の場合のフォールバック。または action と異なるフェーズシグナルでの補完。
  const cs = typeof meta.checkpoint_stage === "string" ? meta.checkpoint_stage : null;
  if (cs === "applying" && !spec.applyingPatterns.enabled) {
    // 申込フェーズ（actionで届かなかったケース）: 申込実例を届け、失注パターンは省く
    spec.applyingPatterns.enabled = true;
    spec.lossPatterns.enabled = false;
    if (spec.examples.boostStates.length === 0) {
      spec.examples.boostStates = ["applying", "application", "application_push", "screening", "contract"];
    }
  } else if (cs === "contract" && !spec.applyingPatterns.enabled) {
    // 契約フェーズ: 署名・契約系の実例を届ける
    spec.applyingPatterns.enabled = true;
    if (spec.examples.boostStates.length === 0) {
      spec.examples.boostStates = ["signing", "contract"];
    }
  } else if (cs === "hearing") {
    // ヒアリングフェーズ: 失注パターンは雑音（このフェーズで失注パターンは早計）
    spec.lossPatterns.enabled = false;
  }
  // cs === "proposing": 提案フェーズはデフォルトフロー・変更不要

  // ①-c next_steps → バケット補完（action/checkpoint_stageで届かなかったケースのフォールバック）
  // next_steps は次アクションの文字列配列。申込・内見ワードを検出してバケットを補完する。
  // guard: 既にそのパターンが有効なら重複適用しない（同一方向のboostStates追加は冪等・Set処理）。
  const ns = meta.next_steps ?? null;
  if (ns && ns.length > 0) {
    const nsText = ns.join(" ");
    if (!spec.applyingPatterns.enabled && /申込|書類|contract/i.test(nsText)) {
      spec.applyingPatterns.enabled = true;
      spec.lossPatterns.enabled = false;
      spec.examples.boostStates = [...new Set([...spec.examples.boostStates, "applying", "application_push"])];
    } else if (!spec.viewingPatterns.enabled && /内見|案内|viewing/i.test(nsText)) {
      spec.viewingPatterns.enabled = true;
      spec.examples.boostStates = [...new Set([...spec.examples.boostStates, "viewing", "viewing_invite"])];
    }
  }

  // ② hesitancy_pattern（保留局面）: 失注パターンは必ず届ける（actionのSKIPより優先）
  if (meta.hesitancy_pattern) {
    if (!spec.lossPatterns.enabled) {
      spec.lossPatterns.enabled = true;
      spec.lossPatterns.limit = 3;
    }
  }

  // ③ condition_change_type → adaptRules（条件変更ターンのみ適応ルールが効く）
  // 監査FIX: 条件系actionの正規キーは condition_hearing（AIX_BRAIN_NOTES）。旧抽象値も後方互換で受ける
  if (meta.condition_change_type) {
    spec.adaptRules.enabled = true;
  } else if (action !== "condition_hearing" && action !== "condition_change") {
    spec.adaptRules.enabled = false;
  }

  // ④ key_topics → knowledge 絞り込み候補（1〜3件のときのみ・それ以外は null=絞り込みなし）
  const topics = (meta.key_topics ?? []).filter(t => typeof t === "string" && t.length > 0);
  spec.knowledge.filterTopics = topics.length >= 1 && topics.length <= 3 ? topics : null;

  // ⑤ reply_direction → 実例の方向性フィルタ候補
  spec.examples.filterByDirection =
    typeof meta.reply_direction === "string" && meta.reply_direction.length > 0
      ? meta.reply_direction
      : null;

  // ⑥ M1(AIX-METAフル活用 2026-08): avoid_topics → 実例ポストフィルタ（excludeReplyRe）。
  // brainが「見積書に言及禁止」と知っているのに見積書カバー文の実例が⭐実例として注入されると
  // プロンプト内で禁止指示と実例が矛盾する（avoid_topics違反の主要因）。
  // 消費側（route.ts fetchExamples: minKeepAfterExclude=3 のfloor付きフェイルオープン）は実装済み。
  // トピックは正規表現メタ文字をエスケープして OR 連結する。
  const avoid = (meta.avoid_topics ?? [])
    .filter((t): t is string => typeof t === "string")
    .map(t => t.trim())
    .filter(t => t.length >= 2 && t.length <= 20);
  if (avoid.length > 0) {
    try {
      spec.examples.excludeReplyRe = new RegExp(
        avoid.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
      );
    } catch {
      spec.examples.excludeReplyRe = null; // 不正パターンはフィルタなし（フェイルオープン）
    }
  }

  // ⑦ ②-b/②-c(AIX-METAフル活用 2026-08): brainが required + 具体的closing_strategy を持つ＝
  // 「例外なく従え」と確信しているケース。genericナレッジ100件の洪水はbrainの具体指示（1行）を
  // 薄める雑音のため、pgvectorナレッジ取得を60件に削減する（0にはしない＝絶対ルール・差分学習は残す）。
  if (meta.enforcement_level === "required" && typeof meta.closing_strategy === "string" && meta.closing_strategy.length > 0) {
    spec.knowledge.limit = 60;
    spec.pgvectorMatchCount = 60;
  }

  return spec;
}
