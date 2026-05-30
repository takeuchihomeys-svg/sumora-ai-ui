import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export async function POST(req: NextRequest) {
  const { conversationId, propertyCustomerId } = await req.json() as {
    conversationId: string;
    propertyCustomerId: string | null;
  };

  if (!conversationId) {
    return NextResponse.json({ ok: false, error: "conversationId required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("conversations")
    .update({ property_customer_id: propertyCustomerId ?? null })
    .eq("id", conversationId);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
