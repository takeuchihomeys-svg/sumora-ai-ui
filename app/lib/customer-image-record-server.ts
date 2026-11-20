// app/lib/customer-image-record-server.ts — お客様の画像の記録（customer_image_records）を書く（サーバー専用・LLM なし）
//   2026-11-21 作業員G。形は customer-image-record.ts（純関数）・読みは customer-image-link（受け取った時の書き起こしだけ）。
//   呼ぶ所: line-webhook の画像の後処理（読み取りの後・ブレインと並べて）。既定 on（CUSTOMER_IMAGE_RECORD=off で止める）。
//   失敗してもお客様への返信・ブレインは止めない（記録だけ）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { linkCustomerImage, type SentForLink } from "@/app/lib/customer-image-link";
import { extractScreenshotProperty } from "@/app/lib/own-property-match";
import { customerImageRecordOn, customerImageRecordRow } from "@/app/lib/customer-image-record";

type Msg = { id: string; conversation_id: string; created_at: string; text: string | null; image_type: string | null; sender?: string };

export async function recordCustomerImages(db: SupabaseClient, messageIds: ReadonlyArray<string>): Promise<number> {
  if (!customerImageRecordOn() || !messageIds.length) return 0;
  const { data: imgs, error } = await db.from("messages").select("id, conversation_id, created_at, text, image_type").in("id", [...messageIds].slice(0, 50));
  if (error || !imgs?.length) return 0;
  const byConv = new Map<string, Msg[]>();
  for (const m of imgs as Msg[]) { if (!/^\s*\[画像\]/.test(m.text ?? "")) continue; const a = byConv.get(m.conversation_id) ?? []; a.push(m); byConv.set(m.conversation_id, a); }
  const rows: ReturnType<typeof customerImageRecordRow>[] = [];
  for (const [cid, list] of byConv) {
    const first = list.map((m) => Date.parse(m.created_at)).sort((a, b) => a - b)[0];
    const [{ data: sp }, { data: sip }, { data: words }] = await Promise.all([
      db.from("sent_properties").select("property_name, room_no, sent_at").eq("conversation_id", cid).order("sent_at", { ascending: false }).limit(300),
      db.from("sent_image_properties").select("property_name, room_no, created_at").eq("conversation_id", cid).order("created_at", { ascending: false }).limit(300),
      db.from("messages").select("created_at, text").eq("conversation_id", cid).eq("sender", "customer")
        .gte("created_at", new Date(first - 20 * 60_000).toISOString()).lte("created_at", new Date(first + 40 * 60_000).toISOString()).limit(60),
    ]);
    const sent: SentForLink[] = [
      ...((sp ?? []) as Array<{ property_name: string | null; room_no: string | null; sent_at: string | null }>).map((r) => ({ name: r.property_name ?? "", room: r.room_no, sentAt: r.sent_at })),
      ...((sip ?? []) as Array<{ property_name: string | null; room_no: string | null; created_at: string }>).map((r) => ({ name: r.property_name ?? "", room: r.room_no, sentAt: r.created_at })),
    ].filter((s) => s.name);
    const said = ((words ?? []) as Array<{ created_at: string; text: string | null }>).filter((w) => !/^\s*\[画像\]/.test(w.text ?? ""));
    const ordered = [...list].sort((a, b) => a.created_at.localeCompare(b.created_at));
    ordered.forEach((m, idx) => {
      const t = Date.parse(m.created_at);
      const near = said.filter((w) => Math.abs(Date.parse(w.created_at) - t) <= 20 * 60_000).map((w) => w.text ?? "").join(" ");
      const link = linkCustomerImage({ text: m.text ?? "", imageType: m.image_type, at: m.created_at, customerWords: near, sent, burst: { index: idx + 1, size: ordered.length } });
      const via = extractScreenshotProperty(m.text)?.via ?? "text";
      rows.push(customerImageRecordRow({ ...m, nameVia: via }, link));
    });
  }
  if (!rows.length) return 0;
  const { error: upErr } = await db.from("customer_image_records").upsert(rows, { onConflict: "message_id" });
  if (upErr) { console.warn(JSON.stringify({ tag: "customer-image-record:failed", error: upErr.message.slice(0, 160) })); return 0; }
  console.log(JSON.stringify({ tag: "customer-image-record", rows: rows.length, kinds: rows.map((r) => r.link_kind) }));
  return rows.length;
}
