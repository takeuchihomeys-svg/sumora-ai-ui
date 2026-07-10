import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { analyzeClosedConversation, type ClosedOutcome } from "@/app/lib/analyze-closed-conversation";

export const maxDuration = 300;

// POST /api/cron/analyze-closed-conversations（毎日 JST 21:00 = UTC 12:00）
// 取りこぼし防止: 直近48時間に applying / closed_won になったのに
// まだ Opus 4.8 分析されていない会話（ai_prompts に closed_analysis_{id} が無いもの）を拾って分析する。
// 通常は app/page.tsx のステータス変更時に /api/analyze-closed-conversation が即時実行済み。
const MAX_PER_RUN = 5; // Opus呼び出しは1件30〜90秒かかるため maxDuration=300 に収まる件数に制限

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const runLogId = await startCronLog("analyze-closed-conversations");

  try {
    const since48h = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

    // 直近48時間に applying / closed_won になった会話
    const { data: convs, error: convErr } = await supabase
      .from("conversations")
      .select("id, status")
      .in("status", ["applying", "closed_won"])
      .gte("updated_at", since48h);
    if (convErr) {
      await finishCronLog(runLogId, false, undefined, convErr.message);
      return NextResponse.json({ ok: false, error: convErr.message }, { status: 500 });
    }

    const candidates = (convs ?? []) as Array<{ id: string; status: string }>;
    if (candidates.length === 0) {
      await finishCronLog(runLogId, true, { analyzed: 0, candidates: 0 });
      return NextResponse.json({ ok: true, analyzed: 0, candidates: 0 });
    }

    // 分析済み（ai_prompts に closed_analysis_{id} が存在）を除外
    const keys = candidates.map((c) => `closed_analysis_${c.id}`);
    const { data: doneRows } = await supabase
      .from("ai_prompts")
      .select("key")
      .in("key", keys);
    const doneKeys = new Set(((doneRows ?? []) as Array<{ key: string }>).map((r) => r.key));

    const pending = candidates.filter((c) => !doneKeys.has(`closed_analysis_${c.id}`));
    const targets = pending.slice(0, MAX_PER_RUN);

    let analyzed = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const c of targets) {
      const outcome: ClosedOutcome = c.status === "closed_won" ? "closed_won" : "applying";
      try {
        const result = await analyzeClosedConversation(c.id, outcome);
        if (result.ok && !result.skipped) analyzed += 1;
        if (!result.ok) {
          failed += 1;
          if (result.error) errors.push(`${c.id}: ${result.error}`);
        }
      } catch (e) {
        failed += 1;
        errors.push(`${c.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const summary = {
      candidates: candidates.length,
      pending: pending.length,
      analyzed,
      failed,
      deferred: Math.max(0, pending.length - targets.length), // 次回cronに持ち越し
    };
    await finishCronLog(runLogId, true, { ...summary, errors: errors.slice(0, 5) });
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    console.error("[analyze-closed-conversations]", e);
    await finishCronLog(runLogId, false, undefined, e instanceof Error ? e.message : String(e));
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}

// GET: Vercel Cron は GET でリクエストするため、認証チェック後 POST へ委譲
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return POST(req);
}
