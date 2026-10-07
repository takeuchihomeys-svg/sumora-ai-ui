// app/lib/design-knowledge-rag-server.ts — 設計知見の埋め込みを作る・自然文で引く（DB と OpenAI）
//   決まりは design-knowledge-rag.ts（純）。埋め込みは text-embedding-3-small（1536次元・$0.02/100万トークン）。
//   設計知見に個人情報は入れない決まりだが、送る前に maskForEmbedding（共通の伏せ字）を通す。
import type { SupabaseClient } from "@supabase/supabase-js";
import { cosine, hybridRank, kbEmbeddingInput, needsEmbedding, sceneQuery, splitPinned, textHash, type KbScene, type RagRow, type Scored } from "@/app/lib/design-knowledge-rag";
import { maskForEmbedding } from "@/app/lib/pii-mask";

const EMBED_MODEL = "text-embedding-3-small";
const EMBED_PRICE_PER_M = 0.02;

function openAiKey(): string {
  const raw = process.env.OPENAI_API_KEY ?? "";
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/** まとめて埋め込む（1回 最大 64 文）。返すのは文ごとの埋め込みと使ったトークン数 */
export async function embedTexts(texts: string[]): Promise<{ vectors: Array<number[] | null>; tokens: number }> {
  const key = openAiKey();
  if (!key || !texts.length) return { vectors: texts.map(() => null), tokens: 0 };
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts.map((t) => maskForEmbedding(t)) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j = await res.json() as { data: Array<{ index: number; embedding: number[] }>; usage?: { prompt_tokens?: number } };
  const out: Array<number[] | null> = texts.map(() => null);
  for (const d of j.data ?? []) out[d.index] = d.embedding;
  return { vectors: out, tokens: j.usage?.prompt_tokens ?? 0 };
}

type EmbRow = RagRow & { embedding_hash?: string | null };
/** 問いの埋め込み（searchKbPinned が P0 の近さを取り直す時に使い回す・プロセスの間だけ） */
const queryVectors = new Map<string, number[]>();
/** 段の列（priority）があるか（本番に ALTER を流す前は無い＝無い時は決定論の推定で並べる・後ろ互換） */
let priorityColumn: boolean | null = null;
export async function hasPriorityColumn(sb: SupabaseClient): Promise<boolean> {
  if (priorityColumn != null) return priorityColumn;
  const { error } = await sb.from("system_design_thinking").select("priority").limit(1);
  priorityColumn = !error;
  return priorityColumn;
}
export async function loadRagRows(sb: SupabaseClient, withHash = false): Promise<EmbRow[]> {
  const all: EmbRow[] = [];
  const cols = "id, title, insight, rationale, context, tags, is_current, created_at" + (withHash ? ", embedding_hash" : "") + ((await hasPriorityColumn(sb)) ? ", priority" : "");
  for (let p = 0; p < 50; p++) {
    const { data, error } = await sb.from("system_design_thinking").select(cols).eq("is_current", true).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(`system_design_thinking: ${error.message}`);
    all.push(...((data ?? []) as unknown as EmbRow[]));
    if ((data ?? []).length < 1000) break;
  }
  return all;
}

/**
 * 埋め込みが無い・文が変わった現行の行を埋める（kb-insert・週の整理・scripts/kb-embed.ts が呼ぶ）。
 *   dry＝数えるだけ（文字数からトークンを見積もる）
 */
export async function embedKbRows(sb: SupabaseClient, opts: { dry: boolean; ids?: string[]; batch?: number } = { dry: true }): Promise<{ target: number; embedded: number; tokens: number; estTokens: number; usd: number }> {
  let rows = await loadRagRows(sb, true);
  if (opts.ids && opts.ids.length) { const set = new Set(opts.ids); rows = rows.filter((r) => set.has(r.id)); }
  const target = rows.filter(needsEmbedding);
  const estTokens = target.reduce((n, r) => n + Math.ceil(kbEmbeddingInput(r).length * 1.1), 0);
  if (opts.dry) return { target: target.length, embedded: 0, tokens: 0, estTokens, usd: (estTokens / 1e6) * EMBED_PRICE_PER_M };
  let embedded = 0, tokens = 0;
  const B = opts.batch ?? 48;
  for (let i = 0; i < target.length; i += B) {
    const chunk = target.slice(i, i + B);
    const inputs: string[] = chunk.map((r) => kbEmbeddingInput(r));
    const { vectors, tokens: t } = await embedTexts(inputs);
    tokens += t;
    for (let k = 0; k < chunk.length; k++) {
      const v = vectors[k];
      if (!v) continue;
      const { error } = await sb.from("system_design_thinking").update({ embedding: v, embedding_hash: textHash(inputs[k]) }).eq("id", chunk[k].id);
      if (error) throw new Error(`embedding の書き込み ${chunk[k].id}: ${error.message}`);
      embedded++;
    }
  }
  return { target: target.length, embedded, tokens, estTokens, usd: (tokens / 1e6) * EMBED_PRICE_PER_M };
}

/**
 * 自然文の問いで引く（近さ＋語＋札＋新しさ）。返すのは上位 k
 *   scene（3巡目・10/07）: 返信の場面で引く＝問いに場面の語を足し（expand=false で足さない）、場面の札・題の型の行に点を足す
 */
export async function searchKb(sb: SupabaseClient, q0: string, opts: { k?: number; tags?: string[]; mode?: "hybrid" | "vector" | "keyword"; rows?: RagRow[]; vecCache?: Map<string, Map<string, number>>; scene?: KbScene | null; expand?: boolean; sceneWeight?: number; weights?: Parameters<typeof hybridRank>[3]["weights"] } = {}): Promise<Scored[]> {
  const q = opts.expand === true ? sceneQuery(q0, opts.scene) : q0; // 語を足すと当たりが下がった（問い33: 0.73→0.79 だが holdout 0.75→0.67）＝既定は足さない
  const rows = opts.rows ?? await loadRagRows(sb);
  let vec = opts.vecCache?.get(q) ?? null;
  if (!vec && (opts.mode ?? "hybrid") !== "keyword") {
    const { vectors } = await embedTexts([q]);
    vec = new Map<string, number>();
    if (vectors[0]) queryVectors.set(q, vectors[0]);
    if (vectors[0]) {
      const { data, error } = await sb.rpc("match_design_thinking_exact", { query_embedding: vectors[0], match_count: 80 });
      if (error) throw new Error(`match_design_thinking_exact: ${error.message}`);
      for (const r of (data ?? []) as Array<{ id: string; similarity: number }>) vec.set(r.id, r.similarity);
    }
    opts.vecCache?.set(q, vec);
  }
  return hybridRank(rows, vec ?? new Map(), q, { nowIso: new Date().toISOString(), tags: opts.tags, mode: opts.mode, scene: opts.scene, sceneWeight: opts.sceneWeight, weights: opts.weights }).slice(0, opts.k ?? 8);
}

/**
 * 2026-10-07 段の別枠つき（kb.ts が使う）: P0（絶対・最優先）のうち問いに関係する物は pinned（上位 k の外・先頭に出す）、残りは searchKb と同じ上位 k
 */
export async function searchKbPinned(sb: SupabaseClient, q0: string, opts: Parameters<typeof searchKb>[2] = {}): Promise<{ pinned: Scored[]; hits: Scored[] }> {
  const k = opts.k ?? 8;
  const all = await searchKb(sb, q0, { ...opts, k: 10_000 });
  // P0 の近さは上位 80 の外のことが多い（並びの近さは上位 80 だけ）→ P0 の行だけ全件比較の近さを取り直す（並びの点は変えない）
  const p0Sims = new Map<string, number>();
  const p0Ids = new Set(all.filter((s) => s.priority === 0).map((s) => s.row.id));
  if (p0Ids.size && (opts.mode ?? "hybrid") !== "keyword") {
    const q = opts.expand === true ? sceneQuery(q0, opts.scene) : q0;
    let v = queryVectors.get(q) ?? null;
    if (!v) { const { vectors } = await embedTexts([q]); v = vectors[0]; if (v) queryVectors.set(q, v); }
    if (v) {
      // RPC の返りは 1,000 行で切れる（PostgREST の上限）＝P0 の埋め込みだけ読んで手元でコサイン（P0 は数行）
      const { data, error } = await sb.from("system_design_thinking").select("id, embedding").in("id", [...p0Ids]);
      if (!error) for (const r of (data ?? []) as Array<{ id: string; embedding: string | number[] | null }>) {
        const e = typeof r.embedding === "string" ? (JSON.parse(r.embedding) as number[]) : r.embedding;
        if (e && e.length) p0Sims.set(r.id, cosine(v, e));
      }
    }
  }
  return splitPinned(all, k, { p0Sims, scene: !!opts.scene && opts.scene !== "other" });
}

/** 新しい行の近い現行の行（週の整理の似ている組の候補・全件比較の SQL 関数） */
export async function neighborsOf(sb: SupabaseClient, id: string, k = 5, min = 0.8): Promise<Array<{ id: string; similarity: number }>> {
  const { data, error } = await sb.rpc("design_thinking_neighbors", { p_id: id, match_count: k, min_similarity: min });
  if (error) throw new Error(`design_thinking_neighbors: ${error.message}`);
  return (data ?? []) as Array<{ id: string; similarity: number }>;
}
