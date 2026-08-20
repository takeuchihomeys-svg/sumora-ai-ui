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
  };
  examples: {
    states: string[];
    customerMsgKeywords: string[];
    excludeReplyRe: RegExp | null;
    boostStates: string[];
  };
  phrases: { categories: string[] };
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
      // 複数質問（先頭3件）
      if (meta.customer_questions?.length) {
        parts.push(meta.customer_questions.slice(0, 3).join(" "));
      }
      if (meta.key_topics?.length) parts.push(meta.key_topics.join(" "));
    }
    return parts.length > 0 ? parts.join(" ") : undefined;
  })();

  // BASELINE: フル取得・除外なし・ブーストなし（従来動作と完全同一）。
  // 将来の Step6 で T1 のときのみ Q1-Q4 バケットによる選択的仕様に切り替える。
  return {
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
    },
    examples: {
      states: primaryStates,
      customerMsgKeywords: [],
      excludeReplyRe: null,
      boostStates: [],
    },
    phrases: { categories: STATE_TO_PHRASE_CATEGORIES[currentState] ?? [] },
  };
}
