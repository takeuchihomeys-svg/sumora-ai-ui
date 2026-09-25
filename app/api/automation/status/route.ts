import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  // 障害修正: SUPABASE_SERVICE_ROLE_KEY 未設定でも空500クラッシュせず anon キーへフォールバック
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json(
      { error: "server misconfigured: SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY missing" },
      { status: 500 }
    );
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const id = req.nextUrl.searchParams.get("id");

  // 2026-09-25 AIXツールの一括検索（1人1コマンド）の進み具合: ?ids=a,b,c（軽い列だけ・最大60件）
  const idsParam = req.nextUrl.searchParams.get("ids");
  if (idsParam) {
    const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 60);
    if (ids.length === 0) return NextResponse.json({ commands: [] });
    const { data, error } = await supabase
      .from("automation_commands")
      .select("id, status, error_message, created_at, picked_up_at, completed_at, customer_ids, sites")
      .in("id", ids);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ commands: data ?? [] });
  }

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
