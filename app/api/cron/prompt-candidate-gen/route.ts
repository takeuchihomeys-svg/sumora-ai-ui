import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import Anthropic from "@anthropic-ai/sdk";
// 2026-10-08 竹内さんの決定の2: 学習の窓 7日（AIXのずれ14日）→30日（新しい7日を先に・札つき・LEARNING_WINDOW_30D=off で旧）
import { learningWindow, recencyTag, windowCountsLabel, weightingInstruction, isRecent } from "@/app/lib/learning-window";
// 2026-10-08 竹内さん「自動的にする」（AI 質問の回答が 8/12 から止まっている）: 待っている質問を設計知見（竹内さんの決定 P0/P1）で自動で答えてから候補を作る。
//   自動の答えは status='auto_answered'（ルールは直接変えない＝ここの承認待ちの候補にだけ流れる）。FEEDBACK_AUTO_ANSWER=off で旧
import { runFeedbackAutoAnswer } from "@/app/lib/feedback-auto-answer-server";
import { feedbackAutoAnswerEnabled, AUTO_ANSWER_STATUS } from "@/app/lib/feedback-auto-answer";
import type { SupabaseClient } from "@supabase/supabase-js";

export const maxDuration = 300;

// ── prompt-candidate-gen: 週次プロンプト候補生成 ─────────────────────────────
// 直近7日間の回答済み（applied）AI質問を横断分析し、
// 固定プロンプトにも既存ルールにも無い欠落を補うルール候補を最大10件生成して
// prompt_candidates（承認待ちキュー）に投入する。
// 実行: 毎週日曜 19:00 UTC（月曜 04:00 JST） vercel.json cron
// ─────────────────────────────────────────────────────────────────────────────

const MAX_CANDIDATES = 10;
const SOURCE_LIMIT = 50;
const RULES_LIMIT = 20;

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  timeout: 240_000,
  maxRetries: 1,
});

// ISO 8601 週ラベル（例: '2026-W31'）
function isoWeekLabel(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // 木曜日基準（ISO week）
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

type FeedbackItem = {
  question: string | null;
  user_answer: string | null;
  applied_rule: string | null;
  answered_at?: string | null;
};

type ActiveRule = {
  rule_key: string;
  rule_text: string;
};

type Candidate = {
  content: string;
  reason: string;
  category: string;
};

function extractJsonArray(text: string): Candidate[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c): c is Candidate => !!c && typeof c.content === "string" && c.content.trim().length > 0)
      .map((c) => ({
        content: String(c.content).trim(),
        reason: typeof c.reason === "string" ? c.reason.trim() : "",
        category: typeof c.category === "string" ? c.category.trim() : "gap",
      }));
  } catch {
    return [];
  }
}

async function run(): Promise<NextResponse> {
  const runId = await startCronLog("prompt-candidate-gen");
  const db = getDb();

  try {
    const weekLabel = isoWeekLabel(new Date());

    // 1. 今週分の候補が既に存在するならスキップ（冪等ガード）
    const { count: existingCount, error: existErr } = await db
      .from("prompt_candidates")
      .select("id", { count: "exact", head: true })
      .eq("week_label", weekLabel);
    if (existErr) throw new Error(`prompt_candidates 確認失敗: ${existErr.message}`);
    if ((existingCount ?? 0) > 0) {
      await finishCronLog(runId, true, { skipped: true, reason: "already_generated", weekLabel });
      return NextResponse.json({ ok: true, generated: 0, skipped: true, weekLabel });
    }

    // 1.5 待っている AI 質問を設計知見で自動で答える（答えられた物だけ・推測しない）
    let autoAnswer: Awaited<ReturnType<typeof runFeedbackAutoAnswer>> | { skipped: string } = { skipped: "off" };
    if (feedbackAutoAnswerEnabled(process.env)) {
      try { autoAnswer = await runFeedbackAutoAnswer(db as unknown as SupabaseClient); }
      catch (e) { autoAnswer = { skipped: e instanceof Error ? e.message : String(e) }; }
      console.log("[prompt-candidate-gen] AI質問の自動回答:", JSON.stringify(autoAnswer).slice(0, 400));
    }

    // 2. 直近7日間（新: 30日・新しい順＝新しい7日が先に SOURCE_LIMIT を埋める）の applied AI質問を取得（10/08: 自動の答え auto_answered も）
    const win = learningWindow("prompt-candidate-gen", 7);
    const since = win.sinceIso;
    const { data: feedbackItems, error: fbErr } = await db
      .from("ai_feedback_items")
      .select("question, user_answer, applied_rule, answered_at")
      .in("status", feedbackAutoAnswerEnabled(process.env) ? ["applied", AUTO_ANSWER_STATUS] : ["applied"])
      .gte("answered_at", since)
      .order("answered_at", { ascending: false })
      .limit(SOURCE_LIMIT);
    if (fbErr) throw new Error(`ai_feedback_items 取得失敗: ${fbErr.message}`);

    const items = (feedbackItems ?? []) as FeedbackItem[];
    if (items.length === 0) {
      await finishCronLog(runId, true, { skipped: true, reason: "no_source_items", weekLabel, autoAnswer });
      return NextResponse.json({ ok: true, generated: 0, skipped: true, reason: "no_source_items", weekLabel, autoAnswer });
    }

    // 3. 既存アクティブルール上位20件（重複候補の生成を防ぐコンテキスト）
    const { data: activeRules, error: ruleErr } = await db
      .from("ai_prompt_rules")
      .select("rule_key, rule_text")
      .eq("is_active", true)
      .order("priority", { ascending: false })
      .limit(RULES_LIMIT);
    if (ruleErr) throw new Error(`ai_prompt_rules 取得失敗: ${ruleErr.message}`);
    const rules = (activeRules ?? []) as ActiveRule[];

    // 3b. 直近14日（新: 30日・新しい順で10件）のAIXミスマッチ提案（alignment_fix / mismatch_fix）
    const win14 = learningWindow("prompt-candidate-gen", 14);
    const since14 = win14.sinceIso;
    const { data: aixSuggestions } = await db
      .from("aix_feature_suggestions")
      .select("suggestion_type, description, action_type, status, created_at")
      .in("suggestion_type", ["alignment_fix", "mismatch_fix"])
      .eq("status", "pending")
      .gte("created_at", since14)
      .order("created_at", { ascending: false })
      .limit(10);

    // 4. Claude で候補生成
    const answersText = items
      .map((it, i) => {
        const parts = [`【質問${i + 1}】${recencyTag(win, it.answered_at)}${(it.question ?? "").slice(0, 300)}`];
        if (it.user_answer) parts.push(`回答: ${it.user_answer.slice(0, 300)}`);
        if (it.applied_rule) parts.push(`適用済みルール: ${it.applied_rule.slice(0, 200)}`);
        return parts.join("\n");
      })
      .join("\n\n");

    const rulesText = rules.length > 0
      ? rules.map((r) => `- [${r.rule_key}] ${r.rule_text}`).join("\n")
      : "（アクティブルールなし）";

    const aixSuggestionsText = aixSuggestions && aixSuggestions.length > 0
      ? `\n\n【${win14.legacy ? "直近14日" : windowCountsLabel(win14)}のAIXミスマッチ（自動検出）】\n` + aixSuggestions.map((s) => `・${recencyTag(win14, s.created_at as string | null)}[${s.action_type ?? "不明"}] ${s.description ?? ""}`).join("\n")
      : "";

    const prompt = `あなたは不動産賃貸仲介のLINE返信AIのプロンプト改善アナリストです。

以下は、スタッフが回答済みのAI質問（AIが業務知識の欠落を検知して起票し、人間が回答したもの）です。

## 回答済みAI質問（${win.legacy ? "直近7日間" : windowCountsLabel(win, items.filter((it) => isRecent(win, it.answered_at)).length, items.filter((it) => !isRecent(win, it.answered_at)).length)}）
${answersText}
${win.legacy ? "" : `\n${weightingInstruction(win, 2)}\n`}
## 既存のアクティブなプロンプトルール（重複禁止の対象）
${rulesText}

## タスク
回答済みAI質問群を横断的に分析し、「固定プロンプトにも既存ルールにも無い欠落」を補う新しいプロンプトルール候補を最大${MAX_CANDIDATES}件抽出してください。

## 厳守事項
- 個別回答の逐語的なルール化は禁止（それは既に自動抽出済み）。複数の質問にまたがるパターンや、構造的な欠落のみを候補にすること
- 既存ルールと同義・重複する候補は出力禁止
- 各候補の content は、そのままシステムプロンプトのルール文として使える日本語の指示文にすること（1〜3文）
- 根拠が弱い場合は無理に${MAX_CANDIDATES}件出さず、確度の高いものだけ出すこと（0件でも可）

## 出力形式
以下のJSON配列のみを出力（説明文・コードフェンス不要）:
[
  {
    "content": "ルール候補文（そのままプロンプトに入る指示文）",
    "reason": "なぜこのルールが必要か（どの質問群から導かれたか）",
    "category": "gap | clarification | new_scene | contradiction_fix のいずれか"
  }
]${aixSuggestionsText}`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 4000,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: prompt }],
    });

    if (response.stop_reason === "refusal") {
      throw new Error("Claude が応答を拒否しました (stop_reason: refusal)");
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const candidates = extractJsonArray(text).slice(0, MAX_CANDIDATES);

    // 5. prompt_candidates へ insert
    let generated = 0;
    if (candidates.length > 0) {
      const rows = candidates.map((c) => ({
        content: c.content,
        reason: c.reason || null,
        category: c.category || "gap",
        status: "pending",
        week_label: weekLabel,
      }));
      const { error: insErr } = await db.from("prompt_candidates").insert(rows);
      if (insErr) throw new Error(`prompt_candidates insert失敗: ${insErr.message}`);
      generated = rows.length;
    }

    await finishCronLog(runId, true, { generated, weekLabel, sourceItems: items.length });
    return NextResponse.json({ ok: true, generated, weekLabel });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[prompt-candidate-gen] 失敗:", msg);
    await finishCronLog(runId, false, undefined, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return run();
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return run();
}
