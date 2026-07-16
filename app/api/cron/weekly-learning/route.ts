import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { upsertKnowledge, generateEmbedding, buildKnowledgeEmbeddingInput } from "@/app/lib/knowledge-utils";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 300;

// ── weekly-learning: 週次バッチ差分学習 ──────────────────────────────────────
// 未分析差分（was_ai_modified=true AND diff_analyzed_at IS NULL）を週単位で
// グルーピングし、クロスパターン分析から新ルールを抽出する。
// analyze-diffs は1件ごとの個別学習、weekly-learning は複数件を束ねた
// マクロパターン学習。両者は補完関係にある。
//
// ?chunk=1|2|3|4 で週の4分割バッチを制御（各 40 件）。
// Vercel cron では週1回呼ぶか、管理画面から手動トリガーする想定。
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 40;
const MAX_AI_QUESTIONS_PER_RUN = 5; // weekly は件数少ないので保守的に
const MAX_PENDING_AI_QUESTIONS = 120;

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  timeout: 120_000,
  maxRetries: 1,
});

// ── AI質問起票ガード（analyze-diffs と同じパターン） ─────────────────────────
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
  title: string;
  content: string;
  hypothesis_status: string | null;
};

type WeeklyAnalysisResult = {
  newRules: Array<{
    title: string;
    content: string;
    trigger?: string;
  }>;
  gaps: Array<{
    description: string;
    frequency: number;
  }>;
  contradictions: Array<{
    description: string;
  }>;
  weeklyQuestion: string | null;
};

// ── Claude によるクロスパターン分析 ──────────────────────────────────────────
// 同一 conversation_state 内の複数差分を束ねて、週内で2件以上繰り返された
// パターンのみを新ルール候補として抽出する。
async function analyzeStateGroup(
  state: string,
  examples: DiffExample[],
  existingRules: ExistingRule[],
): Promise<WeeklyAnalysisResult> {
  const empty: WeeklyAnalysisResult = { newRules: [], gaps: [], contradictions: [], weeklyQuestion: null };

  const examplesText = examples.map((e, i) => {
    const label = (!e.ai_draft || !e.ai_draft.trim())
      ? "✍️ スタッフ手書き"
      : "🔴 AIを修正";
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
    // JSON オブジェクト抽出（Claudeが余計なテキストを返す場合に対応）
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

// ── POST ─────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  // ── CRON_SECRET 認証 ──
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const runLogId = await startCronLog("weekly-learning");
  resetAiQuestionGuard();

  try {
    // ── chunk パラメータ読み取り（1〜4、未指定は 1） ──
    const url = new URL(req.url);
    const chunkParam = url.searchParams.get("chunk");
    const chunk = chunkParam ? Math.min(Math.max(parseInt(chunkParam, 10) || 1, 1), 4) : 1;
    const offset = (chunk - 1) * CHUNK_SIZE;

    console.log(`[weekly-learning] chunk=${chunk}, offset=${offset}, limit=${CHUNK_SIZE}`);

    // ── 未分析差分を取得（is_starred優先・created_at昇順） ──
    const { data: rawExamples, error: fetchErr } = await supabase
      .from("ai_reply_examples")
      .select("id, conversation_state, customer_message, sent_reply, ai_draft, is_starred, created_at")
      .eq("was_ai_modified", true)
      .is("diff_analyzed_at", null)
      .not("sent_reply", "is", null)
      .order("is_starred", { ascending: false })
      .order("created_at", { ascending: true })
      .range(offset, offset + CHUNK_SIZE - 1);

    if (fetchErr) {
      await finishCronLog(runLogId, false, undefined, fetchErr.message);
      return NextResponse.json({ ok: false, error: fetchErr.message }, { status: 500 });
    }

    const examples = (rawExamples ?? []) as DiffExample[];

    if (examples.length === 0) {
      await finishCronLog(runLogId, true, { chunk, processed: 0, newRules: 0, questionsRaised: 0 });
      return NextResponse.json({
        ok: true, chunk, processed: 0, newRules: 0, questionsRaised: 0,
        message: `[weekly-learning] chunk${chunk}: 未分析差分なし`,
      });
    }

    // ── conversation_state でグルーピング ──
    const stateGroups = new Map<string, DiffExample[]>();
    for (const ex of examples) {
      const state = ex.conversation_state ?? "unknown";
      if (!stateGroups.has(state)) stateGroups.set(state, []);
      stateGroups.get(state)!.push(ex);
    }

    let totalNewRules = 0;
    let totalQuestionsRaised = 0;
    const processedIds: string[] = [];

    // ── 各ステートグループを処理 ──
    for (const [state, stateExamples] of stateGroups.entries()) {
      try {
        // 既存の confirmed ルールを取得（最大8件）
        const { data: existingRulesRaw } = await supabase
          .from("ai_reply_knowledge")
          .select("title, content, hypothesis_status")
          .eq("conversation_state", state)
          .eq("hypothesis_status", "confirmed")
          .order("importance", { ascending: false })
          .limit(8);

        const existingRules = (existingRulesRaw ?? []) as ExistingRule[];

        console.log(`[weekly-learning] ${state}: ${stateExamples.length}件分析開始 (既存ルール${existingRules.length}件)`);

        // ── Claude 分析 ──
        const analysis = await analyzeStateGroup(state, stateExamples, existingRules);

        // ── 新ルールを upsertKnowledge で保存 ──
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

            if (result.result === "inserted" || result.result === "merged") {
              totalNewRules++;
              console.log(`[weekly-learning] ${state}: ルール${result.result} — ${rule.title}`);
            }
          } catch (e) {
            console.error(`[weekly-learning] ${state}: upsertKnowledge失敗`, e);
          }
        }

        // ── AI質問起票（contradictions/gaps がある場合のみ） ──
        if (
          analysis.weeklyQuestion &&
          (analysis.contradictions.length > 0 || analysis.gaps.length > 0)
        ) {
          // 重複チェック（先頭50文字でilike）
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

        // 処理済み ID を収集
        for (const ex of stateExamples) {
          processedIds.push(ex.id);
        }
      } catch (e) {
        // 1ステートの失敗は他ステートを止めない
        console.error(`[weekly-learning] ${state}: ステート処理失敗`, e);
      }
    }

    // ── 処理済み差分に diff_analyzed_at を記録 ──
    if (processedIds.length > 0) {
      const now = new Date().toISOString();
      const { error: markErr } = await supabase
        .from("ai_reply_examples")
        .update({ diff_analyzed_at: now })
        .in("id", processedIds);

      if (markErr) {
        console.error("[weekly-learning] diff_analyzed_at 更新失敗:", markErr.message);
        // diff_analyzed_at 更新失敗は致命的ではない（次回バッチで再処理される）
      } else {
        console.log(`[weekly-learning] ${processedIds.length}件に diff_analyzed_at を記録`);
      }
    }

    const processed = processedIds.length;

    await finishCronLog(runLogId, true, { chunk, processed, newRules: totalNewRules, questionsRaised: totalQuestionsRaised });
    return NextResponse.json({
      ok: true,
      chunk,
      processed,
      newRules: totalNewRules,
      questionsRaised: totalQuestionsRaised,
      message: `[weekly-learning] chunk${chunk}: ${processed}件処理・${totalNewRules}件ルール保存・${totalQuestionsRaised}件AI質問起票`,
    });
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
