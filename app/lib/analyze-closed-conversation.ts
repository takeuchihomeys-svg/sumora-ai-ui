import { supabase } from "@/app/lib/supabase";
import { generateEmbedding } from "@/app/lib/knowledge-utils";

// ── 申込/成約確定時の会話全体分析（Opus 4.8）─────────────────────────────────
// conversations.status が applying / closed_won に変わった瞬間に呼ばれ、
// 問い合わせ〜申込/成約までの全メッセージを分析して成約パターンを高品質に蓄積する。
// 保存先（5箇所）:
//   A. winning_pattern_logs（確定成約事例・was_correct=true）
//   B. ai_reply_knowledge（成約パターン・importance 9）
//   C. ai_reply_knowledge（転換点・importance 8）
//   D. property_customers.personality_profile（確定プロファイル）
//   E. ai_prompts key=closed_analysis_{conversationId}（重複防止 + 参照用）

export type ClosedOutcome = "applying" | "closed_won";

export type ClosedAnalysisResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
};

type AnalysisJson = {
  personality_profile?: string;
  winning_pattern?: string;
  turning_point?: string;
  what_worked?: string;
  human_type_label?: string;
};

// Opus 4.8 直接呼び出し（eval-winning-pattern の callSonnet と同パターン）
// ※ Opus 4.8 は temperature 等のサンプリングパラメータを受け付けない（400）ため付けない
async function callOpus(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "");
  if (!apiKey) return "";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(90_000),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      console.warn("[analyze-closed] Opus API error:", res.status, await res.text().catch(() => ""));
      return "";
    }
    const data = await res.json() as { content?: Array<{ type?: string; text?: string }> };
    return data.content?.find((b) => b.type === "text")?.text?.trim() || "";
  } catch (e) {
    console.warn("[analyze-closed] Opus呼び出し失敗:", e);
    return "";
  }
}

// 全メッセージを「[顧客] テキスト」形式にフォーマット（各200字・合計8000字上限）
// 上限超過時は先頭3000字（初回問い合わせの文脈）+ 末尾5000字（申込直前の転換点）を残す
function formatMessages(msgs: Array<{ sender: string; text: string }>): string {
  const full = msgs
    .map((m) => `[${m.sender === "customer" ? "顧客" : "スタッフ"}] ${(m.text || "").slice(0, 200)}`)
    .join("\n");
  if (full.length <= 8000) return full;
  return `${full.slice(0, 3000)}\n...(中略)...\n${full.slice(-5000)}`;
}

export async function analyzeClosedConversation(
  conversationId: string,
  outcome: ClosedOutcome
): Promise<ClosedAnalysisResult> {
  const dedupeKey = `closed_analysis_${conversationId}`;

  // 1. 重複防止チェック（同一会話の再分析防止）
  const { data: existing } = await supabase
    .from("ai_prompts")
    .select("key")
    .eq("key", dedupeKey)
    .maybeSingle();
  if (existing) {
    return { ok: true, skipped: true, reason: "already_analyzed" };
  }

  // 2. 全メッセージ + 顧客基本情報を取得
  const { data: conv } = await supabase
    .from("conversations")
    .select("property_customer_id")
    .eq("id", conversationId)
    .maybeSingle();
  const pcId = (conv as { property_customer_id?: string | null } | null)?.property_customer_id ?? null;

  const { data: msgRows, error: msgErr } = await supabase
    .from("messages")
    .select("sender, text, created_at")
    .eq("conversation_id", conversationId)
    .neq("text", "[画像]")
    .neq("text", "[動画]")
    .not("text", "is", null)
    .order("created_at", { ascending: true });
  if (msgErr) {
    return { ok: false, error: `messages取得失敗: ${msgErr.message}` };
  }
  const msgs = (msgRows ?? []) as Array<{ sender: string; text: string }>;
  if (msgs.length < 3) {
    return { ok: true, skipped: true, reason: "too_few_messages" };
  }

  let customerInfo = "";
  if (pcId) {
    const { data: pc } = await supabase
      .from("property_customers")
      .select("customer_name, desired_area, rent_min, rent_max, floor_plan, move_in_time, preferences, ng_points, other_requests")
      .eq("id", pcId)
      .maybeSingle();
    if (pc) {
      const c = pc as {
        customer_name?: string | null; desired_area?: string | null;
        rent_min?: number | null; rent_max?: number | null;
        floor_plan?: string | null; move_in_time?: string | null;
        preferences?: string | null; ng_points?: string | null; other_requests?: string | null;
      };
      const rentStr = (c.rent_min || c.rent_max)
        ? `${c.rent_min ? Math.floor(c.rent_min / 10000) + "万〜" : "〜"}${c.rent_max ? Math.floor(c.rent_max / 10000) + "万" : ""}`
        : null;
      customerInfo = [
        c.desired_area && `希望エリア: ${c.desired_area}`,
        rentStr && `家賃: ${rentStr}`,
        c.floor_plan && `間取り: ${c.floor_plan}`,
        c.move_in_time && `入居時期: ${c.move_in_time}`,
        c.preferences && `こだわり: ${c.preferences}`,
        c.ng_points && `NG条件: ${c.ng_points}`,
        c.other_requests && `その他希望: ${c.other_requests}`,
      ].filter(Boolean).join("\n");
    }
  }

  const outcomeLabel = outcome === "closed_won" ? "成約" : "申込";

  // 3. Opus 4.8 で分析
  const prompt = `あなたは賃貸仲介営業の成約分析の専門家です。
以下は問い合わせから${outcomeLabel}までの実際の会話全文です。

【会話全文】
${formatMessages(msgs)}

【顧客基本情報】
${customerInfo || "（登録情報なし）"}

以下をJSONで返してください：

{
  "personality_profile": "この顧客の人間性・行動パターンを100字以内で。response_style（即レス/ゆっくり等）・decision_style（即決/比較検討/不安が多い等）・emotional_trigger（何で動いたか）・hesitation_pattern（どこで止まったか）・engagement_level（高/中/低）を含めること",
  "winning_pattern": "この顧客タイプで${outcomeLabel}に至った決め手・勝ち筋を50字以内で",
  "turning_point": "会話の中で顧客の態度が前向きに変わった瞬間・きっかけを1〜2文で",
  "what_worked": "スタッフが取った行動のうち最も効果があったもの（具体的に）",
  "human_type_label": "このタイプの顧客を一言で表すラベル（例：安心重視・慎重派、費用最優先・即決型、比較検討・背中押し型 等）"
}`;

  const rawText = await callOpus(prompt);
  if (!rawText) {
    return { ok: false, error: "Opus応答なし" };
  }

  let result: AnalysisJson = {};
  try {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) result = JSON.parse(match[0]) as AnalysisJson;
  } catch {
    // fall through
  }
  if (!result.winning_pattern || !result.personality_profile) {
    return { ok: false, error: "分析JSONの解析に失敗（保存せず終了・cronで再試行可能）" };
  }

  const label = result.human_type_label || "タイプ不明";

  // 4-E. ai_prompts に保存（重複防止 + 参照用）— 最初に書いて多重実行を防ぐ
  await supabase.from("ai_prompts").upsert({
    key: dedupeKey,
    label: `成約分析: ${label}（${outcomeLabel}）`,
    content: JSON.stringify({
      outcome,
      analyzed_at: new Date().toISOString(),
      message_count: msgs.length,
      ...result,
    }),
    updated_at: new Date().toISOString(),
  }, { onConflict: "key" });

  // 4-A. winning_pattern_logs に確定成約事例として INSERT
  const { error: logErr } = await supabase.from("winning_pattern_logs").insert({
    conversation_id: conversationId,
    customer_id: pcId,
    predicted_pattern: result.winning_pattern,
    actual_outcome: outcome,
    was_correct: true, // 実際に申込/成約したので確定
    personality_profile: result.personality_profile,
  });
  if (logErr) console.warn("[analyze-closed] winning_pattern_logs insert失敗:", logErr.message);

  // 人間性ベースの pgvector 類似検索（customer-summary の fetchWinningPatterns）で
  // 引けるように personality_profile を embedding 化して付与
  const embedding = await generateEmbedding(result.personality_profile).catch(() => null);
  const embeddingField = embedding ? { embedding: JSON.stringify(embedding) } : {};

  // 4-B. ai_reply_knowledge: 高品質成約パターン（importance 9）
  const { error: kErr1 } = await supabase.from("ai_reply_knowledge").insert({
    category: "pattern",
    title: `[成約分析] ${label}`.slice(0, 100),
    content: `${result.winning_pattern}\n---\n転換点: ${result.turning_point ?? ""}\n効果: ${result.what_worked ?? ""}`,
    importance: 9,
    personality_tags: result.personality_profile,
    conversation_state: "applying",
    ...embeddingField,
  });
  if (kErr1) console.warn("[analyze-closed] ai_reply_knowledge(成約分析) insert失敗:", kErr1.message);

  // 4-C. ai_reply_knowledge: 転換点（importance 8）
  const { error: kErr2 } = await supabase.from("ai_reply_knowledge").insert({
    category: "pattern",
    title: `[転換点] ${label}`.slice(0, 100),
    content: `${result.turning_point ?? ""}\n→ ${result.what_worked ?? ""}`,
    importance: 8,
    personality_tags: result.personality_profile,
    conversation_state: "proposing",
    ...embeddingField,
  });
  if (kErr2) console.warn("[analyze-closed] ai_reply_knowledge(転換点) insert失敗:", kErr2.message);

  // 4-D. property_customers に確定プロファイルを UPDATE
  if (pcId) {
    const { error: pcErr } = await supabase
      .from("property_customers")
      .update({ personality_profile: result.personality_profile })
      .eq("id", pcId);
    if (pcErr) console.warn("[analyze-closed] property_customers update失敗:", pcErr.message);
  }

  return { ok: true };
}
