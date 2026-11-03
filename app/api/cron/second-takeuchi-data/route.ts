// GET /api/cron/second-takeuchi-data（Vercel Cron・毎週月曜 JST 5:20）
//   竹内さん本人の AIX の2通目（手本）と場面ごとの型の要約を作り直して表に置く（second_takeuchi_examples・second_takeuchi_forms）。
//   2026-10-29 作業員5（竹内さん KB 585ec774「今までの竹内が送っているのを参考に」）。会話由来の文は倉庫に置かず DB に（RLS・サーバーの鍵だけ）。
//   ?dry=1 … 数だけ返す（書かない）。&days=365（集める期間）
import { NextRequest, NextResponse } from "next/server";
import { runSecondTakeuchiData } from "@/app/lib/second-takeuchi-data-server";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const sp = req.nextUrl.searchParams;
  const days = Number(sp.get("days") ?? "365");
  // 2026-11-03 作業員6: 押した AIX の前後の窓だけを読む・200秒で止めて next を返す（続きは ?before=<next>）。
  //   営業時間（JST 9〜22時）は ?force=1 が無いと動かさない（11/03 10:31〜10:45 の DB の混雑）
  const jstHour = (new Date().getUTCHours() + 9) % 24;
  if (jstHour >= 9 && jstHour < 22 && sp.get("force") !== "1") {
    return NextResponse.json({ ok: true, skipped: "営業時間（JST 9〜22時）は動かさない。?force=1 で動かす", jstHour });
  }
  const before = sp.get("before");
  const report = await runSecondTakeuchiData({
    dry: sp.get("dry") === "1", sinceDays: Number.isFinite(days) && days > 0 ? days : 365,
    beforeIso: before && Number.isFinite(Date.parse(before)) ? new Date(before).toISOString() : null, budgetMs: 200_000,
  });
  return NextResponse.json(report, { status: report.ok ? 200 : 500 });
}
