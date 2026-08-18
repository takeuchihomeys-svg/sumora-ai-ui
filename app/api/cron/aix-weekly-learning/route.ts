import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { PROPERTY_CHECK_RESULT_LABEL } from "@/app/lib/aix-taxonomy";
import { safeInsertAiQuestion } from "@/app/lib/ai-feedback-guard";

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
  property_check_result: PROPERTY_CHECK_RESULT_LABEL,
  greeting_viewing: '挨拶（内覧前後）',
  followup_revive: '追客する',
  acknowledge_check: '確認します',
};

// property_check_result の check_pattern → UIボタン導線名（線引き質問にそのまま記載する）
// 竹内さんがどのボタンの話か即座に分かるよう、実際のUI導線（親ボタン→子ボタン）で表記する
const CHECK_PATTERN_UI_LABELS: Record<string, string> = {
  available: '物件確認した→物件あった',
  alternative: '物件確認した→別の部屋が募集してた',
  unavailable: '物件確認した→物件なかった',
  exclusive: '物件確認した→専任物件だった',
  move_in_date: '物件確認した→入居日確認した',
  interior_photo: '物件確認した→室内写真を確認した',
  other_room_check: '物件確認した→別の部屋について確認した',
  mgmt_availability: '確認した（条件・交渉）→管理会社に確認した→募集状況',
  vacate_date: '確認した（条件・交渉）→管理会社に確認した→退去予定日',
  mgmt_move_in: '確認した（条件・交渉）→管理会社に確認した→入居日',
  mgmt_initial_cost: '確認した（条件・交渉）→管理会社に確認した→初期費用',
  mgmt_guarantor: '確認した（条件・交渉）→管理会社に確認した→保証会社',
  mgmt_parking: '確認した（条件・交渉）→管理会社に確認した→駐車場',
  mgmt_pet: '確認した（条件・交渉）→管理会社に確認した→ペット飼育',
  mgmt_equipment: '確認した（条件・交渉）→管理会社に確認した→設備',
  nearby_parking: '確認した（条件・交渉）→近隣の月極駐車場を確認した',
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
    // property_check_result のみ check_pattern 粒度（空室系と条件系で境界ルールが混線しないよう分割）。
    // check_pattern が残っている行は "property_check_result|mgmt_guarantor" 形式のキー、
    // 無い行（旧ログ）は "property_check_result" にフォールバック集計する。
    const { data: discardedRows } = await supabase
      .from("aix_generate_log")
      .select("action_type, check_pattern")
      .eq("status", "discarded")
      .gte("created_at", fourteenDaysAgo);

    const discardCounts: Record<string, number> = {};
    for (const row of discardedRows ?? []) {
      if (!row.action_type) continue;
      const key = row.action_type === "property_check_result" && row.check_pattern
        ? `property_check_result|${row.check_pattern}`
        : row.action_type;
      discardCounts[key] = (discardCounts[key] ?? 0) + 1;
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

    // 集計ターゲット: 通常アクションは action_type 単位、property_check_result は check_pattern 単位に分割。
    // check_pattern なしの property_check_result ターゲットも残す（旧ログ + bypass シグナル用）。
    const targets: Array<{ actionType: string; checkPattern: string | null }> = [];
    for (const actionType of AIX_ACTIONS) {
      if (actionType === "property_check_result") {
        for (const key of Object.keys(discardCounts)) {
          if (key.startsWith("property_check_result|")) {
            targets.push({ actionType, checkPattern: key.slice("property_check_result|".length) });
          }
        }
      }
      targets.push({ actionType, checkPattern: null });
    }

    for (const { actionType, checkPattern } of targets) {
      if (questionCount >= MAX_QUESTIONS) break;

      const countKey = checkPattern ? `${actionType}|${checkPattern}` : actionType;
      const discards = discardCounts[countKey] ?? 0;
      // action_pattern_logs（bypass）には check_pattern が無いため、
      // action_type 全体ターゲットにのみ計上する（check_pattern 別ターゲットとの二重カウント防止）
      const bypasses = checkPattern ? 0 : (bypassCounts[actionType] ?? 0);
      const isUndefined = !checkPattern && UNDEFINED_BOUNDARY_ACTIONS.has(actionType);

      // Threshold: lower for undefined actions
      const discardThreshold = isUndefined ? 2 : 3;
      const shouldTrigger = discards >= discardThreshold || bypasses >= discardThreshold || (discards >= 2 && bypasses >= 1);

      if (!shouldTrigger) continue;

      // check_pattern 粒度ならUI導線名（例: 確認した（条件・交渉）→管理会社に確認した→保証会社）で表記
      const actionLabel = checkPattern
        ? (CHECK_PATTERN_UI_LABELS[checkPattern] ?? `${ACTION_LABELS[actionType] ?? actionType}（${checkPattern}）`)
        : (ACTION_LABELS[actionType] ?? actionType);

      // Dedup check: don't re-raise same question within 14 days
      const questionPrefix = `【線引き質問】AIX「${actionLabel}`;
      const { data: existing } = await supabase
        .from("ai_feedback_items")
        .select("id")
        .ilike("question", `${questionPrefix}%`)
        .gte("created_at", fourteenDaysAgo)
        .limit(1);

      if (existing && existing.length > 0) continue;

      // タグ: check_pattern があれば [aix_boundary_action:property_check_result|mgmt_guarantor] 形式。
      // ai-feedback 側がこれをパースし BOUNDARY-*-aix を condition_key='check_pattern' で保存する
      const boundaryTag = checkPattern ? `${actionType}|${checkPattern}` : actionType;
      const questionText = `【線引き質問】AIX「${actionLabel}」vs 通常返信AI — 担当範囲の確定

過去14日間のデータ:
・AIXが生成したが送信されなかった件数: ${discards}件
・AIX提案をスタッフがスルーした件数: ${bypasses}件
${isUndefined ? "※このアクションは現在【AIXとの役割分担】ルールに明示されていない曖昧領域です。" : ""}
質問: AIXボタン「${actionLabel}」はどのような場面で使うべきですか？通常返信AIとの役割をはっきりさせてください。
例: 「〇〇の場面はAIX専用」「〇〇の時は通常AIで対応」など具体的に教えてください。

[aix_boundary_action:${boundaryTag}]`;

      // pending上限ガード（MAX_PENDING / aix_action×categoryハードキャップ）経由で起票する
      const inserted = await safeInsertAiQuestion({
        question: questionText,
        speculation: `AIXと通常返信AIの担当範囲が曖昧で、スタッフがAIX提案をスルーしているパターンを検出`,
        category: "aix_boundary",
        confidence: "0.8",
        entry_source: "boundary_analysis",
        aix_action: actionType,
      });
      if (!inserted) continue;

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

      // Brain コンテキスト一括取得（fail-open: conversation_id はすでに SELECT 済み）
      const exConvIds = (examples as Array<{ conversation_id?: string | null }>)
        .map(e => e.conversation_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      const brainByConvId = new Map<string, Record<string, unknown>>();
      if (exConvIds.length > 0) {
        try {
          const { data: brainRows } = await supabase
            .from("conversations")
            .select("id, suggested_aix_meta, property_customers(ai_summary_json)")
            .in("id", exConvIds);
          for (const row of (brainRows ?? []) as Array<{ id: string; suggested_aix_meta: unknown; property_customers: unknown }>) {
            const meta = (row.suggested_aix_meta as Record<string, unknown> | null) ?? {};
            const customer = Array.isArray(row.property_customers)
              ? (row.property_customers[0] as Record<string, unknown> | null)
              : (row.property_customers as Record<string, unknown> | null);
            const summary = (customer?.ai_summary_json as Record<string, unknown> | null) ?? {};
            brainByConvId.set(row.id, { ...meta, ...summary });
          }
        } catch { /* fail-open */ }
      }

      // Format examples for Opus（Brainラベル付き）
      const examplesText = (examples as Array<{ ai_draft?: string; sent_reply?: string; conversation_id?: string | null }>).map((ex, i) => {
        const exBrain = brainByConvId.get(ex.conversation_id ?? "") ?? {};
        const brainParts = [
          exBrain.emotion ? "emotion:" + String(exBrain.emotion) : "",
          exBrain.urgency ? "urgency:" + String(exBrain.urgency) : "",
          exBrain.reply_mode ? "mode:" + String(exBrain.reply_mode) : "",
        ].filter(Boolean);
        const brainTag = brainParts.length > 0 ? ` [${brainParts.join(" ")}]` : "";
        return `【編集例${i + 1}】${brainTag}\nAI生成:\n${ex.ai_draft?.slice(0, 300) ?? ""}\n\nスタッフ送信:\n${ex.sent_reply?.slice(0, 300) ?? ""}`;
      }).join("\n\n---\n\n");

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
- 共通パターンが見つからない場合は空配列 [] を返す
- 各編集例の [emotion/urgency/mode] ラベルを参照し、特定の顧客状況に依存するパターンがあれば条件付きルールとして記述すること（例: urgency=高の場合は〜、emotion=不安の場合は〜）`;

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
