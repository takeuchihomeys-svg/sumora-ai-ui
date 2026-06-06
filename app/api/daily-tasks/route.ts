import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getScreeningClient() {
  return createClient(
    process.env.SCREENING_ADMIN_SUPABASE_URL!,
    process.env.SCREENING_ADMIN_SUPABASE_ANON_KEY!
  );
}

// GET /api/daily-tasks?from=2026-06-01&to=2026-06-30
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  if (!from || !to) {
    return NextResponse.json({ error: "from/to required" }, { status: 400 });
  }

  const sb = getScreeningClient();
  const { data, error } = await sb
    .from("daily_tasks")
    .select("id, customer_name, content, date, time, end_time, done, screening_id, management_company")
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true })
    .order("time", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// POST /api/daily-tasks
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { customer_name, content, date, time, end_time } = body;

  if (!content || !date) {
    return NextResponse.json({ error: "content/date required" }, { status: 400 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const id = `dt_sumora_${Date.now()}`;

  const sb = getScreeningClient();
  const { data, error } = await sb
    .from("daily_tasks")
    .insert({
      id,
      customer_name: customer_name || "",
      content,
      date,
      time: time || "",
      end_time: end_time || "",
      done: false,
      created_at: today,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// DELETE /api/daily-tasks?id=xxx
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const sb = getScreeningClient();
  const { error } = await sb.from("daily_tasks").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// PATCH /api/daily-tasks?id=xxx  (done切り替え等)
export async function PATCH(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const body = await req.json();
  const sb = getScreeningClient();
  const { error } = await sb.from("daily_tasks").update(body).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
