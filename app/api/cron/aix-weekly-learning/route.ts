import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

let _supabase: ReturnType<typeof createClient> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSupabase(): any {
  if (!_supabase) {
    _supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _supabase;
}

const AIX_ACTIONS = [
  "property_recommendation","property_send","viewing_invite","meeting_place",
  "application_push","condition_hearing","estimate_sheet","property_check_result",
  "greeting_viewing","followup_revive","acknowledge_check"
];

const ACTION_LABELS: Record<string, string> = {
  property_recommendation: '物件オススメ',
  property_send: '物件ピックアップ',
  viewing_invite: '内覧へ',
  meeting_place: '待ち合わせ',
  application_push: '申込へ',
  condition_hearing: '条件ヒアリング',
  estimate_sheet: '見積書',
  property_check_result: '物件確認した',
  greeting_viewing: '挨拶（内覧前後）',
  followup_revive: '追客する',
  acknowledge_check: '確認します',
};

// Special actions with no current boundary rule — trigger at lower threshold
const UNDEFINED_BOUNDARY_ACTIONS = new Set(['acknowledge_check', 'followup_revive', 'greeting_viewing']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function detectBoundaryAmbiguity(supabase: any): Promise<number> {
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  let questionCount = 0;
  const MAX_QUESTIONS = 3;

  try {
    // Signal A: AIX生成→送信されなかった (discarded) — grouped by action_type
    const { data: discardedRows } = await supabase
      .from("aix_generate_log")
      .select("action_type")
      .eq("status", "discarded")
      .gte("created_at", fourteenDaysAgo);

    const discardCounts: Record<string, number> = {};
    for (const row of discardedRows ?? []) {
      if (row.action_type) discardCounts[row.action_type] = (discardCounts[row.action_type] ?? 0) + 1;
    }

    // Signal B: suggestion_bypassed — grouped by action_type
    const { data: bypassedRows } = await supabase
      .from("action_pattern_logs")
      .select("action_type")
      .eq("source", "suggestion_bypassed")
      .gte("created_at", fourteenDaysAgo);

    const bypassCounts: Record<string, number> = {};
    for (const row of bypassedRows ?? []) {
      if (row.action_type) bypassCounts[row.action_type] = (bypassCounts[row.action_type] ?? 0) + 1;
    }

    for (const actionType of AIX_ACTIONS) {
      if (questionCount >= MAX_QUESTIONS) break;

      const discards = discardCounts[actionType] ?? 0;
      const bypasses = bypassCounts[actionType] ?? 0;
      const isUndefined = UNDEFINED_BOUNDARY_ACTIONS.has(actionType);

      // Threshold: lower for undefined actions
      const discardThreshold = isUndefined ? 2 : 3;
      const shouldTrigger = discards >= discardThreshold || bypasses >= discardThreshold || (discards >= 2 && bypasses >= 1);

      if (!shouldTrigger) continue;

      const actionLabel = ACTION_LABELS[actionType] ?? actionType;

      // Dedup check: don't re-raise same question within 14 days
      const questionPrefix = `【線引き質問】AIX「${actionLabel}`;
      const { data: existing } = await supabase
        .from("ai_feedback_items")
        .select("id")
        .ilike("question", `${questionPrefix}%`)
        .gte("created_at", fourteenDaysAgo)
        .limit(1);

      if (existing && existing.length > 0) continue;

      const questionText = `【線引き質問】AIX「${actionLabel}」vs 通常返信AI — 担当範囲の確定

過去14日間のデータ:
・AIXが生成したが送信されなかった件数: ${discards}件
・AIX提案をスタッフがスルーした件数: ${bypasses}件
${isUndefined ? "※このアクションは現在【AIXとの役割分担】ルールに明示されていない曖昧領域です。" : ""}
質問: AIX「${actionLabel}」はどのような場面で使うべきですか？通常返信AIとの役割をはっきりさせてください。
例: 「〇〇の場面はAIX専用」「〇〇の時は通常AIで対応」など具体的に教えてください。

[aix_boundary_action:${actionType}]`;

      await getSupabase().from("ai_feedback_items").insert({
        question: questionText,
        speculation: `AIXと通常返信AIの担当範囲が曖昧で、スタッフがAIX提案をスルーしているパターンを検出`,
        category: "aix_boundary",
        confidence: 0.8,
        entry_source: "boundary_analysis",
        aix_action: actionType,
        status: "pending",
      });

      questionCount++;
    }
  } catch (e) {
    console.error("detectBoundaryAmbiguity error:", e);
  }

  return questionCount;
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ビルド時の環境変数未定義を避けるため、クライアントはここで初期化する
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // ISO week number for idempotent rule keys
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
  const weekKey = `${now.getFullYear()}W${String(weekNum).padStart(2, '0')}`;

  const results: Record<string, number> = {};

  for (const actionType of AIX_ACTIONS) {
    try {
      // Fetch AIX edits for this action from past 7 days
      const { data: examples } = await supabase
        .from("ai_reply_examples")
        .select("customer_message, ai_draft, sent_reply, conversation_id")
        .eq("entry_source", "aix_action")
        .eq("aix_action", actionType)
        .eq("was_ai_modified", true)
        .gte("created_at", sevenDaysAgo)
        .not("ai_draft", "is", null)
        .not("sent_reply", "is", null)
        .order("created_at", { ascending: false })
        .limit(15);

      if (!examples || examples.length < 2) {
        results[actionType] = 0;
        continue;
      }

      // Format examples for Opus
      const examplesText = examples.map((ex, i) =>
        `【編集例${i + 1}】\nAI生成:\n${ex.ai_draft?.slice(0, 300) ?? ""}\n\nスタッフ送信:\n${ex.sent_reply?.slice(0, 300) ?? ""}`
      ).join("\n\n---\n\n");

      const systemPrompt = `あなたはLINE賃貸営業AIシステムの品質改善エンジニアです。
AIXボタン「${actionType}」で生成されたテキストをスタッフが修正した事例を分析し、
繰り返し発生している修正パターンから改善ルールを抽出してください。

出力形式（JSON配列、厳守）:
[
  {"rule": "ルール文（日本語・100字以内・具体的・actionable）", "reason": "なぜこの修正が繰り返されるか"}
]

ルール抽出の基準:
- 複数の編集例に共通する修正パターンのみ抽出（1例だけの特殊ケースは除外）
- 「〜を避ける」「〜の場合は〜にする」など具体的な行動指示として書く
- 最大3個まで
- 共通パターンが見つからない場合は空配列 [] を返す`;

      const response = await anthropic.messages.create({
        model: "claude-opus-5",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: `以下は過去7日間の「${actionType}」アクションでスタッフが修正した編集例です:\n\n${examplesText}\n\n繰り返しの修正パターンからルールを抽出してください。`
        }],
        system: systemPrompt,
      });

      const rawText = response.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text ?? "";
      const jsonMatch = rawText.match(/\[\s*[\s\S]*?\]/);
      if (!jsonMatch) { results[actionType] = 0; continue; }

      const rules: { rule: string; reason: string }[] = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(rules) || rules.length === 0) { results[actionType] = 0; continue; }

      let saved = 0;
      for (let i = 0; i < rules.length; i++) {
        const ruleKey = `LEARN-AIX-${actionType}-${weekKey}-${i + 1}`;
        await getSupabase().from("ai_prompt_rules").upsert({
          rule_key: ruleKey,
          rule_text: rules[i].rule,
          action_type: actionType,
          priority: 6,
          is_active: true,
          is_permanent: false,
          reason: `週次AIX学習（${weekKey}）: ${rules[i].reason}`,
        }, { onConflict: "rule_key", ignoreDuplicates: true });
        saved++;
      }
      results[actionType] = saved;
    } catch (e) {
      console.error(`aix-weekly-learning error for ${actionType}:`, e);
      results[actionType] = -1;
    }
  }

  const boundaryQuestions = await detectBoundaryAmbiguity(supabase);

  return NextResponse.json({ ok: true, weekKey, results, boundaryQuestions });
}
