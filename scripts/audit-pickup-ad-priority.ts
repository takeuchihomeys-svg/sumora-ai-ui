// scripts/audit-pickup-ad-priority.ts — ピックアップの選び方（審査中・商談中を入れない／新規のお客様は AD の高い物件を優先）を過去の回に当てる（読むだけ・何も書かない）
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-ad-priority.ts [--since=2026-09-01] [--list]
//
// 2026-09-28 竹内（app/lib/pickup-ad-priority.ts・pickup-review-order.pickQualityTop）:
//   ・回ごとに「届いた時点で全部未送信だった」として、旧の選び方（点の順に10件・審査中も入る）と新の選び方を比べる
//   ・新規のお客様の回＝その回が届いた時点で、お客様へ物件を1件もお送りしていない（sent_properties の一番古いご提案より前）
//   ・スタッフが実際に送った物件（status=sent）の AD の段: 新規の回／お送りした後の回で分ける（実送信で線を引く）
import { createClient } from "@supabase/supabase-js";
import { dropDiscountFromRow } from "../app/lib/property-brain";
import { groupPickupRounds } from "../app/lib/pickup-card-view";
import { sortForReview, pickQualityTop, dealStatusOf, type AixPickRow } from "../app/lib/pickup-review-order";
import { ngHitCodes } from "../app/lib/property-brain";
import { pickupAdTier, firstProposalSentAt, isFirstProposalRound, AD_TIER_JA, type PickupAdTier, type SentLite } from "../app/lib/pickup-ad-priority";
import { pickupDealStatus } from "../app/lib/listing-deal-status";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const SINCE = arg("since", "2026-09-01");
const LIST = process.argv.includes("--list");
const YUMA_CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

type Row = AixPickRow & { created_at: string; batch_id: string; property_customer_id: string | null; conversation_id: string | null; customer_name: string | null; property_name: string; room_no: string | null; complete_group_id: string | null; site?: string | null; image_analysis?: { match?: unknown; match_raw?: unknown; [k: string]: unknown } | null; pdf_text?: string | null; reasons_ja?: string[] | null; summary_text?: string | null };

async function main() {
  const rows: Row[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await sb.from("property_pickups")
      .select("id, created_at, batch_id, site, property_customer_id, conversation_id, customer_name, rank, property_name, room_no, recommended, status, score, verdict, reason_codes, reasons_ja, summary_text, image_analysis, terms, pdf_text, complete_group_id")
      .gte("created_at", SINCE).order("id").range(from, from + 499);
    if (error) throw error;
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 500) break;
  }
  // 画面と同じ読み出し（割引の札を外した点・判定）と、資料の現況
  const fixed = rows.map((r) => {
    const d = dropDiscountFromRow(r as never);
    const r2 = d ? { ...r, score: d.score, verdict: d.verdict, reason_codes: d.reason_codes } : r;
    return { ...r2, deal_status: pickupDealStatus(r as never) };
  });
  const byCust = new Map<string, Row[]>();
  for (const r of fixed) {
    if (r.conversation_id === YUMA_CONV) continue;
    const k = r.property_customer_id ?? `conv:${r.conversation_id}`;
    (byCust.get(k) ?? byCust.set(k, []).get(k)!).push(r);
  }
  // お客様ごとの一番最初のご提案
  // 2026-09-29 反証: 画面（/api/property-pickups）と同じく「会話 or お客様」で読む（別の会話で送り済みのお客様を新規と数えない）
  const convIds = [...new Set(fixed.map((r) => r.conversation_id).filter((x): x is string => !!x))];
  const custIds = [...new Set(fixed.map((r) => r.property_customer_id).filter((x): x is string => !!x))];
  const sentAll: Array<SentLite & { conversation_id: string | null; property_customer_id: string | null }> = [];
  for (const [col, ids] of [["conversation_id", convIds], ["property_customer_id", custIds]] as const) {
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await sb.from("sent_properties").select("conversation_id, property_customer_id, sent_at, channel, delivery, source").in(col, ids.slice(i, i + 100)).or("delivery.eq.customer,delivery.is.null").limit(10000);
      if (error) throw error;
      sentAll.push(...((data ?? []) as typeof sentAll));
    }
  }
  const firstSentOf = (conv: string | null, cust: string | null) =>
    firstProposalSentAt(sentAll.filter((s) => (conv && s.conversation_id === conv) || (cust && s.property_customer_id === cust)));
  const firstSentConvOnly = (conv: string | null) => firstProposalSentAt(sentAll.filter((s) => conv && s.conversation_id === conv));
  let custChanged = 0;

  const stat = { rounds: 0, firstRounds: 0, laterRounds: 0, dealInOld: 0, dealRoundsOld: 0, changedFirst: 0, adOut: 0, shortFirst: 0, shortFirstOld: 0 };
  const cand: Record<string, Record<PickupAdTier, number>> = { first: { ad2: 0, ad15: 0, ad1: 0, low: 0, unknown: 0 }, later: { ad2: 0, ad15: 0, ad1: 0, low: 0, unknown: 0 } };
  const sentTier: Record<string, Record<PickupAdTier, number>> = { first: { ad2: 0, ad15: 0, ad1: 0, low: 0, unknown: 0 }, later: { ad2: 0, ad15: 0, ad1: 0, low: 0, unknown: 0 } };
  const sentDeal = { first: 0, later: 0 };
  const caseShape: Record<string, number> = {};
  const examples: string[] = [];
  for (const [, list] of byCust) {
    const conv = list.find((r) => r.conversation_id)?.conversation_id ?? null;
    const cust = list.find((r) => r.property_customer_id)?.property_customer_id ?? null;
    const fs = conv || cust ? firstSentOf(conv, cust) : undefined;
    if ((conv ? firstSentConvOnly(conv) : undefined) !== fs) custChanged++;
    const batches = [...new Map(list.map((r) => [r.batch_id, r])).values()].map((r) => ({ batch_id: r.batch_id, site: r.site ?? null, created_at: list.filter((x) => x.batch_id === r.batch_id).map((x) => x.created_at).sort()[0], round_id: r.complete_group_id, items: list.filter((x) => x.batch_id === r.batch_id) }));
    for (const round of groupPickupRounds(batches)) {
      const items = round.batches.flatMap((b) => b.items);
      const asNew = items.map((r) => ({ ...r, status: "pending", expired: false }));
      stat.rounds++;
      const first = isFirstProposalRound(round.created_at, fs);
      const key = first ? "first" : "later";
      if (first) stat.firstRounds++; else stat.laterRounds++;
      // 旧: NG・保留なしを点の順に10件（審査中・商談中も入る）
      const notNg = asNew.filter((r) => !(r.verdict === "drop" || r.verdict === "hold" || ngHitCodes(r.reason_codes).length > 0));
      const oldIds = sortForReview(notNg).slice(0, 10).map((r) => r.id);
      const deal = oldIds.filter((id) => dealStatusOf(asNew.find((r) => r.id === id)!)).length;
      stat.dealInOld += deal; if (deal) stat.dealRoundsOld++;
      const q = pickQualityTop(asNew, null, 10, { firstProposal: first });
      for (const r of notNg.filter((x) => !dealStatusOf(x))) cand[key][pickupAdTier(r.reason_codes)]++;
      for (const r of items.filter((x) => x.status === "sent")) { sentTier[key][pickupAdTier(r.reason_codes)]++; if (dealStatusOf(r)) sentDeal[key as "first" | "later"]++; if (LIST && first) console.log(`  送った(新規の回) ${round.created_at.slice(0, 16)} ${r.customer_name} #${r.id} ${r.property_name} ${AD_TIER_JA[pickupAdTier(r.reason_codes)]} ${r.score} 新で選ぶ=${pickQualityTop(asNew, null, 10, { firstProposal: true }).ids.includes(r.id)}`); }
      if (first) {
        const t: Record<PickupAdTier, number> = { ad2: 0, ad15: 0, ad1: 0, low: 0, unknown: 0 };
        for (const r of notNg.filter((x) => !dealStatusOf(x))) t[pickupAdTier(r.reason_codes)]++;
        const shape = `AD2+ ${t.ad2 >= 8 ? "8件以上" : "8件未満"}・AD1.5以上 ${t.ad2 + t.ad15 >= 10 ? "10件以上" : "10件未満"}`;
        caseShape[shape] = (caseShape[shape] ?? 0) + 1;
        const changed = oldIds.filter((id) => !q.ids.includes(id)).length + q.ids.filter((id) => !oldIds.includes(id)).length > 0;
        if (changed) stat.changedFirst++;
        stat.adOut += q.adExcluded;
        if (q.ids.length < 10) stat.shortFirst++;
        if (oldIds.length < 10) stat.shortFirstOld++;
        if ((changed || LIST) && examples.length < 40) {
          const name = items[0]?.customer_name ?? "?";
          const lab = (id: number) => { const r = asNew.find((x) => x.id === id)!; return `#${id}${AD_TIER_JA[pickupAdTier(r.reason_codes)]}/${r.score}${dealStatusOf(r) ? `/${dealStatusOf(r)}` : ""}${r.status}`; };
          examples.push(`${round.created_at.slice(0, 16)} ${name} 候補 AD2+ ${t.ad2}・AD1.5 ${t.ad15}・AD1 ${t.ad1}・不明 ${t.unknown} ／ 旧 ${oldIds.length}件 → 新 ${q.ids.length}件（AD で外す ${q.adExcluded}・審査/商談 ${q.dealExcluded}）\n    旧: ${oldIds.map(lab).join(" ")}\n    新: ${q.ids.map(lab).join(" ")}`);
        }
      }
    }
  }
  console.log(`対象 ${SINCE} 以降・行 ${rows.length}・お客様 ${byCust.size}（YUMA を除く）`);
  console.log(`回 ${stat.rounds}（新規の回 ${stat.firstRounds}・お送りした後の回 ${stat.laterRounds}）`);
  console.log(`   2026-09-29 反証: 「会話 or お客様」で読んで最初のご提案の時刻が変わったお客様 ${custChanged}人`);
  console.log(`① 審査中・商談中: 旧の既定のチェック（点の順10件）に入っていた部屋 ${stat.dealInOld}件（${stat.dealRoundsOld}回）→ 新は0`);
  console.log(`   スタッフが実際に送った審査中・商談中: 新規の回 ${sentDeal.first}・後の回 ${sentDeal.later}`);
  console.log(`② 新規の回で選ばれる物件が変わる回 ${stat.changedFirst}/${stat.firstRounds}・AD の段で外れた物件 ${stat.adOut}件・10件に足りない回 旧 ${stat.shortFirstOld} → 新 ${stat.shortFirst}`);
  console.log(`   新規の回の形:`, caseShape);
  console.log(`   候補（通す・NG なし・審査中/商談中でない）の AD の段:`, cand);
  console.log(`   スタッフが実際に送った物件の AD の段:`, sentTier);
  console.log(examples.join("\n"));
}
main();
