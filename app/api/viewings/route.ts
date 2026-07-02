import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// POST: 内覧予定を登録
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      conversation_id: string;
      customer_name?: string;
      viewing_date: string; // YYYY-MM-DD
      viewing_time?: string; // HH:MM
    };

    const { conversation_id, customer_name, viewing_date, viewing_time } = body;
    if (!conversation_id || !viewing_date) {
      return NextResponse.json({ ok: false, error: "conversation_id and viewing_date required" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("viewings")
      .insert({
        conversation_id,
        customer_name: customer_name ?? null,
        viewing_date,
        viewing_time: viewing_time ?? null,
        status: "scheduled",
      })
      .select("id")
      .single();

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, id: data.id });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

// GET: 今日の内覧一覧（クーロン用）
export async function GET() {
  const todayJST = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("viewings")
    .select("*")
    .eq("viewing_date", todayJST)
    .eq("status", "scheduled");

  if (error) return NextResponse.json({ viewings: [] });
  return NextResponse.json({ viewings: data ?? [] });
}
