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
  const report = await runSecondTakeuchiData({ dry: sp.get("dry") === "1", sinceDays: Number.isFinite(days) && days > 0 ? days : 365 });
  return NextResponse.json(report, { status: report.ok ? 200 : 500 });
}
