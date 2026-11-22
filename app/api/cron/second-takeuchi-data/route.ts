// GET /api/cron/second-takeuchi-data（Vercel Cron・毎週月曜 JST 5:20）
//   竹内さん本人の AIX の2通目（手本）と場面ごとの型の要約を作り直して表に置く（second_takeuchi_examples・second_takeuchi_forms）。
//   2026-10-29 作業員5（竹内さん KB 585ec774「今までの竹内が送っているのを参考に」）。会話由来の文は倉庫に置かず DB に（RLS・サーバーの鍵だけ）。
//   ?dry=1 … 数だけ返す（書かない）。&days=365（集める期間）
import { NextRequest, NextResponse } from "next/server";
import { runSecondTakeuchiData } from "@/app/lib/second-takeuchi-data-server";
import { decideBatchRunFromEnv } from "@/app/lib/batch-daytime-guard";
import { withCronLog } from "@/app/lib/cron-log-wrap";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function handleGET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const sp = req.nextUrl.searchParams;
  const days = Number(sp.get("days") ?? "365");
  // 2026-11-03 作業員6: 押した AIX の前後の窓だけを読む・200秒で止めて next を返す（続きは ?before=<next>）。
  //   営業時間（JST 9〜22時）は ?force=1 が無いと動かさない（11/03 10:31〜10:45 の DB の混雑）
  // 2026-11-03 昼の守り（batch-daytime-guard.ts）: 昼は本番の調子が良い時だけ・量を半分・間を2倍。BATCH_DAYTIME_GUARD=strict で今まで通り（昼は ?force=1 だけ）
  const guard = await decideBatchRunFromEnv(sp.get("force") === "1");
  if (!guard.run) return NextResponse.json({ ok: true, skipped: guard.reason, daytime: guard.daytime });
  const before = sp.get("before");
  const report = await runSecondTakeuchiData({
    dry: sp.get("dry") === "1", sinceDays: Number.isFinite(days) && days > 0 ? days : 365,
    beforeIso: before && Number.isFinite(Date.parse(before)) ? new Date(before).toISOString() : null, budgetMs: Math.round(200_000 * guard.scale), pauseMs: Math.round(80 * guard.pauseScale),
  });
  return NextResponse.json(report, { status: report.ok ? 200 : 500 });
}

// 2026-11-21 作業員N: cron_run_logs に記録を残す（記録だけ・動きは変えない・止める CRON_LOG_WRAP=off）
export const GET = withCronLog("second-takeuchi-data", handleGET);
