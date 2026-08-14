import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { generateEmbedding } from "@/app/lib/knowledge-utils";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import Anthropic from "@anthropic-ai/sdk";

// ── 申込到達会話からの自動学習（analyze-applying）─────────────────────────────
// status が申込段階（applying / 旧名 application, screening, contract / approved）に
// 到達した会話のうち conversations.learned_at IS NULL のものを対象に、
// その会話で送られた全返信（ai_reply_examples）を「成功した会話の返信」として
// was_ai_modified に関わらず Sonnet で分析し、ai_reply_knowledge に
// category='applying_pattern'（申込到達パターン専用カテゴリ）で保存する。
//
// 冪等管理: conversations.learned_at（migrate-schema で追加）。
// フェイルオープン設計:
//   - 学習処理が失敗した会話は learned_at を更新しない → 次回実行で再試行
//   - 1会話の失敗は他の会話の処理を止めない
//
// 起動経路:
//   1. Vercel cron（週次・vercel.json 参照）→ GET → POST 委譲
//   2. analyze-diffs 末尾の fire-and-forget トリガー（日次 cron 経由で自動実行）
//   3. 手動 POST（INTERNAL_API_SECRET）

export const maxDuration = 300;

// 申込段階とみなす status 値（新5段階の 'applying' + 旧名エイリアス + 'approved'）
const APPLYING_STATUSES = ["applying", "approved", "application", "screening", "contract"];

// Sonnet 呼び出しは1件20〜40秒かかるため maxDuration=300 に収まる件数に制限
const MAX_PER_RUN = 5;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", timeout: 60_000, maxRetries: 1 });

// CRON_SECRET（Vercel cron / analyze-diffs トリガー）または
// INTERNAL_API_SECRET（requireInternalAuth）のどちらかで認証する
function checkAuth(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (cronSecret && auth === `Bearer ${cronSecret}`) return null;
  return requireInternalAuth(req);
}

type ApplyingAnalysis = {
  reply_patterns?: string;   // どんな返信パターンが申込まで導いたか
  phase_actions?: string;    // どのフェーズでどんなアクションが効いたか
  customer_profile?: string; // 顧客のタイプ・条件・会話スタイル
  pattern_label?: string;    // このパターンを一言で表すラベル
};

// 会話全文を「[顧客] テキスト」形式にフォーマット（各200字・合計8000字上限）
// 上限超過時は先頭3000字（問い合わせの文脈）+ 末尾5000字（申込直前の転換点）を残す
function formatMessages(msgs: Array<{ sender: string; text: string }>): string {
  const full = msgs
    .map((m) => `[${m.sender === "customer" ? "顧客" : "スタッフ"}] ${(m.text || "").slice(0, 200)}`)
    .join("\n");
  if (full.length <= 8000) return full;
  return `${full.slice(0, 3000)}\n...(中略)...\n${full.slice(-5000)}`;
}

async function callSonnet(prompt: string): Promise<ApplyingAnalysis | null> {
  try {
    const res = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text?.trim() ?? "";
    const match = text.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]) as ApplyingAnalysis;
  } catch (e) {
    console.warn("[analyze-applying] Sonnet呼び出し失敗:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

type ConvResult = { learned: boolean; skipped?: string; error?: string };

// 1会話分の学習処理。成功（または学習対象外としてスキップ確定）時のみ learned_at を更新する。
async function learnFromConversation(conv: { id: string; customer_name: string | null; status: string }): Promise<ConvResult> {
  // 1. 会話の全メッセージ
  const { data: msgRows, error: msgErr } = await supabase
    .from("messages")
    .select("sender, text, created_at")
    .eq("conversation_id", conv.id)
    .neq("text", "[画像]")
    .neq("text", "[動画]")
    .not("text", "is", null)
    .order("created_at", { ascending: true });
  if (msgErr) return { learned: false, error: `messages取得失敗: ${msgErr.message}` };
  const msgs = (msgRows ?? []) as Array<{ sender: string; text: string }>;

  // 会話が短すぎる場合は学習価値なし → learned_at を付けて確定スキップ（無限再試行防止）
  if (msgs.length < 3) {
    await supabase.from("conversations").update({ learned_at: new Date().toISOString() }).eq("id", conv.id);
    return { learned: false, skipped: "too_few_messages" };
  }

  // 2. この会話で送られた返信例（was_ai_modified に関わらず全 sent を成功返信として扱う）
  const { data: exRows, error: exErr } = await supabase
    .from("ai_reply_examples")
    .select("id, conversation_state, customer_message, sent_reply, was_ai_used, was_ai_modified, is_starred, created_at")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: true });
  if (exErr) return { learned: false, error: `ai_reply_examples取得失敗: ${exErr.message}` };
  const examples = (exRows ?? []) as Array<{
    id: string; conversation_state: string | null; customer_message: string | null;
    sent_reply: string | null; was_ai_used: boolean | null; was_ai_modified: boolean | null;
    is_starred: boolean | null; created_at: string | null;
  }>;

  const sentSummary = examples
    .filter((e) => (e.sent_reply || "").trim())
    .map((e, i) =>
      `${i + 1}. [フェーズ: ${e.conversation_state ?? "不明"}${e.is_starred ? "・☆スタッフ厳選" : ""}]\n` +
      `顧客: ${(e.customer_message || "").slice(0, 150)}\n` +
      `返信: ${(e.sent_reply || "").slice(0, 300)}`
    )
    .join("\n---\n")
    .slice(0, 6000);

  // 3. Sonnet で成功パターン分析
  const prompt = `あなたは賃貸仲介LINE営業の成功パターン分析の専門家です。
以下は問い合わせから申込到達（status=${conv.status}）まで進んだ実際の会話です（お客様名: ${conv.customer_name ?? "不明"}）。
この会話で送られた返信はすべて「申込まで導くことに成功した返信」です。

【会話全文】
${formatMessages(msgs)}

【スタッフが送った返信一覧（フェーズ付き）】
${sentSummary || "（返信記録なし）"}

以下のJSONのみ返してください：
{
  "reply_patterns": "この会話でどんな返信パターンが申込まで導いたか（具体的に・150字以内）",
  "phase_actions": "どのフェーズ（hearing/proposing/applying等）でどんなアクションが効いたか（150字以内）",
  "customer_profile": "顧客のタイプ・希望条件・会話スタイル（100字以内）",
  "pattern_label": "この申込到達パターンを一言で表すラベル（例: 即レス提案・背中押し型）"
}`;

  const analysis = await callSonnet(prompt);
  if (!analysis || !analysis.reply_patterns) {
    // 学習失敗 → learned_at は更新しない（次回再試行）
    return { learned: false, error: "Sonnet分析の応答なし/JSON解析失敗（次回再試行）" };
  }

  const label = analysis.pattern_label || "パターン不明";

  // 4. ai_reply_knowledge に category='applying_pattern' で保存
  const content = `【申込到達パターン: ${conv.customer_name ?? "不明"}さん】
返信パターン: ${analysis.reply_patterns}
フェーズ別アクション: ${analysis.phase_actions ?? "不明"}
顧客タイプ: ${analysis.customer_profile ?? "不明"}
ラベル: ${label}`;

  const embedding = await generateEmbedding(`applying_pattern: ${content}`).catch(() => null);
  const { error: kErr } = await supabase.from("ai_reply_knowledge").insert({
    category: "applying_pattern",
    title: `[申込到達] ${label}`.slice(0, 100),
    content,
    importance: 9,
    conversation_state: "applying",
    ...(analysis.customer_profile ? { personality_tags: analysis.customer_profile } : {}),
    ...(embedding ? { embedding: JSON.stringify(embedding) } : {}),
  });
  if (kErr) {
    // 保存失敗 → learned_at は更新しない（次回再試行）
    return { learned: false, error: `ai_reply_knowledge insert失敗: ${kErr.message}` };
  }

  // 5. ☆つき例を「特に重要な成功例」として application_success=true でマーク（失敗しても学習成功扱い）
  const starredIds = examples.filter((e) => e.is_starred).map((e) => e.id);
  if (starredIds.length > 0) {
    const { error: flagErr } = await supabase
      .from("ai_reply_examples")
      .update({ application_success: true })
      .in("id", starredIds);
    if (flagErr) console.warn("[analyze-applying] application_success更新失敗:", flagErr.message);
  }

  // 6. 学習完了 → learned_at を記録（冪等ガード）
  const { error: doneErr } = await supabase
    .from("conversations")
    .update({ learned_at: new Date().toISOString() })
    .eq("id", conv.id);
  if (doneErr) console.warn("[analyze-applying] learned_at更新失敗:", doneErr.message);

  return { learned: true };
}

export async function POST(req: NextRequest) {
  const authError = checkAuth(req);
  if (authError) return authError;

  const runLogId = await startCronLog("analyze-applying");
  try {
    // 処理対象: 申込段階の status かつ learned_at 未設定の会話
    const { data: convs, error: convErr } = await supabase
      .from("conversations")
      .select("id, customer_name, status")
      .in("status", APPLYING_STATUSES)
      .is("learned_at", null)
      .order("updated_at", { ascending: false })
      .limit(50);
    if (convErr) {
      await finishCronLog(runLogId, false, undefined, convErr.message);
      return NextResponse.json({ ok: false, error: convErr.message }, { status: 500 });
    }

    const pending = (convs ?? []) as Array<{ id: string; customer_name: string | null; status: string }>;
    const targets = pending.slice(0, MAX_PER_RUN);

    let learned = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const conv of targets) {
      try {
        const result = await learnFromConversation(conv);
        if (result.learned) learned += 1;
        else if (result.skipped) skipped += 1;
        else {
          failed += 1;
          if (result.error) errors.push(`${conv.id}: ${result.error}`);
        }
      } catch (e) {
        // フェイルオープン: 1会話の失敗は他の会話の処理を止めない（learned_at 未更新 → 次回再試行）
        failed += 1;
        errors.push(`${conv.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const summary = {
      candidates: pending.length,
      learned,
      skipped,
      failed,
      deferred: Math.max(0, pending.length - targets.length), // 次回実行に持ち越し
    };
    await finishCronLog(runLogId, true, { ...summary, errors: errors.slice(0, 5) });
    return NextResponse.json({ ok: true, ...summary, errors: errors.slice(0, 5) });
  } catch (e) {
    console.error("[analyze-applying]", e);
    await finishCronLog(runLogId, false, undefined, e instanceof Error ? e.message : String(e));
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}

// GET: Vercel Cron は GET でリクエストするため、認証チェック後 POST へ委譲
export async function GET(req: NextRequest) {
  const authError = checkAuth(req);
  if (authError) return authError;
  return POST(req);
}
