// POST /api/property-pickups/send  { batch_id, item_ids: number[], action: "send" | "skip", message?: string }
// 「売上サポ」で確認した物件をお客様の LINE に送る（既存の /api/send-line-message を内部から呼ぶ）。
// 2026-09-24 竹内「スタッフは確認してお客さんに送るだけ」
//
// ⚠ LINE は PDF を画像として送れないので、今は「説明文＋物件ごとの PDF のリンク」を本文で送る。
//   画像で送る形（PDF の画像化）は次の段。送った物は property_pickups.status='sent'・property_customers.last_property_sent_at を更新。
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { buildCustomerPickupMessage } from "@/app/lib/property-pickups";

export async function POST(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const body = await req.json().catch(() => ({})) as { batch_id?: string; item_ids?: number[]; action?: "send" | "skip"; message?: string; sent_by?: string };
  const ids = Array.isArray(body.item_ids) ? body.item_ids.filter((n) => Number.isFinite(n)) : [];
  if (!body.batch_id || ids.length === 0) return NextResponse.json({ ok: false, error: "batch_id と item_ids が要ります" }, { status: 400 });

  const { data: rowsRaw, error } = await supabase.from("property_pickups")
    .select("id, batch_id, property_customer_id, conversation_id, summary_text, pdf_blob_url, recommended, status")
    .eq("batch_id", body.batch_id).in("id", ids);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const rows = (rowsRaw ?? []) as Array<{ id: number; property_customer_id: string | null; conversation_id: string | null; summary_text: string; pdf_blob_url: string | null; recommended: number; status: string }>;
  if (rows.length === 0) return NextResponse.json({ ok: false, error: "対象の行が無い" }, { status: 404 });

  const now = new Date().toISOString();
  if (body.action === "skip") {
    await supabase.from("property_pickups").update({ status: "skipped", sent_by: body.sent_by ?? null }).in("id", rows.map((r) => r.id));
    return NextResponse.json({ ok: true, skipped: rows.length });
  }

  const conversationId = rows.find((r) => r.conversation_id)?.conversation_id ?? null;
  if (!conversationId) return NextResponse.json({ ok: false, error: "お客様の会話（LINE）に紐付いていません。物件顧客と会話を紐付けてから送ってください" }, { status: 409 });
  const { data: conv } = await supabase.from("conversations").select("id, line_user_id, account").eq("id", conversationId).maybeSingle();
  const c = conv as { id: string; line_user_id: string | null; account: string | null } | null;
  if (!c?.line_user_id) return NextResponse.json({ ok: false, error: "会話に LINE の宛先が無い" }, { status: 409 });

  const message = (body.message ?? "").trim() || buildCustomerPickupMessage(rows.filter((r) => r.status === "pending"));
  const secret = process.env.INTERNAL_API_SECRET ?? "";
  const res = await fetch(new URL("/api/send-line-message", req.url), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ line_user_id: c.line_user_id, message, account: c.account ?? undefined, conversation_id: c.id, origin: "aix", aix_type: "property_send" }),
  });
  const json = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
  if (!res.ok || !json.ok) return NextResponse.json({ ok: false, error: json.error ?? `送信に失敗（HTTP ${res.status}）` }, { status: 502 });

  // 会話の記録（画面の手打ち送信と同じ形）と、送った印
  await Promise.all([
    supabase.from("messages").insert({ conversation_id: c.id, sender: "staff", text: message, created_at: now, is_aix_generated: true }),
    supabase.from("conversations").update({ last_message: message.slice(0, 200), last_sender: "staff", updated_at: now, ai_draft: null, suggested_aix_meta: null }).eq("id", c.id),
    supabase.from("property_pickups").update({ status: "sent", sent_at: now, sent_by: body.sent_by ?? null }).in("id", rows.map((r) => r.id)),
    rows[0].property_customer_id
      ? supabase.from("property_customers").update({ last_property_sent_at: now }).eq("id", rows[0].property_customer_id)
      : Promise.resolve(),
  ]);
  return NextResponse.json({ ok: true, sent: rows.length, conversation_id: c.id });
}
