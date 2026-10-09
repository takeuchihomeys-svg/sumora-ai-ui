import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { isUsableExampleText, isUsableAiDraft } from "@/app/lib/example-hygiene";
// 2026-09-27 竹内: テスト用の会話（YUMA）は学習に入れない（一覧は test-conversations.ts の1か所）
import { isTestConversation } from "@/app/lib/test-conversations";
// 2026-10-08 竹内さんの決定の2: 窓 14日→30日（新しい7日の会話を先に分析枠へ・LEARNING_WINDOW_30D=off で旧）
import { learningWindow, isRecent } from "@/app/lib/learning-window";
// 2026-10-08 竹内さん「自動的にする」: 申込に届いた会話にも☆（申込の時刻より前の返信だけ・AUTO_STAR_APPLIED=off で旧）
import { autoStarAppliedEnabled, firstAppliedAtByConversation, starEligibleByApply } from "@/app/lib/auto-star-applied";

export const maxDuration = 300;

// 成果連動☆自動付与バッチ
// closed_won になった会話の AI 返信を自動☆ → analyzeAndSaveKnowledge + analyzeDiff が起動
// 毎日1回（vercel.json cron）

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");

  // 過去14日（新: 30日）以内に closed_won になった会話
  const win = learningWindow("auto-star-winners", 14);
  const since = win.sinceIso;

  const { data: wonConvs, error: convErr } = await supabase
    .from("conversations")
    .select("id, updated_at")
    .eq("status", "closed_won")
    .gte("updated_at", since);

  if (convErr) {
    console.error("[auto-star-winners] conv fetch error:", convErr.message);
    return NextResponse.json({ ok: false, error: convErr.message }, { status: 500 });
  }

  // 2026-10-08: 窓の中に申込が入った会話（deal_outcomes.applied_at）。最初の申込の時刻は全案件から取る（その前の返信だけ☆）
  const applyOn = autoStarAppliedEnabled(process.env);
  let firstApplied = new Map<string, number>();
  const appliedRecent: Array<{ id: string; at: string }> = [];
  if (applyOn) {
    const { data: apRows, error: apErr } = await supabase.from("deal_outcomes").select("conversation_id, applied_at").gte("applied_at", since).limit(5000);
    if (apErr) console.warn("[auto-star-winners] deal_outcomes fetch error (申込の会話は今回スキップ):", apErr.message);
    const apIds = [...new Set(((apRows ?? []) as Array<{ conversation_id: string }>).map((r) => r.conversation_id))];
    if (apIds.length) {
      const all: Array<{ conversation_id: string; applied_at: string | null }> = [];
      for (let i = 0; i < apIds.length; i += 200) {
        const { data } = await supabase.from("deal_outcomes").select("conversation_id, applied_at").in("conversation_id", apIds.slice(i, i + 200));
        all.push(...((data ?? []) as Array<{ conversation_id: string; applied_at: string | null }>));
      }
      firstApplied = firstAppliedAtByConversation(all);
      for (const r of (apRows ?? []) as Array<{ conversation_id: string; applied_at: string }>) appliedRecent.push({ id: r.conversation_id, at: r.applied_at });
    }
  }

  if (!wonConvs?.length && !appliedRecent.length) {
    return NextResponse.json({ ok: true, starred: 0, message: `no closed_won / applied conversations in ${win.days} days` });
  }

  // 2026-09-27: テスト用の会話（YUMA）は学びに入れない
  const wonIdSet = new Set((wonConvs ?? []).map((c) => c.id as string));
  const convIds = [...new Set([...wonIdSet, ...appliedRecent.map((r) => r.id)])].filter((id) => !isTestConversation(id));
  // 2026-10-08: 新しい7日に成約した（申込に届いた）会話の例を先に（フル分析の10件の枠は新しい方から埋まる）
  const recentConv = new Set([
    ...(wonConvs ?? []).filter((c) => isRecent(win, c.updated_at as string | null)).map((c) => c.id as string),
    ...appliedRecent.filter((r) => isRecent(win, r.at)).map((r) => r.id),
  ]);

  // 未☆ かつ AI が貢献した例（was_ai_used か was_ai_modified）
  // MED-08: 品質フィルター
  //  - was_ai_modified=false（AIドラフトをそのまま使った）優先: 差分学習ノイズなし・信号が明確
  //  - ai_draft IS NOT NULL: 差分比較できる例のみ（ai_draftがないと差分学習が機能しない）
  //  - sent_reply が短すぎる（30字未満）のショートメッセージは除外（「了解です！」等の意味なし学習を防ぐ）
  const { data: examples, error: exErr } = await supabase
    .from("ai_reply_examples")
    .select("id, conversation_id, sent_reply, was_ai_modified, ai_draft, created_at")
    .in("conversation_id", convIds)
    .eq("is_starred", false)
    .not("ai_draft", "is", null)
    .or("was_ai_used.eq.true,was_ai_modified.eq.true");

  if (exErr) {
    console.error("[auto-star-winners] examples fetch error:", exErr.message);
    return NextResponse.json({ ok: false, error: exErr.message }, { status: 500 });
  }

  // 短すぎる返信はJS側で除外（DBにlength関数で WHERE できないため）
  // 2026-09-11 データ衛生: 生成失敗文（送信文・下書き）には☆を付けない
  const qualityExamples = (examples ?? []).filter(ex =>
    // 申込に届いた会話は申込より前の返信だけ（closed_won の会話は旧のまま）
    starEligibleByApply({ conversation_id: ex.conversation_id as string, created_at: ex.created_at as string | null }, wonIdSet, firstApplied) &&
    ((ex.sent_reply as string | null)?.length ?? 0) >= 30 &&
    isUsableExampleText(ex.sent_reply as string | null) && isUsableAiDraft(ex.ai_draft as string | null)
  );
  // was_ai_modified=false を先頭に（純粋なAI承認シグナルを優先分析）
  const sortedByEdit = [
    ...qualityExamples.filter(ex => ex.was_ai_modified === false),
    ...qualityExamples.filter(ex => ex.was_ai_modified !== false),
  ];
  // 旧の窓では旧と同じ並び。30日では「新しい7日の会話 → 前の23日の会話」（それぞれの中は上の並び）
  const sortedExamples = win.legacy ? sortedByEdit : [
    ...sortedByEdit.filter((ex) => recentConv.has(ex.conversation_id as string)),
    ...sortedByEdit.filter((ex) => !recentConv.has(ex.conversation_id as string)),
  ];

  if (!sortedExamples.length) {
    return NextResponse.json({ ok: true, starred: 0, convs: convIds.length, skipped: (examples?.length ?? 0) - sortedExamples.length, message: "no quality examples to star" });
  }

  // PATCH /api/save-reply-example → is_starred=true
  // 💰 コスト制御: フル分析（Haiku×最大3回/件）は1回の実行につき先頭 MAX_ANALYZE_PER_RUN 件まで。
  // それ以降は isAutoStar: true で☆フラグのみ更新（LLM分析スキップ）。
  // 大量の closed_won が一度に発生してもAnthropic呼び出しが暴発しない。
  const MAX_ANALYZE_PER_RUN = 10;
  let starred = 0;
  let failed = 0;
  let analyzed = 0;

  // フル分析枠（先頭 MAX_ANALYZE_PER_RUN 件）: HTTP経由でHaiku分析込みの☆付与
  for (const ex of sortedExamples.slice(0, MAX_ANALYZE_PER_RUN)) {
    try {
      const res = await fetch(`${baseUrl}/api/save-reply-example`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ex.id, is_starred: true, isAutoStar: false }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) { starred++; analyzed++; }
      else { failed++; console.warn("[auto-star-winners] PATCH failed for:", ex.id, res.status); }
    } catch (e) {
      failed++;
      console.error("[auto-star-winners] PATCH error:", ex.id, e);
    }
  }

  // 超過分（MAX_ANALYZE_PER_RUN 以降）: DB直接バルク更新（HTTP直列ループを排除してタイムアウト防止）
  const bulkIds = sortedExamples.slice(MAX_ANALYZE_PER_RUN).map((e) => e.id as string);
  if (bulkIds.length > 0) {
    const { error: bulkErr } = await supabase
      .from("ai_reply_examples")
      .update({ is_starred: true })
      .in("id", bulkIds);
    if (bulkErr) {
      console.error("[auto-star-winners] bulk update error:", bulkErr.message);
      failed += bulkIds.length;
    } else {
      starred += bulkIds.length;
    }
  }

  const skipped = (examples?.length ?? 0) - sortedExamples.length;
  console.log(`[auto-star-winners] done: starred=${starred} analyzed=${analyzed} failed=${failed} skipped=${skipped}(品質未達) convs=${convIds.length}`);
  return NextResponse.json({ ok: true, starred, analyzed, failed, skipped, total: examples?.length ?? 0, convs: convIds.length });
}
