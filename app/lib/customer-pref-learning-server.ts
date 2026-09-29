// app/lib/customer-pref-learning-server.ts（サーバー専用・DB・DeepSeek。画面から import しない）
// お客様ごとのこだわりの倍率（customer-pref-weights）の **毎週の学習**（材料を作り直す → 学ぶ → 当て直す → 良くなった時だけ表を更新 → 記録）と、
// 判定（judgeProperty）に渡す倍率の読み込み（表が空なら null＝今まで通り）。純関数は customer-pref-learning.ts・customer-pref-weights.ts。
//
// 2026-09-29 竹内「（お客様ごとの採点の倍率を毎週の学習に）組み込む」「DeepSeek で分析できるかな？ 物件検索ブレイン（DeepSeek）の部分が分析する形」
//
// ■ 材料（loadPrefEpisodes＝scripts/build-customer-pref-episodes.ts の組み立てをここに移した・スクリプトはこれを呼ぶ）
//   送付（sent_properties のお客様に届いた行）を 30分の連なりで1束 → 束の前 72h の売上サポの回（保存済みの札）／無ければ拡張の回を今の判定で付け直す。
//   🌟の回（recommendation_snapshots）は週1回の学習と同じ組み立て。条件は履歴でその回の時点へ戻し、履歴の無い欄は行が変わっていない時だけ読む。
//   お客様の鍵＝物件顧客 ID の先頭8文字。YUMA は外す。名前・発言は記録に出さない
// ■ 表: scoring_pref_weights（版・status proposed/active/retired/rejected・weights＝{家族:{strong,stated}}）。active は1つ。version 0＝表なし
// ■ 記録: scoring_pref_learning_runs（数字・前の表・後の表・帯・DeepSeek の読み・週のまとめ）／scoring_pref_reads（DeepSeek が読んだ物・鍵で二度読まない）
import type { SupabaseClient } from "@supabase/supabase-js";
import { baseReasonPoints, reasonJa, type SentRowLike, type PatternRowLike } from "./property-brain";
import { loadEpisodes } from "./scoring-learning-server";
import { buildContext, customerAt, isCustomerSend, type ConditionHistoryRow, type CandLike } from "./scoring-learning-episodes";
import { isTestConversation, YUMA_CONVERSATION_ID } from "./test-conversations";
import { customerStrength, type CustomerStrength, type StrengthLevel } from "./recommend-score-drift";
import { isApplicationPayload } from "./pii-pseudonym";
import { maskPII } from "./pii-mask";
import { loadDeepseekCutoff, isAfterCutoff } from "./post-apply";
import {
  bundleSends, episodeFromBundle, sentFamilyFit, prefStrength, conditionsReadableAt, materialSummary,
  type PrefEpisode, type SendRow, type PrefStrength,
} from "./customer-pref-episodes";
import {
  PREF_WEIGHT_CONFIG, backtestPrefWeights, defaultBandsOf, splitByTime, splitByCustomer, prefWeightResolver, tableHasEffect,
  type PrefWeightTable, type PrefBacktest, type StrengthMap,
} from "./customer-pref-weights";
import {
  PREF_LEARNING_CONFIG, prefAutoApplyEnabled, decidePrefApply, sanitizePrefTable, diffPrefTables, inputHash, estimateDeepSeekUsd, budgetAllows,
  STRENGTH_SYSTEM, buildStrengthUser, parseStrengthReply, strengthMapFromLlm, APPEAL_SYSTEM, buildAppealUser, parseAppealReply,
  HYPOTHESIS_SYSTEM, buildHypothesisUser, parseHypothesisReply, SUMMARY_SYSTEM, buildSummaryUser, parseSummaryReply, deterministicWeeklySummary,
  compareStrengthSources, topCounts, type ReadKind, type LlmStrengthLevel, type WeeklyNumbers, type HypothesisInput,
} from "./customer-pref-learning";

type Row = Record<string, any>;
const H = 3600_000, D = 24 * H;

async function all(build: (a: number, b: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>, page = 1000, maxPages = 100): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < maxPages; p++) {
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
const parse = (v: unknown) => (typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ─── 材料 ────────────────────────────────────────────────────────────────────

/** 回ごとに足した材料（DeepSeek に読ませる物・帯・比べる物） */
export type PrefEpisodeEx = PrefEpisode & {
  strength: CustomerStrength["byFamily"] | null;
  klass: CustomerStrength["klass"] | null;
  conversationId: string | null;
  /** スタッフが送った文（🌟の本文・AIX 物件ピックアップの文）。訴求を読む材料 */
  appealTexts: string[];
  /** 👑（採点の1位）と違う物を選んだ回の材料（👑 を選んだ回・👑 が決まらない回は null） */
  hyp: { crownKey: string; crownText: string; crownScore: number | null; chosenKey: string; chosenText: string; chosenScore: number | null } | null;
};
export type PrefCustomerInfo = {
  customerKey: string; pc: string; cv: string | null; latestAt: string; customerName: string | null;
  /** 最新の回の時点で読める条件（DeepSeek に渡す欄はここから） */
  conditions: Row | null;
  /** 最新の回より前 60日のお客様の発言（申込フォーム・空は除く・cutoff は読む時に引く） */
  messages: Array<{ text: string; at: string }>;
};
export type PrefLoad = {
  episodes: PrefEpisodeEx[];
  counts: Record<string, number>;
  bundleStats: Record<string, unknown>;
  unreadableCount: Record<string, number>;
  prefOf: Map<string, PrefStrength>;
  customers: Map<string, PrefCustomerInfo>;
};

const candText = (c: CandLike): string => {
  const p: string[] = [];
  if (num(c.rent) != null) p.push(`家賃 ${Math.round((c.rent as number) / 1000) / 10}万`);
  if (c.floor_plan) p.push(String(c.floor_plan));
  if (num(c.area_sqm) != null) p.push(`${c.area_sqm}㎡`);
  if (num(c.building_age) != null) p.push(`築${c.building_age}年`);
  if (num(c.walk_minutes) != null) p.push(`徒歩${c.walk_minutes}分${c.station ? `（${c.station}）` : ""}`);
  if (num(c.floor) != null) p.push(`${c.floor}階`);
  if (num(c.ad_months) != null) p.push(`AD${c.ad_months}ヶ月`);
  if (num(c.deposit_months) != null || num(c.key_money_months) != null) p.push(`敷${c.deposit_months ?? "-"}礼${c.key_money_months ?? "-"}`);
  if (Array.isArray(c.equipment) && c.equipment.length) p.push(`設備: ${c.equipment.slice(0, 8).join("・")}`);
  return p.join("・");
};

/** 期間の材料を組み立てる（読むだけ・DB に書かない・LLM を呼ばない） */
export async function loadPrefEpisodes(sb: SupabaseClient, opts: { days: number; until?: string }): Promise<PrefLoad> {
  const until = opts.until ? Date.parse(opts.until) : Date.now();
  const DAYS = opts.days;
  const sinceIso = new Date(until - DAYS * D).toISOString();
  const counts: Record<string, number> = {};

  const yumaCust = new Set<string>();
  { const { data } = await sb.from("conversations").select("property_customer_id").eq("id", YUMA_CONVERSATION_ID).maybeSingle(); if (data?.property_customer_id) yumaCust.add(String(data.property_customer_id)); }

  // ── 送付（お客様に届いた行） ──
  const sentAll = await all((a, b) => sb.from("sent_properties").select("id, property_customer_id, conversation_id, property_name, room_no, source, channel, delivery, sent_at, pickup_id, rent").gte("sent_at", sinceIso).lte("sent_at", new Date(until).toISOString()).order("sent_at").range(a, b) as never);
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

  // ── 🌟の回（週1回の学習と同じ組み立て） ──
  const load = await loadEpisodes(sb, { until: new Date(until).toISOString(), days: DAYS, sources: ["snapshot"] });
  const snapIds = load.episodes.map((e) => Number(e.id.replace(/^snap:/, "")));
  const snapMeta = new Map<number, Row>();
  for (const c of chunks(snapIds, 150)) for (const r of await all((a, b) => sb.from("recommendation_snapshots").select("id, conversation_id, property_customer_id, star_text").in("id", c).range(a, b) as never)) snapMeta.set(Number(r.id), r);
  const snapPcs = [...new Set([...snapMeta.values()].filter((m) => !isTestConversation(m.conversation_id) && m.property_customer_id && !yumaCust.has(String(m.property_customer_id))).map((m) => String(m.property_customer_id)))];
  const allPcIds = [...new Set([...pcIds, ...snapPcs])];
  counts.snapshot_only_customers = snapPcs.filter((p) => !sendsOf.has(p)).length;

  // ── 候補（売上サポの回・拡張の回）・条件・履歴・型・発言・訴求の文・👑 ──
  const pickups: Row[] = [], pools: Row[] = [], custRows: Row[] = [], hist: Row[] = [], pats: Row[] = [];
  for (const c of chunks(pcIds, 60)) {
    pickups.push(...await all((a, b) => sb.from("property_pickups").select("id, created_at, batch_id, complete_group_id, rank, complete_rank, property_customer_id, conversation_id, property_name, room_no, score, reason_codes, status, sent_at, summary_text").in("property_customer_id", c).range(a, b) as never));
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
  const bestOf = new Map<string, number>();
  for (const r of await all((a, b) => sb.from("property_pickup_completions").select("group_id, best_id").range(a, b) as never)) if (r.group_id && r.best_id != null) bestOf.set(String(r.group_id), Number(r.best_id));
  const custs = new Map(custRows.map((r) => [String(r.id), r]));
  const pickupsOf = groupBy(pickups, "property_customer_id"), poolsOf = groupBy(pools, "property_customer_id"), histOf = groupBy(hist, "property_customer_id"), patOf = groupBy(pats, "property_customer_id");
  const convIds = [...new Set([...sends.map((s) => s.conversation_id), ...allPcIds.map((p) => convOfPc.get(p)), ...[...snapMeta.values()].map((m) => m.conversation_id)].filter(Boolean))].filter((x) => !isTestConversation(x)) as string[];
  const msgsOf = new Map<string, Row[]>();
  const snapTimes = load.episodes.map((e) => Date.parse(e.at)).filter(Number.isFinite);
  const msgSince = new Date(Math.min(...sends.map((s) => Date.parse(s.sent_at)), ...snapTimes, until) - 60 * D).toISOString();
  const appealRows: Row[] = [];
  for (const c of chunks(convIds, 40)) {
    for (const r of await all((a, b) => sb.from("messages").select("conversation_id, text, created_at").in("conversation_id", c).eq("sender", "customer").gte("created_at", msgSince).range(a, b) as never)) {
      (msgsOf.get(String(r.conversation_id)) ?? msgsOf.set(String(r.conversation_id), []).get(String(r.conversation_id))!).push(r);
    }
    // 訴求の文: 🌟の本文と AIX 物件ピックアップの文（送った時刻で束に結ぶ）
    for (const r of await all((a, b) => sb.from("recommendation_snapshots").select("conversation_id, sent_at, star_text").in("conversation_id", c).gte("sent_at", sinceIso).range(a, b) as never)) if (r.star_text) appealRows.push({ cv: r.conversation_id, at: r.sent_at, text: r.star_text });
    for (const r of await all((a, b) => sb.from("aix_usage_logs").select("conversation_id, sent_at, generated_text").in("conversation_id", c).eq("aix_type", "property_send").not("sent_at", "is", null).gte("sent_at", sinceIso).range(a, b) as never)) if (r.generated_text) appealRows.push({ cv: r.conversation_id, at: r.sent_at, text: r.generated_text });
  }
  counts.customer_messages = [...msgsOf.values()].reduce((a, x) => a + x.length, 0);
  counts.appeal_texts = appealRows.length;
  const appealOf = groupBy(appealRows, "cv");
  const appealsIn = (cv: string | null, t0: number, t1: number) => (cv ? (appealOf.get(cv) ?? []) : []).filter((r) => { const t = Date.parse(r.at); return t >= t0 - 10 * 60_000 && t <= t1 + 10 * 60_000; }).map((r) => String(r.text));

  // ── その回の時点で読める条件・強さ ──
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
  const messagesBefore = (cv: string | null, t: number) => (cv ? msgsOf.get(cv) ?? [] : []).filter((x) => Date.parse(x.created_at) < t && Date.parse(x.created_at) >= t - 60 * D);
  const strengthAt = (pc: string, cv: string | null, atIso: string): { s: CustomerStrength; unreadable: string[] } | null => {
    const t = Date.parse(atIso);
    const r = readableAt(pc, atIso);
    if (!r) return null;
    for (const f of r.unreadable) unreadableCount[f] = (unreadableCount[f] ?? 0) + 1;
    const h = (histOf.get(pc) ?? []) as ConditionHistoryRow[];
    const msgs = messagesBefore(cv, t).map((x) => String(x.text ?? ""));
    return { s: customerStrength({ conditions: r.c, messages: msgs, history: h.filter((x) => Date.parse(x.created_at) < t) }), unreadable: r.unreadable };
  };

  // 👑 と選んだ物（仮説の材料）。pickup は best_id → 無ければ点の単独1位・pool は付け直した点の1位
  const hypOf = (e: PrefEpisode, textOf: (key: string) => string | null, bestKey: string | null): PrefEpisodeEx["hyp"] => {
    const scored = e.cands.filter((c) => num(c.feats.score) != null);
    let crown = bestKey ? e.cands.find((c) => c.key === bestKey) ?? null : null;
    if (!crown && scored.length >= 2) { const top = Math.max(...scored.map((c) => c.feats.score as number)); const tops = scored.filter((c) => c.feats.score === top); crown = tops.length === 1 ? tops[0] : null; }
    if (!crown || crown.chosen) return null;
    const chosen = [...e.cands].filter((c) => c.chosen).sort((a, b) => (num(b.feats.score) ?? -1e9) - (num(a.feats.score) ?? -1e9))[0];
    if (!chosen) return null;
    return { crownKey: crown.key, crownText: textOf(crown.key) ?? "", crownScore: num(crown.feats.score), chosenKey: chosen.key, chosenText: textOf(chosen.key) ?? "", chosenScore: num(chosen.feats.score) };
  };

  const episodes: PrefEpisodeEx[] = [];
  const baseStrengthOf = new Map<string, CustomerStrength>();
  const bundleStats = { bundles: 0, noCandidates: 0, noMatch: 0, byViaBundles: {} as Record<string, number>, noMatchByVia: {} as Record<string, number>, noCandidatesByVia: {} as Record<string, number> };
  for (const pc of pcIds) {
    const cust = custs.get(pc);
    const cv = sendsOf.get(pc)![0].conversation_id ?? convOfPc.get(pc) ?? null;
    const customerKey = short(pc);
    const bundles = bundleSends((sendsOf.get(pc) ?? []) as unknown as SendRow[]);
    bundleStats.bundles += bundles.length;
    for (const b of bundles) for (const v of b.vias) bundleStats.byViaBundles[v] = (bundleStats.byViaBundles[v] ?? 0) + 1;
    for (const b of bundles) {
      const t0 = Date.parse(b.start), t1 = Date.parse(b.end);
      let ctx = null;
      if (cust) {
        const { c } = customerAt(cust, (histOf.get(pc) ?? []) as ConditionHistoryRow[], b.start);
        const before = (sendsOf.get(pc) ?? []).filter((s) => Date.parse(s.sent_at) < t0 - 60_000) as SentRowLike[];
        const pt = (patOf.get(pc) ?? []).filter((p) => Date.parse(p.created_at) < t0) as PatternRowLike[];
        ctx = buildContext(c, before, pt, b.start);
      }
      let e: PrefEpisode | null = null;
      const pk = (pickupsOf.get(pc) ?? []) as Row[];
      try { e = episodeFromBundle({ bundle: b, customerKey, pickups: pk as never, pools: (poolsOf.get(pc) ?? []) as never, ctx }); } catch { counts.bundle_errors = (counts.bundle_errors ?? 0) + 1; }
      if (!e) {
        const hasCand = pk.some((r) => Math.abs(Date.parse(r.created_at) - t0) <= 72 * H) || (poolsOf.get(pc) ?? []).some((r) => t0 - Date.parse(r.sent_at) <= 72 * H && Date.parse(r.sent_at) <= t0 + 10 * 60_000);
        const via = b.vias.join("+");
        if (hasCand) { bundleStats.noMatch++; bundleStats.noMatchByVia[via] = (bundleStats.noMatchByVia[via] ?? 0) + 1; }
        else { bundleStats.noCandidates++; bundleStats.noCandidatesByVia[via] = (bundleStats.noCandidatesByVia[via] ?? 0) + 1; }
        continue;
      }
      const st = strengthAt(pc, cv, b.start);
      e.meta = { rentMax: rentMaxAt(pc, b.start), priorSends: (sendsOf.get(pc) ?? []).filter((s) => Date.parse(s.sent_at) < t0 - 60_000).length, unreadable: st?.unreadable ?? [] };
      // 仮説の材料: 売上サポの回は行の説明文と best_id・拡張の回は候補の値
      let textOf: (key: string) => string | null = () => null;
      let bestKey: string | null = null;
      if (e.source === "pickup") {
        const rows = pk.filter((r) => { const t = Date.parse(r.created_at); return t >= t0 - 72 * H && t <= t1 + 10 * 60_000; });
        const keyOfRow = (r: Row) => `${r.property_name ?? ""}${r.room_no ? ` ${String(r.room_no).normalize("NFKC").replace(/号室?$/, "").replace(/^0+(?=\d)/, "").trim()}` : ""}`;
        const byKey = new Map<string, Row>();
        for (const r of rows) if (!byKey.has(keyOfRow(r))) byKey.set(keyOfRow(r), r);
        textOf = (k) => (byKey.get(k)?.summary_text ? String(byKey.get(k)!.summary_text) : null);
        const gid = rows[0]?.complete_group_id ?? null;
        const bid = gid ? bestOf.get(String(gid)) ?? null : null;
        const best = bid != null ? rows.find((r) => Number(r.id) === bid) ?? null : null;
        bestKey = best ? keyOfRow(best) : null;
      } else if (e.source === "pool") {
        const byKey = new Map<string, string>();
        for (const p of (poolsOf.get(pc) ?? []).filter((p) => { const t = Date.parse(p.sent_at); return t >= t0 - 72 * H && t <= t0 + 10 * 60_000; })) {
          const raw = parse(p.candidates) as CandLike[] | null;
          if (!Array.isArray(raw)) continue;
          for (const c of raw) if (c?.name) { const k = `${c.name}${c.room_no ? ` ${String(c.room_no).normalize("NFKC").replace(/号室?$/, "").replace(/^0+(?=\d)/, "").trim()}` : ""}`; if (!byKey.has(k)) byKey.set(k, candText(c)); }
        }
        textOf = (k) => byKey.get(k) ?? null;
      }
      const ex: PrefEpisodeEx = { ...e, strength: st?.s.byFamily ?? null, klass: st?.s.klass ?? null, conversationId: cv, appealTexts: appealsIn(cv, t0, t1), hyp: hypOf(e, textOf, bestKey) };
      episodes.push(ex);
      if (st) baseStrengthOf.set(e.id, st.s); else counts.rounds_no_customer_row = (counts.rounds_no_customer_row ?? 0) + 1;
    }
  }
  counts.bundle_rounds = episodes.length;

  // ── 🌟の回 ──
  for (const e of load.episodes) {
    const m = snapMeta.get(Number(e.id.replace(/^snap:/, "")));
    if (!m || isTestConversation(m.conversation_id)) continue;
    const pc = String(m.property_customer_id ?? ""), cv = m.conversation_id ? String(m.conversation_id) : (pc ? convOfPc.get(pc) ?? null : null);
    if (pc && yumaCust.has(pc)) continue;
    const st = pc ? strengthAt(pc, cv, e.at) : null;
    const prior = pc && sendsOf.has(pc) ? sendsOf.get(pc)!.filter((s) => Date.parse(s.sent_at) < Date.parse(e.at) - 60_000).length : null;
    const pe: PrefEpisodeEx = {
      ...e, customerKey: pc ? short(pc) : `cv-${short(cv)}`, vias: ["recommendation"], sent: e.cands.filter((c) => c.chosen).length, matched: e.cands.filter((c) => c.chosen).length,
      meta: { rentMax: pc ? rentMaxAt(pc, e.at) : null, priorSends: prior, unreadable: st?.unreadable ?? [] },
      strength: st?.s.byFamily ?? null, klass: st?.s.klass ?? null, conversationId: cv, appealTexts: m.star_text ? [String(m.star_text)] : [], hyp: null,
    };
    episodes.push(pe);
    if (st) baseStrengthOf.set(pe.id, st.s); else counts.rounds_no_customer_row = (counts.rounds_no_customer_row ?? 0) + 1;
  }
  counts.snapshot_rounds = load.episodes.length;
  counts.rounds_with_unreadable_fields = episodes.filter((e) => (e.meta?.unreadable ?? []).length > 0).length;

  // ── お客様ごとの強さ（送った物件が満たす率を足した物・報告用）と、DeepSeek に渡す材料 ──
  const byCust = new Map<string, PrefEpisodeEx[]>();
  for (const e of episodes) (byCust.get(e.customerKey) ?? byCust.set(e.customerKey, []).get(e.customerKey)!).push(e);
  const prefOf = new Map<string, PrefStrength>();
  const customers = new Map<string, PrefCustomerInfo>();
  const pcOfKey = new Map<string, string>();
  for (const pc of allPcIds) pcOfKey.set(short(pc), pc);
  for (const [k, eps] of byCust) {
    const latest = [...eps].sort((a, b) => (a.at < b.at ? 1 : -1))[0];
    const base = baseStrengthOf.get(latest.id) ?? customerStrength({});
    prefOf.set(k, prefStrength(base, sentFamilyFit(eps)));
    const pc = pcOfKey.get(k);
    if (!pc) continue;
    const cust = custs.get(pc);
    const cv = latest.conversationId ?? convOfPc.get(pc) ?? null;
    const r = readableAt(pc, latest.at);
    customers.set(k, {
      customerKey: k, pc, cv, latestAt: latest.at, customerName: cust?.customer_name ? String(cust.customer_name) : null, conditions: r?.c ?? null,
      messages: messagesBefore(cv, Date.parse(latest.at)).map((x) => ({ text: String(x.text ?? ""), at: String(x.created_at) })).filter((x) => x.text.trim() && !isApplicationPayload(x.text)),
    });
  }
  counts.customers = customers.size;
  return { episodes, counts, bundleStats, unreadableCount, prefOf, customers };
}

// ─── 表（版） ────────────────────────────────────────────────────────────────

export type PrefVersion = { version: number; status: "proposed" | "active" | "retired" | "rejected"; table: PrefWeightTable; created_at?: string; note?: string | null };

export async function listPrefVersions(sb: SupabaseClient): Promise<PrefVersion[]> {
  const { data, error } = await sb.from("scoring_pref_weights").select("version, status, weights, created_at, note").order("version");
  if (error) throw new Error(error.message);
  return ((data ?? []) as Row[]).map((r) => ({ version: Number(r.version), status: r.status, table: sanitizePrefTable(r.weights) ?? {}, created_at: r.created_at, note: r.note ?? null }));
}

/** 版を active にする（0＝表なし）。今の active は retired。scoring-learning-server.activateWeightVersion と同じ順（先に retired → active） */
export async function activatePrefVersion(sb: SupabaseClient, target: number, note?: string): Promise<{ ok: boolean; active: number; error?: string }> {
  try {
    const versions = await listPrefVersions(sb);
    if (target !== 0 && !versions.some((v) => v.version === target)) throw new Error(`版 ${target} がありません`);
    const now = new Date().toISOString();
    for (const v of versions) {
      if (v.status !== "active" || v.version === target) continue;
      const { error } = await sb.from("scoring_pref_weights").update({ status: "retired", retired_at: now }).eq("version", v.version);
      if (error) throw new Error(error.message);
    }
    if (target !== 0 && versions.find((v) => v.version === target)?.status !== "active") {
      const { error } = await sb.from("scoring_pref_weights").update({ status: "active", activated_at: now, ...(note ? { note } : {}) }).eq("version", target);
      if (error) throw new Error(error.message);
    }
    tableCache = null;
    custCache.clear();
    return { ok: true, active: target };
  } catch (e) {
    return { ok: false, active: -1, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 前の版に戻す（今の active より前の一番新しい retired・無ければ 0＝表なし） */
export async function rollbackPrefVersion(sb: SupabaseClient): Promise<{ ok: boolean; active: number; error?: string }> {
  const versions = await listPrefVersions(sb);
  const cur = versions.filter((v) => v.status === "active").sort((a, b) => b.version - a.version)[0] ?? null;
  const prev = cur ? versions.filter((v) => v.status === "retired" && v.version < cur.version).sort((a, b) => b.version - a.version)[0] : null;
  return activatePrefVersion(sb, prev?.version ?? 0, "rollback");
}

// ─── 判定に渡す（表が空なら null＝今まで通り） ───────────────────────────────

let tableCache: { at: number; table: PrefWeightTable | null; version: number } | null = null;
const custCache = new Map<string, { at: number; w: ((code: string) => number) | null }>();

/** DB の表を使うか（環境変数 CUSTOMER_PREF_WEIGHTS=off で止める。既定は使う＝表が空なら何も変わらない） */
export function prefWeightsDbEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.CUSTOMER_PREF_WEIGHTS ?? "").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false");
}

/** active の表（10分は読み直さない）。読めない・無い・効く所が無い時は null */
export async function loadActivePrefTable(sb: SupabaseClient): Promise<{ version: number; table: PrefWeightTable | null }> {
  if (tableCache && Date.now() - tableCache.at < PREF_LEARNING_CONFIG.cacheMs) return { version: tableCache.version, table: tableCache.table };
  let table: PrefWeightTable | null = null, version = 0;
  try {
    const { data, error } = await sb.from("scoring_pref_weights").select("version, weights").eq("status", "active").order("version", { ascending: false }).limit(1).maybeSingle();
    if (!error && data) { table = sanitizePrefTable((data as Row).weights); version = table ? Number((data as Row).version) : 0; }
    if (table && !tableHasEffect(table)) { table = null; }
  } catch { table = null; version = 0; }
  tableCache = { at: Date.now(), table, version };
  return { version, table };
}

const STRENGTH_COLS = "id, customer_name, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, floor_area_min, raw_format_text, desired_area, commute_station, commute_minutes";

/**
 * お客様1人の倍率の関数（judgeProperty の opts.prefWeight と、判定の後で点を付け直す関数に **同じ物** を渡す）。
 *   表が空・止めている・お客様が分からない・読めない時は null（今まで通りの点）。強さは決定論（customerStrength: 条件欄・履歴・発言）。10分はお客様ごとに使い回す
 */
export async function prefWeightForCustomer(sb: SupabaseClient, propertyCustomerId: string | null | undefined): Promise<((code: string) => number) | null> {
  if (!propertyCustomerId || !prefWeightsDbEnabled()) return null;
  const { table } = await loadActivePrefTable(sb);
  if (!table) return null;
  const hit = custCache.get(propertyCustomerId);
  if (hit && Date.now() - hit.at < PREF_LEARNING_CONFIG.cacheMs) return hit.w;
  let w: ((code: string) => number) | null = null;
  try {
    const [c, h, cv] = await Promise.all([
      sb.from("property_customers").select(STRENGTH_COLS).eq("id", propertyCustomerId).maybeSingle(),
      sb.from("property_condition_history").select("changed_field").eq("property_customer_id", propertyCustomerId).limit(200),
      sb.from("conversations").select("id").eq("property_customer_id", propertyCustomerId).limit(5),
    ]);
    if (!c.error && c.data) {
      const convIds = ((cv.data ?? []) as Array<{ id: string }>).map((x) => x.id).filter((id) => !isTestConversation(id));
      let msgs: string[] = [];
      if (convIds.length) {
        const m = await sb.from("messages").select("text").in("conversation_id", convIds).eq("sender", "customer").gte("created_at", new Date(Date.now() - 60 * D).toISOString()).order("created_at", { ascending: false }).limit(200);
        msgs = ((m.data ?? []) as Array<{ text?: string | null }>).map((x) => String(x.text ?? ""));
      }
      const s = customerStrength({ conditions: c.data as Row, messages: msgs, history: (h.data ?? []) as Array<{ changed_field: string }> });
      w = prefWeightResolver(s.byFamily as StrengthMap, table);
    }
  } catch { w = null; }
  custCache.set(propertyCustomerId, { at: Date.now(), w });
  return w;
}

// ─── DeepSeek で読む ─────────────────────────────────────────────────────────

type ReadResult<T> = { value: T | null; usd: number; ok: boolean; model: string; input: number; cacheHit: number; output: number };

/** 物件の判断と同じ口（推論なし・温度0・同じ前置きで1回読み直し・Claude に倒さない）。使用量は llm_usage_logs に名札付き */
async function deepseekRead<T>(action: string, system: string, user: string, maxTokens: number, parseFn: (t: string) => T | null, conversationId: string | null, timeoutMs: number): Promise<ReadResult<T>> {
  const { callDeepSeekRead, VISION_ALT_MODEL_DEFAULT } = await import("./vision-alt-provider");
  const out = await callDeepSeekRead(system, user, { maxTokens, timeoutMs }, parseFn);
  let usd = 0, input = 0, cacheHit = 0, output = 0;
  const now = new Date().toISOString();
  for (const a of out.attempts) {
    const u = a.res?.usage;
    if (u) { usd += estimateDeepSeekUsd({ input: u.input, cacheHit: u.cacheHit, output: u.output }, now); input += u.input; cacheHit += u.cacheHit; output += u.output; }
  }
  void import("./llm-usage-recorder").then(({ recordAltUsage }) => {
    for (const a of out.attempts) {
      recordAltUsage({
        model: a.res?.model ?? VISION_ALT_MODEL_DEFAULT, action, conversationId,
        usage: { input_tokens: a.res?.usage.cacheMiss ?? 0, output_tokens: a.res?.usage.output ?? 0, cache_read_input_tokens: a.res?.usage.cacheHit ?? 0 },
        status: a.res ? 200 : 0, errorType: a.ok ? null : a.res ? "empty_or_unparsable" : "no_response",
        durationMs: a.ms, sysHead: (a.retry ? "【採点の学習・読み直し】" : "【採点の学習】") + system.slice(0, 120), sysKeyFull: null, maxTokens,
      });
    }
  }).catch(() => {});
  return { value: out.value, usd: +usd.toFixed(6), ok: !out.failed, model: out.res?.model ?? VISION_ALT_MODEL_DEFAULT, input, cacheHit, output };
}

type ReadRow = { kind: ReadKind; key: string; input_hash: string; result: unknown; ok: boolean; cost_usd: number; conversation_id?: string | null };

/** 小さい並列（DeepSeek への同時数） */
async function mapLimit<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (i < xs.length) { const k = i++; out[k] = await f(xs[k]); } }));
  return out;
}

// ─── 週1回 ───────────────────────────────────────────────────────────────────

export type PrefLearningReport = {
  ok: boolean; dry: boolean; until: string; days: number;
  counts: Record<string, number>;
  activeVersion: number;
  current: PrefWeightTable | null;
  backtest: PrefBacktest;
  /** お客様で分けた当て直し（参考） */
  byCustomer: Array<{ split: string; gain: number; changes: number; enable: boolean; reason: string }>;
  /** DeepSeek の強さ（読めた人だけ・他は決定論）で当て直した時 */
  llmBacktest: { coverage: number; customers: number; gain: number; enable: boolean; reason: string; changes: number } | null;
  strengthCompare: ReturnType<typeof compareStrengthSources> | null;
  apply: { apply: boolean; propose: boolean; reason: string; version: number | null; tableBefore: PrefWeightTable | null; tableAfter: PrefWeightTable | null; diff: ReturnType<typeof diffPrefTables> };
  llm: { enabled: boolean; reads: Record<ReadKind, number>; reused: Record<ReadKind, number>; skipped: Record<string, number>; usd: number; budgetUsd: number; stoppedBy: string | null; summaryUsd: number };
  appealTop: Array<[string, number]>;
  hypothesisTop: Array<[string, number]>;
  hypothesisNotes: string[];
  weeklySummary: string;
  weeklySummarySource: "deepseek" | "deterministic";
  runId?: number | null;
  error?: string;
  ms: number;
};

export async function runPrefLearning(sb: SupabaseClient, opts: {
  dry?: boolean; days?: number; until?: string; autoApplyEnabled?: boolean;
  /** DeepSeek の読み（既定 on。dry で件数を絞る時は maxReads・budgetUsd） */
  llm?: { enabled?: boolean; maxReads?: Partial<Record<ReadKind, number>>; budgetUsd?: number; timeBudgetMs?: number; summary?: boolean };
  log?: (s: string) => void;
} = {}): Promise<PrefLearningReport> {
  const t0 = Date.now();
  const dry = !!opts.dry;
  const days = opts.days ?? PREF_LEARNING_CONFIG.days;
  const until = opts.until ?? new Date().toISOString();
  const log = opts.log ?? (() => {});
  const cfg = PREF_WEIGHT_CONFIG;

  // ① 材料
  const load = await loadPrefEpisodes(sb, { days, until });
  const eps = load.episodes.filter((e) => e.strength != null);
  const counts = { ...load.counts, rounds: load.episodes.length, usable: eps.length, dropped_no_strength: load.episodes.length - eps.length };
  log(`材料: 回 ${load.episodes.length}（強さの読めた回 ${eps.length}）・お客様 ${load.customers.size}人・${Math.round((Date.now() - t0) / 1000)}秒`);

  // 今の表
  let versions: PrefVersion[] = [];
  try { versions = await listPrefVersions(sb); } catch { versions = []; }
  const act = versions.find((v) => v.status === "active") ?? null;
  const current = act && tableHasEffect(act.table) ? act.table : null;

  // ② 学ぶ・当て直す（決定論の強さ）
  const strengthOf = (e: PrefEpisodeEx, f: string): StrengthLevel => e.strength?.[f]?.level ?? "none";
  const backtest = backtestPrefWeights(eps, baseReasonPoints, strengthOf as never, defaultBandsOf as never, cfg, current, splitByTime);
  const byCustomer = [splitByCustomer(1), splitByCustomer(0)].map((sp, i) => {
    const b = backtestPrefWeights(eps, baseReasonPoints, strengthOf as never, defaultBandsOf as never, cfg, current, sp);
    return { split: i === 0 ? "A で学び B で確かめ" : "B で学び A で確かめ", gain: b.gain, changes: b.learned.changes.length, enable: b.decision.enable, reason: b.decision.reason };
  });
  log(`当て直し（時期）: ${backtest.decision.enable ? "使う" : "使わない"} — ${backtest.decision.reason}`);

  // ③ DeepSeek で読む（強さ・訴求・仮説）。同じ材料は二度読まない（scoring_pref_reads）
  const llmEnabled = (opts.llm?.enabled ?? true) && !!(process.env.DEEPSEEK_API_KEY ?? "").trim();
  const maxReads: Record<ReadKind, number> = { ...PREF_LEARNING_CONFIG.maxReads, ...(opts.llm?.maxReads ?? {}) } as Record<ReadKind, number>;
  const budgetUsd = opts.llm?.budgetUsd ?? PREF_LEARNING_CONFIG.weeklyBudgetUsd;
  const timeBudgetMs = opts.llm?.timeBudgetMs ?? PREF_LEARNING_CONFIG.llmTimeBudgetMs;
  const llm = { enabled: llmEnabled, reads: { customer: 0, appeal: 0, hypothesis: 0 } as Record<ReadKind, number>, reused: { customer: 0, appeal: 0, hypothesis: 0 } as Record<ReadKind, number>, skipped: {} as Record<string, number>, usd: 0, budgetUsd, stoppedBy: null as string | null, summaryUsd: 0 };
  const skip = (why: string) => { llm.skipped[why] = (llm.skipped[why] ?? 0) + 1; };
  const existing = new Map<string, ReadRow>();
  try {
    for (const r of await all((a, b) => sb.from("scoring_pref_reads").select("kind, key, input_hash, result, ok, cost_usd").range(a, b) as never)) existing.set(`${r.kind}|${r.key}`, r as ReadRow);
  } catch (e) { log(`scoring_pref_reads を読めない（表が無い？）: ${e instanceof Error ? e.message : String(e)}`); }
  const newRows: ReadRow[] = [];
  const llmStart = Date.now();
  const canRead = () => { if (!llmEnabled) return false; if (!budgetAllows(llm.usd, budgetUsd)) { llm.stoppedBy ??= `費用の上限 $${budgetUsd}`; return false; } if (Date.now() - llmStart > timeBudgetMs) { llm.stoppedBy ??= `時間の上限 ${Math.round(timeBudgetMs / 1000)}秒`; return false; } return true; };
  const conc = PREF_LEARNING_CONFIG.concurrency, tmo = PREF_LEARNING_CONFIG.readTimeoutMs;

  // 3-1 お客様のこだわりの強さ
  const llmStrength = new Map<string, Record<string, LlmStrengthLevel>>();
  const custList = [...load.customers.values()].sort((a, b) => (a.latestAt < b.latestAt ? 1 : -1));
  const custTodo: Array<{ c: PrefCustomerInfo; user: string; hash: string }> = [];
  for (const c of custList) {
    if (!c.conditions && !c.messages.length) { skip("材料なし"); continue; }
    const mask = (s: string) => maskPII(s, [c.customerName]);
    // 申込以降は渡さない: 線（deepseekSafeCutoff）より後の発言だけ。線が引けない（null）会話は読まない
    let msgs = c.messages;
    if (c.cv) {
      const cut = await loadDeepseekCutoff(sb, c.cv);
      if (cut === null) { skip("申込以降の線が引けない"); continue; }
      msgs = msgs.filter((m) => isAfterCutoff(m.at, cut));
    }
    const user = buildStrengthUser({ conditions: c.conditions, messages: msgs.map((m) => m.text), mask });
    const hash = inputHash(user);
    const hit = existing.get(`customer|cust:${c.customerKey}`);
    if (hit && hit.input_hash === hash && hit.ok) { llm.reused.customer++; const v = parseStrengthReply(JSON.stringify(hit.result)); if (v) llmStrength.set(c.customerKey, v); continue; }
    if (custTodo.length < maxReads.customer) custTodo.push({ c, user, hash }); else skip("件数の上限（強さ）");
  }
  await mapLimit(custTodo, conc, async ({ c, user, hash }) => {
    if (!canRead()) { skip("止めた（強さ）"); return; }
    const r = await deepseekRead("pref_read_customer", STRENGTH_SYSTEM, user, PREF_LEARNING_CONFIG.maxTokens.customer, parseStrengthReply, c.cv, tmo);
    llm.usd += r.usd; llm.reads.customer++;
    if (r.value) llmStrength.set(c.customerKey, r.value);
    newRows.push({ kind: "customer", key: `cust:${c.customerKey}`, input_hash: hash, result: r.value ? { levels: r.value } : null, ok: !!r.value, cost_usd: r.usd, conversation_id: c.cv });
  });

  // 3-2 スタッフが訴求した点
  const appealOf = new Map<string, string[]>();
  const appealTodo: Array<{ e: PrefEpisodeEx; user: string; hash: string }> = [];
  for (const e of [...eps].sort((a, b) => (a.at < b.at ? 1 : -1))) {
    if (!e.appealTexts.length) continue;
    const c = load.customers.get(e.customerKey);
    const user = buildAppealUser(e.appealTexts, (s) => maskPII(s, [c?.customerName]));
    const hash = inputHash(user);
    const hit = existing.get(`appeal|ep:${e.id}`);
    if (hit && hit.input_hash === hash && hit.ok) { llm.reused.appeal++; const v = parseAppealReply(JSON.stringify(hit.result)); if (v) appealOf.set(e.id, v); continue; }
    if (appealTodo.length < maxReads.appeal) appealTodo.push({ e, user, hash }); else skip("件数の上限（訴求）");
  }
  await mapLimit(appealTodo, conc, async ({ e, user, hash }) => {
    if (!canRead()) { skip("止めた（訴求）"); return; }
    const r = await deepseekRead("pref_read_appeal", APPEAL_SYSTEM, user, PREF_LEARNING_CONFIG.maxTokens.appeal, parseAppealReply, e.conversationId, tmo);
    llm.usd += r.usd; llm.reads.appeal++;
    if (r.value) appealOf.set(e.id, r.value);
    newRows.push({ kind: "appeal", key: `ep:${e.id}`, input_hash: hash, result: r.value ? { appeals: r.value } : null, ok: !!r.value, cost_usd: r.usd, conversation_id: e.conversationId });
  });

  // 3-3 👑 と違う物件を選んだ理由の仮説
  const hypOf = new Map<string, { items: string[]; note: string }>();
  const hypTodo: Array<{ e: PrefEpisodeEx; user: string; hash: string }> = [];
  for (const e of [...eps].sort((a, b) => (a.at < b.at ? 1 : -1))) {
    if (!e.hyp || (!e.hyp.crownText && !e.hyp.chosenText)) continue;
    const c = load.customers.get(e.customerKey);
    const mask = (s: string) => maskPII(s, [c?.customerName]);
    const codesOf = (key: string) => (e.cands.find((x) => x.key === key)?.codes ?? []).filter((k) => !/_UNKNOWN$|_UNLISTED$|^FIT_|^SEARCH_/.test(k)).map(reasonJa);
    const strength: Record<string, StrengthLevel> = {};
    for (const [f, v] of Object.entries(e.strength ?? {})) strength[f] = v.level;
    const h: HypothesisInput = {
      crown: { name: e.hyp.crownKey, facts: e.hyp.crownText, reasons: codesOf(e.hyp.crownKey), score: e.hyp.crownScore },
      chosen: { name: e.hyp.chosenKey, facts: e.hyp.chosenText, reasons: codesOf(e.hyp.chosenKey), score: e.hyp.chosenScore },
      strength,
    };
    const user = buildHypothesisUser(h, mask);
    const hash = inputHash(user);
    const hit = existing.get(`hypothesis|ep:${e.id}`);
    if (hit && hit.input_hash === hash && hit.ok) { llm.reused.hypothesis++; const v = parseHypothesisReply(JSON.stringify(hit.result)); if (v) hypOf.set(e.id, v); continue; }
    if (hypTodo.length < maxReads.hypothesis) hypTodo.push({ e, user, hash }); else skip("件数の上限（仮説）");
  }
  await mapLimit(hypTodo, conc, async ({ e, user, hash }) => {
    if (!canRead()) { skip("止めた（仮説）"); return; }
    const r = await deepseekRead("pref_hypothesis", HYPOTHESIS_SYSTEM, user, PREF_LEARNING_CONFIG.maxTokens.hypothesis, parseHypothesisReply, e.conversationId, tmo);
    llm.usd += r.usd; llm.reads.hypothesis++;
    if (r.value) hypOf.set(e.id, r.value);
    newRows.push({ kind: "hypothesis", key: `ep:${e.id}`, input_hash: hash, result: r.value, ok: !!r.value, cost_usd: r.usd, conversation_id: e.conversationId });
  });
  llm.usd = +llm.usd.toFixed(6);
  log(`DeepSeek: 強さ ${llm.reads.customer}（使い回し ${llm.reused.customer}）・訴求 ${llm.reads.appeal}（${llm.reused.appeal}）・仮説 ${llm.reads.hypothesis}（${llm.reused.hypothesis}）・$${llm.usd}${llm.stoppedBy ? `・止めた: ${llm.stoppedBy}` : ""}`);

  // DeepSeek の強さで当て直す（読めた人だけ DeepSeek・他は決定論＝coverage を出す）
  let llmBacktest: PrefLearningReport["llmBacktest"] = null;
  let strengthCompare: PrefLearningReport["strengthCompare"] = null;
  if (llmStrength.size) {
    const llmMap = new Map<string, Record<string, StrengthLevel>>();
    for (const [k, v] of llmStrength) llmMap.set(k, strengthMapFromLlm(v));
    const strengthOfLlm = (e: PrefEpisodeEx, f: string): StrengthLevel => llmMap.get(e.customerKey)?.[f] ?? (llmMap.has(e.customerKey) ? "none" : strengthOf(e, f));
    const b = backtestPrefWeights(eps, baseReasonPoints, strengthOfLlm as never, defaultBandsOf as never, cfg, current, splitByTime);
    const covered = eps.filter((e) => llmMap.has(e.customerKey)).length;
    llmBacktest = { coverage: +(covered / Math.max(1, eps.length)).toFixed(3), customers: llmMap.size, gain: b.gain, enable: b.decision.enable, reason: b.decision.reason, changes: b.learned.changes.length };
    strengthCompare = compareStrengthSources([...load.customers.values()].map((c) => {
      const det = load.prefOf.get(c.customerKey)?.base.byFamily;
      const d: Record<string, StrengthLevel> | null = det ? Object.fromEntries(Object.entries(det).map(([k, v]) => [k, v.level])) : null;
      return { det: d, llm: llmMap.get(c.customerKey) ?? null };
    }));
  }

  // ④ 表を更新するか
  const enabled = opts.autoApplyEnabled ?? prefAutoApplyEnabled();
  const dec = decidePrefApply({ enabled, backtest });
  const apply: PrefLearningReport["apply"] = { ...dec, version: null, tableBefore: current, tableAfter: dec.propose ? backtest.learned.table : current, diff: dec.propose ? diffPrefTables(current, backtest.learned.table) : [] };

  const appealTop = topCounts([...appealOf.values()]);
  const hypothesisTop = topCounts([...hypOf.values()].map((h) => h.items));
  const hypothesisNotes = [...hypOf.values()].map((h) => h.note).filter(Boolean).slice(0, 12);

  // ⑤ 週のまとめ（決定論 → DeepSeek で 10行以内。読めなければ決定論のまま）
  const numbers: WeeklyNumbers = {
    weekOf: until, rounds: eps.length, customers: load.customers.size, train: backtest.train, holdout: backtest.holdout,
    base: backtest.base, weighted: backtest.weighted, gain: backtest.gain,
    changes: backtest.learned.changes.map((c) => ({ family: c.family, level: c.level, from: c.from, to: c.to, rounds: c.rounds })),
    skipped: backtest.learned.skipped, worseBands: backtest.bands.filter((b) => b.note === "悪くなる（使わない）").map((b) => ({ band: b.band, value: b.value, gain: b.gain, n: b.n })),
    verdictFlips: backtest.verdictFlips, decision: backtest.decision.reason, applied: dec.apply, llmGain: llmBacktest?.gain ?? null,
    strengthAgree: strengthCompare ? { compared: strengthCompare.compared, agree: strengthCompare.agree } : null,
    appealTop, hypothesisTop, reads: { ...llm.reads, usd: llm.usd },
  };
  let weeklySummary = deterministicWeeklySummary(numbers);
  let weeklySummarySource: PrefLearningReport["weeklySummarySource"] = "deterministic";
  if ((opts.llm?.summary ?? true) && canRead()) {
    const r = await deepseekRead("pref_weekly_summary", SUMMARY_SYSTEM, buildSummaryUser(numbers), PREF_LEARNING_CONFIG.maxTokens.summary, parseSummaryReply, null, tmo);
    llm.summaryUsd = r.usd; llm.usd = +(llm.usd + r.usd).toFixed(6);
    if (r.value) { weeklySummary = r.value; weeklySummarySource = "deepseek"; }
  }

  const report: PrefLearningReport = {
    ok: true, dry, until, days, counts, activeVersion: act?.version ?? 0, current, backtest, byCustomer, llmBacktest, strengthCompare, apply, llm,
    appealTop, hypothesisTop, hypothesisNotes, weeklySummary, weeklySummarySource, ms: Date.now() - t0,
  };
  if (dry) return report;

  // ⑥ 書く: 読んだ物 → 版 → 記録
  try {
    for (const c of chunks(newRows, 100)) {
      const { error } = await sb.from("scoring_pref_reads").upsert(c.map((r) => ({ ...r, model: "deepseek-flash", read_at: new Date().toISOString() })), { onConflict: "kind,key" });
      if (error) log(`scoring_pref_reads: ${error.message}`);
    }
  } catch (e) { log(`scoring_pref_reads: ${e instanceof Error ? e.message : String(e)}`); }

  let version: number | null = null;
  if (dec.propose) {
    const next = (versions.reduce((m, v) => Math.max(m, v.version), 0) || 0) + 1;
    const { error } = await sb.from("scoring_pref_weights").insert({
      version: next, status: "proposed", weights: backtest.learned.table, base_version: act?.version ?? 0, source: "learning",
      note: apply.diff.map((d) => `${d.family}×${d.level} ×${d.from}→×${d.to}`).join(" / "),
      backtest: { train: backtest.train, holdout: backtest.holdout, base: backtest.base, weighted: backtest.weighted, gain: backtest.gain, bands: backtest.bands, verdictFlips: backtest.verdictFlips, decision: backtest.decision },
    });
    if (error) return { ...report, ok: false, error: `scoring_pref_weights: ${error.message}` };
    version = next;
    apply.version = next;
  }
  const { data: run, error: runErr } = await sb.from("scoring_pref_learning_runs").insert({
    dry: false, data_until: until, days, episodes_total: eps.length, train_n: backtest.train, holdout_n: backtest.holdout, counts,
    active_version: act?.version ?? 0, base: backtest.base, weighted: backtest.weighted, gain: backtest.gain, bands: backtest.bands, verdict_flips: backtest.verdictFlips,
    learned: { changes: backtest.learned.changes, skipped: backtest.learned.skipped.slice(0, 60) }, by_customer: byCustomer,
    decision: backtest.decision.reason, improved: backtest.decision.enable, applied: false, applied_version: version, apply_reason: dec.reason,
    table_before: current, table_after: apply.tableAfter, strength_compare: strengthCompare, llm_backtest: llmBacktest,
    llm: { ...llm, appealTop, hypothesisTop, hypothesisNotes }, weekly_summary: weeklySummary, weekly_summary_source: weeklySummarySource, duration_ms: Date.now() - t0,
  }).select("id").single();
  if (runErr) return { ...report, ok: false, error: `scoring_pref_learning_runs: ${runErr.message}` };
  const runId = Number((run as Row).id);
  if (version != null) await sb.from("scoring_pref_weights").update({ run_id: runId }).eq("version", version);
  if (dec.apply && version != null) {
    const r = await activatePrefVersion(sb, version, `auto run ${runId}`);
    await sb.from("scoring_pref_learning_runs").update({ applied: r.ok, apply_reason: r.ok ? dec.reason : `切り替え失敗: ${r.error}` }).eq("id", runId);
    if (!r.ok) apply.reason = `切り替え失敗: ${r.error}`;
  }
  return { ...report, runId, ms: Date.now() - t0 };
}

/** 報告用: 材料の件数（scripts/build-customer-pref-episodes.ts が使う） */
export { materialSummary };
