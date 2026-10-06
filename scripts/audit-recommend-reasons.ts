// scripts/audit-recommend-reasons.ts
// 物件オススメ（🌟・AIX property_recommendation）でスタッフが「なぜその1件を推したか」を、
// 同じ回の候補（recommendation_snapshots.candidates＝直前72時間にお客様へ送った物件）と並べて調べる（読むだけ・LLM なし・費用0）。
//
// 2026-10-06 竹内「物件オススメでオススメしている物件、お客さんの条件と照らし合わせて、画像分析もして、なぜオススメしているのか、
//   照らし合わせるとスコアリングの基準が上がる。…実際のLINEや成約データからスコアリングの基準変えたほうが良い部分や追加したら良い部分みつける。
//   状況に応じての部分も調査する」
//
// ■ 正解＝スタッフが🌟にした物件（お客様の返信の有無は正誤に使わない。結果は補助の物差し）
// ■ 点は今の判定で付け直し（scoring-learning-server.loadEpisodes の snapshot と同じ組み立て）
// ■ 出す物
//   1. 今の点の一致（1位・3位以内・相対順位・ランダム）— 全体／live（9/25〜・候補が多い）／backfill
//   2. 🌟と同じ回の他の候補の差（特徴ごとの「🌟の方が良い率」）— 全体と状況ごと
//   3. 🌟の本文の訴求（話題）の頻度と、その話題で🌟が回の中で一番か
//   4. 締め（内覧誘導／申込誘導／ご査収）・退去予定
//   5. 結果（72時間以内の返信・🌟の物件名への言及・内覧・申込）と特徴の差
//   6. 当て直し: 特徴の足し点（家賃の帯・広さ・築年・設備・徒歩）と、回の中で標準化した条件付きロジット（時期で7:3）
// ■ 個人情報: 会話は先頭8文字だけ。お客様の発言は出さない（物件名は出す）。YUMA は外す
//
// 実行: npx tsx --env-file=.env.local scripts/audit-recommend-reasons.ts [--days=180] [--out=path.json]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { loadEpisodes } from "../app/lib/scoring-learning-server";
import { rankMetrics, featureStats, type Episode, type EpisodeCandidate } from "../app/lib/scoring-learning";
import { baseReasonPoints } from "../app/lib/property-brain";
import { customerAt, buildContext, episodeFromSnapshot, isCustomerSend, type ConditionHistoryRow } from "../app/lib/scoring-learning-episodes";
import type { SentRowLike, PatternRowLike } from "../app/lib/property-brain";
import { TOPIC_LABEL } from "../app/lib/recommendation-gaps";
import { nameKey, toHalf } from "../app/lib/candidate-facts";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "180"), 10);
// --enrich: 候補の欠けた値を rent_observations（売上サポの資料・拡張の回・送付から埋めた1戸1行）で補ってから点を付ける
const ENRICH = !!args.enrich;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = Record<string, any>;
const H = 3600_000, D = 24 * H;
const pct = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "-" : `${Math.round(x * 100)}%`);
const chunks = <T,>(xs: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };
async function all(build: (a: number, b: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>, page = 1000): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 80; p++) {
    const { data, error } = await build(p * page, p * page + page - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < page) break;
  }
  return out;
}
const textKey = (t: string) => toHalf(String(t ?? "")).toLowerCase().replace(/[\s・･\-‐ー－_.,、。'’"“”!！?？☆★🌟]/gu, "");
function mentions(text: string, name: string): boolean {
  const k = nameKey(name);
  if (k.length < 3) return false;
  return textKey(text).includes(k.slice(0, Math.min(k.length, 8)));
}

// ─── 状況の読み ───────────────────────────────────────────────────────────────
function moveInUrgency(moveIn: string | null | undefined, atIso: string): "urgent" | "later" | "unknown" {
  const s = toHalf(String(moveIn ?? ""));
  if (!s.trim()) return "unknown";
  if (/即|すぐ|至急|急ぎ|今月|早め|なるべく早|今週|来週/.test(s)) return "urgent";
  const m = s.match(/(\d{1,2})\s*月/);
  if (m) {
    const at = new Date(atIso);
    const mon = parseInt(m[1], 10);
    const diff = (mon - (at.getMonth() + 1) + 12) % 12;
    return diff <= 1 ? "urgent" : "later";
  }
  if (/未定|いい物件|良い物件|決まり次第|特に/.test(s)) return "later";
  return "unknown";
}
const REJECT_RE = /(微妙|ちょっと(?:違|厳|高|狭|遠)|好みじゃ|好きじゃ|イマイチ|いまいち|やめ(?:とき|ておき|ます)|見送|合わな|気に入らな|他の(?:物件|お部屋)|別の(?:物件|お部屋)|ないです|無しで|ナシ|古い|狭い|遠い)/;
function ctaOf(t: string): "viewing" | "apply" | "review" | "none" {
  if (/ご査収/.test(t)) return "review";
  if (/お申込み|お申し込み|お部屋(?:を)?抑え|お申込/.test(t)) return "apply";
  if (/ご案内させて頂|ご内覧|内覧/.test(t)) return "viewing";
  return "none";
}

// ─── 当て直し（足し点・条件付きロジット） ─────────────────────────────────────
type Cand = EpisodeCandidate & { base: number };
type Ep = Omit<Episode, "cands"> & { snapId: number; live: boolean; sits: string[]; cands: Cand[] };
function metricsWith(eps: Ep[], extra: (c: Cand, e: Ep) => number) {
  let top1 = 0, top3 = 0, rel = 0, r1 = 0;
  for (const e of eps) {
    const s = e.cands.map((c) => ({ c, s: c.base + extra(c, e) }));
    const n = s.length, max = Math.max(...s.map((x) => x.s));
    const atTop = s.filter((x) => Math.abs(x.s - max) < 1e-9);
    top1 += atTop.filter((x) => x.c.chosen).length / atTop.length;
    const un = s.filter((x) => !x.c.chosen);
    let best = Infinity, relSum = 0, k = 0;
    for (const x of s.filter((y) => y.c.chosen)) {
      const gt = s.filter((y) => y !== x && y.s > x.s + 1e-9).length, eq = s.filter((y) => y !== x && Math.abs(y.s - x.s) < 1e-9).length;
      best = Math.min(best, 1 + gt + eq / 2);
      relSum += (un.filter((y) => y.s > x.s + 1e-9).length + un.filter((y) => Math.abs(y.s - x.s) < 1e-9).length / 2) / un.length; k++;
    }
    if (best <= 3) top3++;
    rel += relSum / k;
    r1 += (n - un.length) / n;
  }
  const N = eps.length || 1;
  return { n: eps.length, top1: top1 / N, top3: top3 / N, rel: rel / N, rand1: r1 / N };
}
/** 回の中の順位（0＝一番良い・1＝一番悪い・値なし null）。dir: high＝大きいほど良い */
function rankIn(e: Ep, f: string, dir: "high" | "low", c: Cand): number | null {
  const v = c.feats[f];
  if (v == null) return null;
  const vals = e.cands.map((x) => x.feats[f]).filter((x): x is number => x != null);
  if (vals.length < 2) return null;
  const better = vals.filter((x) => (dir === "high" ? x > v : x < v)).length;
  return better / (vals.length - 1);
}
const isBest = (e: Ep, f: string, dir: "high" | "low", c: Cand) => { const r = rankIn(e, f, dir, c); return r == null ? null : r === 0 ? 1 : 0; };

const LOGIT_FEATS: Array<[string, (c: Cand, e: Ep) => number | null]> = [
  ["base_score", (c) => c.base],
  ["rent_ratio", (c) => c.feats.rent_ratio ?? null],
  ["rent_near_cap(-|r-0.95|)", (c) => (c.feats.rent_ratio == null ? null : -Math.abs(c.feats.rent_ratio - 0.95))],
  ["area_sqm", (c) => c.feats.area_sqm ?? null],
  ["building_age(-)", (c) => (c.feats.building_age == null ? null : -c.feats.building_age)],
  ["walk(-)", (c) => (c.feats.walk == null ? null : -c.feats.walk)],
  ["floor", (c) => c.feats.floor ?? null],
  ["equipment_count", (c) => c.feats.equipment_count ?? null],
  ["ad_months", (c) => c.feats.ad_months ?? null],
  ["zero_zero", (c) => c.feats.zero_zero ?? null],
  ["plan_match", (c) => c.feats.plan_match ?? null],
  ["structure_rank", (c) => c.feats.structure_rank ?? null],
];
function zMatrix(e: Ep): number[][] {
  return e.cands.map((c) => LOGIT_FEATS.map(([, f]) => {
    const vals = e.cands.map((x) => f(x, e)).filter((x): x is number => x != null);
    const v = f(c, e);
    if (v == null || vals.length < 2) return 0;
    const m = vals.reduce((a, x) => a + x, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, x) => a + (x - m) ** 2, 0) / vals.length) || 1;
    return (v - m) / sd;
  }));
}
function fitLogit(eps: Ep[], l2 = 0.5, iters = 600, lr = 0.05, mask?: boolean[]): number[] {
  const K = LOGIT_FEATS.length;
  const w = new Array(K).fill(0);
  const X = eps.map(zMatrix);
  for (let it = 0; it < iters; it++) {
    const g = new Array(K).fill(0);
    eps.forEach((e, ei) => {
      const xs = X[ei];
      const s = xs.map((x) => x.reduce((a, v, k) => a + v * w[k], 0));
      const mx = Math.max(...s);
      const ex = s.map((v) => Math.exp(v - mx));
      const Z = ex.reduce((a, v) => a + v, 0);
      const p = ex.map((v) => v / Z);
      const chosen = e.cands.map((c) => (c.chosen ? 1 : 0));
      const nc = chosen.reduce((a: number, v) => a + v, 0) || 1;
      for (let k = 0; k < K; k++) {
        let obs = 0, exp = 0;
        xs.forEach((x, i) => { obs += (chosen[i] / nc) * x[k]; exp += p[i] * x[k]; });
        g[k] += obs - exp;
      }
    });
    for (let k = 0; k < K; k++) { if (mask && !mask[k]) { w[k] = 0; continue; } w[k] += lr * (g[k] / eps.length - l2 * w[k] / eps.length); }
  }
  return w;
}
function logitMetrics(eps: Ep[], w: number[]) {
  // 回ごとの z のスコアで1位
  return metricsWithZ(eps, w);
}
function metricsWithZ(eps: Ep[], w: number[]) {
  const tmp = eps.map((e) => {
    const X = zMatrix(e);
    return { ...e, cands: e.cands.map((c, i) => ({ ...c, base: X[i].reduce((a, v, k) => a + v * w[k], 0) })) } as Ep;
  });
  return metricsWith(tmp, () => 0);
}

const STRUCT_RANK: Record<string, number> = { RC: 2, SRC: 2, 鉄骨: 1, 軽量鉄骨: 1, 木造: 0 };
const CUST_COLS = "id, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, created_at, floor_area_min, raw_format_text, desired_area, commute_station, commute_minutes";
const enrichStats = { cands: 0, filled: 0, fields: {} as Record<string, number> };
async function enrichedEpisodes(roByKey: Map<string, Row>, until: string): Promise<Episode[]> {
  const snaps = (await all((a, b) => sb.from("recommendation_snapshots").select("id, conversation_id, property_customer_id, sent_at, star_in_candidates, candidate_count, candidates")
    .gte("sent_at", new Date(Date.parse(until) - DAYS * D).toISOString()).gte("candidate_count", 2).order("id").range(a, b) as never, 300))
    .filter((s) => s.conversation_id !== YUMA_CONVERSATION_ID && s.property_customer_id);
  const pcs = [...new Set(snaps.map((s) => String(s.property_customer_id)))];
  const custs = new Map<string, Row>(); const hist: Row[] = [], sents: Row[] = [], pats: Row[] = [];
  for (const c of chunks(pcs, 80)) {
    const { data } = await sb.from("property_customers").select(CUST_COLS).in("id", c);
    for (const r of (data ?? []) as Row[]) custs.set(r.id, r);
    hist.push(...await all((a, b) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, created_at").in("property_customer_id", c).order("id").range(a, b) as never));
    sents.push(...await all((a, b) => sb.from("sent_properties").select("property_customer_id, property_name, room_no, rent, delivery, source, sent_at").in("property_customer_id", c).order("id").range(a, b) as never));
    pats.push(...await all((a, b) => sb.from("property_selection_patterns").select("property_customer_id, selling_points, selection_label, created_at").in("property_customer_id", c).order("id").range(a, b) as never));
  }
  const g = (xs: Row[]) => { const m = new Map<string, Row[]>(); for (const x of xs) { const k = String(x.property_customer_id); if (!m.has(k)) m.set(k, []); m.get(k)!.push(x); } return m; };
  const hOf = g(hist), sOf = g(sents), pOf = g(pats);
  const out: Episode[] = [];
  for (const s of snaps) {
    const pc = String(s.property_customer_id); const base = custs.get(pc); if (!base) continue;
    const cands = ((typeof s.candidates === "string" ? JSON.parse(s.candidates) : s.candidates) ?? []) as Row[];
    const firstSent = Math.min(...cands.map((c) => Date.parse(String(c.sent_at ?? ""))).filter(Number.isFinite), Date.parse(s.sent_at));
    const { c } = customerAt(base, (hOf.get(pc) ?? []) as ConditionHistoryRow[], s.sent_at);
    const before = (sOf.get(pc) ?? []).filter((x) => Date.parse(x.sent_at) < firstSent - 60_000 && isCustomerSend(x)) as SentRowLike[];
    const pt = (pOf.get(pc) ?? []).filter((p) => Date.parse(p.created_at) < Date.parse(s.sent_at)) as PatternRowLike[];
    const ctx = buildContext(c, before, pt, s.sent_at);
    const filledCands = cands.map((cd) => {
      enrichStats.cands++;
      const ro = roByKey.get(`${nameKey(cd.name)}#${String(cd.room_no ?? "").replace(/^0+/, "")}`);
      if (!ro) return cd;
      const x: Row = { ...cd };
      let any = false;
      const fill = (k: string, v: unknown) => { if (x[k] == null && v != null) { x[k] = v; any = true; enrichStats.fields[k] = (enrichStats.fields[k] ?? 0) + 1; } };
      fill("rent", ro.rent); fill("admin_fee_yen", ro.admin_fee); fill("area_sqm", ro.area_sqm != null ? Number(ro.area_sqm) : null); fill("building_age", ro.building_age);
      fill("walk_minutes", ro.walk_minutes); fill("floor", ro.floor); fill("deposit_months", ro.deposit_months != null ? Number(ro.deposit_months) : null);
      fill("key_money_months", ro.key_money_months != null ? Number(ro.key_money_months) : null); fill("floor_plan", ro.floor_plan);
      if (x.ad_yen == null && x.ad_months == null && ro.ad_yen != null) { x.ad_yen = ro.ad_yen; any = true; enrichStats.fields.ad = (enrichStats.fields.ad ?? 0) + 1; }
      if ((!Array.isArray(x.equipment) || !x.equipment.length) && ro.equipment && typeof ro.equipment === "object") {
        x.equipment = Object.entries(ro.equipment as Record<string, unknown>).filter(([, v]) => v === true).map(([k]) => k); any = true; enrichStats.fields.equipment = (enrichStats.fields.equipment ?? 0) + 1;
      }
      x.__structure = ro.structure ?? null;
      if (any) enrichStats.filled++;
      return x;
    });
    try {
      const e = episodeFromSnapshot({ ...s, candidates: filledCands }, ctx);
      if (!e) continue;
      for (const ec of e.cands) {
        const src = filledCands.find((fc) => ec.key === `${fc.name}${fc.room_no ? ` ${String(fc.room_no).replace(/^0+(?=\d)/, "")}` : ""}`) ?? filledCands.find((fc) => ec.key.startsWith(String(fc.name)));
        const st = src?.__structure as string | null | undefined;
        ec.feats.structure_rank = st != null && st in STRUCT_RANK ? STRUCT_RANK[st] : null;
      }
      out.push(e);
    } catch { /* 付け直せない回は飛ばす */ }
  }
  return out;
}

(async () => {
  const until = new Date().toISOString();
  let { episodes, counts } = await loadEpisodes(sb as never, { until, days: DAYS, sources: ["snapshot"] });
  if (ENRICH) {
    const roByKey = new Map<string, Row>();
    const ros = await all((a, b) => sb.from("rent_observations").select("property_name, room_no, rent, admin_fee, area_sqm, building_age, walk_minutes, structure, floor, deposit_months, key_money_months, equipment, ad_yen, floor_plan").order("id").range(a, b) as never);
    for (const r of ros) roByKey.set(`${nameKey(r.property_name)}#${String(r.room_no ?? "").replace(/^0+/, "")}`, r);
    episodes = await enrichedEpisodes(roByKey, until);
    counts = { ...counts, enriched_episodes: episodes.length, ro_rows: ros.length };
  }
  const snaps = await all((a, b) => sb.from("recommendation_snapshots")
    .select("id, conversation_id, property_customer_id, sent_at, star_name, star_room, star_text, appeal_topics, customer_wants, candidates, candidate_count, star_in_candidates, source, aix_usage_log_id")
    .gte("sent_at", new Date(Date.now() - DAYS * D).toISOString()).order("id").range(a, b) as never, 300);
  const snapAll = snaps.filter((s) => s.conversation_id !== YUMA_CONVERSATION_ID);
  const snapById = new Map(snapAll.map((s) => [Number(s.id), s]));
  const pcs = [...new Set(snapAll.map((s) => String(s.property_customer_id ?? "")).filter(Boolean))];
  const convs = [...new Set(snapAll.map((s) => String(s.conversation_id ?? "")).filter(Boolean))];

  // 材料: お客様の条件・履歴・送付・会話の状態・発言・AIX
  const custs = new Map<string, Row>(); const hist: Row[] = []; const sents: Row[] = [];
  for (const c of chunks(pcs, 80)) {
    const { data } = await sb.from("property_customers").select("id, rent_max, max_rent, rent_min, move_in_time, pet, preferences, ng_points, other_requests, desired_area, created_at").in("id", c);
    for (const r of (data ?? []) as Row[]) custs.set(r.id, r);
    hist.push(...await all((a, b) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, created_at").in("property_customer_id", c).order("id").range(a, b) as never));
    sents.push(...await all((a, b) => sb.from("sent_properties").select("property_customer_id, conversation_id, property_name, room_no, sent_at, delivery, source, customer_reaction, channel").in("property_customer_id", c).order("id").range(a, b) as never));
  }
  const convRow = new Map<string, Row>(); const msgs: Row[] = []; const aix: Row[] = [];
  for (const c of chunks(convs, 60)) {
    const { data } = await sb.from("conversations").select("id, status, is_post_apply").in("id", c);
    for (const r of (data ?? []) as Row[]) convRow.set(r.id, r);
    msgs.push(...await all((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at, referenced_property_id").in("conversation_id", c).gte("created_at", new Date(Date.now() - (DAYS + 30) * D).toISOString()).order("id").range(a, b) as never));
    aix.push(...await all((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, generated_text, created_at").in("conversation_id", c).in("aix_type", ["viewing_invite", "meeting_place", "application_push", "property_recommendation", "estimate_sheet"]).order("id").range(a, b) as never));
  }
  const by = <T extends Row>(xs: T[], k: string) => { const m = new Map<string, T[]>(); for (const x of xs) { const v = String(x[k] ?? ""); if (!m.has(v)) m.set(v, []); m.get(v)!.push(x); } return m; };
  const histOf = by(hist, "property_customer_id"), sentOf = by(sents, "property_customer_id"), msgOf = by(msgs, "conversation_id"), aixOf = by(aix, "conversation_id");

  // ─── 回を組み立てる（点＋状況） ───────────────────────────────────────────
  const eps: Ep[] = [];
  for (const e0 of episodes) {
    const id = Number(String(e0.id).replace("snap:", ""));
    const s = snapById.get(id);
    if (!s) continue;
    const t = Date.parse(s.sent_at);
    const pc = String(s.property_customer_id ?? "");
    const base = custs.get(pc);
    const cAt = base ? customerAt(base, (histOf.get(pc) ?? []) as ConditionHistoryRow[], s.sent_at).c : null;
    const cands = (s.candidates ?? []) as Row[];
    const firstSent = Math.min(...cands.map((c) => Date.parse(String(c.sent_at ?? ""))).filter(Number.isFinite), t);
    const priorSends = (sentOf.get(pc) ?? []).filter((x) => x.delivery !== "shared" && Date.parse(x.sent_at) < firstSent - H);
    const priorStars = snapAll.filter((x) => x.conversation_id === s.conversation_id && Date.parse(x.sent_at) < t - 10 * 60_000).length;
    const before14 = (msgOf.get(s.conversation_id) ?? []).filter((m) => m.sender === "customer" && Date.parse(m.created_at) < t && Date.parse(m.created_at) > t - 14 * D);
    const rejected = before14.some((m) => REJECT_RE.test(String(m.text ?? ""))) || priorSends.some((x) => x.customer_reaction === "rejected");
    const wants = ((s.customer_wants ?? []) as Row[]).map((w) => String(w.key));
    const rentMax = Number(cAt?.rent_max ?? cAt?.max_rent ?? 0) || null;
    const sits: string[] = [];
    sits.push(priorSends.length === 0 && priorStars === 0 ? "first" : "later");
    if (priorStars >= 1) sits.push("star_repeat");
    const urg = moveInUrgency(cAt?.move_in_time, s.sent_at); sits.push(`movein_${urg}`);
    if (/退去予定/.test(String(s.star_text ?? ""))) sits.push("star_taikyo");
    if (rentMax != null) sits.push(rentMax < 70000 ? "budget_low(<7万)" : rentMax < 100000 ? "budget_mid(7-10万)" : "budget_high(10万+)");
    if (e0.segments.includes("pet") || cAt?.pet) sits.push("pet");
    if (wants.includes("screening")) sits.push("screening");
    if (e0.segments.includes("low_initial") || wants.includes("low_initial")) sits.push("low_initial");
    if (rejected) sits.push("rejected_before");
    const starC = e0.cands.find((c) => c.chosen);
    if (starC && starC.codes.some((k) => /^AREA_(WARD_WIDE|STATION_WIDE|FAR|ANCHOR_FAR|NEAR|ANCHOR_REACH_SOME)/.test(k))) sits.push("star_area_widened");
    if (e0.cands.length >= 6) sits.push("cands_6plus");
    eps.push({ ...e0, snapId: id, live: s.source === "live", sits, cands: e0.cands.map((c) => ({ ...c, base: 50 + c.codes.reduce((a, k) => a + baseReasonPoints(k), 0) })) });
  }
  eps.sort((a, b) => a.at.localeCompare(b.at));
  const out: Row = { counts, generated_at: until, days: DAYS };
  const P = (...x: unknown[]) => console.log(...x);

  P(`\n=== 材料 ===`);
  P(`🌟の記録 ${snapAll.length}件（会話 ${convs.length}・お客様 ${pcs.length}）／候補2件以上で🌟が候補にある回 ${eps.length}（live ${eps.filter((e) => e.live).length}・backfill ${eps.filter((e) => !e.live).length}）`);
  const nC = eps.map((e) => e.cands.length).sort((a, b) => a - b);
  P(`回の候補数 中央 ${nC[Math.floor(nC.length / 2)]}・平均 ${(nC.reduce((a, x) => a + x, 0) / nC.length).toFixed(1)}`);

  // 1. 今の点の一致
  P(`\n=== 1. 今の点（付け直し）とスタッフの🌟の一致 ===`);
  const base0 = (x: Ep[]) => metricsWith(x, () => 0);
  for (const [lab, sub] of [["全体", eps], ["live", eps.filter((e) => e.live)], ["backfill", eps.filter((e) => !e.live)]] as const) {
    const m = base0(sub as Ep[]); P(`${lab}: n=${m.n} 1位 ${pct(m.top1)}（ランダム ${pct(m.rand1)}）・3位以内 ${pct(m.top3)}・相対順位 ${m.rel.toFixed(3)}`);
  }
  out.base = { all: base0(eps), live: base0(eps.filter((e) => e.live)) };
  // 材料の欠け
  const featKeys = ["rent_ratio", "area_sqm", "building_age", "walk", "floor", "equipment_count", "ad_months", "zero_zero", "plan_match", "structure_rank"];
  if (ENRICH) P(`補った候補 ${enrichStats.filled}/${enrichStats.cands}・項目 ${JSON.stringify(enrichStats.fields)}`);
  P(`材料の有り率（候補全体）: ` + featKeys.map((f) => `${f} ${pct(eps.flatMap((e) => e.cands).filter((c) => c.feats[f] != null).length / eps.flatMap((e) => e.cands).length)}`).join("・"));

  // 2. 特徴ごとの🌟の方が良い率
  P(`\n=== 2. 🌟 vs 同じ回の他の候補（🌟の方が良い率・z）===`);
  const fs = featureStats(eps);
  for (const [k, v] of Object.entries(fs)) if (v.episodes >= 8) P(`  ${k.padEnd(16)} 回 ${String(v.episodes).padStart(3)}  🌟が良い ${pct(v.winRate)}  z=${v.z}`);
  out.featureStats = fs;
  {
    const st = eps.map((e) => { const s0 = e.cands.find((c) => c.chosen)!; let w = 0, k = 0; for (const o of e.cands) if (!o.chosen) { const a = s0.feats.structure_rank, b = o.feats.structure_rank; if (a == null || b == null || a === b) continue; w += a > b ? 1 : 0; k++; } return k ? w / k : null; }).filter((x): x is number => x != null);
    P(`  structure_rank   回 ${String(st.length).padStart(3)}  🌟が良い(RC寄り) ${pct(st.reduce((a, x) => a + x, 0) / (st.length || 1))}`);
  }
  // 🌟が回の中で一番の率
  P(`  ── 🌟が回の中で一番（値のある候補2件以上の回）`);
  const bestDirs: Array<[string, "high" | "low"]> = [["area_sqm", "high"], ["building_age", "low"], ["walk", "low"], ["floor", "high"], ["equipment_count", "high"], ["ad_months", "high"], ["structure_rank", "high"], ["rent_ratio", "high"], ["rent_ratio", "low"]];
  out.bestRate = {};
  for (const [f, d] of bestDirs) {
    const xs = eps.map((e) => { const c = e.cands.find((x) => x.chosen)!; const b = isBest(e, f, d, c); const n = e.cands.filter((x) => x.feats[f] != null).length; return b == null ? null : { b, n }; }).filter(Boolean) as Array<{ b: number; n: number }>;
    const exp = xs.reduce((a, x) => a + 1 / x.n, 0) / (xs.length || 1);
    P(`  ${f}(${d === "high" ? "大" : "小"}) 回 ${xs.length}  🌟が一番 ${pct(xs.reduce((a, x) => a + x.b, 0) / (xs.length || 1))}（ランダム ${pct(exp)}）`);
    (out.bestRate as Row)[`${f}_${d}`] = { n: xs.length, best: xs.reduce((a, x) => a + x.b, 0) / (xs.length || 1), rand: exp };
  }
  // 家賃の位置
  const ratioBand = (r: number | null | undefined) => r == null ? "不明" : r < 0.8 ? "<80%" : r < 0.9 ? "80-90%" : r < 0.95 ? "90-95%" : r <= 1.0 ? "95-100%" : r <= 1.1 ? "100-110%" : ">110%";
  const bandCount = (sel: (c: Cand) => boolean) => { const m: Record<string, number> = {}; for (const e of eps) for (const c of e.cands) if (sel(c)) m[ratioBand(c.feats.rent_ratio)] = (m[ratioBand(c.feats.rent_ratio)] ?? 0) + 1; return m; };
  P(`  家賃÷上限の帯 🌟: ${JSON.stringify(bandCount((c) => c.chosen))}`);
  P(`  家賃÷上限の帯 他: ${JSON.stringify(bandCount((c) => !c.chosen))}`);
  // 🌟の順（送った順＝pool_rank）
  const firstPos = eps.filter((e) => e.cands.some((c) => c.feats.pool_rank != null));
  P(`  🌟が送った順の1番目: ${pct(firstPos.filter((e) => { const c = e.cands.find((x) => x.chosen)!; return isBest(e, "pool_rank", "low", c) === 1; }).length / (firstPos.length || 1))}（回 ${firstPos.length}）`);

  // 札ごと（🌟が持つ率・回の差）— 上位
  const codeDiff: Record<string, { star: number; other: number; n: number }> = {};
  for (const e of eps) {
    const star = e.cands.filter((c) => c.chosen), oth = e.cands.filter((c) => !c.chosen);
    const codes = new Set(e.cands.flatMap((c) => c.codes));
    for (const k of codes) {
      const a = star.filter((c) => c.codes.includes(k)).length / star.length, b = oth.filter((c) => c.codes.includes(k)).length / oth.length;
      codeDiff[k] ??= { star: 0, other: 0, n: 0 }; codeDiff[k].star += a; codeDiff[k].other += b; codeDiff[k].n++;
    }
  }
  const codeRows = Object.entries(codeDiff).filter(([, v]) => v.n >= 10).map(([k, v]) => ({ k, n: v.n, star: v.star / v.n, other: v.other / v.n, pts: baseReasonPoints(k) })).sort((a, b) => (b.star - b.other) - (a.star - a.other));
  P(`  ── 札: 🌟が持つ率 − 他が持つ率（回 10以上）上位/下位`);
  for (const r of [...codeRows.slice(0, 12), ...codeRows.slice(-12)]) P(`   ${r.k.padEnd(28)} 点${String(r.pts).padStart(4)} 回${String(r.n).padStart(4)} 🌟 ${pct(r.star)} 他 ${pct(r.other)} 差 ${Math.round((r.star - r.other) * 100)}`);
  out.codeDiff = codeRows;

  // 3. 訴求
  P(`\n=== 3. 🌟の本文の訴求（話題）===`);
  const topicCount: Record<string, number> = {};
  const topicBest: Record<string, { n: number; best: number; rand: number }> = {};
  const TOPIC_FEAT: Record<string, [string, "high" | "low"]> = { station_near: ["walk", "low"], spacious: ["area_sqm", "high"], new_build: ["building_age", "low"], floor2: ["floor", "high"], zero_deposit: ["zero_zero", "high"] };
  const starSnaps = snapAll.filter((s) => s.star_text);
  for (const s of starSnaps) for (const k of (s.appeal_topics ?? []) as string[]) topicCount[k] = (topicCount[k] ?? 0) + 1;
  for (const e of eps) {
    const s = snapById.get(e.snapId)!; const c = e.cands.find((x) => x.chosen)!;
    for (const k of (s.appeal_topics ?? []) as string[]) {
      const tf = TOPIC_FEAT[k]; if (!tf) continue;
      const b = isBest(e, tf[0], tf[1], c); if (b == null) continue;
      const n = e.cands.filter((x) => x.feats[tf[0]] != null).length;
      topicBest[k] ??= { n: 0, best: 0, rand: 0 }; topicBest[k].n++; topicBest[k].best += b; topicBest[k].rand += 1 / n;
    }
  }
  P(`本文のある🌟 ${starSnaps.length}通: ` + Object.entries(topicCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${TOPIC_LABEL[k as never] ?? k} ${v}(${pct(v / starSnaps.length)})`).join("・"));
  for (const [k, v] of Object.entries(topicBest)) P(`  訴求「${TOPIC_LABEL[k as never] ?? k}」した回で🌟がその値で回の一番: ${pct(v.best / v.n)}（ランダム ${pct(v.rand / v.n)}・回 ${v.n}）`);
  out.topics = { topicCount, topicBest, nStar: starSnaps.length };
  // 希望 × 訴求
  const wantAppeal: Record<string, { want: number; appealed: number }> = {};
  for (const s of starSnaps) {
    const ap = new Set((s.appeal_topics ?? []) as string[]);
    for (const w of new Set(((s.customer_wants ?? []) as Row[]).map((x) => String(x.key)))) { wantAppeal[w] ??= { want: 0, appealed: 0 }; wantAppeal[w].want++; if (ap.has(w)) wantAppeal[w].appealed++; }
  }
  P(`  希望した話題を🌟で訴求した率: ` + Object.entries(wantAppeal).filter(([, v]) => v.want >= 8).sort((a, b) => b[1].want - a[1].want).map(([k, v]) => `${TOPIC_LABEL[k as never] ?? k} ${v.appealed}/${v.want}`).join("・"));
  out.wantAppeal = wantAppeal;

  // 4. 締め・退去予定・結果
  P(`\n=== 4/5. 締め・結果 ===`);
  type Res = { snapId: number; cta: string; taikyo: boolean; reply72: boolean; mention: boolean; viewing: boolean; apply: boolean; won: boolean; reaction: string | null };
  const res: Res[] = [];
  for (const s of starSnaps) {
    if (!s.star_name) continue;
    const t = Date.parse(s.sent_at);
    const ms = msgOf.get(s.conversation_id) ?? [];
    const staffAfter = ms.filter((m) => m.sender !== "customer" && Date.parse(m.created_at) >= t - 60_000 && Date.parse(m.created_at) <= t + 20 * 60_000).map((m) => String(m.text ?? "")).join("\n");
    const cta = ctaOf(String(s.star_text ?? "") + "\n" + staffAfter);
    const cust72 = ms.filter((m) => m.sender === "customer" && Date.parse(m.created_at) > t && Date.parse(m.created_at) <= t + 72 * H);
    const nextStar = snapAll.filter((x) => x.conversation_id === s.conversation_id && Date.parse(x.sent_at) > t + 10 * 60_000).map((x) => Date.parse(x.sent_at)).sort()[0] ?? Infinity;
    const win = Math.min(t + 21 * D, nextStar + 3 * D);
    const ax = (aixOf.get(s.conversation_id) ?? []).filter((a) => Date.parse(a.created_at) > t && Date.parse(a.created_at) <= win);
    const staffWin = ms.filter((m) => m.sender !== "customer" && Date.parse(m.created_at) > t + 20 * 60_000 && Date.parse(m.created_at) <= win);
    const viewing = ax.some((a) => (a.aix_type === "viewing_invite" || a.aix_type === "meeting_place") && mentions(String(a.generated_text ?? ""), s.star_name)) || staffWin.some((m) => /内覧|ご案内|待ち合わせ/.test(String(m.text ?? "")) && mentions(String(m.text ?? ""), s.star_name));
    const apply = ax.some((a) => a.aix_type === "application_push" && mentions(String(a.generated_text ?? ""), s.star_name)) || staffWin.some((m) => /お申込|お申し込み|申込書/.test(String(m.text ?? "")) && mentions(String(m.text ?? ""), s.star_name));
    const cv = convRow.get(s.conversation_id);
    const won = !!cv && ["closed_won"].includes(String(cv.status)) && apply;
    const sp = (sentOf.get(String(s.property_customer_id ?? "")) ?? []).find((x) => x.customer_reaction && mentions(String(x.property_name ?? ""), s.star_name) && Math.abs(Date.parse(x.sent_at) - t) < 3 * D);
    res.push({ snapId: Number(s.id), cta, taikyo: /退去予定/.test(String(s.star_text ?? "") + staffAfter), reply72: cust72.length > 0, mention: cust72.some((m) => mentions(String(m.text ?? ""), s.star_name)) || cust72.some((m) => m.referenced_property_id), viewing, apply, won, reaction: sp?.customer_reaction ?? null });
  }
  const rate = (xs: Res[], k: keyof Res) => `${xs.filter((x) => x[k]).length}/${xs.length}(${pct(xs.filter((x) => x[k]).length / (xs.length || 1))})`;
  P(`🌟 ${res.length}通: 72時間以内の返信 ${rate(res, "reply72")}・物件への言及 ${rate(res, "mention")}・その物件の内覧 ${rate(res, "viewing")}・その物件の申込 ${rate(res, "apply")}・成約の会話で申込 ${rate(res, "won")}・反応の札 ${res.filter((r) => r.reaction).length}`);
  for (const cta of ["viewing", "apply", "review", "none"]) { const xs = res.filter((r) => r.cta === cta); if (xs.length) P(`  締め ${cta}: ${xs.length}通 返信 ${rate(xs, "reply72")} 内覧 ${rate(xs, "viewing")} 申込 ${rate(xs, "apply")}`); }
  const tk = res.filter((r) => r.taikyo); P(`  退去予定と書いた🌟: ${tk.length}通 締め ${JSON.stringify(Object.fromEntries(["viewing", "apply", "review", "none"].map((c) => [c, tk.filter((r) => r.cta === c).length])))} 申込 ${rate(tk, "apply")}`);
  out.outcomes = res;
  // 結果 × 特徴（回のある物）
  const resBy = new Map(res.map((r) => [r.snapId, r]));
  const withRes = eps.filter((e) => resBy.has(e.snapId));
  const prog = (e: Ep) => { const r = resBy.get(e.snapId)!; return r.viewing || r.apply; };
  const starFeat = (e: Ep, f: string) => e.cands.find((c) => c.chosen)!.feats[f];
  const med = (xs: number[]) => { const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  P(`  ── 進んだ（内覧か申込）🌟 ${withRes.filter(prog).length} vs 進まない ${withRes.filter((e) => !prog(e)).length}（候補の回のある物）`);
  for (const f of ["rent_ratio", "area_sqm", "building_age", "walk", "ad_months", "equipment_count", "score"]) {
    const a = withRes.filter(prog).map((e) => starFeat(e, f)).filter((x): x is number => x != null), b = withRes.filter((e) => !prog(e)).map((e) => starFeat(e, f)).filter((x): x is number => x != null);
    P(`   ${f.padEnd(16)} 進んだ 中央 ${med(a)}（${a.length}）・進まない ${med(b)}（${b.length}）`);
  }
  for (const f of ["rent_ratio", "area_sqm", "building_age", "walk"]) {
    const dir: "high" | "low" = f === "area_sqm" ? "high" : "low";
    const rk = (xs: Ep[]) => { const v = xs.map((e) => rankIn(e, f, dir, e.cands.find((c) => c.chosen)!)).filter((x): x is number => x != null); return v.length ? (v.reduce((a, x) => a + x, 0) / v.length).toFixed(2) + `(${v.length})` : "-"; };
    P(`   回の中の順位(0=一番良い) ${f}: 進んだ ${rk(withRes.filter(prog))}・進まない ${rk(withRes.filter((e) => !prog(e)))}`);
  }
  const mBase = (xs: Ep[]) => { const m = metricsWith(xs, () => 0); return `1位 ${pct(m.top1)}（ラ ${pct(m.rand1)}）n=${m.n}`; };
  P(`   今の点の1位一致: 進んだ回 ${mBase(withRes.filter(prog))}・進まない回 ${mBase(withRes.filter((e) => !prog(e)))}`);

  // 6. 状況ごと
  P(`\n=== 6. 状況ごと（今の点の一致・🌟の方が良い率）===`);
  const sitList = [...new Set(eps.flatMap((e) => e.sits))].sort();
  out.situations = {};
  for (const s of sitList) {
    const sub = eps.filter((e) => e.sits.includes(s));
    if (sub.length < 8) continue;
    const m = metricsWith(sub, () => 0);
    const f2 = featureStats(sub);
    const show = ["rent_ratio", "area_sqm", "building_age", "walk", "ad_months", "equipment_count", "zero_zero", "floor"].map((k) => f2[k].episodes >= 5 ? `${k} ${pct(f2[k].winRate)}(${f2[k].episodes})` : null).filter(Boolean).join(" ");
    const r = sub.map((e) => resBy.get(e.snapId)).filter(Boolean) as Res[];
    P(`  ${s.padEnd(22)} n=${String(sub.length).padStart(3)} 1位 ${pct(m.top1)}(ラ ${pct(m.rand1)}) 相対 ${m.rel.toFixed(2)} | ${show} | 内覧 ${rate(r, "viewing")} 申込 ${rate(r, "apply")}`);
    (out.situations as Row)[s] = { m, f: f2 };
  }

  // 7. 当て直し（足し点）
  P(`\n=== 7. 当て直し（足し点・全回／時期の後ろ3割）===`);
  const cut = Math.floor(eps.length * 0.7);
  const train = eps.slice(0, cut), hold = eps.slice(cut);
  const sims: Array<[string, (c: Cand, e: Ep) => number]> = [
    ["なし", () => 0],
    ["家賃 90-100% +8", (c) => (c.feats.rent_ratio != null && c.feats.rent_ratio >= 0.9 && c.feats.rent_ratio <= 1.0 ? 8 : 0)],
    ["家賃 90-100% +15", (c) => (c.feats.rent_ratio != null && c.feats.rent_ratio >= 0.9 && c.feats.rent_ratio <= 1.0 ? 15 : 0)],
    ["広さ 回の一番 +8", (c, e) => (isBest(e, "area_sqm", "high", c) === 1 ? 8 : 0)],
    ["広さ 回の一番 +15", (c, e) => (isBest(e, "area_sqm", "high", c) === 1 ? 15 : 0)],
    ["広さ 回の順位で 0〜+12", (c, e) => { const r = rankIn(e, "area_sqm", "high", c); return r == null ? 0 : 12 * (1 - r); }],
    ["築年 回の一番新しい +8", (c, e) => (isBest(e, "building_age", "low", c) === 1 ? 8 : 0)],
    ["築年 回の順位で 0〜+12", (c, e) => { const r = rankIn(e, "building_age", "low", c); return r == null ? 0 : 12 * (1 - r); }],
    ["設備の数 回の順位で 0〜+10", (c, e) => { const r = rankIn(e, "equipment_count", "high", c); return r == null ? 0 : 10 * (1 - r); }],
    ["徒歩 回の順位で 0〜+8", (c, e) => { const r = rankIn(e, "walk", "low", c); return r == null ? 0 : 8 * (1 - r); }],
    ["家賃 回の順位(高いほど) 0〜+12", (c, e) => { const r = rankIn(e, "rent_ratio", "high", c); return r == null ? 0 : 12 * (1 - r); }],
    ["構造 RC/SRC +8・木造 −8", (c) => (c.feats.structure_rank == null ? 0 : c.feats.structure_rank === 2 ? 8 : c.feats.structure_rank === 0 ? -8 : 0)],
    ["AD 回の順位で 0〜+10", (c, e) => { const r = rankIn(e, "ad_months", "high", c); return r == null ? 0 : 10 * (1 - r); }],
    ["AD の点 ×0.5（🌟選びだけ）", (c) => -0.5 * c.codes.filter((k) => /^(AD_|PROFIT_)/.test(k)).reduce((a, k) => a + baseReasonPoints(k), 0)],
    ["AD の点 ×0（🌟選びだけ）", (c) => -1 * c.codes.filter((k) => /^(AD_|PROFIT_)/.test(k)).reduce((a, k) => a + baseReasonPoints(k), 0)],
    ["AD ×0.5 ＋広さ一番 +10 ＋築年一番 +8", (c, e) => -0.5 * c.codes.filter((k) => /^(AD_|PROFIT_)/.test(k)).reduce((a, k) => a + baseReasonPoints(k), 0) + (isBest(e, "area_sqm", "high", c) === 1 ? 10 : 0) + (isBest(e, "building_age", "low", c) === 1 ? 8 : 0)],
    ["FIT の点 ×0", (c) => -1 * c.codes.filter((k) => /^FIT_/.test(k)).reduce((a, k) => a + baseReasonPoints(k), 0)],
    ["敷礼0 の点 ×0.5", (c) => -0.5 * c.codes.filter((k) => /^ZERO_ZERO/.test(k)).reduce((a, k) => a + baseReasonPoints(k), 0)],
    ["送った順の1番目 +10（参考・漏れ）", (c, e) => (isBest(e, "pool_rank", "low", c) === 1 ? 10 : 0)],
    ["広さ順位+12 & 築年順位+8 & 家賃帯+8", (c, e) => { const a = rankIn(e, "area_sqm", "high", c), b = rankIn(e, "building_age", "low", c); return (a == null ? 0 : 12 * (1 - a)) + (b == null ? 0 : 8 * (1 - b)) + (c.feats.rent_ratio != null && c.feats.rent_ratio >= 0.9 && c.feats.rent_ratio <= 1.0 ? 8 : 0); }],
  ];
  out.sims = [];
  for (const [lab, f] of sims) {
    const a = metricsWith(eps, f), h = metricsWith(hold, f), lv = metricsWith(eps.filter((e) => e.live), f);
    P(`  ${lab.padEnd(34)} 全 1位 ${pct(a.top1)} 3位 ${pct(a.top3)} 相対 ${a.rel.toFixed(3)} | 後3割 1位 ${pct(h.top1)} 相対 ${h.rel.toFixed(3)} | live 1位 ${pct(lv.top1)} 相対 ${lv.rel.toFixed(3)}`);
    (out.sims as Row[]).push({ lab, all: a, hold: h, live: lv });
  }
  // 条件付きロジット
  P(`\n=== 8. 条件付きロジット（回の中で標準化・前7割で学び後3割で確かめ）===`);
  const w = fitLogit(train);
  P(`  重み: ` + LOGIT_FEATS.map(([k], i) => `${k} ${w[i].toFixed(2)}`).join("・"));
  const wNoBase = fitLogit(train, 0.5, 600, 0.05, LOGIT_FEATS.map(([k]) => k !== "base_score"));
  P(`  重み（今の点を除く）: ` + LOGIT_FEATS.map(([k], i) => `${k} ${wNoBase[i].toFixed(2)}`).join("・"));
  const onlyBase = LOGIT_FEATS.map(([k]) => (k === "base_score" ? 1 : 0));
  for (const [lab, ww] of [["今の点だけ", onlyBase], ["ロジット（全特徴）", w], ["ロジット（点なし）", wNoBase]] as const) {
    const h = logitMetrics(hold, ww as number[]), tr = logitMetrics(train, ww as number[]);
    P(`  ${lab.padEnd(18)} 学び 1位 ${pct(tr.top1)} 相対 ${tr.rel.toFixed(3)} | 確かめ 1位 ${pct(h.top1)}（ラ ${pct(h.rand1)}）3位 ${pct(h.top3)} 相対 ${h.rel.toFixed(3)} n=${h.n}`);
  }
  out.logit = { feats: LOGIT_FEATS.map(([k]) => k), w, wNoBase };
  // 状況ごとのロジット（全回で学ぶ・係数だけ・回が多い所）
  P(`  ── 状況ごとの重み（全回で学ぶ・参考）`);
  for (const s of ["first", "later", "low_initial", "movein_urgent", "budget_low(<7万)", "budget_high(10万+)", "rejected_before", "star_repeat", "pet"]) {
    const sub = eps.filter((e) => e.sits.includes(s)); if (sub.length < 15) continue;
    const ws = fitLogit(sub, 1.0, 600, 0.05, LOGIT_FEATS.map(([k]) => k !== "base_score"));
    P(`   ${s.padEnd(20)} n=${sub.length} ` + LOGIT_FEATS.map(([k], i) => (k === "base_score" ? null : `${k.replace(/\(.*\)/, "")} ${ws[i].toFixed(2)}`)).filter(Boolean).join(" "));
  }

  // 9. 点の1位と🌟が違う回: 🌟が1位の物件より「良い／悪い」項目
  P(`\n=== 9. 点の1位≠🌟の回で、🌟と点の1位の差（両方の値がある回だけ）===`);
  const missAll = eps.filter((e) => { const mx = Math.max(...e.cands.map((c) => c.base)); return !e.cands.some((c) => c.chosen && c.base === mx); });
  const cmp: Array<[string, string, "high" | "low"]> = [["広さ", "area_sqm", "high"], ["築年(新しい)", "building_age", "low"], ["徒歩(近い)", "walk", "low"], ["家賃比(高い)", "rent_ratio", "high"], ["AD", "ad_months", "high"], ["設備の数", "equipment_count", "high"], ["階", "floor", "high"], ["構造(RC寄り)", "structure_rank", "high"], ["間取りの一致", "plan_match", "high"], ["敷礼0", "zero_zero", "high"]];
  for (const [lab, f, d] of cmp) {
    let better = 0, worse = 0, same = 0;
    for (const e of missAll) {
      const st = e.cands.find((c) => c.chosen)!; const top = [...e.cands].sort((a, b) => b.base - a.base)[0];
      const a = st.feats[f], b = top.feats[f]; if (a == null || b == null) continue;
      if (a === b) same++; else if ((d === "high") === (a > b)) better++; else worse++;
    }
    P(`  ${lab.padEnd(10)} 🌟が良い ${better}・悪い ${worse}・同じ ${same}`);
  }
  // 点の差の内訳（家族ごと）: 1位の方が多くもらっている点
  const fam = (k: string) => k.replace(/_(SOFT|MUST|HELD)$/, "").split("_")[0];
  const famGap: Record<string, number[]> = {};
  for (const e of missAll) {
    const st = e.cands.find((c) => c.chosen)!; const top = [...e.cands].sort((a, b) => b.base - a.base)[0];
    const sum = (c: Cand) => { const m: Record<string, number> = {}; for (const k of c.codes) m[fam(k)] = (m[fam(k)] ?? 0) + baseReasonPoints(k); return m; };
    const A = sum(st), B = sum(top);
    for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) { const g = (B[k] ?? 0) - (A[k] ?? 0); if (g) (famGap[k] ??= []).push(g); }
  }
  P(`  点の差（1位−🌟）の家族ごとの合計と回数: ` + Object.entries(famGap).map(([k, v]) => [k, v.reduce((a, x) => a + x, 0), v.length] as const).sort((a, b) => b[1] - a[1]).map(([k, s, n]) => `${k} ${s > 0 ? "+" : ""}${s}(${n})`).join("・"));

  // 10. 結果 × 訴求・状況（本文のある🌟全部）
  P(`\n=== 10. 結果（その物件の内覧・申込）× 訴求 ===`);
  const snapRes = new Map(res.map((r) => [r.snapId, r]));
  const progR = (r: Res) => r.viewing || r.apply;
  const base = res.filter(progR).length / (res.length || 1);
  P(`  全体の進んだ率 ${pct(base)}（${res.filter(progR).length}/${res.length}）`);
  const topicRows: Array<[string, number, number, number, number]> = [];
  for (const k of Object.keys(topicCount)) {
    const w = starSnaps.filter((s) => ((s.appeal_topics ?? []) as string[]).includes(k)).map((s) => snapRes.get(Number(s.id))).filter(Boolean) as Res[];
    const wo = starSnaps.filter((s) => !((s.appeal_topics ?? []) as string[]).includes(k)).map((s) => snapRes.get(Number(s.id))).filter(Boolean) as Res[];
    if (w.length < 20) continue;
    topicRows.push([k, w.length, w.filter(progR).length / w.length, wo.length, wo.filter(progR).length / (wo.length || 1)]);
  }
  for (const [k, n, r1, n0, r0] of topicRows.sort((a, b) => (b[2] - b[4]) - (a[2] - a[4]))) P(`  ${String(TOPIC_LABEL[k as never] ?? k).padEnd(10)} 訴求あり ${pct(r1)}(${n})・なし ${pct(r0)}(${n0})`);
  // 希望に合う訴求の数
  const hitBuckets: Record<string, Res[]> = {};
  for (const s of starSnaps) {
    const r = snapRes.get(Number(s.id)); if (!r) continue;
    const ap = new Set((s.appeal_topics ?? []) as string[]);
    const hits = [...new Set(((s.customer_wants ?? []) as Row[]).map((x) => String(x.key)))].filter((k) => ap.has(k) && !["rent", "spacious", "layout", "station_near"].includes(k)).length;
    const b = hits >= 3 ? "3+" : String(hits);
    (hitBuckets[b] ??= []).push(r);
  }
  P(`  希望に合う訴求の数（家賃・広さ・間取り・駅近の定型を除く）: ` + Object.entries(hitBuckets).sort().map(([k, v]) => `${k}個 ${pct(v.filter(progR).length / v.length)}(${v.length})`).join("・"));
  // 状況（全🌟・簡易）
  const simpleSit = (s: Row) => {
    const t = Date.parse(s.sent_at); const o: string[] = [];
    o.push(snapAll.some((x) => x.conversation_id === s.conversation_id && Date.parse(x.sent_at) < t - 10 * 60_000) ? "2回目以降の🌟" : "最初の🌟");
    const c = custs.get(String(s.property_customer_id ?? "")); const u = moveInUrgency(c?.move_in_time, s.sent_at); o.push(`入居 ${u}`);
    const rm = Number(c?.rent_max ?? c?.max_rent ?? 0); if (rm) o.push(rm < 70000 ? "予算 7万未満" : rm < 100000 ? "予算 7〜10万" : "予算 10万以上");
    const w = new Set(((s.customer_wants ?? []) as Row[]).map((x) => String(x.key)));
    if (w.has("pet")) o.push("ペット"); if (w.has("screening")) o.push("審査が不安"); if (w.has("low_initial")) o.push("初期費用重視");
    if (/退去予定/.test(String(s.star_text ?? ""))) o.push("退去予定の部屋");
    return o;
  };
  const sitRes: Record<string, Res[]> = {};
  for (const s of starSnaps) { const r = snapRes.get(Number(s.id)); if (!r) continue; for (const k of simpleSit(s)) (sitRes[k] ??= []).push(r); }
  P(`  状況ごとの進んだ率: ` + Object.entries(sitRes).sort().map(([k, v]) => `${k} ${pct(v.filter(progR).length / v.length)}(${v.length})`).join("・"));

  // 例（名前を伏せた会話・物件名は出す）: 今の点で🌟が1位でない回
  P(`\n=== 例: 今の点で🌟が1位でない回（新しい順 8）===`);
  const miss = eps.filter((e) => { const mx = Math.max(...e.cands.map((c) => c.base)); return !e.cands.find((c) => c.chosen && c.base === mx); }).slice(-8).reverse();
  for (const e of miss) {
    const s = snapById.get(e.snapId)!;
    const top = [...e.cands].sort((a, b) => b.base - a.base)[0], st = e.cands.find((c) => c.chosen)!;
    const fmt = (c: Cand) => `${c.key}（点${c.base} 家賃比${c.feats.rent_ratio ?? "-"} ${c.feats.area_sqm ?? "-"}㎡ 築${c.feats.building_age ?? "-"} 徒歩${c.feats.walk ?? "-"} AD${c.feats.ad_months ?? "-"} 設備${c.feats.equipment_count ?? "-"}）`;
    P(` ${String(s.conversation_id).slice(0, 8)} ${s.sent_at.slice(0, 10)} [${e.sits.join(",")}] 候補${e.cands.length}`);
    P(`   🌟 ${fmt(st)} 訴求: ${((s.appeal_topics ?? []) as string[]).map((k) => TOPIC_LABEL[k as never] ?? k).join("・")}`);
    P(`   1位 ${fmt(top)}`);
  }
  if (args.out) writeFileSync(String(args.out), JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
