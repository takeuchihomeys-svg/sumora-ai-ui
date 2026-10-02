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
  const sb = createClient(url, key);
  const r = await sentRoomsFor(sb, customerId);
  if (r.error) return NextResponse.json({ ok: false, error: r.error, rooms: [] }, { status: 500 });
  // 2026-10-02 v2.5.69 竹内「送った物件も印刷用PDFが押せない（送付済み）にしたら大丈夫（お客さんに実際に送信した物件は）」:
  //   お客様の LINE に実際に届けた部屋だけ（★物件出し★への共有 delivery=shared を除く）も返す＝案内モードが印刷用PDF を「送付済み」にする
  const c = await sentRoomsFor(sb, customerId, { customerOnly: true });
  return NextResponse.json({ ok: true, rooms: r.rooms, rows: r.rows, without_room: r.without_room, customer_rooms: c.error ? null : c.rooms });
}
