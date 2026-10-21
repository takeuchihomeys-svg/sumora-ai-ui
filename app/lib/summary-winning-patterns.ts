// お客様の要約の「人間性が似た成約事例」の RAG（2026-10-13 customer-summary の route から移した・中身は同じ）
//   竹内さん 10/13「要約をブレインだけにする＝はい」: 要約はブレインの戦略の層だけが書く。戦略の層にも同じ成約パターンの RAG を渡すため共通にした
//   （route の要約＝顧客一覧の手動の要約は今まで通り使う）
import { supabase } from "@/app/lib/supabase-server";
import { generateEmbedding } from "@/app/lib/knowledge-utils";

type SummaryJsonLite = { personality_profile?: string };

// ── 文字列類似度（bigram Dice係数）— 人間性プロファイル同士の部分一致スコアリング用 ──
function bigrams(s: string): Set<string> {
  const t = s.replace(/[\s・、。/／]/g, "");
  const set = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}
export function diceSimilarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

// 高5: 成約パターン検索を「人間性・行動パターン中心」に再設計
// 方針（竹内）: 人間はパターンでだいたい動きが決まっている。家賃・エリア・間取りは2の次。
// 「今の顧客がどういう人間か」（コミュニケーションスタイル・迷い方・決断の仕方）が似ている
// 過去の成約事例を引き、「この人タイプには何が刺さったか」を winning_pattern に反映する。
//
// 段階1: personality_profile（前回サマリーの人間性プロファイル）で pgvector 類似検索
//        （profileが無い初回顧客は従来の条件テキストで代用）
// 段階2: 段階1が3件未満なら winning_pattern_logs の was_correct=true（実際に当たった予測）から
//        人間性プロファイルの文字列類似度（bigram Dice）で上位3件を補完
// フォールバック: どちらも0件なら従来の最新5件
export async function fetchWinningPatterns(
  personalityProfile: string,
  conditionQueryText: string
): Promise<Array<{ content: string }>> {
  const results: Array<{ content: string }> = [];
  // [成約分析]/[転換点] は analyze-closed-conversation（Opus 4.8）が申込/成約時に書く高価値ナレッジ
  const isWonTitle = (t: string) => /成約パターン|決まった|closed_won|成約分析|転換点/i.test(t);

  // ── 段階1: 人間性プロファイルで pgvector 類似検索（match_reply_knowledge RPC）──
  const queryText = personalityProfile || conditionQueryText;
  if (queryText && process.env.OPENAI_API_KEY) {
    const embedding = await generateEmbedding(queryText);
    if (embedding) {
      const { data: vectorHits, error: rpcError } = await supabase.rpc("match_reply_knowledge", {
        query_embedding: embedding,
        match_count: 8,
        min_importance: 7,
      }) as {
        data: Array<{ content: string; category: string; title: string; importance: number; similarity: number }> | null;
        error: { message: string } | null;
      };
      if (rpcError) console.warn("[customer-summary] match_reply_knowledge RPC error:", rpcError.message);
      const patterns = (vectorHits ?? [])
        .filter(r => (r.category === "pattern" || r.category === "applying_pattern") && (r.similarity ?? 0) >= 0.5)
        // 成約系タイトル（成約パターン/決まった/closed_won）を優先、同格なら類似度順
        .sort((a, b) => {
          const aWon = isWonTitle(a.title ?? "") ? 1 : 0;
          const bWon = isWonTitle(b.title ?? "") ? 1 : 0;
          if (aWon !== bWon) return bWon - aWon;
          return (b.similarity ?? 0) - (a.similarity ?? 0);
        })
        .slice(0, 5);
      results.push(...patterns.map(p => ({ content: p.content })));
    }
  }

  // ── 段階2: 3件未満なら winning_pattern_logs の「実際に当たった予測」を人間性類似で補完 ──
  if (personalityProfile && results.length < 3) {
    const { data: logs } = await supabase
      .from("winning_pattern_logs")
      .select("customer_id, predicted_pattern, personality_profile")
      .eq("was_correct", true)
      .order("created_at", { ascending: false })
      .limit(50);
    const logRows = (logs ?? []) as Array<{
      customer_id: string | null;
      predicted_pattern: string;
      personality_profile: string | null;
    }>;

    // personality_profile 未保存の旧レコードは property_customers.ai_summary_json から補完
    const missingIds = [...new Set(
      logRows.filter(l => !l.personality_profile && l.customer_id).map(l => l.customer_id as string)
    )];
    const profileByCustomer = new Map<string, string>();
    if (missingIds.length > 0) {
      const { data: pcs } = await supabase
        .from("property_customers")
        .select("id, ai_summary_json")
        .in("id", missingIds);
      for (const pc of (pcs ?? []) as Array<{ id: string; ai_summary_json: SummaryJsonLite | null }>) {
        const prof = pc.ai_summary_json?.personality_profile;
        if (prof) profileByCustomer.set(pc.id, prof);
      }
    }

    const scored = logRows
      .map(l => {
        const prof = l.personality_profile
          ?? (l.customer_id ? profileByCustomer.get(l.customer_id) : undefined)
          ?? "";
        return { prof, pattern: l.predicted_pattern, score: prof ? diceSimilarity(personalityProfile, prof) : 0 };
      })
      .filter(l => l.score >= 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    results.push(...scored.map(l => ({
      content: `【人間性が似た顧客で実際に当たった一手】人間性: ${l.prof} → 当たった一手: ${l.pattern}`,
    })));
  }

  if (results.length > 0) return results;

  // フォールバック: 従来通り最新5件（[成約分析]/[転換点] タイトルも対象に含める）
  // L139のベクトル検索側と同様に applying_pattern も対象に含める
  const { data } = await supabase
    .from("ai_reply_knowledge")
    .select("content")
    .in("category", ["pattern", "applying_pattern"])
    .or("title.ilike.成約パターン_%,title.ilike.[成約分析]%,title.ilike.[転換点]%")
    .order("created_at", { ascending: false })
    .limit(5);
  return (data as Array<{ content: string }> | null) ?? [];
}
