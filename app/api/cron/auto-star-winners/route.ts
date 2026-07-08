import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

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

  // 過去14日以内に closed_won になった会話
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const { data: wonConvs, error: convErr } = await supabase
    .from("conversations")
    .select("id")
    .eq("status", "closed_won")
    .gte("updated_at", since);

  if (convErr) {
    console.error("[auto-star-winners] conv fetch error:", convErr.message);
    return NextResponse.json({ ok: false, error: convErr.message }, { status: 500 });
  }

  if (!wonConvs?.length) {
    return NextResponse.json({ ok: true, starred: 0, message: "no closed_won conversations in 14 days" });
  }

  const convIds = wonConvs.map((c) => c.id as string);

  // 未☆ かつ AI が貢献した例（was_ai_used か was_ai_modified）
  // MED-08: 品質フィルター
  //  - was_ai_modified=false（AIドラフトをそのまま使った）優先: 差分学習ノイズなし・信号が明確
  //  - ai_draft IS NOT NULL: 差分比較できる例のみ（ai_draftがないと差分学習が機能しない）
  //  - sent_reply が短すぎる（30字未満）のショートメッセージは除外（「了解です！」等の意味なし学習を防ぐ）
  const { data: examples, error: exErr } = await supabase
    .from("ai_reply_examples")
    .select("id, sent_reply, was_ai_modified, ai_draft")
    .in("conversation_id", convIds)
    .eq("is_starred", false)
    .not("ai_draft", "is", null)
    .or("was_ai_used.eq.true,was_ai_modified.eq.true");

  // 短すぎる返信はJS側で除外（DBにlength関数で WHERE できないため）
  const qualityExamples = (examples ?? []).filter(ex =>
    (ex.sent_reply as string | null)?.length ?? 0 >= 30
  );
  // was_ai_modified=false を先頭に（純粋なAI承認シグナルを優先分析）
  const sortedExamples = [
    ...qualityExamples.filter(ex => ex.was_ai_modified === false),
    ...qualityExamples.filter(ex => ex.was_ai_modified !== false),
  ];

  if (exErr) {
    console.error("[auto-star-winners] examples fetch error:", exErr.message);
    return NextResponse.json({ ok: false, error: exErr.message }, { status: 500 });
  }

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
