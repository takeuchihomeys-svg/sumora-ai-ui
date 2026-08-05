import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const body = await req.json() as {
    customer_ids?: string[];
    sites?: string[];
  };

  const { data: existing } = await supabase
    .from("automation_commands")
    .select("id, status")
    .in("status", ["pending", "running"])
    .limit(1);

  if (existing && existing.length > 0) {
    return NextResponse.json({ ok: true, commandId: existing[0].id, reused: true });
  }

  const { data, error } = await supabase
    .from("automation_commands")
    .insert({
      command_type: "batch_property_search",
      customer_ids: body.customer_ids ?? null,
      sites: body.sites ?? ["reins"],
      status: "pending",
    })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, commandId: data.id });
}
