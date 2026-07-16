import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { upsertKnowledge, generateEmbedding, buildKnowledgeEmbeddingInput } from "@/app/lib/knowledge-utils";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 300;

// ── weekly-learning: 週次バッチ学習 ─────────────────────────────────────────
// chunk=1: 新規diff分析（現行維持）
//   未分析差分40件をグルーピングしクロスパターン分析から新ルールを抽出する
// chunk=2: hypothesis × confirmed 矛盾チェック（新規）
//   全hypothesisを confirmed と照合し、矛盾/冗長をrejectedに落とす
// chunk=3: 品質選別 Stage A/B/C（新規）
//   自動却下SQL → 自動昇格SQL → AI中間層判定
// chunk=4: 重複排除 + 週次質問まとめ（新規）
//   pg_trgm類似ペア→Claude判定→重複廃棄 + AI質問起票
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 40;
const MAX_AI_QUESTIONS_PER_RUN = 5;
const MAX_PENDING_AI_QUESTIONS = 120;
const CONTRADICTION_BATCH = 30; // chunk=2: 1回のClaude呼び出しで処理するhypothesis件数
const AI_CLASSIFY_BATCH = 20;   // chunk=3: Stage C で処理するhypothesis件数
const DEDUP_LIMIT = 200;        // chunk=4: 重複排除のhypothesis上位件数

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  timeout: 120_000,
  maxRetries: 1,
});

// ── AI質問起票ガード ───────────────────────────────────────────────────────────
let aiQuestionsInsertedThisRun = 0;
let pendingAiQuestionCount: number | null = null;

function resetAiQuestionGuard() {
  aiQuestionsInsertedThisRun = 0;
  pendingAiQuestionCount = null;
}

async function insertAiQuestion(row: Record<string, unknown>): Promise<boolean> {
  if (aiQuestionsInsertedThisRun >= MAX_AI_QUESTIONS_PER_RUN) {
    console.log(`[weekly-learning] AI質問 1回あたり起票上限(${MAX_AI_QUESTIONS_PER_RUN}件)到達、新規起票スキップ`);
    return false;
  }
  if (pendingAiQuestionCount === null) {
    const { count } = await supabase
      .from("ai_feedback_items")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");
    pendingAiQuestionCount = count ?? 0;
  }
  if (pendingAiQuestionCount + aiQuestionsInsertedThisRun >= MAX_PENDING_AI_QUESTIONS) {
    console.log(`[weekly-learning] AI質問pending上限(${MAX_PENDING_AI_QUESTIONS}件)到達、新規起票スキップ`);
    return false;
  }
  const { error } = await supabase.from("ai_feedback_items").insert(row);
  if (error) {
    console.warn("[weekly-learning] AI質問起票失敗:", error.message);
    return false;
  }
  aiQuestionsInsertedThisRun++;
  return true;
}

// ── 型定義 ────────────────────────────────────────────────────────────────────

type DiffExample = {
  id: string;
  conversation_state: string;
  customer_message: string | null;
  sent_reply: string | null;
  ai_draft: string | null;
  is_starred: boolean;
  created_at: string;
};

type ExistingRule = {
  id: string;
  title: string;
  content: string;
  hypothesis_status: string | null;
};

type HypothesisRule = {
  id: string;
  title: string;
  content: string;
  importance: number;
  category: string;
  conversation_state: string | null;
};

type WeeklyAnalysisResult = {
  newRules: Array<{ title: string; content: string; trigger?: string }>;
  gaps: Array<{ description: string; frequency: number }>;
  contradictions: Array<{ description: string }>;
  weeklyQuestion: string | null;
};

// ── chunk=1: 新規diff分析（現行維持） ────────────────────────────────────────

async function analyzeStateGroup(
  state: string,
  examples: DiffExample[],
  existingRules: ExistingRule[],
): Promise<WeeklyAnalysisResult> {
  const empty: WeeklyAnalysisResult = { newRules: [], gaps: [], contradictions: [], weeklyQuestion: null };

  const examplesText = examples.map((e, i) => {
    const label = (!e.ai_draft || !e.ai_draft.trim()) ? "✍️ スタッフ手書き" : "🔴 AIを修正";
    return `
--- 差分${i + 1} [${label}] ${e.is_starred ? "⭐" : ""} ---
顧客: ${(e.customer_message ?? "").slice(0, 200)}
AI案: ${(e.ai_draft ?? "(なし)").slice(0, 300)}
実際に送った返信: ${(e.sent_reply ?? "").slice(0, 300)}`.trim();
  }).join("\n\n");

  const existingRulesText = existingRules.length > 0
    ? existingRules.map((r, i) => `ルール${i + 1}: ${r.title}\n${r.content}`).join("\n---\n")
    : "（なし）";

  const prompt = `あなたは賃貸仲介の営業コーチです。
以下は【${state}】フェーズで今週スタッフがAIを修正・手書きした返信の差分集（${examples.length}件）です。
既存の確認済みルールも参考にしてください。

## 今週の差分集
${examplesText}

## 既存の確認済みルール（重複不要）
${existingRulesText}

## 分析指示
今週の差分群を横断的に分析し、以下のJSONを返してください。

**重要ルール:**
- 週内で「2件以上同じパターン」が繰り返された場合のみ newRules に含める（1件限りのケースは除外）
- 既存ルールと実質的に同内容のものは newRules に含めない
- 新ルールは具体的・行動的に書く（「〜する」「〜しない」の形式）
- title は 30文字以内、content は 150文字以内
- weeklyQuestion: 今週のデータから生まれた「AIへの最重要質問」1つ（contradictionsまたはgapsがある場合のみ）

返答はJSON配列ではなく以下の形式のJSONオブジェクトのみ：
{
  "newRules": [
    {"title": "ルール名（30字以内）", "content": "具体的ルール（150字以内）", "trigger": "トリガー例（任意）"}
  ],
  "gaps": [
    {"description": "AIが苦手なパターン説明（100字以内）", "frequency": 件数}
  ],
  "contradictions": [
    {"description": "矛盾・不整合の説明（100字以内）"}
  ],
  "weeklyQuestion": "（contradictions/gapsある場合のみ）AIへの最重要質問（100字以内）または null
}`;

  try {
    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: "あなたは賃貸仲介の営業コーチです。スタッフの返信データを分析してAI改善ルールを抽出します。必ず指定されたJSON形式のみ返してください。",
      messages: [{ role: "user", content: prompt }],
    });

    const text = res.content[0].type === "text" ? res.content[0].text.trim() : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`[weekly-learning] ${state}: Claude応答からJSONを抽出できず`);
      return empty;
    }
    const parsed = JSON.parse(jsonMatch[0]) as WeeklyAnalysisResult;
    return {
      newRules: Array.isArray(parsed.newRules) ? parsed.newRules : [],
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
      contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions : [],
      weeklyQuestion: typeof parsed.weeklyQuestion === "string" ? parsed.weeklyQuestion : null,
    };
  } catch (e) {
    console.error(`[weekly-learning] ${state}: Claude呼び出し/JSON解析失敗`, e);
    return empty;
  }
}

async function runChunk1(chunk: number): Promise<Record<string, unknown>> {
  const offset = (chunk - 1) * CHUNK_SIZE; // chunk=1 → offset=0

  const { data: rawExamples, error: fetchErr } = await supabase
    .from("ai_reply_examples")
    .select("id, conversation_state, customer_message, sent_reply, ai_draft, is_starred, created_at")
    .eq("was_ai_modified", true)
    .is("diff_analyzed_at", null)
    .not("sent_reply", "is", null)
    .order("is_starred", { ascending: false })
    .order("created_at", { ascending: true })
    .range(offset, offset + CHUNK_SIZE - 1);

  if (fetchErr) throw new Error(fetchErr.message);

  const examples = (rawExamples ?? []) as DiffExample[];

  if (examples.length === 0) {
    return { chunk, processed: 0, newRules: 0, questionsRaised: 0, message: `chunk${chunk}: 未分析差分なし` };
  }

  const stateGroups = new Map<string, DiffExample[]>();
  for (const ex of examples) {
    const state = ex.conversation_state ?? "unknown";
    if (!stateGroups.has(state)) stateGroups.set(state, []);
    stateGroups.get(state)!.push(ex);
  }

  let totalNewRules = 0;
  let totalQuestionsRaised = 0;
  const processedIds: string[] = [];

  for (const [state, stateExamples] of stateGroups.entries()) {
    try {
      const { data: existingRulesRaw } = await supabase
        .from("ai_reply_knowledge")
        .select("id, title, content, hypothesis_status")
        .eq("conversation_state", state)
        .eq("hypothesis_status", "confirmed")
        .order("importance", { ascending: false })
        .limit(8);

      const existingRules = (existingRulesRaw ?? []) as ExistingRule[];
      const analysis = await analyzeStateGroup(state, stateExamples, existingRules);

      for (const rule of analysis.newRules) {
        if (!rule.title || !rule.content) continue;
        try {
          const embeddingInput = buildKnowledgeEmbeddingInput({
            trigger_example: rule.trigger,
            content: rule.content,
            conversation_state: state,
          });
          const embedding = await generateEmbedding(embeddingInput);
          const result = await upsertKnowledge(supabase, {
            title: `[weekly] ${rule.title}`,
            content: rule.content,
            category: "pattern",
            importance: 7,
            conversation_state: state,
            ...(embedding ? { embedding } : {}),
            ...(rule.trigger ? { trigger_example: rule.trigger } : {}),
          });
          if (result.result === "inserted" || result.result === "merged") totalNewRules++;
        } catch (e) {
          console.error(`[weekly-learning] ${state}: upsertKnowledge失敗`, e);
        }
      }

      if (analysis.weeklyQuestion && (analysis.contradictions.length > 0 || analysis.gaps.length > 0)) {
        const questionSlice = analysis.weeklyQuestion.slice(0, 50);
        const { data: existing } = await supabase
          .from("ai_feedback_items")
          .select("id")
          .ilike("question", `%${questionSlice}%`)
          .in("status", ["pending", "answered", "applied"])
          .limit(1);

        if (!existing || existing.length === 0) {
          const evidence = [
            analysis.gaps.map(g => `ギャップ(${g.frequency}件): ${g.description}`).join(" / "),
            analysis.contradictions.map(c => `矛盾: ${c.description}`).join(" / "),
          ].filter(Boolean).join("\n");

          const raised = await insertAiQuestion({
            question: analysis.weeklyQuestion,
            category: "knowledge_gap",
            confidence: "medium",
            evidence: evidence.slice(0, 500) || null,
            speculation: `週次バッチ学習 chunk${chunk} / ${state} / ${stateExamples.length}件の差分から検出`,
          });
          if (raised) totalQuestionsRaised++;
        }
      }

      for (const ex of stateExamples) processedIds.push(ex.id);
    } catch (e) {
      console.error(`[weekly-learning] ${state}: ステート処理失敗`, e);
    }
  }

  if (processedIds.length > 0) {
    const now = new Date().toISOString();
    await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).in("id", processedIds);
  }

  return {
    chunk,
    processed: processedIds.length,
    newRules: totalNewRules,
    questionsRaised: totalQuestionsRaised,
    message: `chunk${chunk}: ${processedIds.length}件処理・${totalNewRules}件ルール保存・${totalQuestionsRaised}件AI質問起票`,
  };
}

// ── chunk=2: hypothesis × confirmed 矛盾チェック ─────────────────────────────

type ContradictionResult = {
  contradicts: string[];
  redundant_to_confirmed: string[];
  independent: string[];
};

async function checkContradictions(
  hypothesisBatch: HypothesisRule[],
  confirmedRules: ExistingRule[],
): Promise<ContradictionResult> {
  const empty: ContradictionResult = { contradicts: [], redundant_to_confirmed: [], independent: hypothesisBatch.map(r => r.id) };

  const confirmedText = confirmedRules.length > 0
    ? confirmedRules.map(r => `[ID:${r.id}] ${r.title}\n  内容: ${r.content}`).join("\n\n")
    : "（なし）";

  const hypothesisText = hypothesisBatch.map(r =>
    `[ID:${r.id}] ${r.title}\n  内容: ${r.content}`
  ).join("\n\n");

  const prompt = `あなたはLINE不動産返信AIのルールベース品質チェッカーです。

## 確定済みルール（confirmed）
${confirmedText}

## チェック対象の仮説ルール（hypothesis）
${hypothesisText}

以下を判定してください：
1. confirmedと明確に「逆のことを言っている」矛盾ルールのIDリスト
2. confirmedとほぼ同じ内容の冗長ルール（内容の90%以上が重複）のIDリスト
3. 上記いずれでもなく、独立した新知識として価値があるIDリスト

JSON形式のみ返答：
{"contradicts": ["ID", ...], "redundant_to_confirmed": ["ID", ...], "independent": ["ID", ...]}`;

  try {
    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: "ルールベース品質チェッカーです。指定されたJSON形式のみ返してください。",
      messages: [{ role: "user", content: prompt }],
    });

    const text = res.content[0].type === "text" ? res.content[0].text.trim() : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return empty;
    const parsed = JSON.parse(jsonMatch[0]) as ContradictionResult;
    return {
      contradicts: Array.isArray(parsed.contradicts) ? parsed.contradicts : [],
      redundant_to_confirmed: Array.isArray(parsed.redundant_to_confirmed) ? parsed.redundant_to_confirmed : [],
      independent: Array.isArray(parsed.independent) ? parsed.independent : [],
    };
  } catch (e) {
    console.error("[weekly-learning] chunk=2: Claude矛盾チェック失敗", e);
    return empty;
  }
}

async function runChunk2(): Promise<Record<string, unknown>> {
  // contradiction_checked_at IS NULL な hypothesis を取得（importance降順）
  const { data: rawHypothesis } = await supabase
    .from("ai_reply_knowledge")
    .select("id, title, content, importance, category, conversation_state")
    .eq("hypothesis_status", "hypothesis")
    .is("contradiction_checked_at", null)
    .order("importance", { ascending: false })
    .limit(CONTRADICTION_BATCH * 10); // 最大300件（10バッチ分）

  const allHypothesis = (rawHypothesis ?? []) as HypothesisRule[];

  if (allHypothesis.length === 0) {
    return { chunk: 2, processed: 0, rejected: 0, message: "chunk2: 矛盾チェック対象なし" };
  }

  // conversation_state でグルーピング
  const stateGroups = new Map<string, HypothesisRule[]>();
  for (const h of allHypothesis) {
    const state = h.conversation_state ?? "unknown";
    if (!stateGroups.has(state)) stateGroups.set(state, []);
    stateGroups.get(state)!.push(h);
  }

  let totalRejected = 0;
  let totalProcessed = 0;
  const processedIds: string[] = [];

  for (const [state, hyps] of stateGroups.entries()) {
    // そのstateのconfirmedルールを取得
    const { data: confirmedRaw } = await supabase
      .from("ai_reply_knowledge")
      .select("id, title, content, hypothesis_status")
      .eq("conversation_state", state)
      .eq("hypothesis_status", "confirmed")
      .order("importance", { ascending: false })
      .limit(15);

    const confirmedRules = (confirmedRaw ?? []) as ExistingRule[];

    // バッチ処理
    for (let i = 0; i < hyps.length; i += CONTRADICTION_BATCH) {
      const batch = hyps.slice(i, i + CONTRADICTION_BATCH);

      const result = await checkContradictions(batch, confirmedRules);

      // 矛盾・冗長をrejected化
      const toReject = [...result.contradicts, ...result.redundant_to_confirmed];
      if (toReject.length > 0) {
        const now = new Date().toISOString();
        await supabase
          .from("ai_reply_knowledge")
          .update({
            hypothesis_status: "rejected",
            rejection_reason: "ai_contradiction_or_redundant",
            contradiction_checked_at: now,
          })
          .in("id", toReject);
        totalRejected += toReject.length;
      }

      // 独立ルールに contradiction_checked_at を打つ
      if (result.independent.length > 0) {
        const now = new Date().toISOString();
        await supabase
          .from("ai_reply_knowledge")
          .update({ contradiction_checked_at: now })
          .in("id", result.independent);
      }

      for (const h of batch) processedIds.push(h.id);
    }

    totalProcessed += hyps.length;
  }

  return {
    chunk: 2,
    processed: totalProcessed,
    rejected: totalRejected,
    message: `chunk2: ${totalProcessed}件チェック・${totalRejected}件rejected（矛盾/冗長）`,
  };
}

// ── chunk=3: 品質選別 Stage A/B/C ──────────────────────────────────────────

type AiClassifyResult = {
  results: Array<{ id: string; verdict: "promote" | "reject" | "keep"; reason?: string }>;
};

async function aiClassifyBatch(batch: HypothesisRule[]): Promise<AiClassifyResult> {
  const empty: AiClassifyResult = { results: [] };

  const batchText = batch.map(r =>
    `[ID:${r.id}] ${r.title}\n  内容: ${r.content}\n  カテゴリ: ${r.category} / importance: ${r.importance}`
  ).join("\n\n");

  const prompt = `以下の仮説ルール（不動産LINE返信AI用）を評価してください。

${batchText}

判定基準：
- promote: 具体的・実用的・他のconfirmedルールに未収録の新知識 → confirmed昇格
- reject: 抽象的すぎる・フレーズ単発で汎用性なし・実用性が見えない → rejected
- keep: 判断保留（人間への質問候補）

各ルールIDに対してpromote/reject/keepを返してください。
JSON形式のみ返答（keepは最大3件まで）：
{"results": [{"id": "UUID", "verdict": "promote/reject/keep", "reason": "一言"}]}`;

  try {
    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: "不動産LINE返信AIのルール品質評価者です。指定されたJSON形式のみ返してください。",
      messages: [{ role: "user", content: prompt }],
    });

    const text = res.content[0].type === "text" ? res.content[0].text.trim() : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return empty;
    const parsed = JSON.parse(jsonMatch[0]) as AiClassifyResult;
    return { results: Array.isArray(parsed.results) ? parsed.results : [] };
  } catch (e) {
    console.error("[weekly-learning] chunk=3: AI判定失敗", e);
    return empty;
  }
}

async function runChunk3(): Promise<Record<string, unknown>> {
  let autoRejected = 0;
  let autoPromoted = 0;
  let aiPromoted = 0;
  let aiRejected = 0;
  let questionsRaised = 0;

  // Stage A: 自動却下（低重要度 + 30日超過 + 未使用）
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: stageAReject } = await supabase
    .from("ai_reply_knowledge")
    .select("id")
    .eq("hypothesis_status", "hypothesis")
    .lte("importance", 5)
    .eq("apply_count", 0)
    .lt("created_at", thirtyDaysAgo);

  if (stageAReject && stageAReject.length > 0) {
    const ids = stageAReject.map((r: { id: string }) => r.id);
    await supabase
      .from("ai_reply_knowledge")
      .update({ hypothesis_status: "rejected", rejection_reason: "auto_low_quality_30d" })
      .in("id", ids);
    autoRejected += ids.length;
  }

  // Stage A: 自動却下（content短すぎ ≤ 20文字）
  const { data: shortContent } = await supabase
    .from("ai_reply_knowledge")
    .select("id, content")
    .eq("hypothesis_status", "hypothesis");

  if (shortContent) {
    const shortIds = shortContent
      .filter((r: { content: string }) => (r.content ?? "").length < 20)
      .map((r: { id: string }) => r.id);
    if (shortIds.length > 0) {
      await supabase
        .from("ai_reply_knowledge")
        .update({ hypothesis_status: "rejected", rejection_reason: "auto_too_short" })
        .in("id", shortIds);
      autoRejected += shortIds.length;
    }
  }

  // Stage B: 自動昇格（apply_count≥5 + correct_rate≥70%）
  const { data: stageBPromote } = await supabase
    .from("ai_reply_knowledge")
    .select("id, apply_count, correct_count, wrong_count")
    .eq("hypothesis_status", "hypothesis")
    .gte("apply_count", 5);

  if (stageBPromote) {
    const promoteIds = stageBPromote
      .filter((r: { apply_count: number; correct_count: number }) =>
        (r.correct_count ?? 0) / Math.max(r.apply_count ?? 1, 1) >= 0.7
      )
      .map((r: { id: string }) => r.id);
    if (promoteIds.length > 0) {
      await supabase
        .from("ai_reply_knowledge")
        .update({ hypothesis_status: "confirmed", promoted_by: "auto_quality_gate" })
        .in("id", promoteIds);
      autoPromoted += promoteIds.length;
    }
  }

  // Stage C: AI判定（中間層: importance 6〜8、apply_count 0〜2）
  const { data: stageCTarget } = await supabase
    .from("ai_reply_knowledge")
    .select("id, title, content, importance, category, conversation_state")
    .eq("hypothesis_status", "hypothesis")
    .gte("importance", 6)
    .lte("importance", 8)
    .order("importance", { ascending: false })
    .limit(AI_CLASSIFY_BATCH);

  const stageCRules = (stageCTarget ?? []) as HypothesisRule[];

  if (stageCRules.length > 0) {
    const aiResult = await aiClassifyBatch(stageCRules);
    const keepCandidates: Array<{ id: string; reason?: string }> = [];

    for (const item of aiResult.results) {
      if (item.verdict === "promote") {
        await supabase
          .from("ai_reply_knowledge")
          .update({ hypothesis_status: "confirmed", promoted_by: "weekly_ai_judge" })
          .eq("id", item.id);
        aiPromoted++;
      } else if (item.verdict === "reject") {
        await supabase
          .from("ai_reply_knowledge")
          .update({ hypothesis_status: "rejected", rejection_reason: "ai_low_quality" })
          .eq("id", item.id);
        aiRejected++;
      } else if (item.verdict === "keep") {
        keepCandidates.push({ id: item.id, reason: item.reason });
      }
    }

    // keepを週次質問として起票（最大3件）
    const keepToRaise = keepCandidates.slice(0, 3);
    for (const k of keepToRaise) {
      const rule = stageCRules.find(r => r.id === k.id);
      if (!rule) continue;

      const question = `[knowledge_id:${rule.id}] このルール候補を採用すべきか教えてください：「${rule.title}」 — ${rule.content}`;
      const slice = rule.id; // knowledge_id で dedup（タイトル変化に強い）
      const { data: existing } = await supabase
        .from("ai_feedback_items")
        .select("id")
        .ilike("question", `%${slice}%`)
        .in("status", ["pending", "answered", "applied"])
        .limit(1);

      if (!existing || existing.length === 0) {
        const raised = await insertAiQuestion({
          question,
          category: "knowledge_gap",
          confidence: "medium",
          evidence: k.reason ?? null,
          speculation: `weekly-learning chunk3 Stage C: AI判定 keep（importance ${rule.importance}）`,
        });
        if (raised) questionsRaised++;
      }
    }
  }

  // Stage D: バックグラウンド再評価（フィードバック関数が呼ばれなかった場合の救済）
  // apply_count/correct_countが既に閾値を超えているhypothesisを再チェックして昇格
  const { data: stageDBatch } = await supabase
    .from("ai_reply_knowledge")
    .select("id, apply_count, correct_count, wrong_count")
    .eq("hypothesis_status", "hypothesis")
    .gte("apply_count", 5);

  if (stageDBatch && stageDBatch.length > 0) {
    const rescuePromoteIds = stageDBatch
      .filter((r: { apply_count: number; correct_count: number }) =>
        (r.correct_count ?? 0) / Math.max(r.apply_count ?? 1, 1) >= 0.7
      )
      .map((r: { id: string }) => r.id);
    const rescueRejectIds = stageDBatch
      .filter((r: { apply_count: number; wrong_count: number }) =>
        (r.wrong_count ?? 0) / Math.max(r.apply_count ?? 1, 1) >= 0.7
      )
      .map((r: { id: string }) => r.id);
    if (rescuePromoteIds.length > 0) {
      await supabase
        .from("ai_reply_knowledge")
        .update({ hypothesis_status: "confirmed", promoted_by: "weekly_rescue_eval" })
        .in("id", rescuePromoteIds);
      autoPromoted += rescuePromoteIds.length;
    }
    if (rescueRejectIds.length > 0) {
      await supabase
        .from("ai_reply_knowledge")
        .update({ hypothesis_status: "rejected", rejection_reason: "weekly_rescue_eval_low" })
        .in("id", rescueRejectIds);
      autoRejected += rescueRejectIds.length;
    }
  }

  return {
    chunk: 3,
    autoRejected,
    autoPromoted,
    aiPromoted,
    aiRejected,
    questionsRaised,
    message: `chunk3: 自動却下${autoRejected}件・自動昇格${autoPromoted}件・AI昇格${aiPromoted}件・AI却下${aiRejected}件`,
  };
}

// ── chunk=4: 重複排除 + 週次質問まとめ ────────────────────────────────────

type DedupPair = {
  id_a: string;
  id_b: string;
  title_a: string;
  title_b: string;
  imp_a: number;
  imp_b: number;
  sim_score: number;
};

type DedupJudgeResult = {
  pairs: Array<{
    id_a: string;
    id_b: string;
    verdict: "same" | "similar_but_different" | "merge_candidate";
    keep_id: string | null;
  }>;
};

async function runChunk4(): Promise<Record<string, unknown>> {
  let dedupRejected = 0;
  let questionsRaised = 0;

  // pg_trgm で類似タイトルペアを検出（dedup_checked_at IS NULL な上位200件から）
  let simPairs: DedupPair[] = [];
  try {
    const { data: simPairsRaw } = await supabase.rpc("find_similar_hypothesis_pairs", {
      p_limit: DEDUP_LIMIT,
      p_threshold: 0.6,
    });
    simPairs = (simPairsRaw ?? []) as DedupPair[];
  } catch (e) {
    console.warn("[weekly-learning] chunk=4: find_similar_hypothesis_pairs 失敗", e);
  }

  if (simPairs.length > 0) {
    // Claude判定（類似ペアのみ・最大30ペア）
    const pairsToJudge = simPairs.slice(0, 30);
    const pairsText = pairsToJudge.map((p, i) =>
      `ペア${i + 1}:\n  A (ID: ${p.id_a}): ${p.title_a}\n  B (ID: ${p.id_b}): ${p.title_b}\n  類似スコア: ${p.sim_score.toFixed(2)}`
    ).join("\n\n");

    const prompt = `以下のルールペアを判定してください（不動産LINE返信AI用）：

${pairsText}

判定：
- same: 実質同一 → keep_id に残す方のIDを入れる（importanceが高い方）
- similar_but_different: 別パターン → 両方keep、keep_id=null
- merge_candidate: 統合推奨 → keep_id=null（人間に質問）

JSON形式のみ返答：
{"pairs": [{"id_a": "...", "id_b": "...", "verdict": "same/similar_but_different/merge_candidate", "keep_id": "IDまたはnull"}]}`;

    try {
      const res = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: "ルール重複排除の判定者です。指定されたJSON形式のみ返してください。",
        messages: [{ role: "user", content: prompt }],
      });

      const text = res.content[0].type === "text" ? res.content[0].text.trim() : "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const judged = JSON.parse(jsonMatch[0]) as DedupJudgeResult;

        for (const pair of judged.pairs ?? []) {
          if (pair.verdict === "same" && pair.keep_id) {
            const discardId = pair.id_a === pair.keep_id ? pair.id_b : pair.id_a;
            await supabase
              .from("ai_reply_knowledge")
              .update({ hypothesis_status: "rejected", rejection_reason: "ai_dedup_same" })
              .eq("id", discardId);
            dedupRejected++;
          } else if (pair.verdict === "merge_candidate") {
            // マージ候補を質問として起票（A・B両方のタイトルと内容を含める）
            const [ruleARes, ruleBRes] = await Promise.all([
              supabase.from("ai_reply_knowledge").select("title, content").eq("id", pair.id_a).single(),
              supabase.from("ai_reply_knowledge").select("title, content").eq("id", pair.id_b).single(),
            ]);
            const ruleA = ruleARes.data;
            const ruleB = ruleBRes.data;
            if (ruleA && ruleB) {
              const simScore = simPairs.find(p => p.id_a === pair.id_a && p.id_b === pair.id_b)?.sim_score?.toFixed(2) ?? "N/A";
              const question = `以下2つのルールを1つに統合すべきですか？（類似スコア: ${simScore}）\n\nA「${ruleA.title}」\n${String(ruleA.content).slice(0, 120)}\n\nB「${ruleB.title}」\n${String(ruleB.content).slice(0, 120)}`;
              // A・B両IDで dedup（どちらかのIDが含まれていれば重複）
              const { data: existing } = await supabase
                .from("ai_feedback_items")
                .select("id")
                .or(`question.ilike.%${pair.id_a}%,question.ilike.%${pair.id_b}%`)
                .in("status", ["pending", "answered", "applied"])
                .limit(1);

              if (!existing || existing.length === 0) {
                const raised = await insertAiQuestion({
                  question,
                  category: "knowledge_gap",
                  confidence: "low",
                  evidence: `ルールA ID: ${pair.id_a} / ルールB ID: ${pair.id_b} / 類似スコア: ${simScore}`,
                  speculation: "weekly-learning chunk4 重複排除: マージ候補",
                });
                if (raised) questionsRaised++;
              }
            }
          }
        }
      }
    } catch (e) {
      console.error("[weekly-learning] chunk=4: 重複排除Claude判定失敗", e);
    }
  }

  // dedup_checked_at を更新（上位200件）
  const { data: toMark } = await supabase
    .from("ai_reply_knowledge")
    .select("id")
    .eq("hypothesis_status", "hypothesis")
    .is("dedup_checked_at", null)
    .order("importance", { ascending: false })
    .limit(DEDUP_LIMIT);

  if (toMark && toMark.length > 0) {
    const now = new Date().toISOString();
    const markIds = (toMark as { id: string }[]).map(r => r.id);
    await supabase
      .from("ai_reply_knowledge")
      .update({ dedup_checked_at: now })
      .in("id", markIds);
  }

  return {
    chunk: 4,
    dedupRejected,
    questionsRaised,
    message: `chunk4: 重複却下${dedupRejected}件・週次質問${questionsRaised}件起票`,
  };
}

// ── POST ─────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const runLogId = await startCronLog("weekly-learning");
  resetAiQuestionGuard();

  try {
    const url = new URL(req.url);
    const chunkParam = url.searchParams.get("chunk");
    const chunk = chunkParam ? Math.min(Math.max(parseInt(chunkParam, 10) || 1, 1), 4) : 1;

    console.log(`[weekly-learning] chunk=${chunk} 開始`);

    let result: Record<string, unknown>;

    if (chunk === 1) {
      result = await runChunk1(chunk);
    } else if (chunk === 2) {
      result = await runChunk2();
    } else if (chunk === 3) {
      result = await runChunk3();
    } else {
      result = await runChunk4();
    }

    await finishCronLog(runLogId, true, result);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[weekly-learning]", e);
    await finishCronLog(runLogId, false, undefined, e instanceof Error ? e.message : String(e));
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return POST(req);
}
