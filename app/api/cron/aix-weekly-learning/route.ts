import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { PROPERTY_CHECK_RESULT_LABEL } from "@/app/lib/aix-taxonomy";
import { safeInsertAiQuestion } from "@/app/lib/ai-feedback-guard";
import { upsertKnowledge, generateEmbedding, buildKnowledgeEmbeddingInput } from "@/app/lib/knowledge-utils";

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

// prompt cache: アクション別編集差分学習（Opus）の静的システムプロンプト。
// 対象のAIXアクション名（動的）は user メッセージに分離する
const AIX_EDIT_DIFF_SYSTEM = `あなたはLINE賃貸営業AIシステムの品質改善エンジニアです。
ユーザーメッセージに渡されるAIXボタン（アクション）で生成されたテキストをスタッフが修正した事例を分析し、
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

// ============================================================
// AIXパターン蒸留（synthesizeAixPatterns・2026-08-29追加）
// corpus2skill の P1（synthesizeSkills）は entry_source='line_reply' 専用で
// AIXバックフィルデータ（aix_template / aix_property / aix_adapt）を一切処理しない。
// そのままでは品質精査ゼロのデータが aix-template-generate / aix/action のRAGに
// 直接使われ続けるため、ここでアクション別に「良い送信パターン」を蒸留して
// ai_reply_knowledge（category='pattern'）に upsert する。
//   - importance=8: generate-reply の min_importance=7 を満たしつつ、
//     corpus2skill の未使用降格（importance>=7 対象）から1段の猶予を持たせる
//   - conversation_state='aix_{action}': 通常返信のステートマッチと衝突しない名前空間
// ============================================================

const AIX_PATTERN_SOURCES = ["aix_template", "aix_property", "aix_adapt"];
const AIX_PATTERN_MAX_ACTIONS = 6;      // 1実行あたりの蒸留対象アクション上限（コスト・時間制御）
const AIX_PATTERN_MIN_EXAMPLES = 3;     // 蒸留に必要な最小実例数
const AIX_PATTERN_EXAMPLES_PER_ACTION = 10;

// prompt cache: アクション横断で共通の静的システムプロンプト。
// アクション名（動的）は user メッセージに分離し、最大6アクション分の呼び出しで同一キャッシュを共有する
const AIX_PATTERN_SYSTEM = `あなたは賃貸仲介LINE営業のコーチです。ユーザーメッセージに渡されるAIXボタン（アクション）で実際に送信された文の実例から、「このアクションの良い送信パターン」を抽出してください。

条件:
- 固有名詞・物件名・日時に依存しない、どの顧客にも使える普遍パターンのみ
- ⭐お客様が反応した実例のパターンを特に重視する
- 各実例に〔Brain文脈〕（Brain推奨action・フェーズ・顧客インテント・成約戦略・勝ちパターン）が付いている場合、「なぜこの送信文がその顧客状況で良かったか」の文脈として使い、条件付きパターン（例: checkpoint_stage=内覧後なら〜）の抽出に活かすこと
- 薄い・当たり前すぎるものは除外（本当に価値のあるものだけ）
- 最大2個まで。価値あるパターンがなければ空配列 [] を返す

出力形式（JSON配列のみ・説明不要）:
[{"title": "パターン名（25文字以内）", "content": "パターンの詳細と使い方（200文字以内）", "trigger": "このパターンが活きる顧客状況の例文（50文字以内）"}]`;

type AixPatternExample = {
  aix_action: string | null;
  entry_source: string;
  conversation_id: string | null;
  customer_message: string | null;
  sent_reply: string | null;
  is_starred: boolean | null;
};

async function synthesizeAixPatterns(
  supabase: SupabaseClient,
  anthropic: Anthropic,
  sevenDaysAgo: string
): Promise<{ actionsProcessed: number; inserted: number; merged: number; skipped: number }> {
  const result = { actionsProcessed: 0, inserted: 0, merged: 0, skipped: 0 };

  const { data: rows, error } = await supabase
    .from("ai_reply_examples")
    .select("aix_action, entry_source, conversation_id, customer_message, sent_reply, is_starred")
    .in("entry_source", AIX_PATTERN_SOURCES)
    .gte("created_at", sevenDaysAgo)
    .not("sent_reply", "is", null)
    .not("aix_action", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    console.warn("[aix-weekly-learning] synthesizeAixPatterns 取得失敗:", error.message);
    return result;
  }

  // Brain/AIX-META コンテキスト一括取得（fail-open）: パターン抽出時に
  // 「なぜこの送信が良かったか」の顧客状況文脈（brain_action・checkpoint_stage・customer_intent等）を渡す
  const patternBrainMap = new Map<string, Record<string, unknown>>();
  try {
    const patternConvIds = [...new Set(
      ((rows ?? []) as AixPatternExample[])
        .map((r) => r.conversation_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    )];
    if (patternConvIds.length > 0) {
      const { data: brainRows } = await supabase
        .from("conversations")
        .select("id, suggested_aix_meta, property_customers(ai_summary_json)")
        .in("id", patternConvIds);
      for (const row of (brainRows ?? []) as Array<{ id: string; suggested_aix_meta: unknown; property_customers: unknown }>) {
        const meta = (row.suggested_aix_meta as Record<string, unknown> | null) ?? {};
        const customer = Array.isArray(row.property_customers)
          ? (row.property_customers[0] as Record<string, unknown> | null)
          : (row.property_customers as Record<string, unknown> | null);
        const summary = (customer?.ai_summary_json as Record<string, unknown> | null) ?? {};
        patternBrainMap.set(row.id, { ...meta, ...summary });
      }
    }
  } catch { /* fail-open: Brain取得失敗時は文脈なしで蒸留を続行 */ }

  // アクション別にグループ化（⭐実例を優先して各アクション最大10件）
  const byAction = new Map<string, AixPatternExample[]>();
  for (const row of (rows ?? []) as AixPatternExample[]) {
    if (!row.aix_action || !row.sent_reply) continue;
    const group = byAction.get(row.aix_action) ?? [];
    group.push(row);
    byAction.set(row.aix_action, group);
  }

  // 実例数の多いアクションから最大6件を処理対象にする
  const targets = [...byAction.entries()]
    .filter(([, examples]) => examples.length >= AIX_PATTERN_MIN_EXAMPLES)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, AIX_PATTERN_MAX_ACTIONS);

  for (const [actionType, examples] of targets) {
    try {
      const picked = [...examples]
        .sort((a, b) => Number(b.is_starred === true) - Number(a.is_starred === true))
        .slice(0, AIX_PATTERN_EXAMPLES_PER_ACTION);

      const examplesText = picked.map((ex, i) => {
        const starLabel = ex.is_starred ? "⭐お客様が反応した実例" : "通常実例";
        // Brain/AIX-META 文脈（取得できた場合のみ付与）
        const b = patternBrainMap.get(ex.conversation_id ?? "") ?? {};
        const brainParts = [
          b.action ? `Brain推奨action: ${String(b.action)}` : "",
          b.checkpoint_stage ? `フェーズ: ${String(b.checkpoint_stage)}` : "",
          b.customer_intent ? `顧客インテント: ${String(b.customer_intent)}` : "",
          b.closing_strategy ? `成約戦略: ${String(b.closing_strategy)}` : "",
          b.winning_pattern ? `勝ちパターン: ${String(b.winning_pattern)}` : "",
        ].filter(Boolean);
        const brainLine = brainParts.length > 0 ? `\n〔Brain文脈〕${brainParts.join(" / ")}` : "";
        return `【実例${i + 1}】[${starLabel} / ${ex.entry_source}]
お客様の状況: ${(ex.customer_message ?? "").replace(/\n/g, " ").slice(0, 150)}${brainLine}
送信文: ${(ex.sent_reply ?? "").slice(0, 300)}`;
      }).join("\n\n");

      const response = await anthropic.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 1200,
        // prompt cache: 静的な抽出指示（AIX_PATTERN_SYSTEM）をキャッシュし、アクション名・実例は user に分離
        system: [
          { type: "text", text: AIX_PATTERN_SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } },
        ],
        messages: [{
          role: "user",
          content: `対象AIXボタン: 「${ACTION_LABELS[actionType] ?? actionType}」（${actionType}）\n\n以下は過去7日間の「${actionType}」アクションの実送信例です:\n\n${examplesText}`,
        }],
      });

      const rawText = response.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text ?? "";
      const jsonMatch = rawText.match(/\[\s*[\s\S]*\]/);
      if (!jsonMatch) { result.skipped++; continue; }
      const patterns: Array<{ title?: string; content?: string; trigger?: string }> = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(patterns) || patterns.length === 0) { result.skipped++; continue; }

      for (const p of patterns.slice(0, 2)) {
        if (!p?.title?.trim() || !p?.content?.trim() || p.content.length < 20) continue;
        const conversationState = `aix_${actionType}`;
        const embeddingInput = buildKnowledgeEmbeddingInput({
          trigger_example: p.trigger,
          content: p.content,
          conversation_state: conversationState,
        });
        const embedding = await generateEmbedding(embeddingInput).catch(() => null);
        const upserted = await upsertKnowledge(supabase, {
          title: `[aix_pattern] ${p.title.trim().slice(0, 40)}`,
          content: p.content.trim(),
          category: "pattern",
          importance: 8, // 自動削除・降格からの保護レベル
          conversation_state: conversationState,
          ...(embedding ? { embedding } : {}),
          ...(p.trigger ? { trigger_example: p.trigger } : {}),
        });
        if (upserted.result === "inserted") result.inserted++;
        else if (upserted.result === "merged") result.merged++;
      }
      result.actionsProcessed++;
    } catch (e) {
      console.error(`[aix-weekly-learning] synthesizeAixPatterns(${actionType}) 失敗:`, e);
      result.skipped++;
    }
  }

  console.log(`[aix-weekly-learning] AIXパターン蒸留: actions=${result.actionsProcessed}, inserted=${result.inserted}, merged=${result.merged}, skipped=${result.skipped}`);
  return result;
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
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    timeout: 120_000,
    maxRetries: 1,
    defaultHeaders: { "anthropic-beta": "prompt-caching-2024-07-31" },
  });

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
      // 2026-08-29: entry_source を aix_action のみ → 全AIXバケットに拡張。
      // aix_template（adapted_text 由来）/ aix_property・aix_adapt（aix_generate_log 由来）にも
      // ai_draft と was_ai_modified がバックフィルされるため、編集差分の学習対象に含める
      const { data: examples } = await supabase
        .from("ai_reply_examples")
        .select("customer_message, ai_draft, sent_reply, conversation_id")
        .in("entry_source", ["aix_action", "aix_template", "aix_property", "aix_adapt"])
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

      const response = await anthropic.messages.create({
        model: "claude-opus-5",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: `対象AIXボタン: 「${actionType}」\n\n以下は過去7日間の「${actionType}」アクションでスタッフが修正した編集例です:\n\n${examplesText}\n\n繰り返しの修正パターンからルールを抽出してください。`
        }],
        // prompt cache: アクション横断で共通の静的指示をキャッシュ（11アクション分の呼び出しで同一キャッシュを共有）。
        // 動的なアクション名・編集例は user メッセージに分離
        system: [
          { type: "text", text: AIX_EDIT_DIFF_SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } },
        ],
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

  // AIXパターン蒸留: aix_template / aix_property / aix_adapt バケットの品質精査ルート
  // （失敗しても編集差分学習・線引き質問の結果は返す）
  const aixPatterns = await synthesizeAixPatterns(supabase, anthropic, sevenDaysAgo).catch((e) => {
    console.error("[aix-weekly-learning] synthesizeAixPatterns 失敗:", e);
    return { actionsProcessed: 0, inserted: 0, merged: 0, skipped: 0 };
  });

  return NextResponse.json({ ok: true, weekKey, results, boundaryQuestions, aixPatterns });
}

// GET: Vercel Cron は GET でリクエストするため、認証チェック後 POST へ委譲する
// （GETエクスポートがないと毎週 405 Method Not Allowed で一度も実行されない — corpus2skill と同じ罠）
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return POST(req);
}
