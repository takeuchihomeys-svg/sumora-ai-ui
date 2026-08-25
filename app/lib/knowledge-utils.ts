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

  // BOM（U+FEFF）が混入している場合に除去（Vercel env var コピペ時に混入するケースがある）
  const rawKey = process.env.OPENAI_API_KEY ?? "";
  const apiKey = rawKey.charCodeAt(0) === 0xFEFF ? rawKey.slice(1) : rawKey;
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
      signal: AbortSignal.timeout(10_000),
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

// ─── GPT-5.4-nano で物件画像から構造データを抽出 ────────────────────────────
// property_recommendation AIX の after() で呼び出し、aix_generate_log に保存する。
// eval-customer-reaction cron がこのデータを使って候補プールとの照合精度を上げる。
export interface PropertyImageDetails {
  name?: string | null;
  room_no?: string | null;
  rent?: number | null;
  admin_fee?: number | null;
  deposit?: number | null;
  key_money?: number | null;
  floor_plan?: string | null;
  area_sqm?: number | null;
  walk_minutes?: number | null;
  building_age?: number | null;
  ad_months?: number | null;
  features?: string[] | null;
}

export async function extractPropertyDetailsFromImage(imageUrl: string): Promise<PropertyImageDetails | null> {
  const rawKey = process.env.OPENAI_API_KEY ?? "";
  const apiKey = rawKey.charCodeAt(0) === 0xFEFF ? rawKey.slice(1) : rawKey;
  if (!apiKey || !imageUrl) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-nano",
        max_completion_tokens: 500,
        response_format: { type: "json_object" },
        messages: [{
          role: "user",
          content: [
            {
              type: "text",
              text: `この物件資料の画像から情報を抽出してJSONで返してください。不明な項目はnullにしてください。
{
  "name": "物件名（マンション名・アパート名）",
  "room_no": "号室",
  "rent": 家賃（円・数値。万円表記なら×10000して整数に変換）,
  "admin_fee": 管理費・共益費（円・数値）,
  "deposit": 敷金（ヶ月数・数値）,
  "key_money": 礼金（ヶ月数・数値）,
  "floor_plan": "間取り（例：1K・1LDK・ワンルーム）",
  "area_sqm": 専有面積（㎡・数値）,
  "walk_minutes": 最寄り駅徒歩（分・数値）,
  "building_age": 築年数（年・数値）,
  "ad_months": 広告料（ヶ月数・数値）,
  "features": ["設備・特徴リスト（例：オートロック・宅配ボックス・ペット可）"]
}`,
            },
            {
              type: "image_url",
              image_url: { url: imageUrl, detail: "low" },
            },
          ],
        }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.warn("[extractPropertyDetailsFromImage] OpenAI error", res.status, await res.text());
      return null;
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content;
    if (!text) return null;
    return JSON.parse(text) as PropertyImageDetails;
  } catch (e) {
    console.warn("[extractPropertyDetailsFromImage] exception", e);
    return null;
  }
}

// ─── GPT-5.4-nano で推薦理由を抽出 ──────────────────────────────────────────
// eval-customer-reaction cron から呼び出し。AIXオススメ文の「なぜ推薦したか」を要約。
export async function extractRecommendationReason(generatedText: string): Promise<string | null> {
  const rawKey = process.env.OPENAI_API_KEY ?? "";
  const apiKey = rawKey.charCodeAt(0) === 0xFEFF ? rawKey.slice(1) : rawKey;
  if (!apiKey || !generatedText.trim()) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-nano",
        max_completion_tokens: 80,
        messages: [{
          role: "user",
          content: `以下の物件オススメ文から「なぜこの物件をこのお客さんに推薦したか」を40字以内で要約してください。理由のみ返してください。\n\n${generatedText.slice(0, 600)}`,
        }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn("[extractRecommendationReason] OpenAI error", res.status, await res.text());
      return null;
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (e) {
    console.warn("[extractRecommendationReason] exception", e);
    return null;
  }
}

// ─── suggested_aix_meta からお客さんプロファイルタグを導出（API不要）────────
// 「費用重視」「通勤重視」等のタグを正規表現で抽出し、動的スコアリングに使う。
export function deriveCustomerProfileTags(
  meta: { closing_strategy?: string | null; key_topics?: string[] | null; preferences?: string | null } | null,
  customerPreferences?: string | null
): string[] {
  const text = [
    meta?.closing_strategy,
    ...(meta?.key_topics ?? []),
    meta?.preferences,
    customerPreferences,
  ].filter(Boolean).join(" ");
  if (!text) return [];
  const tags: string[] = [];
  if (/費用|初期費用|敷礼|安く|節約|お得/.test(text))       tags.push("費用重視");
  if (/通勤|駅|アクセス|電車/.test(text))                   tags.push("通勤重視");
  if (/広|収納|部屋数|広さ|スペース/.test(text))             tags.push("広さ重視");
  if (/築|新しい|きれい|リノベ|新築/.test(text))             tags.push("築浅重視");
  if (/ペット|猫|犬/.test(text))                            tags.push("ペット重視");
  if (/静か|住宅街|閑静|落ち着/.test(text))                  tags.push("静かな立地");
  if (/在宅|テレワーク|リモート|仕事部屋/.test(text))         tags.push("在宅勤務");
  return tags;
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

export type UpsertResult = { result: "inserted" | "merged" | "skipped"; id?: string };

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
): Promise<UpsertResult> {
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
        return { result: "merged", id: similar.id };
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
      return { result: "skipped" };
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

  const { data: inserted, error: insertError } = await supabase
    .from("ai_reply_knowledge")
    .insert(insertPayload)
    .select("id")
    .single();
  if (insertError) {
    console.error(`[upsertKnowledge] insert failed: "${title}"`, insertError.message);
    throw new Error(`upsertKnowledge insert failed: ${insertError.message}`);
  }

  const newId = (inserted as { id: string } | null)?.id;
  console.log(`[upsertKnowledge] inserted: "${title}" (category=${category}, importance=${importance}, id=${newId ?? "unknown"})`);
  return { result: "inserted", id: newId };
}
