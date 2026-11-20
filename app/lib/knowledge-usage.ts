// app/lib/knowledge-usage.ts — ナレッジの使用回数（used_count・last_used_at）の数え方（既定 off＝今まで通り ai_reply_knowledge を直に +1）
//
// 2026-11-20 作業員H（統括役の頼み・DB の再起動から1時間半で ai_reply_knowledge が 654回更新・11:47〜11:51 の checkpoint 58秒・150秒）:
//   ai_reply_knowledge の行は embedding（TOAST）と embedding_h（行の中・halfvec 3KB）を持つ大きな行で、索引が9本（HNSW を含む）ある。
//   生成のたびに increment_knowledge_used_count が使ったナレッジの行（数件〜数十件）の used_count・last_used_at を +1 する
//   （generate-reply・aix/action×2・aix-template-generate・analyze-diffs）。PostgreSQL の更新は行を丸ごと新しく書き、
//   同じページに空きが無いと（fillfactor 100）全部の索引（HNSW も）に新しい行を足す＝WAL と checkpoint が重くなる。
//   KNOWLEDGE_USAGE_TABLE=on の時: 数えは小さな表 knowledge_usage（knowledge_id・used_delta・last_used_at）に足し、
//   毎晩の update-knowledge の cron の最初に fold_knowledge_usage() で ai_reply_knowledge に1回だけ書き戻す（読む側は今のまま used_count を読む）。
//   ⚠ update-knowledge の cron は used_count=0 の行を消す → 書き戻しはその前（cron の最初）。書き戻しは on・off に関係なく毎晩回す（off にした後の残りも戻す）
//   新しい表・関数が無い（migrate の前）・失敗した時は今まで通りの RPC に戻す（数えを落とさない）。止める: 既定 off（=on で入る）
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: { message: string; code?: string } | null }>;

export function knowledgeUsageTableOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.KNOWLEDGE_USAGE_TABLE ?? "").trim().toLowerCase() === "on";
}

/** 使ったナレッジの id を数える（重複は1つ・空は何もしない）。返り値はどちらで数えたか */
export async function recordKnowledgeUsage(rpc: Rpc, ids: ReadonlyArray<string | null | undefined>, env?: Record<string, string | undefined>): Promise<"table" | "legacy" | "none" | "failed"> {
  const uniq = [...new Set(ids.filter((x): x is string => typeof x === "string" && x.trim().length > 0))];
  if (!uniq.length) return "none";
  if (knowledgeUsageTableOn(env)) {
    try {
      const r = await rpc("increment_knowledge_usage", { p_ids: uniq });
      if (!r.error) return "table";
      console.warn("[knowledge-usage] knowledge_usage に書けない → 今まで通り:", r.error.message);
    } catch (e) {
      console.warn("[knowledge-usage] knowledge_usage に書けない → 今まで通り:", e instanceof Error ? e.message : e);
    }
  }
  try {
    const r = await rpc("increment_knowledge_used_count", { p_ids: uniq });
    return r.error ? "failed" : "legacy";
  } catch {
    return "failed";
  }
}

/** 毎晩の書き戻し（knowledge_usage → ai_reply_knowledge・1行1回）。関数が無ければ 0（migrate の前） */
export async function foldKnowledgeUsage(rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<{ folded: number; error: string | null }> {
  try {
    const r = await rpc("fold_knowledge_usage");
    if (r.error) return { folded: 0, error: /does not exist|Could not find the function|schema cache/i.test(r.error.message) ? null : r.error.message };
    return { folded: Number(r.data) || 0, error: null };
  } catch (e) {
    return { folded: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
