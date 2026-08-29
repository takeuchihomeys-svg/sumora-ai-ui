// app/lib/prompt-cache.ts
// Supabase静的データのモジュールスコープキャッシュ（TTL + SWR + singleflight + fail-open）
// Vercel Functions のウォームインスタンス内でDBクエリを削減する。
// TTL切れでもSWR（stale-while-revalidate）で古いキャッシュを返し生成をブロックしない。

import { supabase } from "@/app/lib/supabase";
import { fetchPromptRules } from "@/app/lib/prompt-rules";

// ═══════════════════════════════════════════════════════════════════════════
// 汎用キャッシュ（TTL + SWR + singleflight）
// ═══════════════════════════════════════════════════════════════════════════

interface CacheEntry<T extends object> {
  /** キャッシュ済みデータ。null = 未フェッチ（コールド） */
  data: T | null;
  /** 最終フェッチ成功時刻（epoch ms）。0 = 未フェッチ or 無効化済み */
  fetchedAt: number;
  /** このエントリのTTL（ms） */
  ttlMs: number;
  /** singleflight: 実行中のフェッチPromise。同時リクエストはこれを共有する */
  revalidating: Promise<T> | null;
}

interface CacheHandle<T extends object> {
  entry: CacheEntry<T>;
  get(): Promise<T>;
}

/**
 * TTL付きモジュールスコープキャッシュを生成する。
 *
 * get() の挙動:
 *   - TTL内のキャッシュあり → 即返す（DBアクセスなし）
 *   - TTL切れ＋古いデータあり → 古いデータを即返し、バックグラウンドで再検証（SWR）
 *   - 未フェッチ（コールド） → フェッチ完了を待つ
 *   - singleflight: 再検証がすでに走っていれば新たなフェッチは起こさない
 *     （同一インスタンス内の同時DBクエリは常に最大1本 — stampede防止）
 *   - fail-open: バックグラウンド再検証の失敗はログのみ（古いデータで継続）。
 *     コールドスタートでの初回フェッチ失敗はエラーを伝播し、公開API側で
 *     フォールバック値（[] / ""）に落とす。
 */
function createCache<T extends object>(
  name: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): CacheHandle<T> {
  const entry: CacheEntry<T> = {
    data: null,
    fetchedAt: 0,
    ttlMs,
    revalidating: null,
  };

  function refresh(): Promise<T> {
    if (entry.revalidating) return entry.revalidating; // singleflight
    entry.revalidating = fetcher()
      .then((data) => {
        entry.data = data;
        entry.fetchedAt = Date.now();
        return data;
      })
      .finally(() => {
        entry.revalidating = null;
      });
    return entry.revalidating;
  }

  return {
    entry,
    async get(): Promise<T> {
      const fresh =
        entry.data !== null && Date.now() - entry.fetchedAt < entry.ttlMs;
      if (fresh) return entry.data as T;

      if (entry.data !== null) {
        // SWR: 古いデータを即返し、バックグラウンドで再検証をキック。
        // すでに再検証中なら refresh() は既存Promiseを返すだけ（重複フェッチなし）。
        void refresh().catch((error) => {
          // fail-open: 再検証失敗は古いキャッシュで続行（返信生成を止めない）
          console.error(
            `[prompt-cache:${name}] バックグラウンド再検証失敗 — 古いキャッシュで続行:`,
            error,
          );
        });
        return entry.data;
      }

      // コールド: フェッチ完了を待つ（失敗は呼び出し元でフォールバック処理）
      return refresh();
    },
  };
}

/**
 * キャッシュレジストリ。キーの先頭プレフィックス（rules: / phrases: / knowledge:）で
 * invalidatePromptCache() のタイプ別無効化に対応する。
 */
const cacheRegistry = new Map<string, CacheHandle<object>>();

function getOrCreateCache<T extends object>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): CacheHandle<T> {
  let cache = cacheRegistry.get(key) as CacheHandle<T> | undefined;
  if (!cache) {
    cache = createCache<T>(key, ttlMs, fetcher);
    cacheRegistry.set(key, cache as unknown as CacheHandle<object>);
  }
  return cache;
}

// ═══════════════════════════════════════════════════════════════════════════
// state → フレーズカテゴリ対応表
// generate-reply/route.ts（旧 L1021-1027）から移設。route.ts 側は削除して
// ここから import すること（二重管理禁止）。
// ═══════════════════════════════════════════════════════════════════════════

export const STATE_TO_PHRASE_CATEGORIES: Record<string, string[]> = {
  hearing: ["cost_reduction", "condition_hearing", "viewing_invite", "anxiety_relief"],
  condition_hearing: ["cost_reduction", "condition_hearing", "viewing_invite", "anxiety_relief"],
  proposing: ["property_recommendation", "urgency_push", "anxiety_relief"],
  property_search: ["property_recommendation", "urgency_push", "anxiety_relief"],
  viewing: ["viewing_invite", "anxiety_relief"],
  viewing_scheduled: ["viewing_invite", "anxiety_relief"],
  viewing_confirmation: ["viewing_invite", "anxiety_relief"],
  meeting_place: ["viewing_invite", "anxiety_relief"],
  applying: ["application_push", "anxiety_relief"],
  application: ["application_push", "anxiety_relief"],
  screening: ["application_push", "anxiety_relief"],
};

/** 対応表にないstateのデフォルトカテゴリ */
export const DEFAULT_PHRASE_CATEGORIES: string[] = ["cost_reduction", "anxiety_relief"];

/** state からフレーズカテゴリを解決する（未知のstateはデフォルトにフォールバック） */
export function resolvePhraseCategories(state: string): string[] {
  return STATE_TO_PHRASE_CATEGORIES[state] ?? DEFAULT_PHRASE_CATEGORIES;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1) ai_prompt_rules — fetchPromptRules() の結果文字列キャッシュ・TTL 60秒
// ═══════════════════════════════════════════════════════════════════════════

const RULES_TTL_MS = 60_000; // 60秒

/**
 * fetchPromptRules() の結果（プロンプト注入用文字列）をキャッシュ経由で取得。
 * キャッシュキー: actionType + conditions + includeGlobal（組み合わせごとに別エントリ）。
 *
 * fetchPromptRules 自体が fail-soft（DB障害時は警告テキストを返す）ため、
 * コールドスタート失敗時のフォールバックは "" を返す。
 */
export async function getCachedPromptRules(
  actionType: string,  // "generate_reply" | "final_check" | AIXアクション名（application_push 等）
  conditions: Record<string, string> = {},
  includeGlobal = true,
  includeLearnAix = false,  // LEARN-AIX-*（AIX編集差分学習）を含める。aix-template-generate のアクション別フェッチ用
): Promise<string> {
  const key = `rules:${actionType}:${JSON.stringify(conditions)}:${includeGlobal}:${includeLearnAix}`;
  const cache = getOrCreateCache<{ text: string }>(key, RULES_TTL_MS, async () => {
    const text = await fetchPromptRules(actionType, conditions, includeGlobal, includeLearnAix);
    return { text };
  });
  try {
    const { text } = await cache.get();
    if (!text) {
      console.log(JSON.stringify({tag:"degradation:cache-miss",cache:"rules",key,cause:"empty-data",returnedEmpty:true}));
    }
    return text;
  } catch (error) {
    console.error(
      "[prompt-cache] プロンプトルール取得失敗（キャッシュも空）— ルールなしで続行:",
      error,
    );
    console.log(JSON.stringify({tag:"degradation:cache-miss",cache:"rules",key,cause:"fetch-error",returnedEmpty:true,error:String(error).slice(0,200)}));
    return "";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2) phrase_dictionary — カテゴリ組み合わせごとのキャッシュ・TTL 10分
//    週次学習cronでしか変わらないためほぼ静的。
// ═══════════════════════════════════════════════════════════════════════════

const PHRASES_TTL_MS = 600_000; // 10分

/**
 * phrase_dictionary からフレーズ文字列一覧をキャッシュ経由で取得。
 *   - category IN categories・priority >= 10・is_active = true
 *   - priority 降順・上位40件
 * キャッシュキー: categories をソートして結合（順序違いの同一組み合わせを同一視）。
 *
 * DB障害時: 古いキャッシュで fail-open。キャッシュも空なら [] を返して
 * フレーズなしで生成を続行。
 */
export async function getCachedPhrases(categories: string[]): Promise<string[]> {
  if (!categories || categories.length === 0) return [];
  const key = `phrases:${[...categories].sort().join(",")}`;
  const cache = getOrCreateCache<string[]>(key, PHRASES_TTL_MS, async () => {
    const { data, error } = await supabase
      .from("phrase_dictionary")
      .select("phrase")
      .in("category", categories)
      .gte("priority", 10)
      .eq("is_active", true)
      .order("priority", { ascending: false })
      .limit(40);
    if (error) throw error;
    return ((data ?? []) as Array<{ phrase: string }>)
      .map((r) => r.phrase)
      .filter(Boolean);
  });
  try {
    const phrases = await cache.get();
    if (phrases.length === 0) {
      console.log(JSON.stringify({tag:"degradation:cache-miss",cache:"phrases",key,cause:"empty-data",returnedEmpty:true}));
    }
    return phrases;
  } catch (error) {
    console.error(
      "[prompt-cache] phrase_dictionary取得失敗（キャッシュも空）— フレーズなしで続行:",
      error,
    );
    console.log(JSON.stringify({tag:"degradation:cache-miss",cache:"phrases",key,cause:"fetch-error",returnedEmpty:true,error:String(error).slice(0,200)}));
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3) ai_reply_knowledge — principles / 失注パターン・TTL 5分
//    書き込み元は analyze-diffs（日次 JST 3:23）と ai-feedback のみ。
//    5分の反映遅延は営業上無害。
// ═══════════════════════════════════════════════════════════════════════════

const KNOWLEDGE_TTL_MS = 300_000; // 5分

export interface KnowledgeItem {
  id: string;
  title: string;
  content: string;
  importance: number;
}

/**
 * importance>=8 の principle ナレッジ（非rejected・importance降順・上位12件）を
 * キャッシュ経由で取得。pgvector検索の取りこぼしに関わらず必ず注入する保証バケット。
 *
 * DB障害時: 古いキャッシュで fail-open。キャッシュも空なら [] を返して
 * ナレッジなしで生成を続行。
 */
export async function getCachedTopPrinciples(): Promise<KnowledgeItem[]> {
  const cache = getOrCreateCache<KnowledgeItem[]>(
    "knowledge:top_principles",
    KNOWLEDGE_TTL_MS,
    async () => {
      const { data, error } = await supabase
        .from("ai_reply_knowledge")
        .select("id, title, content, importance")
        .eq("category", "principle")
        .gte("importance", 8)
        .neq("hypothesis_status", "rejected")
        .order("importance", { ascending: false })
        .limit(12);
      if (error) throw error;
      return (data ?? []) as KnowledgeItem[];
    },
  );
  try {
    return await cache.get();
  } catch (error) {
    console.error(
      "[prompt-cache] principles取得失敗（キャッシュも空）— ナレッジなしで続行:",
      error,
    );
    return [];
  }
}

/**
 * 失注パターンナレッジ（title ILIKE '失注パターン%'・非rejected・importance降順）を
 * キャッシュ経由で取得。limit ごとに別キャッシュエントリ。
 *
 * DB障害時: 古いキャッシュで fail-open。キャッシュも空なら [] を返して続行。
 */
export async function getCachedLossPatterns(limit?: number): Promise<KnowledgeItem[]> {
  const effectiveLimit = limit ?? 4;
  const cache = getOrCreateCache<KnowledgeItem[]>(
    `knowledge:loss_patterns_${effectiveLimit}`,
    KNOWLEDGE_TTL_MS,
    async () => {
      const { data, error } = await supabase
        .from("ai_reply_knowledge")
        .select("id, title, content, importance")
        .ilike("title", "失注パターン%")
        .neq("hypothesis_status", "rejected")
        .order("importance", { ascending: false })
        .limit(effectiveLimit);
      if (error) throw error;
      return (data ?? []) as KnowledgeItem[];
    },
  );
  try {
    return await cache.get();
  } catch (error) {
    console.error(
      "[prompt-cache] 失注パターン取得失敗（キャッシュも空）— パターンなしで続行:",
      error,
    );
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 無効化
// ═══════════════════════════════════════════════════════════════════════════

const TYPE_PREFIX: Record<"rules" | "knowledge" | "phrases", string> = {
  rules: "rules:",
  knowledge: "knowledge:",
  phrases: "phrases:",
};

/**
 * 指定タイプのキャッシュエントリを即時無効化する（fetchedAt を 0 に戻す）。
 * データ自体は保持するため、無効化直後のリクエストは SWR で古い値を返しつつ
 * バックグラウンドで再フェッチが走る（生成をブロックしない）。
 *
 * 注意: Vercel の複数インスタンス分散下ではプロセス内無効化は自インスタンス
 * のみに効く。全インスタンス収束は TTL が保証する。
 */
export function invalidatePromptCache(
  type: "rules" | "knowledge" | "phrases" | "all",
): void {
  cacheRegistry.forEach((cache, key) => {
    if (type === "all" || key.startsWith(TYPE_PREFIX[type as keyof typeof TYPE_PREFIX])) {
      cache.entry.fetchedAt = 0;
    }
  });
}
