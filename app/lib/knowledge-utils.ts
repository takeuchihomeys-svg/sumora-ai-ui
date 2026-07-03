import type { SupabaseClient } from "@supabase/supabase-js";

export type UpsertKnowledgeParams = {
  title: string;
  content: string;
  category: string;
  importance: number;
  conversation_state?: string;
  embedding?: number[];
  source_example_id?: string;
};

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
 *    → similarity > 0.92 かつ同カテゴリの既存ルールがあれば importance を +1 して UPDATE → "merged"
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
        const newImportance = Math.min(9, similar.importance + 1);
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
