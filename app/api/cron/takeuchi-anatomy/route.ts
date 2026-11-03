// GET /api/cron/takeuchi-anatomy（Vercel Cron・毎週月曜 JST 6:00）
//   竹内さんの文の解剖（場面×趣旨で偏りなく約200通・伏せ済みの本文だけを DeepSeek で下読み・決定論の札と食い違った所に印）。
//   2026-11-03 作業員6。1回 limit 通（既定 50）・200秒で止める（残りは次の呼び出し）。営業時間（JST 9〜22時）は ?force=1 が無いと動かさない。
//   ?dry=1 … 選ぶ数と残りだけ（書かない・LLM を呼ばない）
import { NextRequest, NextResponse } from "next/server";
import { runTakeuchiAnatomy } from "@/app/lib/takeuchi-anatomy-server";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const sp = req.nextUrl.searchParams;
  const jstHour = (new Date().getUTCHours() + 9) % 24;
  if (jstHour >= 9 && jstHour < 22 && sp.get("force") !== "1") {
    return NextResponse.json({ ok: true, skipped: "営業時間（JST 9〜22時）は動かさない。?force=1 で動かす", jstHour });
  }
  const limit = Number(sp.get("limit") ?? "50");
  const report = await runTakeuchiAnatomy({ dry: sp.get("dry") === "1", limit: Number.isFinite(limit) && limit > 0 ? limit : 50, budgetMs: 200_000 });
  return NextResponse.json(report, { status: report.ok ? 200 : 500 });
}
