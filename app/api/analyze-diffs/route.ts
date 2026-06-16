import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// AIドラフトと実送信の差分を比較して学習ルールを抽出
async function analyzeDiff(
  customerMessage: string,
  aiDraft: string,
  sentReply: string,
  conversationState: string,
): Promise<{ skip: boolean; title?: string; rule?: string; category?: string } | null> {
  try {
    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: `AIが生成した下書きとスタッフが実際に送った返信を比較して、改善パターンを抽出してください。

【お客様のメッセージ】
${customerMessage || "不明"}

【AIの下書き】
${aiDraft}

【スタッフが実際に送った返信】
${sentReply}

【フェーズ】${conversationState}

以下の場合は {"skip":true} のみ返す：
- 物件名・金額・日時・住所・顧客名など固有情報だけが違う
- 誤字修正のみ（1〜2文字の変更）
- 文末の「！」の有無のみ
- 意味のある改善パターンが読み取れない（ほぼ同じ内容）

意味のある改善がある場合、必ずJSON形式で返す：
{"skip":false,"title":"差分学習: [何のパターンか（25文字以内・具体的に）]","rule":"[具体的なルール。NGとOK例を明示。200文字以内]","category":"pattern"}

JSONのみを返す。説明文は不要。`,
      }],
    });

    const text = res.content[0].type === "text" ? res.content[0].text.trim() : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as { skip: boolean; title?: string; rule?: string; category?: string };
  } catch {
    return null;
  }
}

export async function POST() {
  // 未処理の差分を最大15件取得
  const { data: examples } = await supabase
    .from("ai_reply_examples")
    .select("id, customer_message, ai_draft, sent_reply, conversation_state")
    .eq("was_ai_modified", true)
    .is("diff_analyzed_at", null)
    .not("ai_draft", "is", null)
    .not("sent_reply", "is", null)
    .order("created_at", { ascending: false })
    .limit(15);

  if (!examples || examples.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, learned: 0, message: "処理対象なし" });
  }

  let processed = 0;
  let learned = 0;
  const now = new Date().toISOString();

  for (const ex of examples) {
    const { id, customer_message, ai_draft, sent_reply, conversation_state } = ex as {
      id: string;
      customer_message: string;
      ai_draft: string;
      sent_reply: string;
      conversation_state: string;
    };

    // 差分が小さい場合はスキップ（文字数差10文字以下）
    const lenDiff = Math.abs((ai_draft?.length ?? 0) - (sent_reply?.length ?? 0));
    if (lenDiff < 10) {
      await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
      processed++;
      continue;
    }

    const result = await analyzeDiff(customer_message, ai_draft, sent_reply, conversation_state);

    if (result && !result.skip && result.title && result.rule) {
      // 重複チェック（同じキーワードのタイトルが既にあれば登録しない）
      const keyword = result.title.replace("差分学習: ", "").slice(0, 12);
      const { data: existing } = await supabase
        .from("ai_reply_knowledge")
        .select("id")
        .ilike("title", `%${keyword}%`)
        .limit(1);

      if (!existing || existing.length === 0) {
        await supabase.from("ai_reply_knowledge").insert({
          title: result.title,
          content: result.rule,
          category: result.category ?? "pattern",
          conversation_state: conversation_state ?? "proposing",
          importance: 8,
          source_example_id: id,
        });
        learned++;
      }
    }

    await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
    processed++;
  }

  // 学習済みナレッジのembeddingを即座にバックフィル
  if (learned > 0) {
    void fetch(`${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/backfill-embeddings`, {
      method: "POST",
    }).catch(() => {});
  }

  return NextResponse.json({ ok: true, processed, learned, message: `${processed}件処理・${learned}件学習` });
}

export async function GET() {
  return POST();
}
