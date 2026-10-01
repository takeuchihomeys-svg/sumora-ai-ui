// GET /api/property-pickups?days=30
// 「売上サポ」のピックアップ: お客様ごとに、ブレインの判断（batch）とスタッフの発言（送った・見送り・メモ）を時系列で返す。
// 画面は LINE の一覧と同じ形（お客様の行 → タップで会話風。左＝ブレイン、右＝スタッフ）。
// 2026-09-24 竹内「紐づいているお客さんで LINE のチャット一覧のような UI。判断したのが会話風に送られる形。DeepSeek 側は左・スタッフは右」
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { toPickupHandoffItem } from "@/app/lib/property-pickups";
import { orderByRequestedIds } from "@/app/lib/sent-image-order";
import { waitUntil } from "@vercel/functions";
import { pickCustomerBest, bestBasisFor, bestRuleTag, customerImageNeed } from "@/app/lib/pickup-best";
import { COMPLETE_BEST_WINDOW_HOURS } from "@/app/lib/pickup-complete";
import { claimIdleComplete } from "@/app/lib/pickup-complete-server";
import { sortForReview, sentBeforeIds, type SentHistLite } from "@/app/lib/pickup-review-order";
import { pickSaveImageUrl } from "@/app/lib/pickup-image-url";
import { withPickupRetention } from "@/app/lib/pickup-retention";
import { loadConditionSummary } from "@/app/lib/condition-summary-server";
import { groupPickupRounds } from "@/app/lib/pickup-card-view";
import { listingAdStamp, listingRoomText, nameWithRoom } from "@/app/lib/pickup-listing-text";
// 2026-09-28 竹内「審査中と出ているのは物件ピックアップのチェックに入れない」「新規のお客さんは AD の高い物件を優先」（純関数）
import { pickupDealStatus } from "@/app/lib/listing-deal-status";
import { firstProposalSentAt, lastProposalSentAt, type SentLite as ProposalSentLite } from "@/app/lib/pickup-ad-priority";
import { dropDiscountFromRow, isDiscountCompareCode } from "@/app/lib/property-brain";
import { widenChainNotes, type ChainCommandLite, type PickupLite } from "@/app/lib/search-widen-chain";
import { WEB_BRAIN_SOURCE } from "@/app/lib/web-brain-search";
import { summarizeNewArrivals, newArrivalLine, NEW_ARRIVAL_WINDOW_HOURS, type NewArrivalRow, type NewArrivalSummary, type SentBuilding } from "@/app/lib/new-arrivals";

export const dynamic = "force-dynamic";
// 2026-09-25 反証: 詳細を開いた時の10分の自動まとめは、自動の読み取り（最長 約200秒で新しい物件を始めない）を waitUntil で後ろに回す。
//   関数の上限が短いと読み取りの途中で切れ、まとめが running のまま 15分後の Cron のやり直しまで残る → complete と同じ 300秒
export const maxDuration = 300;

type Row = {
  id: number; created_at: string; batch_id: string; property_customer_id: string | null; conversation_id: string | null;
  customer_name: string | null; site: string | null; rank: number; property_name: string; room_no: string | null;
  summary_text: string; pdf_url: string | null; pdf_blob_url: string | null; pdf_has_text: boolean;
  verdict: string | null; score: number | null; reasons_ja: string[] | null; reason_codes?: string[] | null; ad_yen: number | null; profit_yen: number | null;
  recommended: number; status: string; sent_at: string | null;
  page_image_url: string | null; agent_image_url: string | null; trim_image_url: string | null; image_lines: string[] | null; image_facts: Record<string, boolean | null> | null;
  image_analysis: Record<string, unknown> | null;
  /** 2026-09-27 案A: その回をメモの上書きで判定した印（search-override.ts の PickupSearchOverride）。無い行＝登録の条件 */
  search_override?: Record<string, unknown> | null;
  /** 2026-09-27 その回を見つけた検索の種類（pinpoint｜widen・無い行＝分からない） */
  search_mode?: string | null;
  /** 2026-09-24 資料の設備欄 × お客様の条件の照合（pickup-equipment.ts の PickupEquipment） */
  equipment?: Record<string, unknown> | null;
  /** 2026-09-25 資料の表の募集の条件と希望の照合（pickup-terms.ts の PickupTerms） */
  terms?: Record<string, unknown> | null;
  /** 2026-09-25 物件の場所と希望のエリア・通勤の照合（area-want.ts の PickupLocation） */
  location?: Record<string, unknown> | null;
  /** 2026-09-25 画像・資料を消した時刻（/api/cron/pickup-retention） */
  expired_at?: string | null;
};
type Note = { id: number; created_at: string; property_customer_id: string; batch_id: string | null; text: string; author: string | null };

export async function GET(req: NextRequest) {
  // ?ids=1,2,3 → AIX【物件ピックアップした】に渡す画像（お客様に送る1ページ目だけ。元付＝agent_image_url は返さない）
  //   2026-09-24 竹内「AIX で送るにして、押したら AIX の物件ピックアップに選択した画像がセットされた状態に」
  const idsParam = req.nextUrl.searchParams.get("ids");
  if (idsParam) {
    const ids = idsParam.split(",").map((s) => Number(s)).filter((n) => Number.isFinite(n)).slice(0, 10);
    //   2026-09-24 夜: 説明文（summary_text＝AD・🌟 入り）は返さない（AIX の入力欄に流れる入口を作らない・お客様に届く道を塞ぐ）
    const { data, error } = await supabase.from("property_pickups").select("id, created_at, expired_at, rank, property_name, room_no, conversation_id, trim_image_url, page_image_url").in("id", ids);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    // 2026-09-25 保存期間（届いてから 72時間）が切れた物件は画像を渡さない（image_url: null・AIX には載らない）
    const nowMs = Date.now();
    // 2026-10-01 竹内「送った資料の1枚目が一番オススメの物件にする形 1枚目の👑」: 頼まれた ids の順（売上サポの画面の並び＝👑 が先頭・次に点の順）で返す。
    //   旧は rank（拡張の検索順）で並べ直していて、1枚目が 👑 でない回があった（sent-image-order.ts の説明）。
    //   送った印の記録（pickup-sent-plan）は rank 順で URL と結ぶので、画面が URL を rank 順に並べ直して渡す（imageUrlsInRankOrder）
    const items = orderByRequestedIds((data ?? []) as Array<{ id: number; created_at: string; expired_at: string | null; rank: number; property_name: string; room_no: string | null; conversation_id: string | null; trim_image_url: string | null; page_image_url: string | null }>, ids)
      .map((r) => toPickupHandoffItem(withPickupRetention(r, nowMs)));
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
      .select("id, created_at, batch_id, property_customer_id, conversation_id, customer_name, site, rank, property_name, room_no, summary_text, pdf_url, pdf_blob_url, pdf_has_text, verdict, score, reasons_ja, ad_yen, profit_yen, recommended, status, sent_at, page_image_url, agent_image_url, trim_image_url, image_lines, image_facts, image_analysis, equipment, terms, expired_at")
      .gte("created_at", since).order("created_at", { ascending: false }).order("rank", { ascending: true }).limit(3000),
    supabase.from("property_pickup_notes").select("id, created_at, property_customer_id, batch_id, text, author").gte("created_at", since).order("created_at", { ascending: true }).limit(2000),
  ]);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const nowMs = Date.now();
  const rows = ((data ?? []) as Row[]).map((r) => withPickupRetention(r, nowMs));
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
type SentLite = { conversation_id: string | null; property_customer_id: string | null; channel: string | null; delivery: string | null; source: string | null; sent_at: string | null; property_name?: string | null };
async function buildList(since: string) {
  const nowMs = Date.now();
  const [pk, sp, roundOf, na] = await Promise.all([
    // 2026-09-27 一覧の 👑 も詳細と同じ1本の並び（判定の点 → 画像の点）: 画像で分析の点だけ JSON から引く（分析の全文は返さない）・号室も
    supabase.from("property_pickups").select("id, created_at, batch_id, property_customer_id, conversation_id, customer_name, rank, property_name, room_no, recommended, status, sent_at, score, verdict, reason_codes, search_override, ia_match:image_analysis->match, ia_raw:image_analysis->match_raw, ia_ok:image_analysis->ok_count, ia_review:image_analysis->review->>status, ia_wants:image_analysis->wants, ia_checks:image_analysis->checks")
      .gte("created_at", since).order("created_at", { ascending: false }).limit(3000),
    supabase.from("sent_properties").select("conversation_id, property_customer_id, channel, delivery, source, sent_at, property_name")
      .gte("sent_at", since).not("conversation_id", "is", null).or("delivery.eq.customer,and(delivery.is.null,source.neq.line_group)").order("sent_at", { ascending: false }).limit(3000),
    readRoundIds({ since }),
    readNewArrivalCandidates(nowMs),
  ]);
  if (pk.error) return { ok: false, error: pk.error.message };
  type L = {
    key: string; property_customer_id: string | null; conversation_id: string | null; customer_name: string | null;
    pending: number; last_pickup_at: string | null; batch_count: number; last_batch: { batch_id: string; count: number; rec_name: string | null } | null;
    sent: { pickup: number; recommendation: number; other: number; last_at: string | null };
  };
  const byKey = new Map<string, L>();
  const convToKey = new Map<string, string>();
  const sentNamesByKey = new Map<string, SentBuilding[]>();
  // 2026-09-25 竹内「まとめられていない」: 一覧の「🧠 N件」も、短い間に届いた回（リアプロ・itandi）をまとめた1回分で数える
  // 2026-09-25 一覧の「🧠 N件・👑名前」: 一番オススメは DeepSeek の🌟★ ではなく 👑（まとめの best_id → 無ければ判定の点の1位・同点は🌟）
  type BestLite = { id: number; created_at: string; batch_id: string; rank: number; status: string; recommended: number; property_name: string; room_no?: string | null; score: number | null; verdict: string | null; search_override?: unknown;
    reason_codes?: string[] | null;
    image_analysis?: { match?: unknown; match_raw?: unknown; ok_count?: unknown; review?: { status?: unknown }; wants?: unknown; checks?: unknown } | null };
  type BestLiteDb = BestLite & { ia_match?: unknown; ia_raw?: unknown; ia_ok?: unknown; ia_review?: unknown; ia_wants?: unknown; ia_checks?: unknown };
  type BatchSum = { batch_id: string; created_at: string; site: string | null; round_id: string | null; count: number; rows: BestLite[] };
  const batchesSeen = new Map<string, Map<string, BatchSum>>();
  // 2026-09-27 付け直し（backfill-drop-discount-codes --apply）の前の行も、割引と AD の比べの札を外した点・判定で 👑 を決める（詳細と同じ）。
  //   札のある行だけ説明文（AD の月数を読むため）を別に読む
  type ListDb = BestLiteDb & { property_customer_id: string | null; conversation_id: string | null; customer_name: string | null; reason_codes?: string[] | null };
  const listRows = (pk.data ?? []) as ListDb[];
  const discIds = listRows.filter((r) => (r.reason_codes ?? []).some(isDiscountCompareCode)).map((r) => r.id);
  const summaryOf = new Map<number, string | null>();
  for (let i = 0; i < discIds.length; i += 200) {
    const { data: st, error: stErr } = await supabase.from("property_pickups").select("id, summary_text").in("id", discIds.slice(i, i + 200));
    if (stErr) break;
    for (const t of (st ?? []) as Array<{ id: number; summary_text: string | null }>) summaryOf.set(t.id, t.summary_text);
  }
  // 2026-09-29 お客様ごとのこだわりの倍率（判定に渡した物と同じ・表が空なら null＝今まで通り）。お客様ごとに1回だけ引く
  const { prefWeightForCustomer } = await import("@/app/lib/customer-pref-learning-server");
  const prefWOf = new Map<string, ((code: string) => number) | null>();
  for (const pcId of new Set(listRows.filter((r) => (r.reason_codes ?? []).some(isDiscountCompareCode)).map((r) => r.property_customer_id).filter((x): x is string => !!x))) prefWOf.set(pcId, await prefWeightForCustomer(supabase, pcId));
  for (const rx of listRows) {
    const d = (rx.reason_codes ?? []).some(isDiscountCompareCode) ? dropDiscountFromRow({ ...rx, summary_text: summaryOf.get(rx.id) ?? "" }, rx.property_customer_id ? prefWOf.get(rx.property_customer_id) ?? null : null) : null;
    // 2026-09-27 版 b: 👑 は合計（判定の点＋画像の加点）。加点は判定の札と画像の希望・答えから（pickup-image-bonus・詳細と同じ）
    const r0 = d ? { ...rx, score: d.score, verdict: d.verdict, reason_codes: d.reason_codes } : rx;
    const { ia_match, ia_raw, ia_ok, ia_review, ia_wants, ia_checks, ...rest } = r0;
    const r = { ...rest, image_analysis: ia_match === undefined && ia_review === undefined ? null : { match: ia_match, match_raw: ia_raw, ok_count: ia_ok, review: ia_review ? { status: ia_review } : undefined, wants: ia_wants, checks: ia_checks } };
    const key = r.property_customer_id ?? `conv:${r.conversation_id ?? r.batch_id}`;
    const c = byKey.get(key) ?? { key, property_customer_id: r.property_customer_id, conversation_id: r.conversation_id, customer_name: r.customer_name, pending: 0, last_pickup_at: null, batch_count: 0, last_batch: null, sent: { pickup: 0, recommendation: 0, other: 0, last_at: null } };
    if (!c.conversation_id && r.conversation_id) c.conversation_id = r.conversation_id;
    if (r.status === "pending") c.pending++;
    if (!c.last_pickup_at || r.created_at > c.last_pickup_at) c.last_pickup_at = r.created_at;
    const seen = batchesSeen.get(key) ?? new Map<string, BatchSum>();
    const bs = seen.get(r.batch_id) ?? { batch_id: r.batch_id, created_at: r.created_at, site: null, round_id: roundOf.get(r.batch_id) ?? null, count: 0, rows: [] };
    bs.count++;
    if (r.created_at < bs.created_at) bs.created_at = r.created_at;
    bs.rows.push(r);
    seen.set(r.batch_id, bs);
    batchesSeen.set(key, seen);
    byKey.set(key, c);
    if (c.conversation_id) convToKey.set(c.conversation_id, key);
  }
  const lastRounds: Array<{ c: L; key: string; round_id: string | null; rows: BestLite[] }> = [];
  for (const [key, seen] of batchesSeen) {
    const c = byKey.get(key);
    if (!c) continue;
    const rounds = groupPickupRounds([...seen.values()]);
    c.batch_count = rounds.length;
    const last = rounds[rounds.length - 1];
    if (last) {
      c.last_batch = { batch_id: last.key, count: last.batches.reduce((n, b) => n + b.count, 0), rec_name: null };
      lastRounds.push({ c, key: last.key, round_id: last.round_id, rows: last.batches.flatMap((b) => b.rows) });
    }
  }
  // まとめてある回は best_id（画面の 👑 と同じ決まり）。無い回・読めない時・前の決まりのまとめは判定の点の1位（外す候補は除く・同点は画像の点）
  const gids = [...new Set(lastRounds.map((x) => x.round_id).filter((v): v is string => !!v))];
  const bestOf = new Map<string, number>();
  for (let i = 0; i < gids.length; i += 200) {
    const { data } = await supabase.from("property_pickup_completions").select("group_id, best_id, rule:result->>basis_rule").in("group_id", gids.slice(i, i + 200));
    for (const r of (data ?? []) as Array<{ group_id: string; best_id: number | null; rule?: string | null }>) if (r.best_id != null && r.rule === bestRuleTag("score")) bestOf.set(r.group_id, Number(r.best_id));
  }
  const crowns: Array<{ c: L; b: BestLite }> = [];
  for (const x of lastRounds) {
    const pre = x.round_id ? bestOf.get(x.round_id) : undefined;
    const hit = pre != null ? x.rows.find((r) => r.id === pre && r.status === "pending") : undefined;
    const b = hit ?? (() => { const p = pickCustomerBest(x.rows, { basis: "score", windowHours: 24 * 365 }); return p ? x.rows.find((r) => r.id === p.id) : undefined; })();
    if (x.c.last_batch) x.c.last_batch.rec_name = b ? nameWithRoom(b.property_name, b.room_no ?? null) : null;
    if (b && x.c.last_batch) crowns.push({ c: x.c, b });
  }
  // 2026-09-27 竹内「物件名に号室もいれる」（号室は資料の文字のまま・0 を落とさない＝詳細のカードと同じ）:
  //   👑 の1件だけ資料の文字（pdf_text）を読んで号室名を取る（2.5.31 より前の行は room_no の頭の 0 が落ちている）。読めない時は room_no
  const crownIds = crowns.map((x) => x.b.id);
  for (let i = 0; i < crownIds.length; i += 100) {
    const { data: tx, error: txErr } = await supabase.from("property_pickups").select("id, pdf_text").in("id", crownIds.slice(i, i + 100));
    if (txErr) break;
    const roomOf = new Map(((tx ?? []) as Array<{ id: number; pdf_text: string | null }>).map((t) => [t.id, listingRoomText(t.pdf_text)]));
    for (const x of crowns) {
      const rt = roomOf.get(x.b.id);
      if (rt && x.c.last_batch) x.c.last_batch.rec_name = nameWithRoom(x.b.property_name, rt);
    }
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
    const names = sentNamesByKey.get(key) ?? [];
    names.push({ property_name: s.property_name ?? null });
    sentNamesByKey.set(key, names);
  }
  // 2026-09-25 竹内「右の一覧の項目を新着物件に。ブレインの基準をクリアした物件があれば LINE 一覧と同じ UI で 1・2 や文字が出る」:
  //   お客様ごとの新着（通す・未送信・未読・72時間以内・送った建物に当たらない＝new-arrivals.ts）。数・一番新しい時刻・2行目の文
  const newBy = new Map<string, NewArrivalSummary>();
  if (na.rows.length > 0) {
    const rowsByKey = new Map<string, Array<NewArrivalRow>>();
    for (const r of na.rows) {
      const key = (r.conversation_id ? convToKey.get(r.conversation_id) : undefined) ?? r.property_customer_id ?? `conv:${r.conversation_id ?? r.batch_id}`;
      const arr = rowsByKey.get(key) ?? [];
      arr.push(r);
      rowsByKey.set(key, arr);
    }
    for (const [key, rows] of rowsByKey) {
      const sum = summarizeNewArrivals(rows, sentNamesByKey.get(key) ?? [], nowMs);
      if (sum.count > 0) newBy.set(key, sum);
    }
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
    const nw = newBy.get(c.key) ?? null;
    return {
      ...c,
      customer_name: c.customer_name ?? cv?.customer_name ?? null,
      line: cv ? { profile_image_url: cv.profile_image_url, updated_at: cv.updated_at, account: cv.account, status: cv.status, last_sender: cv.last_sender } : null,
      last_at: last,
      order_at: cv?.updated_at ?? last,
      new_count: nw?.count ?? 0,
      new_at: nw?.at ?? null,
      new_line: nw ? newArrivalLine(nw) : null,
    };
  // 並びは今まで通り LINE の順。新着のあるお客様は 200人の枠から落とさない（新着物件のタブは画面で新着の順に並べ直す）
  }).sort((a, z) => ((z.new_count > 0 ? 1 : 0) - (a.new_count > 0 ? 1 : 0)) || (z.order_at ?? "").localeCompare(a.order_at ?? "")).slice(0, 200)
    .sort((a, z) => (z.order_at ?? "").localeCompare(a.order_at ?? ""));
  const newTotal = customers.reduce((n, c) => n + (c.new_count ?? 0), 0);
  return { ok: true, customers, new_total: newTotal, new_error: na.error };
}

/**
 * 新着物件の候補（通す・未送信・未読・画像が残っている・72時間以内）。summary_text は2行目の家賃に使う。
 * seen_at の列がまだ無い（本番に入る前）・読めない時は空＋理由（一覧は出す＝新着だけ出ない）
 */
type NewArrivalDbRow = NewArrivalRow & { property_customer_id: string | null; conversation_id: string | null; batch_id: string };
async function readNewArrivalCandidates(nowMs: number): Promise<{ rows: NewArrivalDbRow[]; error: string | null }> {
  try {
    const since = new Date(nowMs - NEW_ARRIVAL_WINDOW_HOURS * 3600_000).toISOString();
    const { data, error } = await supabase.from("property_pickups")
      .select("id, created_at, batch_id, property_customer_id, conversation_id, property_name, summary_text, verdict, status, expired_at, seen_at, score, recommended, rank")
      .eq("verdict", "pass").eq("status", "pending").is("seen_at", null).is("expired_at", null)
      .gte("created_at", since).order("created_at", { ascending: false }).limit(2000);
    if (error) { console.warn("[property-pickups] 新着を読めない:", error.message); return { rows: [], error: error.message }; }
    return { rows: (data ?? []) as NewArrivalDbRow[], error: null };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 2026-09-30 詳細で読むお客様の条件の列。画像で確かめる希望（customerImageNeed）の4列に、会話の一番上の「🔎 お客様の条件」の列を足した物
 *   （トーク画面の顧客カード app/page.tsx と同じ property_customers が出所）
 */
const CUSTOMER_CONDITION_COLUMNS = "preferences, ng_points, other_requests, additional_conditions, desired_area, area, floor_plan, layout, rent_min, rent_max, max_rent, walk_minutes, building_age, move_in_time, initial_cost_limit, floor_area_min, floor_area_max, pet, commute_station, commute_minutes, exclusion_areas, structure_types, created_at";

// ── 詳細（開いたお客様1人分・直近 N 回分＋送った履歴） ─────────────────────────────
async function buildDetail(pcid: string | null, conv: string | null, nBatches: number) {
  // 2026-09-25 竹内「10分たてば自動的に送られた物件まとめて」: 開いた時に、最後に届いた行から10分を過ぎたまとめ前の回があればその場でまとめる
  //   （Cron・拡張の alarm と同じ判定・同じまとめ ID＝冪等）。まとめ ID を付けるだけ先に待ち（数百ms）、読み取り・順位・👑 は後ろ
  if (pcid) {
    try {
      const idle = await claimIdleComplete(pcid, "screen");
      if (idle.job) { try { waitUntil(idle.job); } catch { /* ローカル: 待たずに走らせる */ } }
    } catch { /* まとめられなくても詳細は出す */ }
  }
  let q = supabase.from("property_pickups")
    .select("id, created_at, batch_id, property_customer_id, conversation_id, customer_name, site, rank, property_name, room_no, summary_text, pdf_url, pdf_blob_url, pdf_has_text, verdict, score, reasons_ja, reason_codes, ad_yen, profit_yen, recommended, status, sent_at, page_image_url, agent_image_url, trim_image_url, image_lines, image_facts, image_analysis, equipment, terms, location, search_override, search_mode, expired_at")
    .order("created_at", { ascending: false }).limit(300);
  q = pcid ? q.eq("property_customer_id", pcid) : q.eq("conversation_id", conv as string);
  let sq = supabase.from("sent_properties").select("id, property_name, room_no, channel, delivery, source, sent_at, image_url, pickup_id").order("sent_at", { ascending: false }).limit(40);
  sq = conv ? sq.eq("conversation_id", conv) : sq.eq("property_customer_id", pcid as string);
  // 2026-09-24 竹内「画像で分析が推奨される条件のお客さん（WIC 等）は画像読み取りを推奨」: 条件欄だけの軽い判定（会話・訴求は引かない・DeepSeek も呼ばない）
  const pcRes = pcid
    ? supabase.from("property_customers").select(CUSTOMER_CONDITION_COLUMNS).eq("id", pcid).maybeSingle()
    : Promise.resolve({ data: null });
  // 2026-09-25 竹内「文章の部分も要約できるように」: 条件の要約（決定論＋保存済みの DeepSeek の要約・ここでは DeepSeek を呼ばない）と照らせない条件
  const sumRes = pcid ? loadConditionSummary(pcid, { allowLlm: false }).catch(() => null) : Promise.resolve(null);
  // 2026-09-25 竹内「まとめられていない」: 拡張の「完了」でまとめた1回分の印（complete_group_id）。列がまだ無い時は読めない（error）→ 届いた時刻で寄せる
  const roundRes = readRoundIds(pcid ? { pcid } : { conv: conv as string });
  // 2026-09-27 竹内「まずピンポイント検索して、なければ広げて検索する形」: 自動で広げたコマンド（payload.chain）と、広げても足りなかった時の「ここで止めます」
  const chainRes: Promise<ChainCommandLite[]> = pcid
    ? Promise.resolve(supabase.from("automation_commands").select("id, created_at, status, sites, customer_ids, payload")
        .contains("customer_ids", [pcid]).eq("payload->>source", WEB_BRAIN_SOURCE).not("payload->chain", "is", null)
        .gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString()).order("created_at", { ascending: false }).limit(10))
        .then((r) => (r.error ? [] : (r.data ?? []) as ChainCommandLite[]), () => [])
    : Promise.resolve([]);
  const [pk, notesRes, sentRes, condRes, sum, roundOf, chainCmds] = await Promise.all([
    q,
    pcid ? supabase.from("property_pickup_notes").select("id, created_at, property_customer_id, batch_id, text, author").eq("property_customer_id", pcid).order("created_at", { ascending: true }).limit(200) : Promise.resolve({ data: [] }),
    sq,
    pcRes,
    sumRes,
    roundRes,
    chainRes,
  ]);
  if (pk.error) return { ok: false, error: pk.error.message };
  // 2026-09-25 竹内「3日前の画像は消される・保存期間が終了しましたと出る（LINE のように）」: 届いてから 72時間を過ぎた行は
  //   画像・資料の URL を空にして expired を付ける（消す処理は毎日1回の cron。間の数時間も画面は 72時間ちょうどでそろえる）
  const nowMs = Date.now();
  // 2026-09-27 竹内「AD はこっち側で自由に変えられる」: 付け直し（backfill-drop-discount-codes --apply）の前の行も、
  //   割引と AD の比べの札を外した点・判定・理由で出す（札・保留・👑 の並びが、付け直した後と同じになる）
  // 2026-09-29 お客様ごとのこだわりの倍率（判定に渡した物と同じ・表が空なら null＝今まで通り）
  const { prefWeightForCustomer } = await import("@/app/lib/customer-pref-learning-server");
  const prefW = await prefWeightForCustomer(supabase, pcid ?? ((pk.data ?? []) as Row[]).find((r) => r.property_customer_id)?.property_customer_id ?? null);
  const rows = ((pk.data ?? []) as Row[]).map((r) => {
    const d = dropDiscountFromRow(r, prefW);
    const r2 = d ? { ...r, score: d.score, verdict: d.verdict, reason_codes: d.reason_codes, reasons_ja: d.reasons_ja } : r;
    return withPickupRetention(r2, nowMs);
  });
  const order: string[] = [];
  const byBatch = new Map<string, { batch_id: string; created_at: string; site: string | null; conversation_id: string | null; items: Row[] }>();
  for (const r of rows) {
    let b = byBatch.get(r.batch_id);
    if (!b) { b = { batch_id: r.batch_id, created_at: r.created_at, site: r.site, conversation_id: r.conversation_id, items: [] }; byBatch.set(r.batch_id, b); order.push(r.batch_id); }
    b.items.push(r);
  }
  // 2026-09-25 竹内「まとめられていない」: 直近 N 回は「まとめの回」（短い間に届いたリアプロ・itandi の回を1つ）で数える。
  //   回の途中で切ると、画面で1つにまとめる回の片方だけが出る → まとめの回ごと返す（画面も同じ関数で寄せる）
  const rounds = groupPickupRounds(order.map((id) => ({ ...byBatch.get(id)!, round_id: roundOf.get(id) ?? null })));
  // 2026-09-24 竹内「並び順は物件オススメが一番上でスコアリング順にする」→ 2026-09-25 点の高い順（同点は🌟★／🌟 → 元の順位）。
  //   一番オススメ（👑）の先頭寄せは画面（pickup-best.roundBestId → sortForReview の bestId）。画面も同じ関数で並べ直す
  const batches0 = rounds.slice(-nBatches).flatMap((r) => r.batches).map((b) => ({ ...b, items: sortForReview(b.items) })).sort((a, z) => a.created_at.localeCompare(z.created_at));
  // 2026-09-27 竹内「物件名に号室もいれる」「AD の項目は重要なので物件名の横にもスタンプでいれる」: 資料の文字（pdf_text）から
  //   号室名と AD の欄を資料の文字のまま読んで行に付ける（pickup-listing-text.ts）。資料の全文は画面に返さない（出す行の分だけ別に読む）
  const shownIds = batches0.flatMap((b) => b.items.map((it) => it.id));
  const listingOf = new Map<number, { ad_text: string | null; room_text: string | null; deal_status: string | null }>();
  const termsOf = new Map(rows.map((r) => [r.id, (r as { terms?: { evidence?: { moveIn?: string | null } | null } | null }).terms ?? null]));
  for (let i = 0; i < shownIds.length; i += 100) {
    const { data: tx, error: txErr } = await supabase.from("property_pickups").select("id, pdf_text").in("id", shownIds.slice(i, i + 100));
    if (txErr) { console.warn("[property-pickups] 資料の文字を読めない（号室・AD の札なし）:", txErr.message); break; }
    for (const t of (tx ?? []) as Array<{ id: number; pdf_text: string | null }>) listingOf.set(t.id, { ad_text: listingAdStamp(t.pdf_text), room_text: listingRoomText(t.pdf_text),
      // 2026-09-28 資料の現況の申込の状況（審査中・商談中）。表の照合の根拠（terms.evidence.moveIn）→ 資料の文字の「現況/入居時期」の順
      deal_status: pickupDealStatus({ terms: termsOf.get(t.id) ?? null, pdf_text: t.pdf_text }) });
  }
  const withListing = <T extends { id: number }>(it: T) => ({ ...it, ad_text: listingOf.get(it.id)?.ad_text ?? null, room_text: listingOf.get(it.id)?.room_text ?? null, deal_status: listingOf.get(it.id)?.deal_status ?? null });
  const batches = batches0.map((b) => ({ ...b, items: b.items.map(withListing) }));
  const first = rows[0] ?? null;
  const convId = conv ?? first?.conversation_id ?? null;
  // 2026-09-28 新規のお客様か（まだ物件を直接お送りしていない）: 一番古いお送りの行（sent_history は新しい40件だけなので別に読む）
  //   2026-09-29 反証: 会話IDだけで読むと、別の会話で送り済みのお客様（652d039f: 9/16 に別の会話で10件）を新規と扱う
  //   → sent-image-record.knownPropertyNames と同じく「会話 or お客様」で読む。delivery（お客様に届けた送付）は読んだ後に絞る（.or を2つ重ねない）
  const custId = pcid ?? (first as { property_customer_id?: string | null } | null)?.property_customer_id ?? null;
  const firstSentQ = (() => {
    if (!convId && !custId) return Promise.resolve<string | null | undefined>(undefined);
    let q = supabase.from("sent_properties").select("sent_at, channel, delivery, source");
    q = convId && custId ? q.or(`conversation_id.eq.${convId},property_customer_id.eq.${custId}`) : convId ? q.eq("conversation_id", convId) : q.eq("property_customer_id", custId as string);
    return Promise.resolve(q.order("sent_at", { ascending: true }).limit(300))
      .then((r) => (r.error ? undefined : firstProposalSentAt(((r.data ?? []) as ProposalSentLite[]).filter((x) => x.delivery == null || x.delivery === "customer"))), () => undefined);
  })();
  // 2026-09-30 YUMA の送付テスト: 送付済みの部屋の照合（売上サポの確かめ・既定のチェック・👑）が sent_history（新しい40行）だけを見ていて、
  //   41行目より前に送った部屋（YUMA: 9/27 に送ったパークサイド岡山 301）を別の回から選んでも「送付済み」の確かめが出なかった。
  //   照合用に建物名と号室だけを会話 or お客様で広く読む（拡張の /api/automation/sent-rooms と同じ広さ・表示用の sent_history は40行のまま）
  const roomHistQ: Promise<SentHistLite[] | null> = (() => {
    if (!convId && !custId) return Promise.resolve(null);
    let q = supabase.from("sent_properties").select("property_name, room_no, delivery, source, channel, sent_at");
    q = convId && custId ? q.or(`conversation_id.eq.${convId},property_customer_id.eq.${custId}`) : convId ? q.eq("conversation_id", convId) : q.eq("property_customer_id", custId as string);
    return Promise.resolve(q.order("sent_at", { ascending: false }).limit(1000))
      .then((r) => (r.error ? null : ((r.data ?? []) as SentHistLite[])), () => null);
  })();
  const [{ data: cv }, firstSent, roomHist] = await Promise.all([
    convId ? supabase.from("conversations").select("customer_name, profile_image_url, updated_at, account, status, last_sender").eq("id", convId).maybeSingle() : Promise.resolve({ data: null }),
    firstSentQ,
    roomHistQ,
  ]);
  // 👑 に送付済みの部屋（別の回で届けた同じ部屋・完全一致）を選ばない（既定のチェックと同じ線・sent-room-match）
  const sentBeforeSet = sentBeforeIds(rows.map((r) => ({ id: r.id, status: r.status, property_name: r.property_name, room_no: r.room_no, room_text: listingOf.get(r.id)?.room_text ?? null })), roomHist ?? (sentRes.data as SentHistLite[] | null) ?? []);
  const notSentBefore = <T extends { id: number }>(xs: T[]): T[] => (sentBeforeSet.size ? xs.filter((x) => !sentBeforeSet.has(x.id)) : xs);
  const c = cv as { customer_name: string | null; profile_image_url: string | null; updated_at: string | null; account: string | null; status: string | null; last_sender: string | null } | null;
  // 画像で確かめる希望: 分析済みの回に保存した希望（会話・訴求込み）があればそれ、無ければ条件欄だけで軽く判定（pickup-best.customerImageNeed）
  const cond = (condRes.data ?? null) as { preferences?: string | null; ng_points?: string | null; other_requests?: string | null; additional_conditions?: string | null } | null;
  const imageNeed = customerImageNeed(rows, cond);
  // 2026-09-25 竹内「画像で分析必要なお客さんなら画像で分析の点、画像で分析不要なお客さんは判定した点」: 👑 の決め方はお客様ごと（決まりの表は pickup-best.ts）
  const basis = bestBasisFor(imageNeed);
  // 2026-09-24 竹内「1番オススメの物件全体の中で」: 回をまたいだ一番（最新の回から 6時間以内の未送信）。
  // 2026-09-25 一番新しい回が「完了」／10分の自動まとめでまとめてあれば、そのまとめの 👑（property_pickup_completions.best_id）を読む。
  //   同じ純関数（pickCustomerBest）・同じ basis をまとめた行に当て、best_id が今も候補なら（未送信・まとめの後に分析し直していない・決まりが同じ）それを一番に
  const latestGid = rows[0] ? roundOf.get(rows[0].batch_id) ?? null : null;
  let bestFrom: "complete" | "window" = "window";
  let bestRaw = null as ReturnType<typeof pickCustomerBest>;
  if (latestGid) {
    const groupRows = rows.filter((r) => roundOf.get(r.batch_id) === latestGid);
    const { data: comp } = await supabase.from("property_pickup_completions").select("status, best_id, finished_at, result").eq("group_id", latestGid).maybeSingle();
    const cp = comp as { status: string | null; best_id: number | null; finished_at: string | null; result: { basis_rule?: string } | null } | null;
    // 反証（2026-09-25）: 時刻は文字の比べ方だと「…Z」と「…+00:00」・小数の桁で食い違う → Date.parse で比べる。
    //   決まり（basis_rule）が無い前の版のまとめは、決まりが同じか分からないので best_id を使わない（同じ関数で並べ直す）
    const finMs = cp?.finished_at ? Date.parse(cp.finished_at) : NaN;
    const reanalyzed = Number.isFinite(finMs) && groupRows.some((r) => {
      const at = Date.parse(String((r.image_analysis as { analyzed_at?: unknown } | null)?.analyzed_at ?? ""));
      return Number.isFinite(at) && at > finMs;
    });
    // 2026-09-27 決まりの名前に版を付けた（bestRuleTag・判定の点 → 画像の点の1本の並び）。前の版のまとめは best_id を使わず並べ直す
    const preferId = cp?.status === "done" && cp.best_id != null && !reanalyzed && cp.result?.basis_rule === bestRuleTag(basis) ? Number(cp.best_id) : null;
    bestRaw = pickCustomerBest(notSentBefore(groupRows), { windowHours: COMPLETE_BEST_WINDOW_HOURS, basis, preferId });
    bestFrom = "complete";
  } else {
    bestRaw = pickCustomerBest(notSentBefore(rows), { basis });
  }
  // 2026-09-24 竹内「全体で一番条件に合うのところも画像表示する」: 一番の物件の画像（お客様に送る1ページ目だけ・元付は返さない）
  const bestRow = bestRaw ? rows.find((r) => r.id === bestRaw.id) ?? null : null;
  const best = bestRaw ? { ...bestRaw, from: bestFrom, image_url: bestRow ? pickSaveImageUrl(bestRow) : null, status: bestRow?.status ?? null,
    room_text: listingOf.get(bestRaw.id)?.room_text ?? null, ad_text: listingOf.get(bestRaw.id)?.ad_text ?? null } : null;
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
      // 2026-09-30 送付済みの部屋の照合用（建物名・号室・届け先だけ・最大1000行）。画面の確かめ・既定のチェックは sent_history（40行）より先にこちらを使う
      ...(roomHist ? { sent_room_history: roomHist } : {}),
      has_more_batches: rounds.length > nBatches,
      // 2026-09-28 一番最初に物件をお送りした時刻（null＝まだ・読めない時は項目なし＝画面は今まで通りの選び方）
      ...(firstSent !== undefined ? { first_proposal_sent_at: firstSent } : {}),
      // 2026-09-30 お客様へ届けた一番最近のご提案の送付（AD1未満の穴埋め「しばらく新着を送れていない」の材料・読めない時は項目なし＝「他に無い時だけ」）
      ...(roomHist ? { last_proposal_sent_at: lastProposalSentAt(roomHist.filter((x) => x.delivery == null || x.delivery === "customer") as ProposalSentLite[]) } : {}),
      best,
      image_need: imageNeed,
      condition_summary: sum ? { line: sum.line, uncheckable: sum.uncheckable, ai: sum.ai.length > 0 } : null,
      // 2026-09-30 竹内「一番上にお客さんの物件探している条件を入れておく」: 会話の一番上の「🔎 お客様の条件」の材料
      //   （property_customers の列そのまま・整形は画面の customer-condition-view.ts）
      customer_conditions: condRes.data ?? null,
      // 2026-09-27 自動で広げた回の説明（サイトごと・24時間以内）。画面は回の見出しの下に出す
      widen_chain: widenChainNotes(chainCmds, rows.map((r) => ({ id: r.id, created_at: r.created_at, site: r.site, verdict: r.verdict, search_mode: r.search_mode ?? null })) as PickupLite[], nowMs)
        .map((n) => ({ ...n, at: chainCmds.find((c) => (c.payload?.chain?.site ?? "") === n.site)?.created_at ?? null })),
    },
  };
}

/**
 * まとめの回の印（拡張の「完了」でまとめた1回分）を batch_id ごとに読む。
 * 列の名前は property_pickups.complete_group_id（/api/property-pickups/complete・pickup-complete-server が付ける）。画面と関数の中では round_id と呼ぶ。
 *   ※ 最初は round_id という列を読んでいた → 本番の列は complete_group_id で、error を握りつぶして時刻でしか寄せていなかった（反証レビューで直した）
 * 列がまだ無い・読めない時は空（届いた時刻で寄せる）。詳細の本体の問い合わせを落とさないよう別に読む
 */
async function readRoundIds(by: { pcid: string } | { conv: string } | { since: string }): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    let q = supabase.from("property_pickups").select("batch_id, complete_group_id").not("complete_group_id", "is", null).order("created_at", { ascending: false }).limit(3000);
    q = "pcid" in by ? q.eq("property_customer_id", by.pcid) : "conv" in by ? q.eq("conversation_id", by.conv) : q.gte("created_at", by.since);
    const { data, error } = await q;
    if (error) { console.warn("[property-pickups] まとめ ID を読めない（時刻で寄せる）:", error.message); return out; }
    for (const r of (data ?? []) as Array<{ batch_id: string; complete_group_id: string | null }>) if (r.complete_group_id && !out.has(r.batch_id)) out.set(r.batch_id, r.complete_group_id);
  } catch { /* 読めなければ時刻で寄せる */ }
  return out;
}
