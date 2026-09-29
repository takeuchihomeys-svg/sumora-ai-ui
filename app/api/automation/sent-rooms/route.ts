import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { sentRoomsFor } from "@/app/lib/sent-rooms-server";

/**
 * GET /api/automation/sent-rooms?customer_id=…
 * 2026-09-29 v2.5.41 竹内「一度送ったことがある物件はダウンロードもしないように…人間の動きのように」:
 *   拡張が一括検索の1人ごとに読み、一覧で同じ部屋（建物名＋号室）を選ばない（chrome-extension/sent-skip.js）。
 *   返すのは建物名と号室だけ（お客様の名前・電話は返さない）。認証は他の自動化 API と同じ（AUTOMATION_API_KEY がある時だけ強制）。
 */
export async function GET(req: NextRequest) {
  const apiKey = process.env.AUTOMATION_API_KEY;
  if (apiKey && req.headers.get("x-automation-key") !== apiKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const customerId = (req.nextUrl.searchParams.get("customer_id") ?? "").trim();
  if (!/^[0-9a-f-]{8,40}$/i.test(customerId)) return NextResponse.json({ ok: false, error: "customer_id が必要です" }, { status: 400 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "server misconfigured" }, { status: 500 });
  const r = await sentRoomsFor(createClient(url, key), customerId);
  if (r.error) return NextResponse.json({ ok: false, error: r.error, rooms: [] }, { status: 500 });
  return NextResponse.json({ ok: true, rooms: r.rooms, rows: r.rows, without_room: r.without_room });
}
