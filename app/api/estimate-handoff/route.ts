// app/api/estimate-handoff/route.ts
// GET /api/estimate-handoff?conversation_id=…[&pickup_id=<property_pickups.id>] — LINE の会話から見積書作成に引き継ぐ材料（読むだけ・LLM を呼ばない・内部認証）。
//   2026-10-01 竹内「見積書きかれたら LINE のところに見積書のがでて押したら見積書のツールのところに連携」
//   判断は app/lib/estimate-handoff.ts（純関数）・材料の読み込みは estimate-handoff-server.ts
import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { loadEstimateHandoff } from "@/app/lib/estimate-handoff-server";

export const maxDuration = 20;

export async function GET(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const conversationId = (req.nextUrl.searchParams.get("conversation_id") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return NextResponse.json({ ok: false, error: "conversation_id required" }, { status: 400 });
  try {
    // 2026-10-06 AIX ツールの物件の札の「見積書作成」から来た時は、その行のお部屋で開く（このお客様の行だけ・サーバーで確かめる）
    const pk = (req.nextUrl.searchParams.get("pickup_id") ?? "").trim();
    const pickupId = /^[1-9][0-9]{0,14}$/.test(pk) ? Number(pk) : null;
    const handoff = await loadEstimateHandoff(conversationId, { pickupId });
    if (!handoff) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true, handoff }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.warn("[estimate-handoff] failed:", conversationId.slice(0, 8), e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, error: "failed" }, { status: 500 });
  }
}
