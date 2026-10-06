// GET /api/cron/design-knowledge  （Vercel Cron・毎週月曜 JST 4:40＝日曜 19:40 UTC）
//   ?dry=1 … 数えるだけ（DB に書かない・DeepSeek も呼ばない）
// 設計知見（system_design_thinking）の整理（2026-10-06 竹内「設計知見の更新や成長はツールを完成させるにあたってかなり重要」・⑯）:
//   ① 重複・② 竹内さんの決定で古くなった行（決定論で言い切れる物だけ）を退役（消さない・理由と上書きした行を残す）
//   ③ この1週間に入った行を含む似ている組を DeepSeek に聞いて要確認の一覧へ（自動では退役しない・個人情報は伏せる）
//   ④ 分野ごとの「今の決まり」（design_rules_digest）を作り直す。手元の memory/rules_digest_*.md は scripts/kb-digest.ts --write で写す
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { runDesignKnowledgeCycle } from "@/app/lib/design-knowledge-curation-server";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const logId = dry ? null : await startCronLog("design-knowledge");
  try {
    const r = await runDesignKnowledgeCycle(supabase, { dry, llm: !dry, sinceDays: 8, by: "cron:design-knowledge" });
    const summary = {
      rows: r.rows, current: r.current, retiredDuplicates: r.retiredDuplicates, retiredDecisions: r.retiredDecisions,
      review: r.review.length, missingDecisionRows: r.missingDecisionRows, llm: r.llm, digests: r.digests,
    };
    await finishCronLog(logId, true, summary);
    return NextResponse.json({ ok: true, ...summary, plannedDuplicates: r.plannedDuplicates, plannedDecisions: r.plannedDecisions });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(logId, false, undefined, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
