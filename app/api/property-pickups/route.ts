// GET /api/property-pickups?days=30
// 「売上サポ」のピックアップ: お客様ごとに、ブレインの判断（batch）とスタッフの発言（送った・見送り・メモ）を時系列で返す。
// 画面は LINE の一覧と同じ形（お客様の行 → タップで会話風。左＝ブレイン、右＝スタッフ）。
// 2026-09-24 竹内「紐づいているお客さんで LINE のチャット一覧のような UI。判断したのが会話風に送られる形。DeepSeek 側は左・スタッフは右」
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

type Row = {
  id: number; created_at: string; batch_id: string; property_customer_id: string | null; conversation_id: string | null;
  customer_name: string | null; site: string | null; rank: number; property_name: string; room_no: string | null;
  summary_text: string; pdf_url: string | null; pdf_blob_url: string | null; pdf_has_text: boolean;
  verdict: string | null; score: number | null; reasons_ja: string[] | null; ad_yen: number | null; profit_yen: number | null;
  recommended: number; status: string; sent_at: string | null;
};
type Note = { id: number; created_at: string; property_customer_id: string; batch_id: string | null; text: string; author: string | null };

export async function GET(req: NextRequest) {
  const days = Math.min(90, Math.max(1, Number(req.nextUrl.searchParams.get("days") ?? "30")));
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const [{ data, error }, notesRes] = await Promise.all([
    supabase.from("property_pickups")
      .select("id, created_at, batch_id, property_customer_id, conversation_id, customer_name, site, rank, property_name, room_no, summary_text, pdf_url, pdf_blob_url, pdf_has_text, verdict, score, reasons_ja, ad_yen, profit_yen, recommended, status, sent_at")
      .gte("created_at", since).order("created_at", { ascending: false }).order("rank", { ascending: true }).limit(3000),
    supabase.from("property_pickup_notes").select("id, created_at, property_customer_id, batch_id, text, author").gte("created_at", since).order("created_at", { ascending: true }).limit(2000),
  ]);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const rows = (data ?? []) as Row[];
  const notes = (notesRes.data ?? []) as Note[];

  type Batch = { batch_id: string; created_at: string; site: string | null; conversation_id: string | null; items: Row[] };
  type Customer = { key: string; property_customer_id: string | null; conversation_id: string | null; customer_name: string | null; batches: Batch[]; notes: Note[]; pending: number; last_at: string };
  const customers = new Map<string, Customer>();
  const batchIndex = new Map<string, Batch>();
  for (const r of rows) {
    const key = r.property_customer_id ?? `conv:${r.conversation_id ?? r.batch_id}`;
    const c = customers.get(key) ?? { key, property_customer_id: r.property_customer_id, conversation_id: r.conversation_id, customer_name: r.customer_name, batches: [], notes: [], pending: 0, last_at: r.created_at };
    if (!c.conversation_id && r.conversation_id) c.conversation_id = r.conversation_id;
    let b = batchIndex.get(r.batch_id);
    if (!b) { b = { batch_id: r.batch_id, created_at: r.created_at, site: r.site, conversation_id: r.conversation_id, items: [] }; batchIndex.set(r.batch_id, b); c.batches.push(b); }
    b.items.push(r);
    if (r.status === "pending") c.pending++;
    if (r.created_at > c.last_at) c.last_at = r.created_at;
    if (r.sent_at && r.sent_at > c.last_at) c.last_at = r.sent_at;
    customers.set(key, c);
  }
  for (const n of notes) {
    const c = customers.get(n.property_customer_id);
    if (!c) continue;
    c.notes.push(n);
    if (n.created_at > c.last_at) c.last_at = n.created_at;
  }
  const list = [...customers.values()]
    .map((c) => ({ ...c, batches: c.batches.map((b) => ({ ...b, items: b.items.sort((a, z) => a.rank - z.rank) })).sort((a, z) => a.created_at.localeCompare(z.created_at)) }))
    .sort((a, z) => z.last_at.localeCompare(a.last_at));
  return NextResponse.json({ ok: true, customers: list });
}
