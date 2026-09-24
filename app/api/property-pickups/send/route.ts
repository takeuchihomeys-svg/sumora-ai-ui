// POST /api/property-pickups/send  { batch_id, item_ids: number[], action: "skip" | "mark_sent", ... }
// 「売上サポ」のピックアップの状態を変える（見送り・AIX で送り終えた印）。**この API は LINE に何も送らない。**
//
// 2026-09-24 夜 竹内「お客さんに送る時これ送られてないようにする（2枚目のスクショ）」:
//   旧 UI の「確認してお客様に送る」（action:"send"）が、拡張の説明文（summary_text＝AD・🌟★・家賃の生の文）を
//   本文にして画像の後に LINE へ送っていた。お客様への送信は AIX【物件ピックアップした】に一本化し、直接の送信は止めた。
//   サーバー側で断つので、本番ビルドが落ちていた間の旧画面・開いたままのタブ・PWA のキャッシュから押されても LINE に届かない（410 を返す）。
//   説明文（AD・🌟）は社内用。お客様向けの本文は AIX が作る（出口の決定論: 説明文を本文に変える関数ごと消した）。
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { classifyPickupSendAction, PICKUP_DIRECT_SEND_GONE_MESSAGE } from "@/app/lib/property-pickups";

export async function POST(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const body = await req.json().catch(() => ({})) as { batch_id?: string; item_ids?: number[]; action?: string; sent_by?: string; image_urls?: unknown; conversation_id?: string };
  // 直接の送信（send・action 無し・知らない値）は DB を読む前に止める
  const kind = classifyPickupSendAction(body.action);
  if (kind === "gone") return NextResponse.json({ ok: false, error: PICKUP_DIRECT_SEND_GONE_MESSAGE }, { status: 410 });

  const ids = Array.isArray(body.item_ids) ? body.item_ids.filter((n) => Number.isFinite(n)) : [];
  if (!body.batch_id || ids.length === 0) return NextResponse.json({ ok: false, error: "batch_id と item_ids が要ります" }, { status: 400 });

  const { data: rowsRaw, error } = await supabase.from("property_pickups")
    .select("id, batch_id, property_customer_id, conversation_id, page_image_url, trim_image_url, status, rank, property_name, room_no, ad_yen")
    .eq("batch_id", body.batch_id).in("id", ids).order("rank", { ascending: true });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const rowsAll = (rowsRaw ?? []) as Array<{ id: number; property_customer_id: string | null; conversation_id: string | null; page_image_url: string | null; trim_image_url: string | null; status: string; rank: number; property_name: string; room_no: string | null; ad_yen: number | null }>;
  if (rowsAll.length === 0) return NextResponse.json({ ok: false, error: "対象の行が無い" }, { status: 404 });

  if (kind === "skip") {
    await supabase.from("property_pickups").update({ status: "skipped", sent_by: body.sent_by ?? null }).in("id", rowsAll.map((r) => r.id));
    return NextResponse.json({ ok: true, skipped: rowsAll.length });
  }

  // kind === "mark_sent"
  // 2026-09-24 竹内「AIX で送るにして」: 送信は AIX【物件ピックアップした】が行う。送り終えたら印だけ付ける（LINE には何も送らない）
  const now = new Date().toISOString();
  await supabase.from("property_pickups").update({ status: "sent", sent_at: now, sent_by: body.sent_by ?? "aix" }).in("id", rowsAll.map((r) => r.id)).eq("status", "pending");
  if (rowsAll[0].property_customer_id) await supabase.from("property_customers").update({ last_property_sent_at: now }).eq("id", rowsAll[0].property_customer_id);
  // image_urls: 画面（売上サポの handoff）が AIX で実際に届けた画像の URL（送った順）。古い画面は渡さない → null（画像の対応は付けない）
  const delivered = Array.isArray(body.image_urls) ? body.image_urls.filter((u): u is string => typeof u === "string" && !!u) : null;
  // 2026-09-24 反証: 画面が送った先の会話（conversation_id）とピックアップの会話が違えば記録しない
  //   （別のお客様に送った画像を、このピックアップのお客様の「送った」行として書かない。送った印は上で付けている）
  const pickupConv = rowsAll.find((r) => r.conversation_id)?.conversation_id ?? null;
  if (body.conversation_id && pickupConv && body.conversation_id !== pickupConv) {
    console.warn(JSON.stringify({ tag: "property-pickups/send", warn: "conversation_mismatch", batch: body.batch_id }));
    return NextResponse.json({ ok: true, marked: rowsAll.length, recorded: { inserted: 0, updated: 0, images: 0, skipped: ["conversation_mismatch"] } });
  }
  // 2026-09-24 竹内「どれ物件ピックアップで送ったか物件オススメで送ったかもわかる」:
  //   送り終えたピックアップを sent_properties に直接書く（channel=pickup・pickup_id 付き）。失敗しても送った印は付ける
  let recorded = null;
  try {
    const { recordPickupSent } = await import("@/app/lib/pickup-sent-record");
    recorded = await recordPickupSent({ pickups: rowsAll, deliveredImageUrls: delivered });
  } catch (e) {
    console.warn("[property-pickups/send] 送った物件の記録に失敗（印は付けた）:", e instanceof Error ? e.message : e);
  }
  return NextResponse.json({ ok: true, marked: rowsAll.length, recorded });
}
