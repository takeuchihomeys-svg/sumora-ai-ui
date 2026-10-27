// app/api/aix/brought-properties/route.ts — AIX【物件確認した】・【見積書送る】を開いた時に、お客様が送ってきた物件（まだ確認の結果を返していない）を返す（読むだけ）
// 2026-10-28 竹内さんの決定（設計知見 25714f9b）: 物件名・件数をブレインの台帳（property-thread）から先に入れる。画面は NEXT_PUBLIC_AIX_BROUGHT_PREFILL=on の時だけ呼ぶ
import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { loadBroughtPrefillFor } from "@/app/lib/aix-brought-prefill-server";

export async function GET(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const conversationId = (req.nextUrl.searchParams.get("conversation_id") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return NextResponse.json({ ok: false, error: "conversation_id が無い" }, { status: 400 });
  const p = await loadBroughtPrefillFor(conversationId);
  return NextResponse.json({ ok: true, ...(p ?? { rooms: [], count: 0, lastCheckAt: null }) });
}
