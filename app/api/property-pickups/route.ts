// GET /api/property-pickups?days=30
// 「売上サポ」のピックアップ: お客様ごとに、ブレインの判断（batch）とスタッフの発言（送った・見送り・メモ）を時系列で返す。
// 画面は LINE の一覧と同じ形（お客様の行 → タップで会話風。左＝ブレイン、右＝スタッフ）。
// 2026-09-24 竹内「紐づいているお客さんで LINE のチャット一覧のような UI。判断したのが会話風に送られる形。DeepSeek 側は左・スタッフは右」
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { toPickupHandoffItem } from "@/app/lib/property-pickups";
import { pickCustomerBest } from "@/app/lib/pickup-best";
import { sortForReview } from "@/app/lib/pickup-review-order";
import { pickSaveImageUrl } from "@/app/lib/pickup-image-url";
import { extractImageWants, dedupeWantsByTopic, imageAnalysisNeed, type ImageWant } from "@/app/lib/image-wants";

export const dynamic = "force-dynamic";

type Row = {
  id: number; created_at: string; batch_id: string; property_customer_id: string | null; conversation_id: string | null;
  customer_name: string | null; site: string | null; rank: number; property_name: string; room_no: string | null;
  summary_text: string; pdf_url: string | null; pdf_blob_url: string | null; pdf_has_text: boolean;
  verdict: string | null; score: number | null; reasons_ja: string[] | null; reason_codes?: string[] | null; ad_yen: number | null; profit_yen: number | null;
  recommended: number; status: string; sent_at: string | null;
  page_image_url: string | null; agent_image_url: string | null; trim_image_url: string | null; image_lines: string[] | null; image_facts: Record<string, boolean | null> | null;
  image_analysis: Record<string, unknown> | null;
  /** 2026-09-24 資料の設備欄 × お客様の条件の照合（pickup-equipment.ts の PickupEquipment） */
  equipment?: Record<string, unknown> | null;
  /** 2026-09-25 資料の表の募集の条件と希望の照合（pickup-terms.ts の PickupTerms） */
  terms?: Record<string, unknown> | null;
};
type Note = { id: number; created_at: string; property_customer_id: string; batch_id: string | null; text: string; author: string | null };

export async function GET(req: NextRequest) {
  // ?ids=1,2,3 → AIX【物件ピックアップした】に渡す画像（お客様に送る1ページ目だけ。元付＝agent_image_url は返さない）
  //   2026-09-24 竹内「AIX で送るにして、押したら AIX の物件ピックアップに選択した画像がセットされた状態に」
  const idsParam = req.nextUrl.searchParams.get("ids");
  if (idsParam) {
    const ids = idsParam.split(",").map((s) => Number(s)).filter((n) => Number.isFinite(n)).slice(0, 10);
    //   2026-09-24 夜: 説明文（summary_text＝AD・🌟 入り）は返さない（AIX の入力欄に流れる入口を作らない・お客様に届く道を塞ぐ）
    const { data, error } = await supabase.from("property_pickups").select("id, rank, property_name, room_no, conversation_id, trim_image_url, page_image_url").in("id", ids);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    const items = ((data ?? []) as Array<{ id: number; rank: number; property_name: string; room_no: string | null; conversation_id: string | null; trim_image_url: string | null; page_image_url: string | null }>)
      .sort((a, z) => a.rank - z.rank)
      .map(toPickupHandoffItem);
    return NextResponse.json({ ok: true, items });
  }
  const days = Math.min(90, Math.max(1, Number(req.nextUrl.searchParams.get("days") ?? "30")));
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  // 2026-09-24 竹内「開くとき重いのは画像を全部読み取っているから。お客さんの詳細を開いた時に読み込まれるように。全て読み込むと重い」:
  //   一覧（view=list）は行の要約だけ（画像・本文・分析は返さない）。詳細（view=detail）は開いたお客様1人分・直近 N 回分だけ
  const view = req.nextUrl.searchParams.get("view");
  if (view === "list") return NextResponse.json(await buildList(since));
  if (view === "detail") {
    const pcid = req.nextUrl.searchParams.get("pcid");
    const conv = req.nextUrl.searchParams.get("conv");
    const nBatches = Math.min(30, Math.max(1, Number(req.nextUrl.searchParams.get("batches") ?? "3")));
    if (!pcid && !conv) return NextResponse.json({ ok: false, error: "pcid か conv が要ります" }, { status: 400 });
    return NextResponse.json(await buildDetail(pcid, conv, nBatches));
  }

  const [{ data, error }, notesRes] = await Promise.all([
    supabase.from("property_pickups")
      .select("id, created_at, batch_id, property_customer_id, conversation_id, customer_name, site, rank, property_name, room_no, summary_text, pdf_url, pdf_blob_url, pdf_has_text, verdict, score, reasons_ja, ad_yen, profit_yen, recommended, status, sent_at, page_image_url, agent_image_url, trim_image_url, image_lines, image_facts, image_analysis, equipment, terms")
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
  // 2026-09-24 竹内「順番も LINE と同じに連動させる。一覧は LINE と同じ UI（アイコンも付ける）」:
  //   紐付いている LINE の会話（アイコン・アカウント・最終更新）を付けて、LINE の一覧と同じ順（updated_at 降順）に並べる
  const convIds = [...new Set([...customers.values()].map((c) => c.conversation_id).filter((v): v is string => !!v))];
  type ConvLite = { id: string; profile_image_url: string | null; updated_at: string | null; account: string | null; status: string | null; last_sender: string | null };
  const convMap = new Map<string, ConvLite>();
  if (convIds.length > 0) {
    const { data: convs } = await supabase.from("conversations").select("id, profile_image_url, updated_at, account, status, last_sender").in("id", convIds);
    for (const cv of (convs ?? []) as ConvLite[]) convMap.set(cv.id, cv);
  }
  const list = [...customers.values()]
    .map((c) => {
      const cv = c.conversation_id ? convMap.get(c.conversation_id) ?? null : null;
      const lastPickupAt = c.batches.map((b) => b.created_at).sort().slice(-1)[0] ?? c.last_at;
      return {
        ...c,
        batches: c.batches.map((b) => ({ ...b, items: b.items.sort((a, z) => a.rank - z.rank) })).sort((a, z) => a.created_at.localeCompare(z.created_at)),
        line: cv ? { profile_image_url: cv.profile_image_url, updated_at: cv.updated_at, account: cv.account, status: cv.status, last_sender: cv.last_sender } : null,
        last_pickup_at: lastPickupAt,
        // LINE の一覧の並び＝会話の updated_at。紐付いていなければピックアップの時刻
        order_at: cv?.updated_at ?? c.last_at,
      };
    })
    .sort((a, z) => z.order_at.localeCompare(a.order_at));
  return NextResponse.json({ ok: true, customers: list });
}

// ── 一覧（軽い要約） ─────────────────────────────────────────────────────────────
// 2026-09-24 竹内「ここに一覧が出るように、開くと履歴が見れる。並びは LINE の一覧と連動」:
//   ピックアップのあるお客様に加えて、直近にお客様へ物件を送った（sent_properties・delivery=customer）お客様も並べる。
//   並びは LINE の一覧と同じ＝会話の updated_at 降順
type SentLite = { conversation_id: string | null; property_customer_id: string | null; channel: string | null; delivery: string | null; source: string | null; sent_at: string | null };
async function buildList(since: string) {
  const [pk, sp] = await Promise.all([
    supabase.from("property_pickups").select("id, created_at, batch_id, property_customer_id, conversation_id, customer_name, rank, property_name, recommended, status, sent_at")
      .gte("created_at", since).order("created_at", { ascending: false }).limit(3000),
    supabase.from("sent_properties").select("conversation_id, property_customer_id, channel, delivery, source, sent_at")
      .gte("sent_at", since).not("conversation_id", "is", null).or("delivery.eq.customer,and(delivery.is.null,source.neq.line_group)").order("sent_at", { ascending: false }).limit(3000),
  ]);
  if (pk.error) return { ok: false, error: pk.error.message };
  type L = {
    key: string; property_customer_id: string | null; conversation_id: string | null; customer_name: string | null;
    pending: number; last_pickup_at: string | null; batch_count: number; last_batch: { batch_id: string; count: number; rec_name: string | null } | null;
    sent: { pickup: number; recommendation: number; other: number; last_at: string | null };
  };
  const byKey = new Map<string, L>();
  const convToKey = new Map<string, string>();
  const batchesSeen = new Map<string, Set<string>>();
  for (const r of (pk.data ?? []) as Array<{ created_at: string; batch_id: string; property_customer_id: string | null; conversation_id: string | null; customer_name: string | null; rank: number; property_name: string; recommended: number; status: string }>) {
    const key = r.property_customer_id ?? `conv:${r.conversation_id ?? r.batch_id}`;
    const c = byKey.get(key) ?? { key, property_customer_id: r.property_customer_id, conversation_id: r.conversation_id, customer_name: r.customer_name, pending: 0, last_pickup_at: null, batch_count: 0, last_batch: null, sent: { pickup: 0, recommendation: 0, other: 0, last_at: null } };
    if (!c.conversation_id && r.conversation_id) c.conversation_id = r.conversation_id;
    if (r.status === "pending") c.pending++;
    if (!c.last_pickup_at || r.created_at > c.last_pickup_at) c.last_pickup_at = r.created_at;
    const seen = batchesSeen.get(key) ?? new Set<string>();
    if (!seen.has(r.batch_id)) { seen.add(r.batch_id); c.batch_count++; }
    batchesSeen.set(key, seen);
    // 行は新しい順に来るので、最初に見た batch が最新
    if (!c.last_batch) c.last_batch = { batch_id: r.batch_id, count: 0, rec_name: null };
    if (c.last_batch.batch_id === r.batch_id) {
      c.last_batch.count++;
      if (r.recommended === 2 || (r.recommended === 1 && !c.last_batch.rec_name)) c.last_batch.rec_name = r.property_name;
    }
    byKey.set(key, c);
    if (c.conversation_id) convToKey.set(c.conversation_id, key);
  }
  for (const s of (sp.data ?? []) as SentLite[]) {
    if (!s.conversation_id) continue;
    const key = convToKey.get(s.conversation_id) ?? (s.property_customer_id && byKey.has(s.property_customer_id) ? s.property_customer_id : null) ?? s.property_customer_id ?? `conv:${s.conversation_id}`;
    const c = byKey.get(key) ?? { key, property_customer_id: s.property_customer_id, conversation_id: s.conversation_id, customer_name: null, pending: 0, last_pickup_at: null, batch_count: 0, last_batch: null, sent: { pickup: 0, recommendation: 0, other: 0, last_at: null } };
    if (!c.conversation_id) c.conversation_id = s.conversation_id;
    if (!c.property_customer_id && s.property_customer_id) c.property_customer_id = s.property_customer_id;
    const ch = s.channel ?? (s.source === "aix:property_send" ? "pickup" : s.source === "aix:property_recommendation" ? "recommendation" : null);
    if (ch === "pickup") c.sent.pickup++; else if (ch === "recommendation") c.sent.recommendation++; else c.sent.other++;
    if (s.sent_at && (!c.sent.last_at || s.sent_at > c.sent.last_at)) c.sent.last_at = s.sent_at;
    byKey.set(key, c);
    convToKey.set(s.conversation_id, key);
  }
  const convIds = [...new Set([...byKey.values()].map((c) => c.conversation_id).filter((v): v is string => !!v))];
  type ConvLite = { id: string; customer_name: string | null; profile_image_url: string | null; updated_at: string | null; account: string | null; status: string | null; last_sender: string | null };
  const convMap = new Map<string, ConvLite>();
  for (let i = 0; i < convIds.length; i += 200) {
    const { data: convs } = await supabase.from("conversations").select("id, customer_name, profile_image_url, updated_at, account, status, last_sender").in("id", convIds.slice(i, i + 200));
    for (const cv of (convs ?? []) as ConvLite[]) convMap.set(cv.id, cv);
  }
  const customers = [...byKey.values()].map((c) => {
    const cv = c.conversation_id ? convMap.get(c.conversation_id) ?? null : null;
    const last = [c.last_pickup_at, c.sent.last_at].filter((v): v is string => !!v).sort().slice(-1)[0] ?? "";
    return {
      ...c,
      customer_name: c.customer_name ?? cv?.customer_name ?? null,
      line: cv ? { profile_image_url: cv.profile_image_url, updated_at: cv.updated_at, account: cv.account, status: cv.status, last_sender: cv.last_sender } : null,
      last_at: last,
      order_at: cv?.updated_at ?? last,
    };
  }).sort((a, z) => (z.order_at ?? "").localeCompare(a.order_at ?? "")).slice(0, 200);
  return { ok: true, customers };
}

// ── 詳細（開いたお客様1人分・直近 N 回分＋送った履歴） ─────────────────────────────
async function buildDetail(pcid: string | null, conv: string | null, nBatches: number) {
  let q = supabase.from("property_pickups")
    .select("id, created_at, batch_id, property_customer_id, conversation_id, customer_name, site, rank, property_name, room_no, summary_text, pdf_url, pdf_blob_url, pdf_has_text, verdict, score, reasons_ja, reason_codes, ad_yen, profit_yen, recommended, status, sent_at, page_image_url, agent_image_url, trim_image_url, image_lines, image_facts, image_analysis, equipment, terms")
    .order("created_at", { ascending: false }).limit(300);
  q = pcid ? q.eq("property_customer_id", pcid) : q.eq("conversation_id", conv as string);
  let sq = supabase.from("sent_properties").select("id, property_name, room_no, channel, delivery, source, sent_at, image_url, pickup_id").order("sent_at", { ascending: false }).limit(40);
  sq = conv ? sq.eq("conversation_id", conv) : sq.eq("property_customer_id", pcid as string);
  // 2026-09-24 竹内「画像で分析が推奨される条件のお客さん（WIC 等）は画像読み取りを推奨」: 条件欄だけの軽い判定（会話・訴求は引かない・DeepSeek も呼ばない）
  const pcRes = pcid
    ? supabase.from("property_customers").select("preferences, ng_points, other_requests, additional_conditions").eq("id", pcid).maybeSingle()
    : Promise.resolve({ data: null });
  const [pk, notesRes, sentRes, condRes] = await Promise.all([
    q,
    pcid ? supabase.from("property_pickup_notes").select("id, created_at, property_customer_id, batch_id, text, author").eq("property_customer_id", pcid).order("created_at", { ascending: true }).limit(200) : Promise.resolve({ data: [] }),
    sq,
    pcRes,
  ]);
  if (pk.error) return { ok: false, error: pk.error.message };
  const rows = (pk.data ?? []) as Row[];
  const order: string[] = [];
  const byBatch = new Map<string, { batch_id: string; created_at: string; site: string | null; conversation_id: string | null; items: Row[] }>();
  for (const r of rows) {
    let b = byBatch.get(r.batch_id);
    if (!b) { b = { batch_id: r.batch_id, created_at: r.created_at, site: r.site, conversation_id: r.conversation_id, items: [] }; byBatch.set(r.batch_id, b); order.push(r.batch_id); }
    b.items.push(r);
  }
  // 2026-09-24 竹内「並び順は物件オススメが一番上でスコアリング順にする」: 🌟★ → 🌟 → 点の高い順（同点は元の順位）。画面も同じ関数で並べ直す
  const batches = order.slice(0, nBatches).map((id) => byBatch.get(id)!).map((b) => ({ ...b, items: sortForReview(b.items) })).sort((a, z) => a.created_at.localeCompare(z.created_at));
  const first = rows[0] ?? null;
  const convId = conv ?? first?.conversation_id ?? null;
  const { data: cv } = convId ? await supabase.from("conversations").select("customer_name, profile_image_url, updated_at, account, status, last_sender").eq("id", convId).maybeSingle() : { data: null };
  const c = cv as { customer_name: string | null; profile_image_url: string | null; updated_at: string | null; account: string | null; status: string | null; last_sender: string | null } | null;
  // 2026-09-24 竹内「1番オススメの物件全体の中で」: 回をまたいだ一番（最新の回から 6時間以内の未送信・画像で分析の点）
  const bestRaw = pickCustomerBest(rows);
  // 2026-09-24 竹内「全体で一番条件に合うのところも画像表示する」: 一番の物件の画像（お客様に送る1ページ目だけ・元付は返さない）
  const bestRow = bestRaw ? rows.find((r) => r.id === bestRaw.id) ?? null : null;
  const best = bestRaw ? { ...bestRaw, image_url: bestRow ? pickSaveImageUrl(bestRow) : null, status: bestRow?.status ?? null } : null;
  // 画像で確かめる希望: 分析済みの回に保存した希望（会話・訴求込み）があればそれ、無ければ条件欄だけで軽く判定
  const savedWants = rows.map((r) => (r.image_analysis as { wants?: unknown } | null)?.wants).find((w): w is ImageWant[] => Array.isArray(w) && w.length > 0) ?? null;
  const cond = (condRes.data ?? null) as { preferences?: string | null; ng_points?: string | null; other_requests?: string | null; additional_conditions?: string | null } | null;
  const wantsForNeed = savedWants ?? dedupeWantsByTopic(extractImageWants({ conditions: cond }));
  const imageNeed = { ...imageAnalysisNeed(wantsForNeed), from: savedWants ? "analysis" : "conditions" };
  return {
    ok: true,
    customer: {
      key: pcid ?? `conv:${convId}`,
      property_customer_id: pcid ?? first?.property_customer_id ?? null,
      conversation_id: convId,
      customer_name: first?.customer_name ?? c?.customer_name ?? null,
      batches,
      notes: (notesRes.data ?? []) as Note[],
      pending: rows.filter((r) => r.status === "pending").length,
      last_at: rows[0]?.created_at ?? "",
      line: c ? { profile_image_url: c.profile_image_url, updated_at: c.updated_at, account: c.account, status: c.status, last_sender: c.last_sender } : null,
      sent_history: (sentRes.data ?? []) as Array<{ id: string; property_name: string; room_no: string | null; channel: string | null; delivery: string | null; source: string | null; sent_at: string; image_url: string | null; pickup_id: number | null }>,
      has_more_batches: order.length > nBatches,
      best,
      image_need: imageNeed,
    },
  };
}
