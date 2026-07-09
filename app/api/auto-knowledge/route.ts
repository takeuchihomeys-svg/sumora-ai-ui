import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { upsertKnowledge, generateEmbedding } from "@/app/lib/knowledge-utils";

export const maxDuration = 60;

const STATE_NORMALIZE: Record<string, string> = {
  condition_hearing: "hearing", property_search: "hearing",
  property_recommendation: "proposing", viewing: "proposing",
  estimate_request: "proposing", availability_check: "proposing",
  application: "applying", screening: "applying", contract: "applying",
};

async function extractCorrectionRule(
  aiDraft: string,
  sentReply: string,
  state: string,
  customerMessage: string,
): Promise<{ rule: string; category: string } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "");
  if (!apiKey) return null;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        system: `賃貸仲介LINEのAI文案とスタッフが実際に送った文を比較し、次回以降のAIが学べる改善ルールを抽出してください。

出力形式（JSONのみ）:
{"rule":"AIは〜としたが、正しくは〜（60字以内・具体的に）","category":"pattern|style|phrase|principle のいずれか"}

categoryの判断基準:
- pattern: 何を書くか・何を省くか・構成順序
- style: 丁寧さ・語調・言い回しの傾向
- phrase: 特定のフレーズを使う/避ける
- principle: 顧客対応の原則・考え方

以下の場合は {"skip":true} のみ返すこと:
・誤字修正・句読点・絵文字だけの変更
・本質的に同じ内容の言い換えのみ
・「もっと丁寧に」など抽象的すぎてAIが再現できないもの
・個別案件にしか当てはまらない内容`,
        messages: [{
          role: "user",
          content: `【営業フェーズ】${state}
【お客様メッセージ】${customerMessage.slice(0, 150)}

【AIが生成した文】
${aiDraft.slice(0, 500)}

【スタッフが実際に送った文】
${sentReply.slice(0, 500)}`,
        }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) return null;
    const data = await res.json() as { content?: Array<{ text: string }> };
    const text = data.content?.[0]?.text?.trim() || "";
    if (!text) return null;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { skip?: boolean; rule?: string; category?: string };
    if (parsed.skip || !parsed.rule || parsed.rule.length < 15) return null;
    // BUG-10: principleはsave-reply-exampleで審査済みのものだけ保存。auto-knowledgeからは除外
    const category = ["pattern", "style", "phrase"].includes(parsed.category ?? "")
      ? (parsed.category as string)
      : "pattern";
    return { rule: parsed.rule, category };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await req.json() as {
      example_id?: string;
      aiDraft?: string;
      sentReply?: string;
      conversationState?: string;
      customerMessage?: string;
    };

    let aiDraft: string;
    let sentReply: string;
    let conversationState: string;
    let customerMessage: string;

    // example_id 指定: DBから実例データを取得（☆トリガー用）
    if (body.example_id) {
      const { data: ex } = await supabase
        .from("ai_reply_examples")
        .select("ai_draft, sent_reply, conversation_state, customer_message, was_ai_modified")
        .eq("id", body.example_id)
        .single() as { data: { ai_draft?: string | null; sent_reply: string; conversation_state: string; customer_message: string; was_ai_modified: boolean } | null };

      if (!ex || !ex.was_ai_modified || !ex.ai_draft) {
        return NextResponse.json({ ok: false, reason: "no ai modification found" });
      }
      aiDraft = ex.ai_draft;
      sentReply = ex.sent_reply;
      conversationState = ex.conversation_state;
      customerMessage = ex.customer_message;
    } else {
      // 直接フィールド指定（互換性維持）
      if (!body.aiDraft?.trim() || !body.sentReply?.trim()) {
        return NextResponse.json({ ok: false, reason: "missing fields" });
      }
      aiDraft = body.aiDraft;
      sentReply = body.sentReply;
      conversationState = body.conversationState ?? "hearing";
      customerMessage = body.customerMessage ?? "";
    }

    // AIと送信文が同じなら学習不要
    if (aiDraft.trim() === sentReply.trim()) {
      return NextResponse.json({ ok: false, reason: "no diff" });
    }

    // S10: 差分が小さすぎる場合は、数字/否定の意味変化がなければスキップ
    // （単純な言い回し変更を誤学習させない）
    if (Math.abs(aiDraft.length - sentReply.length) < 20) {
      const numsA = aiDraft.match(/\d+/g) ?? [];
      const numsB = sentReply.match(/\d+/g) ?? [];
      const negA = (aiDraft.match(/(?:できません|ございません|ありません|いません|しません|ません)/g) ?? []).length;
      const negB = (sentReply.match(/(?:できません|ございません|ありません|いません|しません|ません)/g) ?? []).length;
      const hasSemanticChange = JSON.stringify(numsA) !== JSON.stringify(numsB) || negA !== negB;
      if (!hasSemanticChange) {
        return NextResponse.json({ ok: false, reason: "diff too small" });
      }
    }

    const normalized = (STATE_NORMALIZE[conversationState] ?? conversationState) || "hearing";

    const extracted = await extractCorrectionRule(aiDraft, sentReply, normalized, customerMessage);

    if (!extracted) {
      return NextResponse.json({ ok: false, reason: "extraction skipped or failed" });
    }

    const { rule, category } = extracted;

    // contentフィールド強化: customerMessageがある場合、先頭に例文を付加
    const enrichedContent = customerMessage
      ? `例: 顧客が「${customerMessage.slice(0, 100)}」と言った場合。${rule}`
      : rule;

    // BUG-08+09: customerMessageが重複しないよう generate-reply の検索クエリと形式を揃える。
    // 検索側は `${state}: ${顧客メッセージ}` で embedding するため保存側も同じ形式。
    // BUG-09: ローカルgetEmbeddingをgenerateEmbedding（キャッシュ付き）に統一。
    const embeddingInput = customerMessage
      ? `${normalized}: ${customerMessage}`.slice(0, 2000)
      : enrichedContent.slice(0, 2000);
    const embedding = await generateEmbedding(embeddingInput).catch(() => null);

    const upsertResult = await upsertKnowledge(supabase, {
      title: "差分学習 [自動]",
      category,
      importance: 8,       // BUG-07: 自動生成ルールは8スタート（save-reply-exampleの手動確認済みより1低く）
      conversation_state: normalized,
      content: enrichedContent,
      ...(embedding !== null ? { embedding } : {}),
      ...(body.example_id ? { source_example_id: body.example_id } : {}), // BUG-12: 元実例IDを記録
    });

    if (upsertResult === "merged") {
      console.log(`[auto-knowledge] 既存ルール強化: "${rule.slice(0, 50)}"`);
    } else if (upsertResult === "skipped") {
      console.log(`[auto-knowledge] スキップ（重複）: "${rule.slice(0, 50)}"`);
    } else if (upsertResult === "inserted") {
      // 新規ルール → ai_prompt_rules に非アクティブ候補として即座に登録
      // （翌朝 analyze-diffs で confirmed になると is_active=true・priority=8 に昇格）
      try {
        const { data: newRow } = await supabase
          .from("ai_reply_knowledge")
          .select("id")
          .eq("title", "差分学習 [自動]")
          .eq("conversation_state", normalized)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (newRow?.id) {
          await supabase.from("ai_prompt_rules").upsert({
            rule_key: `LEARN-${newRow.id as string}`,
            action_type: "generate_reply",
            condition_key: normalized ? "conversation_state" : null,
            condition_value: normalized ?? null,
            rule_text: enrichedContent.slice(0, 500),
            reason: `auto-knowledge候補（importance=8）。confirmed後に自動アクティブ化`,
            priority: 4,
            is_active: false,
          }, { onConflict: "rule_key", ignoreDuplicates: true });
          console.log(`[auto-knowledge] ai_prompt_rules候補登録: LEARN-${newRow.id as string}`);
        }
      } catch { /* ignore */ }
    }

    return NextResponse.json({ ok: true, rule, upsertResult });
  } catch (e) {
    console.error("auto-knowledge error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
