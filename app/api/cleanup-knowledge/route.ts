import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

const CRON_SECRET = "hasu-cron-secret-2024";

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
    const { data, error } = await supabase
      .from("ai_reply_knowledge")
      .select("id, source_example_id, category, title, content, importance, created_at")
      .not("source_example_id", "is", null)
      .order("created_at", { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
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
    if (error) console.error("[cleanup-knowledge] delete error:", error.message);
    else deleted += chunk.length;
  }
  return deleted;
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret");
  if (secret !== CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const allRows = await fetchAllWithSource();
    const toDelete = new Set<string>();

    // ── PASS 1: 同 (source_example_id, category, title) 内は最新1件のみ残す ──
    // order=created_at asc なので配列の後方ほど新しい → 後方を「勝者」にする
    const latestByKey = new Map<string, string>(); // key → winning id
    for (const row of allRows) {
      const key = `${row.source_example_id}||${row.category}||${row.title}`;
      const prev = latestByKey.get(key);
      if (prev) toDelete.add(prev); // 古い方を削除候補に
      latestByKey.set(key, row.id); // 常に最新で上書き
    }

    // ── PASS 2: content が完全一致するentryは全体でも1件のみ残す ──
    // importance高 → created_at新しい順で優先
    const bestByContent = new Map<string, KnowledgeRow>();
    for (const row of allRows) {
      if (toDelete.has(row.id)) continue; // PASS1削除候補はスキップ
      const contentKey = `${row.category}||${row.content.trim()}`;
      const existing = bestByContent.get(contentKey);
      if (!existing) {
        bestByContent.set(contentKey, row);
      } else {
        // importance高い方を残す。同importanceなら新しい方を残す
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

    const deleteList = [...toDelete];
    const deleted = await deleteIds(deleteList);

    return NextResponse.json({
      ok: true,
      total_scanned: allRows.length,
      deleted,
      kept: allRows.length - deleted,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cleanup-knowledge] error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
