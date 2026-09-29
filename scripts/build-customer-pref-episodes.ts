// scripts/build-customer-pref-episodes.ts
// 「今までお客様に実際に送った物件」を起点に、お客様ごとのこだわりに合わせた重みを学ぶための材料を組み立てる（読むだけ・DB に書かない・LLM を呼ばない）。
// 純関数は app/lib/customer-pref-episodes.ts。結果は JSON（既定: scratchpad の pcs/）。
//
// 2026-09-29 竹内「実際に今までお客さんに送った物件の部分で実績してもできるから、その点も併せて分析すればよりスコアリング強化できる」
//   正解は「スタッフが選んで送った事実」。お客様の返信の有無は使わない。重みはここでは直さない。
//
// ■ 材料
//   送付   … sent_properties のお客様に届いた行（全期間・2026-08-14〜）を 30分以内の連なりで1束に
//   候補   … 束の前 72h の売上サポの回（property_pickups・札は保存済み）→ 無ければ拡張の回（property_candidate_pools）をまとめて今の判定で付け直す
//   🌟     … recommendation_snapshots（🌟を送った時点の候補＝直近72hに送った物件の中で🌟にした物）は週1回の学習と同じ組み立て（参考として並べる）
//   条件   … property_customers を property_condition_history で送った時点へ戻す。履歴の無い欄（こだわり・NG の 9/27 前・ペット・自由文）は
//            行がその回より前から変わっていない時だけ使う（conditionsReadableAt・今の値を過去の回に当てない・2026-09-29 反証レビュー）
//   お客様 … 鍵は物件顧客 ID の先頭8文字。🌟だけのお客様も条件・履歴・発言を同じように読む（読めない回は strength=null）
//   強さ   … recommend-score-drift.customerStrength（条件欄・自由文・強い言い方・NG 欄・発言・言い直し）＋ 送った物件がその条件を満たす率
// ■ 個人情報: お客様は物件顧客 ID の先頭8文字だけ。名前・発言は出さない。YUMA（テスト用）は外す
//
// 実行: npx tsx --env-file=.env.local scripts/build-customer-pref-episodes.ts [--days=400] [--out-dir=path] [--show=5]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { loadEpisodes } from "../app/lib/scoring-learning-server";
import { buildContext, customerAt, isCustomerSend, type ConditionHistoryRow } from "../app/lib/scoring-learning-episodes";
import type { SentRowLike, PatternRowLike } from "../app/lib/property-brain";
import { isTestConversation, YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";
import { customerStrength, familyJa, type CustomerStrength, type StrengthLevel } from "../app/lib/recommend-score-drift";
import { reasonJa } from "../app/lib/property-brain";
import {
  bundleSends, episodeFromBundle, sentFamilyFit, prefStrength, learnableByFamily, learnableByCode, materialSummary, conditionsReadableAt,
  type PrefEpisode, type SendRow, type PrefStrength,
} from "../app/lib/customer-pref-episodes";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "400"), 10);
const SHOW = parseInt(String(args.show ?? "5"), 10);
const OUT_DIR = String(args["out-dir"] ?? join(process.env.CLAUDE_SCRATCHPAD ?? process.env.TEMP ?? ".", "pcs"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = Record<string, any>;
const H = 3600_000, D = 24 * H;

async function all(build: (a: number, b: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>, page = 1000): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 100; p++) {
    const { data, error } = await build(p * page, p * page + page - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < page) break;
  }
  return out;
}
const chunks = <T,>(xs: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };
const groupBy = <T extends Row>(xs: T[], key: string) => { const m = new Map<string, T[]>(); for (const x of xs) { const k = x[key]; if (!k) continue; (m.get(k) ?? m.set(k, []).get(k)!).push(x); } return m; };
const short = (id: unknown) => String(id ?? "").slice(0, 8) || "?";
const pct = (x: number | null | undefined) => (x == null ? "-" : `${Math.round(x * 100)}%`);
const parse = (v: unknown) => (typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v);

async function main() {
  const until = Date.now();
  const sinceIso = new Date(until - DAYS * D).toISOString();
  const counts: Record<string, number> = {};

  // YUMA
  const yumaCust = new Set<string>();
  { const { data } = await sb.from("conversations").select("property_customer_id").eq("id", YUMA_CONVERSATION_ID).maybeSingle(); if (data?.property_customer_id) yumaCust.add(String(data.property_customer_id)); }

  // ── 送付（お客様に届いた行） ────────────────────────────────────────────────
  const sentAll = await all((a, b) => sb.from("sent_properties").select("id, property_customer_id, conversation_id, property_name, room_no, source, channel, delivery, sent_at, pickup_id, rent").gte("sent_at", sinceIso).order("sent_at").range(a, b) as never);
  counts.sent_rows = sentAll.length;
  const convs = await all((a, b) => sb.from("conversations").select("id, property_customer_id").not("property_customer_id", "is", null).range(a, b) as never);
  const pcOfConv = new Map(convs.map((c) => [String(c.id), String(c.property_customer_id)]));
  const convOfPc = new Map<string, string>();
  for (const c of convs) if (!convOfPc.has(String(c.property_customer_id))) convOfPc.set(String(c.property_customer_id), String(c.id));
  const sends: Row[] = sentAll.filter((r) => isCustomerSend(r) && !isTestConversation(r.conversation_id)).map((r): Row => ({ ...r, property_customer_id: r.property_customer_id ?? (r.conversation_id ? pcOfConv.get(String(r.conversation_id)) ?? null : null) }))
    .filter((r) => r.property_customer_id && !yumaCust.has(String(r.property_customer_id)));
  counts.sent_customer_rows = sends.length;
  counts.sent_no_customer = sentAll.filter((r) => isCustomerSend(r)).length - sends.length;
  const sendsOf = groupBy(sends, "property_customer_id");
  const pcIds = [...sendsOf.keys()];
  counts.customers_with_sends = pcIds.length;

  // ── 🌟の回（週1回の学習と同じ組み立て）のお客様を先に集める（2026-09-29 反証レビュー: 🌟だけのお客様は履歴・発言を読まずに強さを出していた） ──
  const load = await loadEpisodes(sb as never, { until: new Date(until).toISOString(), days: DAYS, sources: ["snapshot"] });
  const snapIds = load.episodes.map((e) => Number(e.id.replace(/^snap:/, "")));
  const snapMeta = new Map<number, Row>();
  for (const c of chunks(snapIds, 150)) for (const r of await all((a, b) => sb.from("recommendation_snapshots").select("id, conversation_id, property_customer_id").in("id", c).range(a, b) as never)) snapMeta.set(Number(r.id), r);
  const snapPcs = [...new Set([...snapMeta.values()].filter((m) => !isTestConversation(m.conversation_id) && m.property_customer_id && !yumaCust.has(String(m.property_customer_id))).map((m) => String(m.property_customer_id)))];
  const allPcIds = [...new Set([...pcIds, ...snapPcs])];
  counts.snapshot_only_customers = snapPcs.filter((p) => !sendsOf.has(p)).length;

  // ── 候補（売上サポの回・拡張の回）・条件・履歴・型・発言 ─────────────────────
  const pickups: Row[] = [], pools: Row[] = [], custRows: Row[] = [], hist: Row[] = [], pats: Row[] = [];
  for (const c of chunks(pcIds, 60)) {
    pickups.push(...await all((a, b) => sb.from("property_pickups").select("id, created_at, batch_id, complete_group_id, rank, complete_rank, property_customer_id, conversation_id, property_name, room_no, score, reason_codes, status, sent_at").in("property_customer_id", c).range(a, b) as never));
    pools.push(...await all((a, b) => sb.from("property_candidate_pools").select("id, property_customer_id, site, sent_at, candidates").in("property_customer_id", c).gte("sent_at", new Date(until - (DAYS + 4) * D).toISOString()).range(a, b) as never, 200));
  }
  for (const c of chunks(allPcIds, 60)) {
    const { data, error } = await sb.from("property_customers").select("*").in("id", c);
    if (error) throw new Error(error.message);
    custRows.push(...(data ?? []));
    hist.push(...await all((a, b) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, created_at").in("property_customer_id", c).range(a, b) as never));
    pats.push(...await all((a, b) => sb.from("property_selection_patterns").select("property_customer_id, selling_points, selection_label, created_at").in("property_customer_id", c).range(a, b) as never));
  }
  counts.pickup_rows = pickups.length; counts.pool_rows = pools.length;
  const custs = new Map(custRows.map((r) => [String(r.id), r]));
  const pickupsOf = groupBy(pickups, "property_customer_id"), poolsOf = groupBy(pools, "property_customer_id"), histOf = groupBy(hist, "property_customer_id"), patOf = groupBy(pats, "property_customer_id");
  const convIds = [...new Set([...sends.map((s) => s.conversation_id), ...allPcIds.map((p) => convOfPc.get(p)), ...[...snapMeta.values()].map((m) => m.conversation_id)].filter(Boolean))].filter((x) => !isTestConversation(x)) as string[];
  const msgsOf = new Map<string, Row[]>();
  const snapTimes = load.episodes.map((e) => Date.parse(e.at)).filter(Number.isFinite);
  const msgSince = new Date(Math.min(...sends.map((s) => Date.parse(s.sent_at)), ...snapTimes) - 60 * D).toISOString();
  for (const c of chunks(convIds, 40)) for (const r of await all((a, b) => sb.from("messages").select("conversation_id, text, created_at").in("conversation_id", c).eq("sender", "customer").gte("created_at", msgSince).range(a, b) as never)) {
    (msgsOf.get(String(r.conversation_id)) ?? msgsOf.set(String(r.conversation_id), []).get(String(r.conversation_id))!).push(r);
  }
  counts.customer_messages = [...msgsOf.values()].reduce((a, x) => a + x.length, 0);

  // ── 1束 → 1回 ──────────────────────────────────────────────────────────────
  const episodes: PrefEpisode[] = [];
  const baseStrengthOf = new Map<string, CustomerStrength>();
  const bundleStats = { bundles: 0, noCandidates: 0, noMatch: 0, byViaBundles: {} as Record<string, number>, noMatchByVia: {} as Record<string, number>, noCandidatesByVia: {} as Record<string, number> };
  // その回の時点で読める条件（customerAt で履歴から戻し、履歴の無い欄は行がその回より前から変わっていない時だけ）
  const unreadableCount: Record<string, number> = {};
  const readableAt = (pc: string, atIso: string): { c: Row; unreadable: string[] } | null => {
    const base = custs.get(pc);
    if (!base) return null;
    const restored = customerAt(base, (histOf.get(pc) ?? []) as ConditionHistoryRow[], atIso).c;
    return conditionsReadableAt(restored, atIso, base.updated_at ?? null);
  };
  const rentMaxAt = (pc: string, atIso: string): number | null => {
    const r = readableAt(pc, atIso);
    if (!r) return null;
    const c = r.c;
    const v = typeof c.rent_max === "number" ? c.rent_max : typeof c.max_rent === "number" ? c.max_rent : parseInt(String(c.rent_max ?? c.max_rent ?? ""), 10);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const strengthAt = (pc: string, cv: string | null, atIso: string): { s: CustomerStrength; unreadable: string[] } | null => {
    const t = Date.parse(atIso);
    const r = readableAt(pc, atIso);
    if (!r) return null;
    for (const f of r.unreadable) unreadableCount[f] = (unreadableCount[f] ?? 0) + 1;
    const h = (histOf.get(pc) ?? []) as ConditionHistoryRow[];
    const msgs = (cv ? msgsOf.get(cv) ?? [] : []).filter((x) => Date.parse(x.created_at) < t && Date.parse(x.created_at) >= t - 60 * D).map((x) => String(x.text ?? ""));
    return { s: customerStrength({ conditions: r.c, messages: msgs, history: h.filter((x) => Date.parse(x.created_at) < t) }), unreadable: r.unreadable };
  };
  for (const pc of pcIds) {
    const cust = custs.get(pc);
    const cv = sendsOf.get(pc)![0].conversation_id ?? convOfPc.get(pc) ?? null;
    // お客様の鍵は物件顧客 ID から（会話 ID を先に使うと🌟の回と別の鍵になり得た・2026-09-29 反証レビュー）
    const customerKey = short(pc);
    const bundles = bundleSends((sendsOf.get(pc) ?? []) as unknown as SendRow[]);
    bundleStats.bundles += bundles.length;
    for (const b of bundles) for (const v of b.vias) bundleStats.byViaBundles[v] = (bundleStats.byViaBundles[v] ?? 0) + 1;
    for (const b of bundles) {
      const t0 = Date.parse(b.start);
      let ctx = null;
      if (cust) {
        const { c } = customerAt(cust, (histOf.get(pc) ?? []) as ConditionHistoryRow[], b.start);
        const before = (sendsOf.get(pc) ?? []).filter((s) => Date.parse(s.sent_at) < t0 - 60_000) as SentRowLike[];
        const pt = (patOf.get(pc) ?? []).filter((p) => Date.parse(p.created_at) < t0) as PatternRowLike[];
        ctx = buildContext(c, before, pt, b.start);
      }
      let e: PrefEpisode | null = null;
      try { e = episodeFromBundle({ bundle: b, customerKey, pickups: (pickupsOf.get(pc) ?? []) as never, pools: (poolsOf.get(pc) ?? []) as never, ctx }); } catch { counts.bundle_errors = (counts.bundle_errors ?? 0) + 1; }
      if (!e) {
        const hasCand = (pickupsOf.get(pc) ?? []).some((r) => Math.abs(Date.parse(r.created_at) - t0) <= 72 * H) || (poolsOf.get(pc) ?? []).some((r) => t0 - Date.parse(r.sent_at) <= 72 * H && Date.parse(r.sent_at) <= t0 + 10 * 60_000);
        const via = b.vias.join("+");
        if (hasCand) { bundleStats.noMatch++; bundleStats.noMatchByVia[via] = (bundleStats.noMatchByVia[via] ?? 0) + 1; }
        else { bundleStats.noCandidates++; bundleStats.noCandidatesByVia[via] = (bundleStats.noCandidatesByVia[via] ?? 0) + 1; }
        continue;
      }
      // 帯の材料（当て直し用）: その時点の家賃の上限・この回より前に送った件数・その時点で読めなかった欄
      const st = strengthAt(pc, cv, b.start);
      e.meta = { rentMax: rentMaxAt(pc, b.start), priorSends: (sendsOf.get(pc) ?? []).filter((s) => Date.parse(s.sent_at) < t0 - 60_000).length, unreadable: st?.unreadable ?? [] };
      episodes.push(e);
      if (st) baseStrengthOf.set(e.id, st.s); else counts.rounds_no_customer_row = (counts.rounds_no_customer_row ?? 0) + 1;
    }
  }
  counts.bundle_rounds = episodes.length;

  // ── 🌟の回（週1回の学習と同じ組み立て・参考）。お客様の条件・履歴・発言は上で送付のお客様と同じように読んだ ─────
  for (const e of load.episodes) {
    const m = snapMeta.get(Number(e.id.replace(/^snap:/, "")));
    if (!m || isTestConversation(m.conversation_id)) continue;
    const pc = String(m.property_customer_id ?? ""), cv = m.conversation_id ? String(m.conversation_id) : (pc ? convOfPc.get(pc) ?? null : null);
    if (pc && yumaCust.has(pc)) continue;
    const pe: PrefEpisode = { ...e, customerKey: pc ? short(pc) : `cv-${short(cv)}`, vias: ["recommendation"], sent: e.cands.filter((c) => c.chosen).length, matched: e.cands.filter((c) => c.chosen).length };
    episodes.push(pe);
    const st = pc ? strengthAt(pc, cv, e.at) : null;
    // 🌟の回の「前に送った件数」は sent_properties のある人だけ数えられる（無い人は null＝新規／継続の帯に入れない）
    const prior = pc && sendsOf.has(pc) ? sendsOf.get(pc)!.filter((s) => Date.parse(s.sent_at) < Date.parse(e.at) - 60_000).length : null;
    pe.meta = { rentMax: pc ? rentMaxAt(pc, e.at) : null, priorSends: prior, unreadable: st?.unreadable ?? [] };
    // 読めなかった回（お客様の行が無い）は strength=null（学ぶ回と帯から外す＝当て直しで除く）
    if (st) baseStrengthOf.set(pe.id, st.s); else counts.rounds_no_customer_row = (counts.rounds_no_customer_row ?? 0) + 1;
  }
  counts.snapshot_rounds = load.episodes.length;
  counts.rounds_with_unreadable_fields = episodes.filter((e) => (e.meta?.unreadable ?? []).length > 0).length;

  // ── こだわりの強さ（お客様ごと・送った物件がその条件を満たす率を足す） ─────────
  const byCust = groupBy(episodes.map((e) => ({ ...e, _k: e.customerKey })), "_k") as Map<string, PrefEpisode[]>;
  const prefOf = new Map<string, PrefStrength>();
  for (const [k, eps] of byCust) {
    const latest = [...eps].sort((a, b) => (a.at < b.at ? 1 : -1))[0];
    const base = baseStrengthOf.get(latest.id) ?? customerStrength({});
    prefOf.set(k, prefStrength(base, sentFamilyFit(eps)));
  }
  // 学べる件数の強さは「その回の時点のお客様の書き方・言い方」だけ（sentFit で上げた強さは、同じ送付を正解にも使うので循環する＝表には使わない）
  const strengthOf = (e: PrefEpisode, family: string): StrengthLevel => baseStrengthOf.get(e.id)?.byFamily[family]?.level ?? "none";

  // ── 報告 ─────────────────────────────────────────────────────────────────────
  const bundleEps = episodes.filter((e) => e.source !== "snapshot");
  const summaryAll = materialSummary(episodes), summaryBundle = materialSummary(bundleEps);
  console.log(`=== 送った物件を起点にした学習の材料（${DAYS}日・YUMA 除く・読むだけ）===`);
  console.log("材料:", JSON.stringify(counts));
  console.log("束:", JSON.stringify(bundleStats));
  console.log("その回の時点で読めなかった欄（回の数）:", JSON.stringify(unreadableCount));
  const line = (t: string, s: ReturnType<typeof materialSummary>) => console.log(`${t}: お客様 ${s.customers}人・回 ${s.rounds}・候補 ${s.candidates}件（選んだ ${s.chosen}）・候補に当たらなかった送付 ${s.unmatchedSends}件\n  材料別: ${JSON.stringify(s.bySource)}\n  月別: ${JSON.stringify(s.byMonth)}\n  経路: ${JSON.stringify(s.byVia)}`);
  line("■ 送付の束の回（売上サポ／拡張の回の候補）", summaryBundle);
  line("■ 全部（🌟の回を含む）", summaryAll);
  console.log(`  候補で条件が読めている数（回の候補 ${summaryAll.candidates}件中）: ${Object.entries(summaryAll.familyCoverage).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${familyJa(f)} ${n}`).join("・")}`);

  const klass = new Map<string, number>();
  for (const p of prefOf.values()) klass.set(p.base.klass, (klass.get(p.base.klass) ?? 0) + 1);
  console.log(`\n■ お客様のこだわりの強さ（${prefOf.size}人・書き方・言い方から）: ${[...klass].map(([k, n]) => `${k} ${n}人`).join("・")}`);
  const raisedCount = new Map<string, number>();
  for (const p of prefOf.values()) for (const f of p.raisedBySentFit) raisedCount.set(f, (raisedCount.get(f) ?? 0) + 1);
  console.log(`  送った物件がその条件を 85% 以上満たす（3件以上）stated の条件 ＝ sentFit で strong に上がる候補（参考・下の表には使わない）: ${[...raisedCount].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${familyJa(f)} ${n}人`).join("・") || "なし"}`);
  const fitAgg = new Map<string, { ok: number; known: number; custs: number }>();
  for (const p of prefOf.values()) for (const [f, v] of Object.entries(p.sentFit)) { const a = fitAgg.get(f) ?? { ok: 0, known: 0, custs: 0 }; a.ok += v.ok; a.known += v.known; a.custs++; fitAgg.set(f, a); }
  console.log(`  送った物件が条件を満たす率（全員・条件が読めた送付だけ）: ${[...fitAgg].sort((a, b) => b[1].known - a[1].known).map(([f, a]) => `${familyJa(f)} ${pct(a.ok / a.known)}（${a.known}件・${a.custs}人）`).join("・")}`);

  const famRows = learnableByFamily(episodes, strengthOf);
  console.log(`\n■ 条件の種類 × こだわりの強さ: 学べる回（選んだ物と選ばなかった物で満たすかが違う回）｜お客様｜選んだ物が満たす｜候補全体｜どの候補でも読めない回`);
  for (const r of famRows.filter((x) => x.rounds > 0 || x.level === "all")) console.log(`  ${familyJa(r.family)}｜${r.level}｜${r.rounds}｜${r.customers}｜${pct(r.chosenOk)}｜${pct(r.poolOk)}｜${r.blindRounds}`);
  const famBundle = learnableByFamily(bundleEps, strengthOf);
  console.log(`\n■ 〃 送付の束の回だけ（🌟の回を除く）`);
  for (const r of famBundle.filter((x) => x.rounds > 0)) console.log(`  ${familyJa(r.family)}｜${r.level}｜${r.rounds}｜${r.customers}｜${pct(r.chosenOk)}｜${pct(r.poolOk)}｜${r.blindRounds}`);

  const codeRows = learnableByCode(episodes, strengthOf);
  console.log(`\n■ 札ごと × 強さ: 学べる回（札の有無が違う回・凍結の札は除く）｜お客様｜選んだ方が持つ率（上位）`);
  for (const r of codeRows.filter((x) => x.level === "all").slice(0, 30)) {
    const sub = codeRows.filter((x) => x.code === r.code && x.level !== "all").map((x) => `${x.level} ${x.rounds}回 ${pct(x.winRate)}`).join(" / ");
    console.log(`  ${r.code}（${reasonJa(r.code)}）｜${r.rounds}｜${r.customers}｜${pct(r.winRate)}｜${sub}`);
  }

  console.log(`\n■ 実例（送付の束の回・新しい順・${SHOW}件）`);
  for (const e of [...bundleEps].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, SHOW)) {
    const p = prefOf.get(e.customerKey);
    const chosen = e.cands.filter((c) => c.chosen);
    const strong = Object.entries(p?.level ?? {}).filter(([, v]) => v === "strong").map(([f]) => familyJa(f));
    console.log(`  [${e.source}] 会話 ${e.customerKey}…・${e.at.slice(0, 16)}・経路 ${e.vias.join("+")}・送付 ${e.sent}件（候補に当たった ${e.matched}）・候補 ${e.cands.length}件${e.poolsMerged ? `・拡張の回 ${e.poolsMerged}回をまとめた` : ""}・こだわり ${p?.base.klass}（指数 ${p?.base.index}）・強い条件: ${strong.join("、") || "なし"}`);
    for (const c of chosen.slice(0, 3)) console.log(`    選んだ ${c.key}: ${typeof c.feats.score === "number" ? `${c.feats.score}点` : "点なし"}・${c.codes.slice(0, 8).join(" ")}`);
    const top = [...e.cands].filter((c) => !c.chosen && typeof c.feats.score === "number").sort((a, b) => (b.feats.score as number) - (a.feats.score as number))[0];
    if (top) console.log(`    選ばなかった中の1位 ${top.key}: ${top.feats.score}点・${top.codes.slice(0, 8).join(" ")}`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const custTable = [...prefOf].map(([k, p]) => ({
    customer: k, klass: p.base.klass, index: p.base.index, ngCount: p.base.ngCount, emphasisCount: p.base.emphasisCount, restatements: p.base.restatements, messages: p.base.messages,
    rounds: byCust.get(k)?.length ?? 0, strong: Object.entries(p.level).filter(([, v]) => v === "strong").map(([f]) => f), raisedBySentFit: p.raisedBySentFit, sentFit: p.sentFit,
  }));
  writeFileSync(join(OUT_DIR, "episodes.json"), JSON.stringify({ days: DAYS, builtAt: new Date(until).toISOString(), counts, bundleStats, episodes: episodes.map((e) => ({ ...e, strength: baseStrengthOf.get(e.id)?.byFamily ?? null, klass: baseStrengthOf.get(e.id)?.klass ?? null })) }, null, 1));
  writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify({ days: DAYS, counts, bundleStats, unreadableCount, summaryAll, summaryBundle, learnableByFamily: famRows, learnableByFamilyBundle: famBundle, learnableByCode: codeRows, customers: custTable }, null, 1));
  console.log(`\n→ ${join(OUT_DIR, "episodes.json")}・${join(OUT_DIR, "summary.json")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
