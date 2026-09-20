import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
// 2026-09-20 竹内「一度送った物件が間違えって入ってしまうこと防げる（アナウンスがでる）」:
//   重複の線は sent-property-record の純関数に一本化する（四者同名）。
//   旧実装は「号室が完全一致したら名前を見ずに重複確定」だったが、実測（scripts/audit-property-dup-threshold.ts・
//   同じ会話の物件名ペア684組）で **号室が同じでも名前が違うペアが494組**あった（「101号室」はどの建物にもある）。
//   つまり「コル・デ・ソル杭全 101」を送ると「小路東一戸建 101」が重複と警告されていた。
//   新しい線は「名前の似ている度 ≥ 0.95 かつ 号室一致」。名前が違う物を巻き込む数が0になる線（実測）。
import { isSameProperty } from "@/app/lib/sent-property-record";

export const maxDuration = 15;

// CORS headers — allow Chrome extension origins
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ─── OPTIONS (preflight) ─────────────────────────────────────────────────────
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// ─── GET handler ─────────────────────────────────────────────────────────────
// Usage: GET /api/check-property-duplicate?property_name=xxx&room_no=xxx&property_customer_id=xxx
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const queryPropertyName = searchParams.get("property_name") ?? "";
  const queryRoomNo = searchParams.get("room_no") ?? "";
  const propertyCustomerId = searchParams.get("property_customer_id") ?? "";
  // 2026-09-20: conversation_id でも引けるようにする（設計知見「conversation_id で引けば 86% 取れるのに
  //   property_customer_id だけで引いていたのが穴」。物件のお客様に紐付いていない会話が 14% ある）。
  //   Chrome 拡張は今まで通り property_customer_id だけで呼べる（応答の形も変えない）。
  const conversationId = searchParams.get("conversation_id") ?? "";

  if (!propertyCustomerId && !conversationId) {
    return NextResponse.json(
      { error: "property_customer_id または conversation_id が必要です" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  /** 両方渡されたらどちらかに当たる物を取る（紐付けが片方しか無い行を取りこぼさない） */
  const fetchSent = async () => {
    let q = supabase.from("sent_properties").select("property_name, room_no, sent_at");
    if (propertyCustomerId && conversationId) {
      q = q.or(`property_customer_id.eq.${propertyCustomerId},conversation_id.eq.${conversationId}`);
    } else if (propertyCustomerId) {
      q = q.eq("property_customer_id", propertyCustomerId);
    } else {
      q = q.eq("conversation_id", conversationId);
    }
    return q.order("sent_at", { ascending: false });
  };

  // "list mode": no name/room_no — return every sent property for this customer
  // Used by score-overlay.js to prefetch and do local duplicate matching
  if (!queryPropertyName && !queryRoomNo) {
    const { data: listData, error: listError } = await fetchSent();
    if (listError) {
      return NextResponse.json(
        { error: listError.message },
        { status: 500, headers: CORS_HEADERS }
      );
    }
    return NextResponse.json({ list: listData ?? [] }, { headers: CORS_HEADERS });
  }

  // Fetch all sent properties for this customer
  const { data, error } = await fetchSent();

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500, headers: CORS_HEADERS }
    );
  }

  const rows = (data ?? []) as Array<{
    property_name: string;
    room_no: string;
    sent_at: string;
  }>;

  // 重複判定は sent-property-record.isSameProperty に一本化（四者同名）:
  //   ・名前の似ている度が 0.95 未満なら、号室が同じでも別物件（実測494組がそう）
  //   ・名前が十分近くて号室が両方あるなら号室で決める（同じ建物の別部屋を潰さない）
  //   ・号室が片方でも無いなら、名前が十分近い時点で重複
  const incoming = { property_name: queryPropertyName, room_no: queryRoomNo };
  const matches = rows.filter((row) =>
    isSameProperty({ property_name: row.property_name ?? "", room_no: row.room_no ?? null }, incoming));

  return NextResponse.json(
    {
      is_duplicate: matches.length > 0,
      duplicates: matches.map((r) => ({
        property_name: r.property_name,
        room_no: r.room_no,
        sent_at: r.sent_at,
      })),
    },
    { headers: CORS_HEADERS }
  );
}
