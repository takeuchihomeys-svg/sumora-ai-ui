// GET /api/property-pickups/talk?conv=<会話ID>[&pcid=<お客様ID>]  → その会話のトーク画面に出す「新着物件カード」（スタッフだけ）
// GET /api/property-pickups/talk?view=counts                    → トーク一覧の印（会話ごとの新着の数＝AIXツールの新着物件と同じ数）
// 2026-09-27 竹内「ブレインの検索 → AIXツールで採点された新着物件を、LINE のトーク画面（スタッフだけ）に折りたたみで出す。
//   押したら AIXツールのそのグループへ。確認したかが分かるように。トークの一覧にも新着 N件・未確認の印」
// 読むだけ（書かない）。中身の決まりは app/lib/new-arrival-card.ts・新着の数は app/lib/new-arrivals.ts（AIXツールと同じ関数）。
// お客様に出ない: 返すのは画面の表示だけ。messages・LINE 送信・下書き・ブレインの材料には入れない。
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { buildNewArrivalCards, type NacAudit, type NacPickupRow } from "@/app/lib/new-arrival-card";
import { summarizeNewArrivals, NEW_ARRIVAL_WINDOW_HOURS, type NewArrivalRow, type SentBuilding } from "@/app/lib/new-arrivals";

export const dynamic = "force-dynamic";

/** トークに出す期間（これより古い回は出さない） */
const TALK_DAYS = 14;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  if (sp.get("view") === "counts") return NextResponse.json(await buildCounts());
  const conv = sp.get("conv");
  const pcidIn = sp.get("pcid");
  if (!conv && !pcidIn) return NextResponse.json({ ok: false, error: "conv か pcid が要ります" }, { status: 400 });
  // .or() の文字に入るので UUID の形だけ通す
  const UUID = /^[0-9a-f-]{36}$/i;
  if ((conv && !UUID.test(conv)) || (pcidIn && !UUID.test(pcidIn))) return NextResponse.json({ ok: false, error: "ID の形が違います" }, { status: 400 });
  // 会話 → お客様（conversations.property_customer_id）で結ぶ
  let pcid = pcidIn;
  if (!pcid && conv) {
    const { data } = await supabase.from("conversations").select("property_customer_id").eq("id", conv).maybeSingle();
    pcid = (data as { property_customer_id: string | null } | null)?.property_customer_id ?? null;
  }
  const since = new Date(Date.now() - TALK_DAYS * 86400_000).toISOString();
  let q = supabase.from("property_pickups")
    .select("id, created_at, batch_id, site, verdict, status, seen_at, sent_at, search_mode, search_override, complete_group_id, property_customer_id, conversation_id, property_name, room_no, trim_image_url")
    .gte("created_at", since).order("created_at", { ascending: false }).limit(600);
  q = pcid && conv ? q.or(`property_customer_id.eq.${pcid},conversation_id.eq.${conv}`) : pcid ? q.eq("property_customer_id", pcid) : q.eq("conversation_id", conv as string);
  const auditsP = pcid
    ? supabase.from("search_audits").select("created_at, site, is_wide, intended, customer_snapshot")
        .eq("property_customer_id", pcid).gte("created_at", new Date(Date.parse(since) - 3 * 3600_000).toISOString())
        .order("created_at", { ascending: false }).limit(200)
    : Promise.resolve({ data: [], error: null });
  const [pk, au] = await Promise.all([q, auditsP]);
  if (pk.error) return NextResponse.json({ ok: false, error: pk.error.message }, { status: 500 });
  const rows = (pk.data ?? []) as Array<NacPickupRow & { property_customer_id: string | null; conversation_id: string | null }>;
  const cards = buildNewArrivalCards(rows, (au.error ? [] : (au.data ?? [])) as NacAudit[]);
  // AIXツールの一覧の鍵（PickupReview の focusKey と同じ: お客様 ID → 無ければ conv:<会話>）
  const focus = pcid ?? rows.find((r) => r.property_customer_id)?.property_customer_id ?? (conv ? `conv:${conv}` : null);
  return NextResponse.json({ ok: true, focus, cards });
}

/** 会話ごとの新着の数（通す・未送信・未読・72時間以内・送った建物に当たらない＝AIXツールの新着物件と同じ） */
async function buildCounts() {
  const nowMs = Date.now();
  const since = new Date(nowMs - NEW_ARRIVAL_WINDOW_HOURS * 3600_000).toISOString();
  const { data, error } = await supabase.from("property_pickups")
    .select("id, created_at, property_customer_id, conversation_id, property_name, verdict, status, expired_at, seen_at")
    .eq("verdict", "pass").eq("status", "pending").is("seen_at", null).is("expired_at", null)
    .gte("created_at", since).limit(2000);
  if (error) return { ok: false, error: error.message, counts: {} };
  const rows = (data ?? []) as Array<NewArrivalRow & { property_customer_id: string | null; conversation_id: string | null }>;
  // 会話の無い行はお客様 → 会話（conversations.property_customer_id）で結ぶ
  const pcids = [...new Set(rows.filter((r) => !r.conversation_id && r.property_customer_id).map((r) => r.property_customer_id as string))];
  const convOfPc = new Map<string, string>();
  for (let i = 0; i < pcids.length; i += 200) {
    const { data: cv } = await supabase.from("conversations").select("id, property_customer_id").in("property_customer_id", pcids.slice(i, i + 200));
    for (const c of (cv ?? []) as Array<{ id: string; property_customer_id: string }>) if (!convOfPc.has(c.property_customer_id)) convOfPc.set(c.property_customer_id, c.id);
  }
  const byConv = new Map<string, NewArrivalRow[]>();
  for (const r of rows) {
    const cid = r.conversation_id ?? (r.property_customer_id ? convOfPc.get(r.property_customer_id) : undefined);
    if (!cid) continue;
    const arr = byConv.get(cid) ?? [];
    arr.push(r);
    byConv.set(cid, arr);
  }
  const convIds = [...byConv.keys()];
  const sentBy = new Map<string, SentBuilding[]>();
  for (let i = 0; i < convIds.length; i += 200) {
    const { data: sp } = await supabase.from("sent_properties").select("conversation_id, property_name")
      .in("conversation_id", convIds.slice(i, i + 200)).or("delivery.eq.customer,and(delivery.is.null,source.neq.line_group)").limit(3000);
    for (const s of (sp ?? []) as Array<{ conversation_id: string; property_name: string | null }>) {
      const arr = sentBy.get(s.conversation_id) ?? [];
      arr.push({ property_name: s.property_name });
      sentBy.set(s.conversation_id, arr);
    }
  }
  const counts: Record<string, number> = {};
  for (const [cid, rs] of byConv) {
    const n = summarizeNewArrivals(rs, sentBy.get(cid) ?? [], nowMs).count;
    if (n > 0) counts[cid] = n;
  }
  return { ok: true, counts };
}
