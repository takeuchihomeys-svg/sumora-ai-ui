// app/api/property-customers/undo-condition-change/route.ts — 画面の帯（ブレイン自動更新）の「元に戻す」
// 2026-10-06 ⑫ 竹内さん（R）: LINE の言葉で自動で変えた検索の条件を、画面で1押しで戻せるように（一番新しい変更の束を取り消す）。
//   決め方は condition-restore.planUndoLatestChange（今の値が後で変わっている列・戻す先が空の列は触らない）。戻した事も履歴に残す（書き手 undo）
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { undoLatestConditionChange } from "@/app/lib/condition-restore-server";
import { inferAreaMode } from "@/app/lib/line-webhook-text";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { id?: string };
  const id = typeof body.id === "string" ? body.id : "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const res = await undoLatestConditionChange(supabase, id, (a) => inferAreaMode(supabase as never, a));
  if (res.error) return NextResponse.json({ error: res.error }, { status: 500 });
  const { data: row } = await supabase.from("property_customers")
    .select("desired_area, floor_plan, rent_max, rent_min, floor_area_min, walk_minutes, building_age, area_mode, additional_conditions").eq("id", id).maybeSingle();
  return NextResponse.json({ changed: res.changed, skipped: res.plan.skipped, customer: row ?? null });
}
