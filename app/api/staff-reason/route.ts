// app/api/staff-reason/route.ts — スタッフの理由のワンタップの書き込み（app/lib/staff-reason.ts）
//   画面（公開キー）からは書かない＝サーバーの鍵で brain_decision_logs.staff_reason を書く（11/03 指揮役）。
//   受ける物: { logId: uuid, reason: staff_only|material|scene|wording }。それ以外は 400
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isStaffReasonKey } from "@/app/lib/staff-reason";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  let body: { logId?: unknown; reason?: unknown } = {};
  try { body = await req.json(); } catch { /* */ }
  const logId = String(body.logId ?? ""), reason = String(body.reason ?? "");
  if (!UUID.test(logId) || !isStaffReasonKey(reason)) return NextResponse.json({ ok: false, error: "logId か reason が読めない" }, { status: 400 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "サーバーの鍵が無い" }, { status: 500 });
  const db = createClient(url, key, { auth: { persistSession: false } });
  // 理由は1回だけ（もう入っている行は書き換えない）
  const { data, error } = await db.from("brain_decision_logs").update({ staff_reason: reason, staff_reason_at: new Date().toISOString() }).eq("id", logId).is("staff_reason", null).select("id");
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, written: (data ?? []).length });
}
