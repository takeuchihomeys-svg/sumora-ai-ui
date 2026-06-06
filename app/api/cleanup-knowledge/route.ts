import { NextRequest, NextResponse } from "next/server";
import { runKnowledgeCleanup } from "@/app/lib/knowledge-cleanup";

export const maxDuration = 60;

const CRON_SECRET = "hasu-cron-secret-2024";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret");
  if (secret !== CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runKnowledgeCleanup();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
