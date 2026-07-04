import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

function getBaseUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");
}

async function runBackfill() {
  const res = await fetch(`${getBaseUrl()}/api/analyze-diffs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const data = await res.json();
  return NextResponse.json({ ok: true, backfill: data });
}

// バックフィル専用: analyze-diffsを内部で呼び出して未分析を消化する
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return runBackfill();
}

// 手動実行用
export async function POST() {
  return runBackfill();
}
