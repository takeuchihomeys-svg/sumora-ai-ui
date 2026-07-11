import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/app/lib/supabase";

// ─── テキスト類似度（bigram Jaccard）#31 ─────────────────────────────────────
// 空白除去後の2文字グラム集合の Jaccard 係数（0〜1）。語順の入れ替えに頑健。
function buildBigrams(s: string): Set<string> {
  const set = new Set<string>();
  const text = s.replace(/\s+/g, "");
  for (let i = 0; i < text.length - 1; i++) {
    set.add(text.slice(i, i + 2));
  }
  return set;
}

export function textSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const biA = buildBigrams(a);
  const biB = buildBigrams(b);
  let intersection = 0;
  for (const g of biA) { if (biB.has(g)) intersection++; }
  const union = biA.size + biB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

// ─── OpenAI 埋め込み生成（text-embedding-3-small・1536次元）＋キャッシュ #29 ──
// ⑥ メモリキャッシュ（最大500件FIFO）+ Supabase embedding_cache テーブルで永続化。
// 優先順: メモリ → DB → OpenAI API生成 → DB+メモリに保存。
const embeddingCache = new Map<string, number[]>();

export async function generateEmbedding(text: string): Promise<number[] | null> {
  const cacheKey = text.slice(0, 2000);

  // メモリキャッシュ確認（最速）
  if (embeddingCache.has(cacheKey)) return embeddingCache.get(cacheKey)!;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  // ⑥ DBキャッシュ確認（再起動後も有効）
  try {
    const { data: cached } = await supabase
      .from("embedding_cache")
      .select("embedding")
      .eq("text_key", cacheKey)
      .maybeSingle();
    if (cached?.embedding) {
      const emb = cached.embedding as number[];
      embeddingCache.set(cacheKey, emb);
      return emb;
    }
  } catch {
    // DBキャッシュ失敗はスキップして通常生成へ
  }

  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: cacheKey }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    const embedding = data.data[0]?.embedding ?? null;
    if (embedding) {
      // メモリキャッシュ更新（FIFO 500件上限）
      embeddingCache.set(cacheKey, embedding);
      if (embeddingCache.size > 500) embeddingCache.delete(embeddingCache.keys().next().value!);
      // ⑥ DBキャッシュに永続保存（fire-and-forget）
      // supabase-js v2 はlazy評価のため void では実行されない → .then()で強制実行
      supabase.from("embedding_cache").upsert({ text_key: cacheKey, embedding }).then(() => {}, () => {});
    }
    return embedding;
  } catch {
    return null;
  }
}

export type UpsertKnowledgeParams = {
  title: string;
  content: string;
  category: string;
  importance: number;
  conversation_state?: string;
  embedding?: number[];
  source_example_id?: string;
  /**
   * このルールが適用される「顧客メッセージの例文」。
   * embedding 生成の入力にのみ使用（DBカラムなし・保存しない）。#21
   * 検索時のクエリ（顧客メッセージ）と意味空間を揃えるため、
   * ルール文ではなくこちらを embedding 化する。
   */
  trigger_example?: string;
};

/**
 * ナレッジの embedding 入力を組み立てる（#21 embedding入力の非対称問題対策）。
 *
 * 検索側（generate-reply）は「`${state}: ${顧客メッセージ}`」をクエリに embedding 検索するため、
 * 保存側も trigger_example（=顧客メッセージの例文）を優先して同じ形式で embedding 化する。
 * trigger_example がない場合は従来通り rule/content にフォールバック。
 */
export function buildKnowledgeEmbeddingInput(params: {
  trigger_example?: string;
  rule?: string;
  content?: string;
  conversation_state?: string;
}): string {
  const base = params.trigger_example || params.rule || params.content || "";
  if (!base) return "";
  return params.conversation_state ? `${params.conversation_state}: ${base}` : base;
}

type MatchRpcRow = {
  id: string;
  title: string;
  content: string;
  category: string;
  importance: number;
  similarity: number;
  hypothesis_status?: string;
  conversation_state?: string;
};

/**
 * ai_reply_knowledge への重複排除 upsert。
 *
 * 1. embedding が提供されている場合: match_reply_knowledge RPC で類似度チェック
 *    → similarity > 0.92 かつ同カテゴリの既存ルールがあれば importance を「既存と新規の高い方」に UPDATE → "merged"
 * 2. embedding なし or 類似なし: タイトル先頭15文字の ilike チェック
 *    → タイトル重複あり → "skipped"
 * 3. 上記いずれでも重複なし → INSERT → "inserted"
 */
export async function upsertKnowledge(
  supabase: SupabaseClient,
  params: UpsertKnowledgeParams,
): Promise<"inserted" | "merged" | "skipped"> {
  const { title, content, category, importance, conversation_state, embedding, source_example_id } = params;

  // Step 1: embedding による意味的類似チェック
  if (embedding && embedding.length > 0) {
    const { data: matches, error: rpcError } = await supabase.rpc("match_reply_knowledge", {
      query_embedding: embedding,
      match_count: 5,
      min_importance: 1,
    }) as { data: MatchRpcRow[] | null; error: unknown };

    if (!rpcError && matches && matches.length > 0) {
      // BUG-04: conversation_state が異なるルールとのマージを防ぐ
      const similar = matches.find(
        (m) => m.similarity > 0.92 && m.category === category && (!conversation_state || m.conversation_state === conversation_state),
      );

      if (similar) {
        // importanceインフレ防止: 加算はせず「既存 vs 新規」の高い方を維持（上限9）
        const newImportance = Math.min(9, Math.max(similar.importance || 0, importance || 0));
        await supabase
          .from("ai_reply_knowledge")
          .update({ importance: newImportance })
          .eq("id", similar.id);

        console.log(
          `[upsertKnowledge] merged: "${title}" → 既存ID ${similar.id} (similarity=${similar.similarity.toFixed(3)}, importance ${similar.importance}→${newImportance})`,
        );
        return "merged";
      }
    }
  }

  // Step 2: タイトル先頭25文字の ilike 重複チェック（embeddingありはStep1で済み・embeddingなし時のみ実行）
  // embedding がある場合は Step1（similarity>0.92）で重複排除済みのため ilike は実行しない（誤スキップ防止）
  // BUG-11: conversation_state でスコープを絞ることでクロスステート誤スキップを防ぐ
  if (!embedding || embedding.length === 0) {
    const keyword = title.slice(0, 25);
    let ilq = supabase
      .from("ai_reply_knowledge")
      .select("id")
      .ilike("title", `%${keyword}%`);
    if (conversation_state) ilq = ilq.eq("conversation_state", conversation_state);
    const { data: existing } = await ilq.limit(1);

    if (existing && existing.length > 0) {
      console.log(`[upsertKnowledge] skipped: タイトル重複 "${keyword}" (state=${conversation_state ?? "any"})`);
      return "skipped";
    }
  }

  // Step 3: INSERT — BUG-02: Supabase は失敗時に例外を投げず { error } を返すため必ず検査する
  const insertPayload: Record<string, unknown> = {
    title,
    content,
    category,
    importance,
    ...(conversation_state ? { conversation_state } : {}),
    ...(source_example_id ? { source_example_id } : {}),
    ...(embedding ? { embedding: JSON.stringify(embedding) } : {}),
  };

  const { error: insertError } = await supabase.from("ai_reply_knowledge").insert(insertPayload);
  if (insertError) {
    console.error(`[upsertKnowledge] insert failed: "${title}"`, insertError.message);
    throw new Error(`upsertKnowledge insert failed: ${insertError.message}`);
  }

  console.log(`[upsertKnowledge] inserted: "${title}" (category=${category}, importance=${importance})`);
  return "inserted";
}
