import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export async function GET() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: commands } = await supabase
    .from("automation_commands")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1);

  if (!commands || commands.length === 0) {
    return NextResponse.json({ command: null });
  }

  const cmd = commands[0];

  await supabase
    .from("automation_commands")
    .update({ status: "running", picked_up_at: new Date().toISOString() })
    .eq("id", cmd.id)
    .eq("status", "pending");

  return NextResponse.json({ command: { ...cmd, status: "running" } });
}
