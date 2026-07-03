import type { SupabaseClient } from "@supabase/supabase-js";

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
      const similar = matches.find(
        (m) => m.similarity > 0.92 && m.category === category,
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

  // Step 2: タイトル先頭15文字の ilike 重複チェック
  const keyword = title.slice(0, 15);
  const { data: existing } = await supabase
    .from("ai_reply_knowledge")
    .select("id")
    .ilike("title", `%${keyword}%`)
    .limit(1);

  if (existing && existing.length > 0) {
    console.log(`[upsertKnowledge] skipped: タイトル重複 "${keyword}"`);
    return "skipped";
  }

  // Step 3: INSERT
  const insertPayload: Record<string, unknown> = {
    title,
    content,
    category,
    importance,
    ...(conversation_state ? { conversation_state } : {}),
    ...(source_example_id ? { source_example_id } : {}),
    ...(embedding ? { embedding: JSON.stringify(embedding) } : {}),
  };

  await supabase.from("ai_reply_knowledge").insert(insertPayload);

  console.log(`[upsertKnowledge] inserted: "${title}" (category=${category}, importance=${importance})`);
  return "inserted";
}
