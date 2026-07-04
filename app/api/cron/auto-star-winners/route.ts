import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// 成果連動☆自動付与バッチ
// closed_won になった会話の AI 返信を自動☆ → analyzeAndSaveKnowledge + analyzeDiff が起動
// 毎日1回（vercel.json cron）

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
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
  const { data: examples, error: exErr } = await supabase
    .from("ai_reply_examples")
    .select("id")
    .in("conversation_id", convIds)
    .eq("is_starred", false)
    .or("was_ai_used.eq.true,was_ai_modified.eq.true");

  if (exErr) {
    console.error("[auto-star-winners] examples fetch error:", exErr.message);
    return NextResponse.json({ ok: false, error: exErr.message }, { status: 500 });
  }

  if (!examples?.length) {
    return NextResponse.json({ ok: true, starred: 0, convs: convIds.length, message: "all examples already starred" });
  }

  // PATCH /api/save-reply-example → is_starred=true
  // 💰 コスト制御: フル分析（Haiku×最大3回/件）は1回の実行につき先頭 MAX_ANALYZE_PER_RUN 件まで。
  // それ以降は isAutoStar: true で☆フラグのみ更新（LLM分析スキップ）。
  // 大量の closed_won が一度に発生してもAnthropic呼び出しが暴発しない。
  const MAX_ANALYZE_PER_RUN = 10;
  let starred = 0;
  let failed = 0;
  let analyzed = 0;

  for (const [i, ex] of examples.entries()) {
    const isAutoStar = i >= MAX_ANALYZE_PER_RUN;
    try {
      const res = await fetch(`${baseUrl}/api/save-reply-example`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ex.id, is_starred: true, isAutoStar }),
      });
      if (res.ok) {
        starred++;
        if (!isAutoStar) analyzed++;
      } else {
        failed++;
        console.warn("[auto-star-winners] PATCH failed for:", ex.id, res.status);
      }
    } catch (e) {
      failed++;
      console.error("[auto-star-winners] PATCH error:", ex.id, e);
    }
  }

  console.log(`[auto-star-winners] done: starred=${starred} analyzed=${analyzed} failed=${failed} convs=${convIds.length}`);
  return NextResponse.json({ ok: true, starred, analyzed, failed, total: examples.length, convs: convIds.length });
}
