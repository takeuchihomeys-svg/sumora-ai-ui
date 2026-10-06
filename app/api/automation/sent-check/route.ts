import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { familyIdsFor } from "@/app/lib/customer-family";
import { filterOutAlreadySent, type OutgoingProperty, type SentProperty } from "@/app/lib/sent-property-filter";

/**
 * POST /api/automation/sent-check  { customer_id, rows: [{ name, room, url }] }
 * 2026-10-01 竹内「建物ごとはずすってのはみたら分かる状態になっているのかな？」「それでおこなう」:
 *   一覧のこの行を送ったら、merge-pdfs が送付済みとして外すか（建物ごと・部屋・URL）を、送る前に一覧で印にするための口。
 *   外す判定は merge-pdfs と同じ関数・同じ材料（sent_properties をお客様で引く・既定は建物ごと）＝印と実際の除外が食い違わない。
 *   読むだけ（記録は書かない）。返すのは行の番号と理由・一致した建物名だけ。認証は sent-rooms と同じ
 */
export async function POST(req: NextRequest) {
  const apiKey = process.env.AUTOMATION_API_KEY;
  if (apiKey && req.headers.get("x-automation-key") !== apiKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as { customer_id?: string; rows?: Array<{ name?: string | null; room?: string | null; url?: string | null }> } | null;
  const customerId = String(body?.customer_id ?? "").trim();
  if (!/^[0-9a-f-]{8,40}$/i.test(customerId)) return NextResponse.json({ ok: false, error: "customer_id が必要です" }, { status: 400 });
  const rows = Array.isArray(body?.rows) ? body!.rows.slice(0, 300) : [];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "server misconfigured" }, { status: 500 });
  const sb = createClient(url, key);
  // merge-pdfs と同じ引き方（お客様で引く・2000件まで）
  // 2026-10-06 v2.5.78: 子の行（2つ目の探し物）は親の会話で届けた物も同じ人の送付済み（merge-pdfs と同じ customer-family.ts）
  const ids = await familyIdsFor(sb, customerId);
  const { data, error } = await sb.from("sent_properties").select("property_name, room_no, property_url").in("property_customer_id", ids.length ? ids : [customerId]).limit(2000);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const sent = (data ?? []) as SentProperty[];
  const outgoing: OutgoingProperty[] = rows.map((r) => ({ url: r?.url ?? null, propertyName: String(r?.name ?? ""), roomNo: String(r?.room ?? "") }));
  const level = process.env.SKIP_SENT_LEVEL === "room" ? "room" : "building";
  const result = filterOutAlreadySent(outgoing, sent, level);
  return NextResponse.json({
    ok: true,
    level,
    dropped: result.dropped.map((d) => ({ index: d.index, reason: d.reason })),
  });
}
