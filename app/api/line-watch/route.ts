// /api/line-watch — LINE の見張り 1段目（2026-10-01 竹内「LINE の監視の部分にうつる」・設計 line-watch-design.md §6）
//   GET … 見張りの画面（/watch）。読むだけ（書き込み・送信・LLM なし）。?test=1 で YUMA（テスト用の会話）も出す
//   認証: 画面の内部認証（Authorization: Bearer NEXT_PUBLIC_INTERNAL_API_SECRET）。お客様の名前・下書きの文が載るので付ける
import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { supabase } from "@/app/lib/supabase";
import { loadLineWatch } from "@/app/lib/line-watch-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const includeTest = req.nextUrl.searchParams.get("test") === "1";
  try {
    const data = await loadLineWatch(supabase, { includeTest });
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
