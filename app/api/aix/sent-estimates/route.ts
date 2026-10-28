// app/api/aix/sent-estimates/route.ts — AIX【初期費用について】を開いた時、貼る画像の初期値に「この会話で直近に送った御見積書」を返す（読むだけ・LLM なし・内部認証）
//   スイッチ COST_BREAKDOWN_SENT_ESTIMATE=on の時だけ返す（off は空＝今と同じ）。文の生成の代わりの道（/api/aix/action）と同じ読み方
import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { costBreakdownSentEstimateOn } from "@/app/lib/cost-breakdown-sent";
import { loadSentEstimateUrls } from "@/app/lib/cost-breakdown-sent-server";

export async function GET(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const conversationId = (req.nextUrl.searchParams.get("conversation_id") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return NextResponse.json({ ok: false, error: "conversation_id が無い" }, { status: 400 });
  if (!costBreakdownSentEstimateOn()) return NextResponse.json({ ok: true, urls: [] });
  try {
    return NextResponse.json({ ok: true, urls: await loadSentEstimateUrls(conversationId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.warn(JSON.stringify({ tag: "aix:sent-estimates", conversationId, error: String(e).slice(0, 160) }));
    return NextResponse.json({ ok: true, urls: [] });
  }
}
