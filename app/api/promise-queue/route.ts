// app/api/promise-queue/route.ts — 会話画面「約束の続き」（次に送る AIX・残り・果たした物）を返す（内部認証・読むだけ・LLM なし）
//   GET ?conversation_id=… → { next: string | null, rest: string[], done: string[] }
//   2026-10-09 竹内さん「読み込んで約束して、約束した事を記録して、それを AIX で送っていけば完全にできる」。決まりは app/lib/promise-queue.ts。戻す: 既定 off・PROMISE_QUEUE=on で入る
import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { promiseQueueEnabled } from "@/app/lib/promise-queue";

export const maxDuration = 20;
const ID_RE = /^[0-9a-f-]{36}$/i;

export async function GET(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const conversationId = (req.nextUrl.searchParams.get("conversation_id") ?? "").trim();
  if (!ID_RE.test(conversationId)) return NextResponse.json({ ok: false, error: "conversation_id required" }, { status: 400 });
  if (!promiseQueueEnabled()) return NextResponse.json({ ok: true, next: null, rest: [], done: [] });
  try {
    const { promiseQueueView } = await import("@/app/lib/promise-queue-server");
    const v = await promiseQueueView(conversationId);
    return NextResponse.json({ ok: true, next: v.next, rest: v.rest, done: v.done.slice(-4) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
