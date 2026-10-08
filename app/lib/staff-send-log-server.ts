// app/lib/staff-send-log-server.ts — 送信の API で「どの端末から送ったか」を残す（2026-10-08 竹内「端末で分析して竹内か従業員か」）
//   staff_devices（端末ごとに1行・書き手は竹内さんが1回付ける）＋ staff_send_log（送信ごとに1行・LINE の message id つき）。
//   messages の行は画面が送信の後に line_message_id つきで入れる → DB のトリガー（migrate-schema の fill_message_staff_writer）が
//   staff_send_log から端末と書き手を写す。ここは失敗しても送信を止めない（表が無い間は何もしない）。戻す: STAFF_SEND_LOG=off
import { supabase } from "@/app/lib/supabase";
import { deviceLabelOf, parseStaffDeviceId, STAFF_DEVICE_HEADER } from "@/app/lib/staff-device";

export type StaffSendLogInput = {
  headers: Headers;
  conversationId: string | null;
  lineMessageIds: string[];
  origin: string | null;
  aixType: string | null;
  kind: "text" | "image" | "images" | "call_button";
};

export async function recordStaffSend(input: StaffSendLogInput): Promise<void> {
  if ((process.env.STAFF_SEND_LOG ?? "on").toLowerCase() === "off") return;
  if (!input.lineMessageIds.length) return;
  try {
    const ua = input.headers.get("user-agent") ?? "";
    const deviceId = parseStaffDeviceId(input.headers.get(STAFF_DEVICE_HEADER));
    const label = deviceLabelOf(ua);
    const now = new Date().toISOString();
    let writer: string | null = null;
    if (deviceId) {
      const { data: dev } = await supabase.from("staff_devices").select("writer, send_count").eq("device_id", deviceId).maybeSingle();
      const d = dev as { writer: string | null; send_count: number | null } | null;
      writer = d?.writer ?? null;
      const { error } = d
        ? await supabase.from("staff_devices").update({ label, user_agent: ua.slice(0, 400), last_seen_at: now, send_count: (d.send_count ?? 0) + 1 }).eq("device_id", deviceId)
        : await supabase.from("staff_devices").insert({ device_id: deviceId, label, user_agent: ua.slice(0, 400), first_seen_at: now, last_seen_at: now, send_count: 1 });
      if (error) throw new Error(error.message);
    }
    const { error } = await supabase.from("staff_send_log").insert({
      conversation_id: input.conversationId, line_message_ids: input.lineMessageIds, origin: input.origin, aix_type: input.aixType, kind: input.kind,
      device_id: deviceId, device_label: label, user_agent: ua.slice(0, 400), staff_writer: writer, created_at: now,
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn(JSON.stringify({ tag: "staff-send-log:failed", error: e instanceof Error ? e.message : String(e) }));
  }
}
