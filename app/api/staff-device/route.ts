// app/api/staff-device/route.ts — この端末（ブラウザ）の書き手の印（管理者＝竹内さん／スタッフ＝従業員）を読む・付ける（LLM なし・内部認証）
//   2026-10-08 竹内さんの決定11「管理者とスタッフにする」: 新しい端末でアプリを開いた時、まだ印が無ければ画面の小さな欄で選び staff_devices.writer に入れる。
//   中の値は 'takeuchi'／'employee' のまま（画面の表示だけ「管理者（竹内さん）」「スタッフ（従業員）」・app/lib/staff-device.ts）。
//   付けた時に、その端末の過去の送信を DB のトリガー（fill_message_staff_writer）と同じ形で埋め直す
//   （messages.sent_device_id がこの端末の通だけ・人が付けた manual は触らない）。staff_send_log の書き手の空きも埋める。
//   既に印がある端末は付け直さない（409・付け直しは DB で。間違って押した端末で過去の書き手が入れ替わらないように）。
//
//   GET  /api/staff-device?device_id=…            → { ok, writer, writer_ja, label, send_count }
//   POST /api/staff-device { device_id, writer }   → { ok, writer, backfilled: { messages, send_log } }
import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { supabase } from "@/app/lib/supabase";
import { parseStaffDeviceId, parseDeviceWriter, deviceWriterLabel, deviceLabelOf } from "@/app/lib/staff-device";

export const maxDuration = 20;

export async function GET(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const deviceId = parseStaffDeviceId(req.nextUrl.searchParams.get("device_id"));
  if (!deviceId) return NextResponse.json({ ok: false, error: "device_id required" }, { status: 400 });
  const { data, error } = await supabase.from("staff_devices").select("writer, label, send_count").eq("device_id", deviceId).maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const d = data as { writer: string | null; label: string | null; send_count: number | null } | null;
  return NextResponse.json({ ok: true, writer: parseDeviceWriter(d?.writer), writer_ja: deviceWriterLabel(d?.writer), label: d?.label ?? null, send_count: d?.send_count ?? 0 }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  let body: { device_id?: unknown; writer?: unknown } = {};
  try { body = await req.json(); } catch { /* 下で 400 */ }
  const deviceId = parseStaffDeviceId(typeof body.device_id === "string" ? body.device_id : null);
  const writer = parseDeviceWriter(body.writer);
  if (!deviceId || !writer) return NextResponse.json({ ok: false, error: "device_id と writer（takeuchi|employee）が要ります" }, { status: 400 });

  const cur = await supabase.from("staff_devices").select("writer").eq("device_id", deviceId).maybeSingle();
  if (cur.error) return NextResponse.json({ ok: false, error: cur.error.message }, { status: 500 });
  const curWriter = parseDeviceWriter((cur.data as { writer: string | null } | null)?.writer);
  if (curWriter && curWriter !== writer) {
    return NextResponse.json({ ok: false, error: `この端末は既に「${deviceWriterLabel(curWriter)}」です（付け直しは DB で）`, writer: curWriter }, { status: 409 });
  }
  if (!cur.data) {
    const ua = req.headers.get("user-agent") ?? "";
    const now = new Date().toISOString();
    const ins = await supabase.from("staff_devices").insert({ device_id: deviceId, label: deviceLabelOf(ua), user_agent: ua.slice(0, 400), writer, first_seen_at: now, last_seen_at: now, send_count: 0 });
    if (ins.error) return NextResponse.json({ ok: false, error: ins.error.message }, { status: 500 });
  } else if (!curWriter) {
    // 印が空の時だけ付ける（同時に2台で押しても先の1回だけ）
    const up = await supabase.from("staff_devices").update({ writer }).eq("device_id", deviceId).is("writer", null);
    if (up.error) return NextResponse.json({ ok: false, error: up.error.message }, { status: 500 });
  }

  // 過去の送信を埋め直す（トリガーと同じ形・この端末の通だけ・manual は触らない）。失敗しても印は付いている（次に開いた時にもう一度は走らない＝報告に出す）
  const backfilled = { messages: 0, send_log: 0, error: null as string | null };
  try {
    const m = await supabase.from("messages")
      .update({ staff_writer: writer, staff_writer_source: "device", staff_writer_confidence: "sure" }, { count: "exact" })
      .eq("sent_device_id", deviceId).eq("sender", "staff")
      .or("staff_writer_source.is.null,staff_writer_source.neq.manual");
    if (m.error) throw new Error(m.error.message);
    backfilled.messages = m.count ?? 0;
    const l = await supabase.from("staff_send_log").update({ staff_writer: writer }, { count: "exact" }).eq("device_id", deviceId).is("staff_writer", null);
    if (l.error) throw new Error(l.error.message);
    backfilled.send_log = l.count ?? 0;
  } catch (e) {
    backfilled.error = e instanceof Error ? e.message : String(e);
  }
  console.log(JSON.stringify({ tag: "staff-device:writer-set", device: deviceId.slice(0, 8), writer, backfilled }));
  return NextResponse.json({ ok: true, writer, writer_ja: deviceWriterLabel(writer), backfilled });
}
