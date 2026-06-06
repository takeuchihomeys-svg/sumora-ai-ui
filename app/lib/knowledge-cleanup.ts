import { supabase } from "./supabase";

type KnowledgeRow = {
  id: string;
  source_example_id: string | null;
  category: string;
  title: string;
  content: string;
  importance: number;
  created_at: string;
};

async function fetchAllWithSource(): Promise<KnowledgeRow[]> {
  const rows: KnowledgeRow[] = [];
  let page = 0;
  while (true) {
    const { data } = await supabase
      .from("ai_reply_knowledge")
      .select("id, source_example_id, category, title, content, importance, created_at")
      .not("source_example_id", "is", null)
      .order("created_at", { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (!data || data.length === 0) break;
    rows.push(...(data as KnowledgeRow[]));
    if (data.length < 1000) break;
    page++;
  }
  return rows;
}

async function deleteIds(ids: string[]): Promise<number> {
  const CHUNK = 100;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { error } = await supabase.from("ai_reply_knowledge").delete().in("id", chunk);
    if (error) console.error("[knowledge-cleanup] delete error:", error.message);
    else deleted += chunk.length;
  }
  return deleted;
}

export async function runKnowledgeCleanup(): Promise<{ total_scanned: number; deleted: number; kept: number }> {
  const allRows = await fetchAllWithSource();
  if (allRows.length === 0) return { total_scanned: 0, deleted: 0, kept: 0 };

  const toDelete = new Set<string>();

  // PASS 1: 同 (source_example_id, category, title) 内は最新1件のみ残す
  const latestByKey = new Map<string, string>();
  for (const row of allRows) {
    const key = `${row.source_example_id}||${row.category}||${row.title}`;
    const prev = latestByKey.get(key);
    if (prev) toDelete.add(prev);
    latestByKey.set(key, row.id);
  }

  // PASS 2: content完全一致はimportance高・新しい方のみ残す
  const bestByContent = new Map<string, KnowledgeRow>();
  for (const row of allRows) {
    if (toDelete.has(row.id)) continue;
    const contentKey = `${row.category}||${row.content.trim()}`;
    const existing = bestByContent.get(contentKey);
    if (!existing) {
      bestByContent.set(contentKey, row);
    } else {
      const keepExisting =
        existing.importance > row.importance ||
        (existing.importance === row.importance && existing.created_at >= row.created_at);
      if (keepExisting) {
        toDelete.add(row.id);
      } else {
        toDelete.add(existing.id);
        bestByContent.set(contentKey, row);
      }
    }
  }

  const deleted = await deleteIds([...toDelete]);
  return { total_scanned: allRows.length, deleted, kept: allRows.length - deleted };
}
