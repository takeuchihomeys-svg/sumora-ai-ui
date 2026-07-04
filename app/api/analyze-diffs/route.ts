import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { upsertKnowledge, buildKnowledgeEmbeddingInput, generateEmbedding } from "@/app/lib/knowledge-utils";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// AIドラフトと実送信の差分を比較して学習ルールを抽出
async function analyzeDiff(
  customerMessage: string,
  aiDraft: string,
  sentReply: string,
  conversationState: string,
): Promise<{ skip: boolean; title?: string; rule?: string; category?: string; trigger_example?: string } | null> {
  try {
    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 900,
      messages: [{
        role: "user",
        content: `スタッフが実際に送った返信とAIの下書きを「構成・文の役割」レベルで比較分析し、改善パターンを抽出してください。

【お客様のメッセージ】
${customerMessage || "不明"}

【AIの下書き】
${aiDraft}

【スタッフが実際に送った返信（正解）】
${sentReply}

【フェーズ】${conversationState}

▼ この順番で分析する
① スタッフの返信を1文ずつ分解し、各文の「役割」をラベル付け
   役割ラベル例：[承認][共感][情報提供][提案][申込誘導][確認質問][次アクション][感謝][サポート姿勢]
② AIの下書きも同様に分解・役割付け
③ 役割レベルで比較：削除された役割・追加された役割・順番の変化を特定
④ 「なぜその構成がこのお客様の心理に正解か」を1文で考える

▼ スキップ条件（以下のみなら {"skip":true} のみ返す）
- 固有情報（物件名・金額・日時・住所・顧客名）のみ違う
- 誤字修正のみ（1〜2文字）
- 役割・構成・意図に実質的な差がない（ほぼ同じ）

▼ 学習ルールがある場合のJSON出力
{"skip":false,"title":"差分学習: [構成パターン名（30文字以内・具体的に）]","rule":"[役割レベルのルール。NG構成→OK構成、なぜその順番が正解かの理由を含む。250文字以内]","category":"[pattern=構成テンプレート / style=文体・トーン / phrase=言い回し のいずれかのみ。principle は絶対に選ばないこと]","trigger_example":"[このルールが適用される典型的なお客様メッセージの例文（1〜2文）。お客様が実際に送ってきそうな言葉で書く。ルールの説明文ではなくお客様側のメッセージそのものを書くこと]"}

JSONのみを返す。分析の途中経過は不要。`,
      }],
    });

    const text = res.content[0].type === "text" ? res.content[0].text.trim() : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as { skip: boolean; title?: string; rule?: string; category?: string; trigger_example?: string };
  } catch {
    return null;
  }
}

function textSimilarity(a: string, b: string): number {
  const s1 = a.replace(/\s+/g, "");
  const s2 = b.replace(/\s+/g, "");
  if (s1 === s2) return 1;
  if (!s1 || !s2) return 0;
  let j = 0, matches = 0;
  for (let i = 0; i < s1.length; i++) {
    while (j < s2.length && s2[j] !== s1[i]) j++;
    if (j < s2.length) { matches++; j++; }
  }
  return matches / Math.max(s1.length, s2.length);
}

// 修正量に応じて importance を変動（save-reply-example と統一）
// sim < 0.4 = 大幅修正 → 9 / 0.4〜0.65 = 中程度 → 8 / 0.65〜 = 微修正 → 7
function diffImportance(sim: number): number {
  if (sim < 0.4) return 9;
  if (sim < 0.65) return 8;
  return 7;
}

export async function POST(req: NextRequest) {
  // ?limit=N で件数を指定可能（デフォルト30・最大200）
  // maxDuration=60秒 / 1件あたり約2秒 → 30件が上限目安
  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 30, 200) : 30;

  // 未処理の差分を取得（is_starred順で重要な学習から処理）
  const { data: examples } = await supabase
    .from("ai_reply_examples")
    .select("id, customer_message, ai_draft, sent_reply, conversation_state, is_starred")
    .eq("was_ai_modified", true)
    .is("diff_analyzed_at", null)
    .not("ai_draft", "is", null)
    .not("sent_reply", "is", null)
    .order("is_starred", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (!examples || examples.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, learned: 0, message: "処理対象なし" });
  }

  let processed = 0;
  let learned = 0;
  const now = new Date().toISOString();

  for (const ex of examples) {
    const { id, customer_message, ai_draft, sent_reply, conversation_state, is_starred } = ex as {
      id: string;
      customer_message: string;
      ai_draft: string;
      sent_reply: string;
      conversation_state: string;
      is_starred: boolean;
    };

    // 完全一致はスキップ（構成が同じなので学習不要）
    if ((ai_draft ?? "").trim() === (sent_reply ?? "").trim()) {
      await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
      processed++;
      continue;
    }

    // 分割送信っぽい場合（sentReplyがaiDraftの55%未満かつ類似度30%以上）はスキップ
    const sim = textSimilarity((ai_draft ?? "").trim(), (sent_reply ?? "").trim());
    const likelySplit = (sent_reply ?? "").trim().length < (ai_draft ?? "").trim().length * 0.55 && sim >= 0.3;
    if (likelySplit) {
      await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
      processed++;
      continue;
    }

    const result = await analyzeDiff(customer_message, ai_draft, sent_reply, conversation_state);

    if (result && !result.skip && result.title && result.rule) {
      // principle は diff 由来ルールの「絶対ルール」昇格を防ぐため許可しない（#4）
      const ALLOWED_CATEGORIES = new Set(["pattern", "style", "phrase"]);
      const rawCategory = (result.category ?? "pattern").split("=")[0].trim();
      const safeCategory = ALLOWED_CATEGORIES.has(rawCategory) ? rawCategory : "pattern";
      // #21: 検索クエリ（顧客メッセージ）と意味空間を揃えるため trigger_example を優先して embedding 化
      const embeddingInput = buildKnowledgeEmbeddingInput({
        trigger_example: result.trigger_example,
        rule: result.rule,
        conversation_state: conversation_state ?? "proposing",
      });
      const embedding = await generateEmbedding(embeddingInput);
      // ☆つき or 大幅修正ほど importance を上げる
      const baseImp = diffImportance(sim);
      const imp = is_starred ? Math.min(9, baseImp + 1) : baseImp;

      const upsertResult = await upsertKnowledge(supabase, {
        title: result.title,
        content: result.rule,
        category: safeCategory,
        importance: imp,
        conversation_state: conversation_state ?? "proposing",
        source_example_id: id,
        ...(embedding ? { embedding } : {}),
      });

      if (upsertResult === "inserted") {
        learned++;
      } else if (upsertResult === "merged") {
        console.log(`[analyze-diffs] 既存ルール強化: "${result.title}"`);
        learned++;
      } else {
        console.log(`[analyze-diffs] スキップ（重複）: "${result.title}"`);
      }
    }

    await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
    processed++;
  }

  // 学習済みナレッジのembeddingを即座にバックフィル
  if (learned > 0) {
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
      ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");
    void fetch(`${baseUrl}/api/backfill-embeddings`, {
      method: "POST",
    }).catch(() => {});
  }

  return NextResponse.json({ ok: true, processed, learned, message: `${processed}件処理・${learned}件学習` });
}

export async function GET(req: NextRequest) {
  // Vercel Cron からの呼び出しを CRON_SECRET で認証（#15）
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (cronSecret && authHeader !== "Bearer " + cronSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return POST(req);
}
