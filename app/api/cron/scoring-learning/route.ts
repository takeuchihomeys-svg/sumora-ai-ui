// GET /api/cron/scoring-learning  （Vercel Cron・毎週月曜 JST 5:10）
//   ?dry=1 … 測りと提案だけ返す（DB に書かない）。&days=180（既定）
// 物件の点（judgeProperty）の重みを、スタッフが選んだ事実（🌟にした物件・送った物件）で測り、差がはっきりした札だけ重みの調整を提案する。
// 決定論・LLM を呼ばない（費用0）。最初は提案だけ（scoring_weights に proposed）。自動で入れるのは SCORING_LEARNING_AUTO_APPLY=on かつ
// 件数・確かめ用・続けて良くなった週の条件を満たした時だけ（app/lib/scoring-learning.ts の AUTO_APPLY_RULES）。
// 2026-09-25 竹内「自動的に学習されていく仕組みを作る。判定基準をより精度高くしていくために。データを積み重ねていけばかなり質高くなっていく」
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { runScoringLearning } from "@/app/lib/scoring-learning-server";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const sp = req.nextUrl.searchParams;
  const dry = sp.get("dry") === "1";
  const days = Math.min(365, Math.max(14, parseInt(sp.get("days") ?? "180", 10) || 180));
  try {
    const r = await runScoringLearning(supabase, { dry, days });
    // 返す物は要約だけ（札ごとの表は DB の scoring_learning_runs に）
    return NextResponse.json({
      ok: r.ok, dry: r.dry, error: r.error, runId: r.runId ?? null, proposedVersion: r.proposedVersion ?? null, activeVersion: r.activeVersion,
      counts: r.counts, all: r.metrics.all, holdout: r.evaluation, changes: r.proposal.changes, autoApply: r.autoApply,
    }, { status: r.ok ? 200 : 500 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
