// GET /api/cron/kb-eval  （Vercel Cron・毎週月曜 JST 5:10＝日曜 20:10 UTC・週の整理 design-knowledge の後）
//   2026-11-07 作業員1（竹内さん「親5本の木にする」・統括役の頼み③）: 設計知見の RAG の物差し（scripts/kb-eval-set.ts）を毎週回し、
//   前の週（cron_run_logs の前の ok の結果）と比べて下がった所を結果に残す。読むだけ（埋め込みを問いの数だけ・$0.0001 程度）。LLM なし
//   ?dry=1 … 回すが cron_run_logs に書かない
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase-server";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { runKbEval, type EvalSummary } from "../../../../scripts/kb-eval";
import { kbEvalDrops } from "@/app/lib/design-knowledge-priority";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const logId = dry ? null : await startCronLog("kb-eval");
  try {
    const { data: prevRow } = await supabase.from("cron_run_logs").select("result_json, started_at").eq("cron_name", "kb-eval").eq("ok", true)
      .order("started_at", { ascending: false }).limit(1).maybeSingle();
    const prev = (prevRow?.result_json ?? null) as { overall?: EvalSummary["overall"]; byScene?: EvalSummary["byScene"]; byPriority?: EvalSummary["byPriority"] } | null;
    // 「題の頭で引く」（P0/P1 全行）は時間がかかるので週は回さない（手元の scripts/kb-eval.ts で見る）
    const s = await runKbEval({ set: "all", self: false });
    const summary = {
      questions: s.questions, overall: s.overall, dev: s.dev, ho: s.ho, byPriority: s.byPriority, byScene: s.byScene,
      stale: { retiredShown: s.stale.retiredShown, olderNearAbove: s.stale.olderNearAbove },
      prevAt: prevRow?.started_at ?? null,
      drops: kbEvalDrops(prev, s),
    };
    await finishCronLog(logId, true, summary);
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(logId, false, undefined, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
