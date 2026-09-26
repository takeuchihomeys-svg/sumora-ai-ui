// app/api/customer-state/route.ts
// GET /api/customer-state?conversation_id=… — お客様の今の段階とお部屋ごとの状況（customer-state.ts）を返す（読むだけ・内部認証）。
//   2026-09-26 竹内「LINE のトークの上に今の状況を把握しているステータスのような物が表示されていたら、ズレがあった際にわかりやすい」
//   画面（段2）がトークの上の1行（headline）と「⚠ずれ」の中身（conflicts）を出すのに使う。
import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { getCustomerState } from "@/app/lib/customer-state-server";
import { compactCustomerStateForView } from "@/app/lib/customer-state";

export const maxDuration = 20;

export async function GET(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const conversationId = (req.nextUrl.searchParams.get("conversation_id") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return NextResponse.json({ ok: false, error: "conversation_id required" }, { status: 400 });
  const state = await getCustomerState(conversationId);
  if (!state) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  // ?view=compact … 画面のトークの上の表示用（送っただけの候補は件数だけ・出来事は直近だけ。1会話 最大約30KB → 数KB）
  const body = req.nextUrl.searchParams.get("view") === "compact" ? compactCustomerStateForView(state) : state;
  return NextResponse.json({ ok: true, state: body }, { headers: { "Cache-Control": "no-store" } });
}
