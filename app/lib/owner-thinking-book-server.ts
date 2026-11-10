// app/lib/owner-thinking-book-server.ts — 竹内さんの考え方の本を引く（読むだけ・埋め込み1回・作業員9・11/11・BRAIN_OWNER_BOOK 既定 off）
//   行: system_design_thinking の現行で札「竹内さんの決定」の行（P1/P2・埋め込みつき）。30分の控え（インスタンスごと）。
//   失敗・時間切れは空（ブレインは今まで通り）。会話の文は埋め込み（OpenAI・伏せた後）にだけ使い、外の LLM には送らない
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateEmbedding } from "@/app/lib/knowledge-utils";
import { pickBook, bookBlock, bookAskText, toUnit, pointsProperty, ownerBookOnlyBase, type BookRow, type BookCard, type TurnMarks } from "@/app/lib/owner-thinking-book";

const TTL_MS = 30 * 60 * 1000;
let cache: { at: number; rows: BookRow[] } | null = null;
async function loadBookRows(sb: SupabaseClient): Promise<BookRow[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const rows: BookRow[] = [];
  for (let from = 0; from < 2000; from += 200) {
    const { data, error } = await sb.from("system_design_thinking").select("id,title,insight,rationale,tags,priority,created_at,embedding")
      .eq("is_current", true).contains("tags", ["竹内さんの決定"]).in("priority", [1, 2]).order("created_at", { ascending: true }).range(from, from + 199);
    if (error) throw new Error(`system_design_thinking(本): ${error.message}`);
    for (const r of (data ?? []) as Array<BookRow & { embedding: unknown }>) {
      const e = typeof r.embedding === "string" ? (JSON.parse(r.embedding) as number[]) : (r.embedding as number[] | null);
      rows.push({ ...r, embedding: Array.isArray(e) ? toUnit(e) : null });
    }
    if (!data || data.length < 200) break;
  }
  cache = { at: Date.now(), rows };
  return rows;
}

export type OwnerBookPull = { block: string; cards: BookCard[]; ms: number; marks: TurnMarks; err?: string };
export async function ownerBookForTurn(sb: SupabaseClient, o: { scene: string | null; customerTurn: string; lastStaff: string | null; sentProps: number; promise: boolean }): Promise<OwnerBookPull> {
  const t0 = Date.now();
  const marks: TurnMarks = { pointsProperty: pointsProperty(o.customerTurn), sent: o.sentProps > 0, promise: o.promise };
  try {
    const [rows, emb] = await Promise.all([loadBookRows(sb), generateEmbedding(bookAskText(o.customerTurn, o.lastStaff))]);
    if (!emb) return { block: "", cards: [], ms: Date.now() - t0, marks, err: "embedding" };
    const cards = pickBook(rows, { scene: o.scene, turnEmb: toUnit(emb), turnText: o.customerTurn, marks, onlyTags: ownerBookOnlyBase() ? ["竹内さんの土台"] : undefined });
    return { block: bookBlock(cards), cards, ms: Date.now() - t0, marks };
  } catch (e) {
    return { block: "", cards: [], ms: Date.now() - t0, marks, err: (e instanceof Error ? e.message : String(e)).slice(0, 120) };
  }
}
