import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { upsertKnowledge, buildKnowledgeEmbeddingInput, generateEmbedding } from "@/app/lib/knowledge-utils";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, timeout: 30_000, maxRetries: 1 });

// 物件ピックアップした: 特定のコンポーネント（intro/pickup/invite/closing）単位で差分分析
// aiComponentText = AIが生成したそのパーツのテキスト、sentReply = スタッフが送った全文
// Haikuがsentifyの中から該当パーツを特定して比較する
async function analyzeComponentDiff(
  customerMessage: string,
  aiComponentText: string,
  sentReply: string,
  componentState: string, // "property_send_pickup" 等
  componentName: string,  // "ピックアップ行（条件説明）" 等
): Promise<{ skip: boolean; title?: string; rule?: string } | null> {
  try {
    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `物件ピックアップメッセージの「${componentName}」パーツについて、スタッフがAI文案を改善した差分から学習ルールを抽出してください。

【AIが生成した「${componentName}」】
${aiComponentText}

【スタッフが実際に送った全文（この中から「${componentName}」に対応する部分を見つけて比較する）】
${sentReply}

分析手順：
① スタッフの全文の中からAIの「${componentName}」に対応する部分を特定する
② AIの生成と比較して変わった点（言い回し・強調・省略・言葉の選択）を特定する
③ その変化が次回の生成に活かせるルールかを判断する

スキップ条件（以下のみなら {"skip":true}）：
- 物件名・エリア・日時・顧客名などの固有情報だけが違う
- ほぼ同じ（90%以上一致）
- スタッフの文中に対応するパーツが見当たらない

学習ルールがある場合のJSON（スキップ以外）：
{"skip":false,"title":"${componentName}改善: [パターン名・30文字以内]","rule":"[次回から守るべきルール・200文字以内。NG表現→OK表現の対比で書く]"}

JSONのみを返す。説明不要。`,
      }],
    });
    const text = res.content[0].type === "text" ? res.content[0].text.trim() : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as { skip: boolean; title?: string; rule?: string };
  } catch {
    return null;
  }
}

// AIドラフトと実送信の差分を比較して学習ルールを抽出
async function analyzeDiff(
  customerMessage: string,
  aiDraft: string,
  sentReply: string,
  conversationState: string,
  componentHint = "",
): Promise<{ skip: boolean; title?: string; rule?: string; category?: string; trigger_example?: string } | null> {
  try {
    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 900,
      messages: [{
        role: "user",
        content: `スタッフが実際に送った返信とAIの下書きを「構成・文の役割」レベルで比較分析し、改善パターンを抽出してください。${componentHint}

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
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  // ?limit=N で件数を指定可能（デフォルト30・最大200）
  // maxDuration=60秒 / 1件あたり約2秒 → 30件が上限目安
  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 30, 200) : 30;

  // 未処理の差分を取得（is_starred順で重要な学習から処理）
  const { data: examples, error: examplesError } = await supabase
    .from("ai_reply_examples")
    .select("id, customer_message, ai_draft, sent_reply, conversation_state, is_starred, ai_components, reply_angle")
    .eq("was_ai_modified", true)
    .is("diff_analyzed_at", null)
    .not("ai_draft", "is", null)
    .not("sent_reply", "is", null)
    .order("is_starred", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  // DBエラーを空配列として握りつぶさず、明示的にエラーを返す
  if (examplesError) {
    return NextResponse.json({ ok: false, error: examplesError.message }, { status: 500 });
  }

  if (!examples || examples.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, learned: 0, message: "処理対象なし" });
  }

  let processed = 0;
  let learned = 0;
  const now = new Date().toISOString();

  for (const ex of examples) {
    const { id, customer_message, ai_draft, sent_reply, conversation_state, is_starred, ai_components, reply_angle } = ex as {
      id: string;
      customer_message: string;
      ai_draft: string;
      sent_reply: string;
      conversation_state: string;
      is_starred: boolean;
      ai_components: Record<string, string> | null;
      reply_angle: string | null;
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

    // 物件ピックアップした: コンポーネント単位の差分分析
    // ai_components + reply_angle="component_diff:..." があればパーツごとに学習ルールを生成・保存
    if (ai_components && reply_angle?.startsWith("component_diff:")) {
      const changedComponents = reply_angle.replace("component_diff:", "").split(",");
      const LEARNABLE = ["intro", "pickup", "invite", "closing"];
      const learnableChanged = changedComponents.filter(c => LEARNABLE.includes(c));
      if (learnableChanged.length === 0) {
        // vacating/calendarだけ変化 → 固有情報のみ。学習不要
        await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
        processed++;
        continue;
      }
      const COMPONENT_NAMES: Record<string, string> = {
        intro:   "挨拶文",
        pickup:  "ピックアップ行（条件説明）",
        invite:  "内覧誘導文",
        closing: "締め文",
      };
      // コンポーネントごとに差分分析（最大2件: Haiku コスト抑制）
      for (const comp of learnableChanged.slice(0, 2)) {
        const aiCompText = (ai_components as Record<string, string>)[comp] ?? "";
        if (!aiCompText || aiCompText.length < 5) continue;
        const compState = `property_send_${comp}`;
        const compResult = await analyzeComponentDiff(
          customer_message, aiCompText, sent_reply, compState, COMPONENT_NAMES[comp] ?? comp,
        );
        if (compResult && !compResult.skip && compResult.title && compResult.rule) {
          const embInput = buildKnowledgeEmbeddingInput({
            trigger_example: customer_message,
            rule: compResult.rule,
            conversation_state: compState,
          });
          const embedding = await generateEmbedding(embInput);
          const imp = is_starred ? Math.min(9, diffImportance(sim) + 1) : diffImportance(sim);
          const upsertResult = await upsertKnowledge(supabase, {
            title: compResult.title,
            content: compResult.rule,
            category: "pattern",
            importance: imp,
            conversation_state: compState,
            source_example_id: id,
            ...(embedding ? { embedding } : {}),
          });
          if (upsertResult === "inserted" || upsertResult === "merged") learned++;
        }
      }
      await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
      processed++;
      continue; // 通常の full-message analyzeDiff はスキップ
    }

    const result = await analyzeDiff(customer_message, ai_draft, sent_reply, conversation_state);

    // AI呼び出し失敗時は diff_analyzed_at をマークせず、次回Cronで再試行
    if (result === null) {
      processed++;
      continue;
    }

    if (!result.skip && result.title && result.rule) {
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
      headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {},
    }).catch(() => {});
  }

  return NextResponse.json({ ok: true, processed, learned, message: `${processed}件処理・${learned}件学習` });
}

export async function GET(req: NextRequest) {
  // Vercel Cron からの呼び出しを CRON_SECRET で認証（#15）
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== "Bearer " + cronSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return POST(req);
}
