import { NextRequest, NextResponse } from "next/server";
import { recordSentImageProperty } from "@/app/lib/sent-image-record";

// 2026-09-22 竹内「画像から物件名などを読み取る処理 deepseek に置き換える」→「やる（2回読んでいるのを1回に）」:
//   旧: Claude Haiku Vision で物件名・号室を読み、照合せずに記録していた。送信時（send-line-message）にも
//   同じ画像を DeepSeek で読んでいたので、1枚を2回読んでいた。
//   → 読み取りと記録は app/lib/sent-image-record.ts の recordSentImageProperty に一本化（DeepSeek・1回・照合つき）。
//     同じ画像を既に読んでいれば読み直さない。
//   画面の送信は send-line-message が読むので、ここを呼ぶのは送る前に画像を扱う経路だけ（AIX 物件オススメの生成時）。
//   推論モデルで数秒〜20秒かかる。呼び出し元は結果を待たない（裏で動く）
export const maxDuration = 90;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { image_url?: string; conversation_id?: string; property_customer_id?: string };
    const { image_url, conversation_id, property_customer_id } = body;
    if (!image_url) return NextResponse.json({ error: "image_url は必須です" }, { status: 400 });
    if (!conversation_id) return NextResponse.json({ error: "conversation_id は必須です" }, { status: 400 });

    const r = await recordSentImageProperty({
      imageUrl: image_url,
      conversationId: conversation_id,
      source: "vision",
      propertyCustomerId: property_customer_id ?? null,
    });
    return NextResponse.json({
      ok: true,
      property_name: r.propertyName,
      room_no: r.roomNo,
      matched: r.matched,
      read: r.read,
      is_duplicate: r.sentProperties === "duplicate_skipped",
    });
  } catch (err) {
    console.error("[extract-property-info]", err);
    return NextResponse.json({ error: "物件情報の抽出に失敗しました" }, { status: 500 });
  }
}
