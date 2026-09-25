// POST /api/property-pickups/seen { property_customer_id?, conversation_id?, seen_by? }
// AIXツールの「新着物件」の既読。お客様の詳細を開いた時に、そのお客様のまだ読んでいない「通す」（verdict='pass'・未送信）へまとめて入れる。
// 2026-09-25 竹内「ブレインの基準をクリアした物件があれば LINE 一覧と同じ UI で 1・2 や文字が出る」
//   → 既読はスタッフ全員で共有（誰かが開けば全員の画面で消える・LINE の既読と同じ）。新着の決まりは app/lib/new-arrivals.ts
// 書くのは seen_at / seen_by だけ（送信・判定・並びは変えない）。冪等（もう読んだ行は触らない）。
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";

export async function POST(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const body = await req.json().catch(() => ({})) as { property_customer_id?: string | null; conversation_id?: string | null; seen_by?: string | null };
  const pcid = typeof body.property_customer_id === "string" && body.property_customer_id ? body.property_customer_id : null;
  const conv = typeof body.conversation_id === "string" && body.conversation_id ? body.conversation_id : null;
  if (!pcid && !conv) return NextResponse.json({ ok: false, error: "property_customer_id か conversation_id が要ります" }, { status: 400 });
  const seenBy = String(body.seen_by ?? "web").slice(0, 60) || "web";
  let q = supabase.from("property_pickups")
    .update({ seen_at: new Date().toISOString(), seen_by: seenBy })
    .eq("verdict", "pass").eq("status", "pending").is("seen_at", null);
  q = pcid ? q.eq("property_customer_id", pcid) : q.eq("conversation_id", conv as string);
  const { data, error } = await q.select("id");
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, seen: (data ?? []).length });
}
