// scripts/audit-ad-under1.ts — AD1ヶ月未満の物件の扱い（app/lib/ad-under1-policy.ts）を過去の候補・実送信に当てる（読むだけ・何も書かない）
// 実行: npx tsx --env-file=.env.local scripts/audit-ad-under1.ts [--since=2026-09-01] [--stale=7] [--list]
//
// 2026-09-30 竹内「AD1未満の物件は基本的に送らない。売上5万以上ある場合で、他に物件ない場合やしばらく新着を送れていない人などは送っても良い。1K の AD1未満はきほんおくらない」
//   ・A 候補: AD1未満の行を政策（never／fallback）に分け、間取り別・売上別に数える。保存の札（AD_UNDER_1M／AD_NONE）と政策が食い違う行を出す
//   ・B 実送信: 実際にお客様へ届けた物件（status=sent・sent_properties の delivery=customer を会話＋建物名で行に突き合わせ）に never が無いか（誤って外す 0 が目標）
//   ・C 間隔: 回が届いた時点で、そのお客様への最後のご提案の送付から何日だったか（しばらくの線を決める材料）
//   ・D 当て直し: 保存済みの行の札を今の決まりに置き換えた形で pickQualityTop に通し、旧（AD1未満は全部除く）と新（穴埋めあり）を比べる
//   保存済みの行の付け直しはしない（竹内さん「ここからで大丈夫」の前例）
import { createClient } from "@supabase/supabase-js";
import { parsePropertyFacts } from "../app/lib/property-brain";
import { groupPickupRounds } from "../app/lib/pickup-card-view";
import { pickQualityTop, isAdUnder1FallbackRow, type AixPickRow } from "../app/lib/pickup-review-order";
import { adUnder1Policy, adUnder1CodeFor, isStaleForAdUnder1, type AdUnder1Policy } from "../app/lib/ad-under1-policy";
import { isProposalSend, lastProposalSentAt, type SentLite } from "../app/lib/pickup-ad-priority";
import { pickupDealStatus } from "../app/lib/listing-deal-status";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const SINCE = arg("since", "2026-09-01");
const STALE = Number(arg("stale", "8"));
const LIST = process.argv.includes("--list");
const YUMA_CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const norm = (s: unknown) => String(s ?? "").replace(/[\s　]/g, "").toLowerCase();

type Row = AixPickRow & { created_at: string; batch_id: string; property_customer_id: string | null; conversation_id: string | null; customer_name: string | null; property_name: string; room_no: string | null; complete_group_id: string | null; site?: string | null; summary_text?: string | null; ad_yen?: number | null };
type Sent = SentLite & { conversation_id: string | null; property_customer_id: string | null; property_name: string | null };

const bucket = (n: number | null) => n == null ? "売上不明" : n < 30000 ? "〜3万未満" : n < 50000 ? "3万〜5万未満" : n < 80000 ? "5万〜8万未満" : "8万以上";
const inc = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };

async function main() {
  const rows: Row[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await sb.from("property_pickups")
      .select("id, created_at, batch_id, site, property_customer_id, conversation_id, customer_name, rank, property_name, room_no, recommended, status, score, verdict, reason_codes, summary_text, ad_yen, terms, pdf_text, complete_group_id")
      .gte("created_at", SINCE).order("id").range(from, from + 499);
    if (error) throw error;
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 500) break;
  }
  const R = rows.filter((r) => r.conversation_id !== YUMA_CONV).map((r) => ({ ...r, deal_status: pickupDealStatus(r as never) }));
  const facts = new Map<number, ReturnType<typeof parsePropertyFacts>>();
  for (const r of R) facts.set(r.id, parsePropertyFacts(r.summary_text ?? ""));
  const policyOf = (r: Row) => { const f = facts.get(r.id)!; return adUnder1Policy({ adMonths: f.adMonths, adYen: f.adYen, rentYen: f.rentYen, floorPlan: f.floorPlan }); };
  const hasStoredLow = (r: Row) => (r.reason_codes ?? []).some((c) => /^(?:AD_UNDER_1M|AD_NONE)(?:_HELD)?$/.test(c));

  console.log(`対象 ${SINCE} 以降・行 ${R.length}（YUMA を除く）・stale=${STALE}日`);

  // ── A 候補 ──
  console.log("\n■ A 候補: AD1ヶ月未満の行");
  const low = R.filter((r) => hasStoredLow(r) || policyOf(r).policy !== "na");
  const byPolicy: Record<string, number> = {}, byPlan: Record<string, Record<string, number>> = { never: {}, fallback: {} }, bySales: Record<string, Record<string, number>> = { never: {}, fallback: {} };
  const mismatch: string[] = [];
  for (const r of low) {
    const p = policyOf(r);
    const stored = hasStoredLow(r);
    inc(byPolicy, `${p.policy}${stored ? "" : "(保存の札なし)"}`);
    if (p.policy === "na") { mismatch.push(`#${r.id} ${r.customer_name} ${r.property_name} 札=${(r.reason_codes ?? []).filter((c) => /^AD_/.test(c)).join(",")} 月数=${p.months} 売上=${p.salesYen}`); continue; }
    inc(byPlan[p.policy], facts.get(r.id)!.floorPlan || "(間取り不明)");
    inc(bySales[p.policy], bucket(p.salesYen));
  }
  console.log("政策別:", byPolicy);
  console.log("送らない側 never の間取り:", byPlan.never, "売上:", bySales.never);
  console.log("穴埋め fallback の間取り:", byPlan.fallback, "売上:", bySales.fallback);
  console.log(`保存の札はあるのに今の決まりで対象外（na）になった行 ${mismatch.length}件`); for (const m of mismatch.slice(0, 20)) console.log("  " + m);
  const dropOther = low.filter((r) => r.verdict === "drop").length;
  console.log(`うち保存の判定が drop（ほかの理由）${dropOther}件・hold ${low.filter((r) => r.verdict === "hold").length}件・pass ${low.filter((r) => r.verdict === "pass").length}件`);

  // ── B 実送信 ──
  console.log("\n■ B 実送信: お客様へ届けた物件に AD1未満があるか");
  const convIds = [...new Set(R.map((r) => r.conversation_id).filter((x): x is string => !!x))];
  const custIds = [...new Set(R.map((r) => r.property_customer_id).filter((x): x is string => !!x))];
  const sent: Sent[] = [];
  const seenSent = new Set<string>();
  for (const [col, ids] of [["conversation_id", convIds], ["property_customer_id", custIds]] as const) {
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await sb.from("sent_properties").select("id, conversation_id, property_customer_id, property_name, sent_at, channel, delivery, source").in(col, ids.slice(i, i + 100)).or("delivery.eq.customer,delivery.is.null").limit(20000);
      if (error) throw error;
      for (const s of (data ?? []) as Array<Sent & { id: string }>) if (!seenSent.has(s.id)) { seenSent.add(s.id); sent.push(s); }
    }
  }
  const sentRows = R.filter((r) => r.status === "sent");
  const bySentRow: Record<string, number> = {};
  for (const r of sentRows) inc(bySentRow, policyOf(r).policy);
  console.log(`この売上サポから送った（status=sent）${sentRows.length}件の政策:`, bySentRow);
  const idx = new Map<string, Row[]>();
  for (const r of R) { const k = `${r.conversation_id}|${norm(r.property_name)}`; (idx.get(k) ?? idx.set(k, []).get(k)!).push(r); }
  const matched = sent.filter((s) => s.conversation_id !== YUMA_CONV).map((s) => ({ s, rs: idx.get(`${s.conversation_id}|${norm(s.property_name)}`) })).filter((x) => x.rs);
  const byMatched: Record<string, number> = {};
  const wrongly: string[] = [];
  for (const { s, rs } of matched) {
    const pols = rs!.map((r) => policyOf(r).policy);
    const worst: AdUnder1Policy = pols.every((p) => p === "na") ? "na" : pols.includes("fallback") ? "fallback" : "never";
    inc(byMatched, worst);
    if (worst !== "na") wrongly.push(`${(s.sent_at ?? "").slice(0, 16)} ${rs![0].customer_name} ${s.property_name} ${worst} ${policyOf(rs![0]).why}`);
  }
  console.log(`お客様へ届けた ${sent.length}件のうち行に突き合わせできた ${matched.length}件の政策:`, byMatched);
  console.log(`誤って外す（届けた物件が never）: ${wrongly.filter((w) => / never /.test(w)).length}件`);
  for (const w of wrongly) console.log("  送った・AD1未満: " + w);

  // ── C 間隔 ──
  console.log("\n■ C 間隔: 回が届いた時点で、最後のご提案の送付から何日か");
  const sendsOf = (conv: string | null, cust: string | null) => sent.filter((s) => (conv && s.conversation_id === conv) || (cust && s.property_customer_id === cust));
  const byCust = new Map<string, Row[]>();
  for (const r of R) { const k = r.property_customer_id ?? `conv:${r.conversation_id}`; (byCust.get(k) ?? byCust.set(k, []).get(k)!).push(r); }
  type RoundInfo = { name: string; at: string; items: Row[]; lastSent: string | null; gapDays: number | null };
  const rounds: RoundInfo[] = [];
  for (const [, list] of byCust) {
    const conv = list.find((r) => r.conversation_id)?.conversation_id ?? null;
    const cust = list.find((r) => r.property_customer_id)?.property_customer_id ?? null;
    const sends = sendsOf(conv, cust).filter(isProposalSendLite);
    const batches = [...new Map(list.map((r) => [r.batch_id, r])).values()].map((r) => ({ batch_id: r.batch_id, site: r.site ?? null, created_at: list.filter((x) => x.batch_id === r.batch_id).map((x) => x.created_at).sort()[0], round_id: r.complete_group_id, items: list.filter((x) => x.batch_id === r.batch_id) }));
    for (const round of groupPickupRounds(batches)) {
      const items = round.batches.flatMap((b) => b.items);
      const before = sends.filter((s) => s.sent_at && Date.parse(s.sent_at) < Date.parse(round.created_at));
      const last = lastProposalSentAt(before);
      rounds.push({ name: items[0]?.customer_name ?? "?", at: round.created_at, items, lastSent: last, gapDays: last ? (Date.parse(round.created_at) - Date.parse(last)) / 86_400_000 : null });
    }
  }
  const gapBucket = (d: number | null) => d == null ? "一度も送っていない" : d < 1 ? "〜1日" : d < 3 ? "1〜3日" : d < 5 ? "3〜5日" : d < 7 ? "5〜7日" : d < 10 ? "7〜10日" : d < 14 ? "10〜14日" : "14日以上";
  const gaps: Record<string, number> = {};
  for (const r of rounds) inc(gaps, gapBucket(r.gapDays));
  console.log(`回 ${rounds.length}・最後のご提案から:`, gaps);
  const gapsLow: Record<string, number> = {};
  for (const r of rounds) if (r.items.some((x) => policyOf(x).policy === "fallback")) inc(gapsLow, gapBucket(r.gapDays));
  console.log("穴埋め候補（fallback）を含む回の間隔:", gapsLow);

  // ── D 当て直し ──
  console.log("\n■ D 当て直し: 旧（AD1未満は全部除く）→ 新（穴埋めあり）");
  const simRow = (r: Row): Row => {
    const p = policyOf(r);
    if (p.policy === "na" && !hasStoredLow(r)) return r;
    const code = p.policy === "na" ? null : adUnder1CodeFor(p.policy);
    const codes = (r.reason_codes ?? []).map((c) => (c === "AD_UNDER_1M" || c === "AD_UNDER_1M_HELD") && code ? code : c);
    const neverNow = p.policy === "never";
    return { ...r, reason_codes: codes, verdict: neverNow ? "drop" : r.verdict };
  };
  for (const stale of [3, 5, 7, 8, 10, 14]) {
    let fillNoOther = 0, fillStale = 0, roundsWithFallback = 0, filledRows = 0, neverDrop = 0;
    const ex: string[] = [];
    for (const rd of rounds) {
      const asNew = rd.items.map((r) => ({ ...simRow(r), status: "pending", expired: false }));
      const isStale = isStaleForAdUnder1(rd.at, rd.lastSent, stale);
      const q = pickQualityTop(asNew, null, 10, { firstProposal: false, staleSinceLastSend: isStale });
      const fb = asNew.filter((r) => isAdUnder1FallbackRow(r)).length;
      if (fb) roundsWithFallback++;
      neverDrop += asNew.filter((r) => policyOf(r).policy === "never").length;
      if (q.adUnder1Filled) {
        filledRows += q.adUnder1Filled;
        if (q.adUnder1FillWhy === "stale") fillStale++; else fillNoOther++;
        if (ex.length < 12) ex.push(`  ${rd.at.slice(0, 16)} ${rd.name} 通常の候補 ${q.ids.length - q.adUnder1Filled}件＋穴埋め ${q.adUnder1Filled}件（${q.adUnder1FillWhy}・最後の送付 ${rd.gapDays == null ? "なし" : rd.gapDays.toFixed(1) + "日前"}）`);
      }
    }
    console.log(`stale=${stale}日: 穴埋め候補のある回 ${roundsWithFallback}・穴埋めが入る回 ほかに無い ${fillNoOther}／しばらく ${fillStale}・入る行 ${filledRows}`);
    if (stale === STALE) { console.log(`   （never の行 ${neverDrop}）`); for (const e of ex) console.log(e); }
  }
  if (LIST) {
    console.log("\n■ 一覧（AD1未満の行）");
    for (const r of low) { const p = policyOf(r); const f = facts.get(r.id)!; console.log([r.id, r.customer_name, r.property_name, f.floorPlan, f.rentYen, p.months == null ? "" : p.months.toFixed(2), p.salesYen, p.policy, r.verdict, r.score, r.status].join("\t")); }
  }
}
function isProposalSendLite(s: SentLite): boolean { return isProposalSend(s); }
main();
