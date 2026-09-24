// POST /api/property-pickups/notes { property_customer_id, batch_id?, text, author? }
// 売上サポのピックアップ会話で、スタッフが右側に書くメモ（LINE の会話風の「スタッフの発言」）。
// 2026-09-24 竹内「DeepSeek 側は左・スタッフの会話は右」
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { property_customer_id?: string; batch_id?: string; text?: string; author?: string };
  const text = String(body.text ?? "").trim();
  if (!body.property_customer_id || !text) return NextResponse.json({ ok: false, error: "property_customer_id と text が要ります" }, { status: 400 });
  const { data, error } = await supabase.from("property_pickup_notes")
    .insert({ property_customer_id: body.property_customer_id, batch_id: body.batch_id ?? null, text: text.slice(0, 2000), author: body.author ?? null })
    .select("id, created_at").maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, note: data });
}
