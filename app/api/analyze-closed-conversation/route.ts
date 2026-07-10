import { NextRequest, NextResponse } from "next/server";
import { analyzeClosedConversation, type ClosedOutcome } from "@/app/lib/analyze-closed-conversation";

export const maxDuration = 120;

// POST /api/analyze-closed-conversation
// 申込（applying）/ 成約（closed_won）にステータスが変わった瞬間に
// app/page.tsx から fire-and-forget で呼ばれる（認証なし・内部呼び出し専用）。
// 会話全体を Opus 4.8 で分析し、成約パターンを5箇所に蓄積する。
// 取りこぼしは /api/cron/analyze-closed-conversations（毎日 JST 21:00）が拾う。
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({})) as {
      conversationId?: string;
      outcome?: string;
    };

    const conversationId = (body.conversationId ?? "").trim();
    if (!conversationId) {
      return NextResponse.json({ ok: false, error: "conversationId required" }, { status: 400 });
    }
    const outcome: ClosedOutcome = body.outcome === "closed_won" ? "closed_won" : "applying";

    const result = await analyzeClosedConversation(conversationId, outcome);
    if (!result.ok) {
      return NextResponse.json(result, { status: 500 });
    }
    return NextResponse.json(result);
  } catch (e) {
    console.error("[analyze-closed-conversation]", e);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
