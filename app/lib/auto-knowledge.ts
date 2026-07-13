// auto-knowledge のコアロジック（AI案 vs 送信文の差分から修正ルールを抽出してナレッジ化）
// 401修正: 以前は app/page.tsx が /api/auto-knowledge をAuthorizationヘッダなしでfetchしており
// 常に401で学習が停止していた。HTTPを介さずサーバー側（save-reply-example PATCH の after()）から
// この関数を直接呼ぶ構成に変更。/api/auto-knowledge ルート（cron/手動用）も同じ関数を使う。
import { supabase } from "@/app/lib/supabase";
import { upsertKnowledge, generateEmbedding } from "@/app/lib/knowledge-utils";

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
        temperature: 0,
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

export type AutoKnowledgeResult = {
  ok: boolean;
  reason?: string;
  rule?: string;
  upsertResult?: string;
};

export async function learnFromModifiedExample(params: {
  exampleId?: string;
  aiDraft: string;
  sentReply: string;
  conversationState?: string;
  customerMessage?: string;
}): Promise<AutoKnowledgeResult> {
  const aiDraft = params.aiDraft;
  const sentReply = params.sentReply;
  const conversationState = params.conversationState ?? "hearing";
  const customerMessage = params.customerMessage ?? "";

  if (!aiDraft?.trim() || !sentReply?.trim()) {
    return { ok: false, reason: "missing fields" };
  }

  // AIと送信文が同じなら学習不要
  if (aiDraft.trim() === sentReply.trim()) {
    return { ok: false, reason: "no diff" };
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
      return { ok: false, reason: "diff too small" };
    }
  }

  const normalized = (STATE_NORMALIZE[conversationState] ?? conversationState) || "hearing";

  const extracted = await extractCorrectionRule(aiDraft, sentReply, normalized, customerMessage);

  if (!extracted) {
    return { ok: false, reason: "extraction skipped or failed" };
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
    ...(params.exampleId ? { source_example_id: params.exampleId } : {}), // BUG-12: 元実例IDを記録
  });

  if (upsertResult.result === "merged") {
    console.log(`[auto-knowledge] 既存ルール強化: "${rule.slice(0, 50)}"`);
  } else if (upsertResult.result === "skipped") {
    console.log(`[auto-knowledge] スキップ（重複）: "${rule.slice(0, 50)}"`);
  } else if (upsertResult.result === "inserted") {
    // 新規ルール → ai_prompt_rules に非アクティブ候補として即座に登録
    // （翌朝 analyze-diffs で confirmed になると is_active=true・priority=8 に昇格）
    try {
      // upsertKnowledge が id を返すようになったため直接利用（DB再クエリ不要）
      const newId = upsertResult.id;
      if (newId) {
        await supabase.from("ai_prompt_rules").upsert({
          rule_key: `LEARN-${newId}`,
          action_type: "generate_reply",
          condition_key: normalized ? "conversation_state" : null,
          condition_value: normalized ?? null,
          rule_text: enrichedContent.slice(0, 500),
          reason: `auto-knowledge候補（importance=8）。confirmed後に自動アクティブ化`,
          priority: 4,
          is_active: false,
        }, { onConflict: "rule_key", ignoreDuplicates: true });
        console.log(`[auto-knowledge] ai_prompt_rules候補登録: LEARN-${newId}`);
      }
    } catch { /* ignore */ }
  }

  return { ok: true, rule, upsertResult: upsertResult.result };
}
