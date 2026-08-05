import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const id = req.nextUrl.searchParams.get("id");

  if (id) {
    const { data, error } = await supabase
      .from("automation_commands")
      .select("*")
      .eq("id", id)
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ command: data });
  }

  const { data, error } = await supabase
    .from("automation_commands")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ commands: data ?? [] });
}
