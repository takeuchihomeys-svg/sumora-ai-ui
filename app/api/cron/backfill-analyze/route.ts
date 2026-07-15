import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

function getBaseUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");
}

async function runBackfill() {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const res = await fetch(`${getBaseUrl()}/api/analyze-diffs?limit=15`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {}),
      },
      signal: AbortSignal.timeout(55_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[backfill-analyze] analyze-diffs error:", res.status, body);
      return NextResponse.json({ ok: false, error: body }, { status: 500 });
    }
    const data = await res.json();
    return NextResponse.json({ ok: true, backfill: data });
  } catch (err) {
    console.error("[backfill-analyze] fetch error:", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

// バックフィル専用: analyze-diffsを内部で呼び出して未分析を消化する
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return runBackfill();
}

// 手動実行用
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return runBackfill();
}
