// GET /api/aix/guarantor-prefill?conversation_id=xxx[&name=物件名 号室...]
// AIX【保証会社について】を開いた時の先入れ（会話から決めた物件＋その物件の資料の保証会社・種類）。
// 2026-10-06 竹内（松浦 麻夜 事例）。読むだけ（DB の書き込み・LLM 呼び出しなし）。中身は app/lib/guarantor-prefill-server.ts
import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { loadGuarantorPrefill } from "@/app/lib/guarantor-prefill-server";

export const maxDuration = 15;

export async function GET(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const conversationId = req.nextUrl.searchParams.get("conversation_id")?.trim();
  if (!conversationId) return NextResponse.json({ ok: false, error: "conversation_id は必須です" }, { status: 400 });
  try {
    // 売上サポから開いた時は選んだ物件（name を複数）
    const names = req.nextUrl.searchParams.getAll("name").map((n) => n.slice(0, 80)).filter(Boolean);
    const p = await loadGuarantorPrefill(conversationId, { names });
    console.log(JSON.stringify({
      tag: "aix:guarantor-prefill", conversationId, source: p.targets.source, properties: p.cards.length,
      companies: p.cards.filter((c) => c.company).length, statuses: p.cards.map((c) => c.materialStatus),
    }));
    return NextResponse.json({ ok: true, ...p });
  } catch (e) {
    console.error("[aix/guarantor-prefill]", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
