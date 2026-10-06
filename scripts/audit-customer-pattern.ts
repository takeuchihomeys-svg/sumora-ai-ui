// scripts/audit-customer-pattern.ts
// お客様の型（パターン）が何種類あるか・型ごとにスタッフの選び方が違うか・型ごとに採点基準を変えると一致が上がるか（読むだけ・LLM なし・費用0・DB に書かない）。
//
// 2026-10-06 竹内「パターンによって採点基準パターンかえているか　またお客さんのパターンは何パターンあるか調査できるか　徹底的に調査して仕上げる
//   分析力上げるため　設計知見と協力して行う」
//
// ■ 型は app/lib/customer-pattern.ts（条件欄だけで決まる軸＋会話の数えで決まる軸）。その回の時点の条件（property_condition_history で戻す）で決める
// ■ 出す物
//   1. 型の分布（今の全お客様・軸ごと・組み合わせ・会話の軸）
//   2. 送った物（scoring-learning の回＝拡張の回・売上サポの回・🌟の時点の候補）: 型ごとに「選んだ方が良い率」（特徴ごと・全体と比べた差）と今の点の一致
//   3. 🌟（直した束＝同じ束・前の🌟/入居中/断った物/同じ建物の別の部屋を外す）: 型ごとに🌟が束で一番の特徴（ランダムと比べる）・今のオススメの点の1位一致
//   4. 刺さった新着（v2 strong）: 型ごとの刺さった物の特徴（送った新着全体と比べた lift）
//   5. 型ごとの足し点の当て直し: 前7割で「型×特徴」の足し点を選び、後3割で🌟の1位一致・送った物の1位一致を旧/新で比べる（全員に同じ足し点の案とも並べる）
// ■ 正解はスタッフが選んで送った事実（🌟・送った物）。お客様の反応は材料（刺さった新着）としてだけ使い、正誤にしない
// ■ 個人情報: 名前・発言・電話は出さない（会話は先頭8字・条件は型の名前だけ）。YUMA は外す
//
// 実行: npx tsx --env-file=.env.local scripts/audit-customer-pattern.ts [--days=180] [--part=1,2,3,4,5] [--out=path.json] [--weekly]
//   --weekly … 毎週の点検の短い版（1・3・5 の要点だけ・型ごとの一致率の表）
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { baseReasonPoints, type SentRowLike, type PatternRowLike } from "../app/lib/property-brain";
import { customerAt, buildContext, episodeFromSnapshot, isCustomerSend, type ConditionHistoryRow } from "../app/lib/scoring-learning-episodes";
import { loadEpisodes } from "../app/lib/scoring-learning-server";
import { loadHookMaterials } from "../app/lib/hooked-arrival-learning-server";
import { nameKey, bestBuildingMatch, sameBuildingName, toHalf } from "../app/lib/candidate-facts";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";
import { type StarCandidate } from "../app/lib/recommend-star-rank";
import { rankByRecommendScore } from "../app/lib/recommend-score";
import { adMonthsOfPickup, structureOf, equipmentKeysOf, areaSqmOfPickup, starSituationFromConditions } from "../app/lib/star-rank-pickup";
import {
  customerPatternOf, conversationPatternOf, PATTERN_KEYS, HOUSEHOLD_JA, BUDGET_JA, FOCUS_JA, URGENCY_JA,
  type CustomerPattern, type PatternKey, type PatternConditions, type Stage,
} from "../app/lib/customer-pattern";
import {
  PATTERN_FEATURES, PATTERN_FEATURE_JA, patternFeatureBits, patternBonusOf, patternBonusOfBits, learnPatternBonusTable, describePatternBonusTable, patternGroupKeys,
  type PatternFeature, type PatternFeatureInput, type PatternBonusTable, type PatternEpisode,
} from "../app/lib/customer-pattern-weights";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "180"), 10);
const PARTS = new Set(String(args.part ?? "1,2,3,4,5").split(",").map((x) => x.trim()));
const WEEKLY = !!args.weekly;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
type Row = Record<string, any>;
const D = 864e5, H = 36e5;
const P = (...x: unknown[]) => console.log(...x);
const pct = (a: number, n?: number) => { const x = n == null ? a : n ? a / n : NaN; return Number.isFinite(x) ? `${Math.round(x * 100)}%` : "-"; };
const chunks = <T,>(xs: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };
const normRoom = (r: unknown) => toHalf(String(r ?? "")).replace(/[^0-9A-Za-z]/g, "").replace(/^0+(?=\d)/, "");
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
const groupBy = (xs: Row[], k = "property_customer_id") => { const m = new Map<string, Row[]>(); for (const x of xs) { const v = String(x[k] ?? ""); if (!v) continue; if (!m.has(v)) m.set(v, []); m.get(v)!.push(x); } return m; };
const count = <T,>(xs: T[], f: (x: T) => string) => { const o: Record<string, number> = {}; for (const x of xs) { const k = f(x); o[k] = (o[k] ?? 0) + 1; } return Object.entries(o).sort((a, b) => b[1] - a[1]); };
const line = (xs: [string, number][], n: number) => xs.map(([k, v]) => `${k} ${v}(${pct(v, n)})`).join("・");

const CUST_COLS = "id, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, created_at, floor_area_min, raw_format_text, desired_area, commute_station, commute_minutes, requirement_strength, profile_label, parent_customer_id, status, last_property_sent_at";
const PORTAL_RE = /https?:\/\/[^\s]*(?:suumo|homes\.co|athome|chintai\.net|canary|ieagent|smocca|door\.ac|apamanshop|minimini|able\.co|eheya|realpro|itandi)/i;
const PROP_IMG = new Set(["floor_plan", "property_photo"]);
const LABEL_KEY: Record<string, string> = {
  エレベーター: "elevator", 宅配ボックス: "delivery_box", オートロック: "autolock", ネット無料: "net_free", 駐車場: "parking", "バス・トイレ別": "bath_toilet",
  独立洗面台: "washbasin", 室内洗濯機置場: "laundry_in", 角部屋: "corner", ペット相談: "pet", 南向き: "south", エアコン: "aircon", システムキッチン: "system_kitchen",
  対面キッチン: "counter_kitchen", 追い焚き: "reheating", 浴室乾燥機: "bath_dryer", 温水洗浄便座: "washlet", ウォークインクローゼット: "walk_in_closet",
  "2口コンロ": "burner2", フローリング: "flooring", 駐輪場: "bike_parking", "24時間ゴミ出し": "garbage24", モニター付インターホン: "monitor_intercom", 最上階: "top_floor",
};
const toKey = (s: string) => LABEL_KEY[s] ?? s;
const mentions = (text: string, name: string) => { const k = nameKey(name); return k.length >= 3 && nameKey(text).includes(k.slice(0, Math.min(k.length, 6))); };

/** 2群の「回ごとの率」の差の z（Welch） */
function diffZ(a: number[], b: number[]): number {
  const m = (x: number[]) => x.reduce((s, v) => s + v, 0) / (x.length || 1);
  const v = (x: number[]) => { const mu = m(x); return x.length > 1 ? x.reduce((s, y) => s + (y - mu) ** 2, 0) / (x.length - 1) : 0.25; };
  if (a.length < 2 || b.length < 2) return 0;
  const se = Math.sqrt(Math.max(v(a), 0.25 / a.length) / a.length + Math.max(v(b), 0.25 / b.length) / b.length);
  return se ? (m(a) - m(b)) / se : 0;
}
/** 回の中で「選んだ方が特徴を持つ率」（持つ／持たないが割れた組だけ） */
function episodeBitWin(cands: Array<{ chosen: boolean; bits: Partial<Record<PatternFeature, 0 | 1 | null>> }>, f: PatternFeature): number | null {
  let w = 0, k = 0;
  for (const a of cands) if (a.chosen) for (const b of cands) if (!b.chosen) {
    const x = a.bits[f], y = b.bits[f];
    if (x == null || y == null || x === y) continue;
    w += x; k++;
  }
  return k ? w / k : null;
}

(async () => {
  const until = Date.now();
  const out: Row = { at: new Date(until).toISOString(), days: DAYS };
  const yumaCust = new Set<string>();
  {
    const { data } = await sb.from("conversations").select("property_customer_id").eq("id", YUMA_CONVERSATION_ID).maybeSingle();
    if (data?.property_customer_id) yumaCust.add(String(data.property_customer_id));
  }
  const custAll = (await all((a, b) => sb.from("property_customers").select(CUST_COLS).order("id").range(a, b) as never)).filter((c) => !yumaCust.has(String(c.id)));
  const custById = new Map(custAll.map((c) => [String(c.id), c]));
  const ids = custAll.map((c) => String(c.id));
  const hist: Row[] = [], sents: Row[] = [], convRows: Row[] = [];
  for (const c of chunks(ids, 80)) {
    hist.push(...await all((a, b) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, created_at").in("property_customer_id", c).order("id").range(a, b) as never));
    sents.push(...await all((a, b) => sb.from("sent_properties").select("property_customer_id, conversation_id, property_name, room_no, delivery, source, sent_at, customer_reaction, recruitment_status").in("property_customer_id", c).order("id").range(a, b) as never));
    const { data } = await sb.from("conversations").select("id, property_customer_id").in("property_customer_id", c);
    convRows.push(...((data ?? []) as Row[]));
  }
  const hOf = groupBy(hist), sOf = groupBy(sents);
  const convOfCust = new Map<string, string[]>();
  for (const r of convRows) { const k = String(r.property_customer_id); if (!convOfCust.has(k)) convOfCust.set(k, []); convOfCust.get(k)!.push(String(r.id)); }
  const convIds = [...new Set(convRows.map((r) => String(r.id)))].filter((x) => x !== YUMA_CONVERSATION_ID);
  // お客様の発言（持ち込みの数え・断った物）と AIX（内覧・見積書＝深い段）
  const custMsgs: Row[] = [], aixRows: Row[] = [];
  for (const c of chunks(convIds, 50)) {
    custMsgs.push(...await all((a, b) => sb.from("messages").select("conversation_id, text, image_type, created_at, referenced_property_id").in("conversation_id", c).eq("sender", "customer").order("id").range(a, b) as never));
    aixRows.push(...await all((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at").in("conversation_id", c).in("aix_type", ["viewing_invite", "meeting_place", "viewing_schedule", "estimate_sheet"]).order("id").range(a, b) as never));
  }
  const mOf = groupBy(custMsgs, "conversation_id"), aOf = groupBy(aixRows, "conversation_id");
  const custOfConv = new Map<string, string>(); for (const r of convRows) custOfConv.set(String(r.id), String(r.property_customer_id));

  /** その時点の条件 → 型（条件欄だけ） */
  const patternAt = (pc: string, atIso: string | null): CustomerPattern | null => {
    const base = custById.get(pc); if (!base) return null;
    const c = atIso ? customerAt(base, (hOf.get(pc) ?? []) as ConditionHistoryRow[], atIso).c : base;
    return customerPatternOf(c as PatternConditions);
  };
  /** その時点の会話の軸 */
  const convPatternAt = (pc: string, atMs: number) => {
    const cvs = convOfCust.get(pc) ?? [];
    const ms = cvs.flatMap((cv) => mOf.get(cv) ?? []).filter((m) => Date.parse(m.created_at) < atMs);
    const brought = ms.filter((m) => PORTAL_RE.test(String(m.text ?? "")) || PROP_IMG.has(String(m.image_type ?? ""))).length;
    const sentBefore = (sOf.get(pc) ?? []).filter((s) => isCustomerSend(s) && Date.parse(s.sent_at) < atMs).length;
    const ax = cvs.flatMap((cv) => aOf.get(cv) ?? []).filter((a) => Date.parse(a.created_at) < atMs);
    return conversationPatternOf({ broughtProperties: brought, sentBefore, viewingBefore: ax.some((a) => a.aix_type !== "estimate_sheet"), estimateBefore: ax.some((a) => a.aix_type === "estimate_sheet") });
  };

  // ─── 1. 型の分布 ───────────────────────────────────────────────
  const active = custAll.filter((c) => !c.parent_customer_id);
  const pats = active.map((c) => ({ c, p: customerPatternOf(c as PatternConditions), cp: convPatternAt(String(c.id), until) }));
  const sentCust = pats.filter((x) => (sOf.get(String(x.c.id)) ?? []).some(isCustomerSend));
  if (PARTS.has("1")) {
    const N = pats.length, NS = sentCust.length;
    P(`=== 1. お客様の型の分布（物件顧客 ${N}人・子の行と YUMA を除く／物件を送ったお客様 ${NS}人）===`);
    P(`  世帯: ${line(count(pats, (x) => HOUSEHOLD_JA[x.p.household]), N)}`);
    P(`    決め手: ${line(count(pats, (x) => x.p.householdFrom === "text" ? "自由文の語" : x.p.householdFrom === "layout" ? "間取り" : "なし"), N)}`);
    P(`  予算: ${line(count(pats, (x) => BUDGET_JA[x.p.budget]), N)}`);
    const fN: Record<string, number> = {}; for (const x of pats) for (const f of x.p.focus) fN[f] = (fN[f] ?? 0) + 1;
    P(`  重視点（重なりあり）: ${Object.entries(fN).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${FOCUS_JA[k as never]} ${v}(${pct(v, N)})`).join("・")}`);
    P(`  重視点の数: ${line(count(pats, (x) => `${x.p.focus.filter((f) => f !== "screening").length}個`), N)}`);
    P(`  一番の重視点: ${line(count(pats, (x) => FOCUS_JA[x.p.primaryFocus]), N)}`);
    P(`  急ぎ: ${line(count(pats, (x) => URGENCY_JA[x.p.urgency]), N)}`);
    P(`  条件の固さ（絶対の要望の数）: ${line(count(pats, (x) => x.p.firmness === "firm" ? "固い(2以上)" : x.p.firmness === "some" ? "1つ" : "なし"), N)}`);
    P(`  学生・新社会人の語: ${pats.filter((x) => x.p.student).length}`);
    P(`  会話: 持ち込み型（物件の URL・画像を2件以上）${pats.filter((x) => x.cp.bringsOwn).length}・段 ${line(count(pats, (x) => ({ new: "新規(送付0)", proposing: "提案中", deep: "内覧・見積あり" } as Record<Stage, string>)[x.cp.stage]), N)}`);
    P(`\n  採点の型（世帯 一人/二人以上 × 初期費用）: 全員 ${line(count(pats, (x) => x.p.patternKey), N)}`);
    P(`                                         送ったお客様 ${line(count(sentCust, (x) => x.p.patternKey), NS)}`);
    P(`  世帯×予算（送ったお客様）: ${line(count(sentCust, (x) => `${HOUSEHOLD_JA[x.p.household]}×${BUDGET_JA[x.p.budget]}`).slice(0, 14), NS)}`);
    P(`  世帯×一番の重視点（送ったお客様）: ${line(count(sentCust, (x) => `${HOUSEHOLD_JA[x.p.household]}×${FOCUS_JA[x.p.primaryFocus]}`).slice(0, 16), NS)}`);
    // 細かい組み合わせ（世帯×予算×一番の重視点×急ぎ）が何種類になるか
    const fine = count(sentCust, (x) => `${HOUSEHOLD_JA[x.p.household]}×${BUDGET_JA[x.p.budget]}×${FOCUS_JA[x.p.primaryFocus]}×${URGENCY_JA[x.p.urgency]}`);
    P(`  細かい組み合わせ（世帯×予算×一番の重視点×急ぎ）: ${fine.length}種類・5人以上の型 ${fine.filter(([, v]) => v >= 5).length}・1人だけ ${fine.filter(([, v]) => v === 1).length}`);
    const mid = count(sentCust, (x) => `${HOUSEHOLD_JA[x.p.household]}×${FOCUS_JA[x.p.primaryFocus]}`);
    P(`  中くらい（世帯×一番の重視点）: ${mid.length}種類・10人以上 ${mid.filter(([, v]) => v >= 10).length}（${mid.filter(([, v]) => v >= 10).reduce((a, [, v]) => a + v, 0)}人）`);
    out.distribution = {
      n: N, sentN: NS,
      household: count(pats, (x) => x.p.household), householdFrom: count(pats, (x) => x.p.householdFrom), budget: count(pats, (x) => x.p.budget), focus: fN,
      primary: count(pats, (x) => x.p.primaryFocus), urgency: count(pats, (x) => x.p.urgency), firmness: count(pats, (x) => x.p.firmness),
      student: pats.filter((x) => x.p.student).length, bringsOwn: pats.filter((x) => x.cp.bringsOwn).length, stage: count(pats, (x) => x.cp.stage),
      patternKeyAll: count(pats, (x) => x.p.patternKey), patternKeySent: count(sentCust, (x) => x.p.patternKey),
      householdBudgetSent: count(sentCust, (x) => `${x.p.household}×${x.p.budget}`), householdPrimarySent: mid,
      fineKinds: fine.length, fineFivePlus: fine.filter(([, v]) => v >= 5).length,
    };
  }

  // ─── 2. 送った物（scoring-learning の回）─────────────────────────────
  type Tagged = { id: string; at: string; source: string; pc: string; p: CustomerPattern; stage: Stage; bringsOwn: boolean; cands: Array<{ chosen: boolean; score: number; bits: Partial<Record<PatternFeature, 0 | 1 | null>> }> };
  const sendEps: Tagged[] = [];
  if (PARTS.has("2") || PARTS.has("5")) {
    const { episodes, counts } = await loadEpisodes(sb as never, { until: new Date(until).toISOString(), days: DAYS, sources: ["snapshot", "pool", "pickup"] });
    // 回 → お客様（id の頭で引く）
    const snapIds = episodes.filter((e) => e.source === "snapshot").map((e) => e.id.slice(5));
    const poolIds = episodes.filter((e) => e.source === "pool").map((e) => e.id.slice(5));
    const batchIds = episodes.filter((e) => e.source === "pickup").map((e) => e.id.slice(7));
    const pcOf = new Map<string, string>();
    for (const c of chunks(snapIds, 200)) { const { data } = await sb.from("recommendation_snapshots").select("id, property_customer_id").in("id", c); for (const r of (data ?? []) as Row[]) pcOf.set(`snap:${r.id}`, String(r.property_customer_id)); }
    for (const c of chunks(poolIds, 200)) { const { data } = await sb.from("property_candidate_pools").select("id, property_customer_id").in("id", c); for (const r of (data ?? []) as Row[]) pcOf.set(`pool:${r.id}`, String(r.property_customer_id)); }
    for (const c of chunks(batchIds, 100)) { const { data } = await sb.from("property_pickups").select("batch_id, property_customer_id").in("batch_id", c); for (const r of (data ?? []) as Row[]) pcOf.set(`pickup:${r.batch_id}`, String(r.property_customer_id)); }
    for (const e of episodes) {
      const pc = pcOf.get(e.id); if (!pc) continue;
      const p = patternAt(pc, e.at); if (!p) continue;
      const cp = convPatternAt(pc, Date.parse(e.at));
      sendEps.push({
        id: e.id, at: e.at, source: e.source, pc, p, stage: cp.stage, bringsOwn: cp.bringsOwn,
        cands: e.cands.map((c) => ({ chosen: c.chosen, score: 50 + c.codes.reduce((a, k) => a + baseReasonPoints(k), 0), bits: patternFeatureBits(featInputOfEpisode(c.feats), p) })),
      });
    }
    sendEps.sort((a, b) => a.at.localeCompare(b.at));
    if (PARTS.has("2") && !WEEKLY) {
      P(`\n=== 2. 送った物（スタッフが選んで送った回・${DAYS}日・${JSON.stringify(counts)}）===`);
      P(`  型の付いた回 ${sendEps.length}（拡張 ${sendEps.filter((e) => e.source === "pool").length}・売上サポ ${sendEps.filter((e) => e.source === "pickup").length}・🌟の時点 ${sendEps.filter((e) => e.source === "snapshot").length}）・お客様 ${new Set(sendEps.map((e) => e.pc)).size}人`);
      out.sends = reportByType(sendEps, "送った物");
    }
  }

  // ─── 3. 🌟（直した束）──────────────────────────────────────────────
  type SC = { key: string; name: string; room: string; chosen: boolean; codes: string[]; base: number; f: Row; sentAt: number; sameSess: boolean; prevStar: boolean; rejected: boolean; unavailable: boolean; sameBldStar: boolean };
  type SE = { id: number; at: string; live: boolean; pc: string; p: CustomerPattern; stage: Stage; bringsOwn: boolean; cands: SC[]; sit: ReturnType<typeof starSituationFromConditions>; standalone: boolean };
  const starEps: SE[] = [];
  if (PARTS.has("3") || PARTS.has("5")) {
    const snapsAll = (await all((a, b) => sb.from("recommendation_snapshots").select("id, conversation_id, property_customer_id, sent_at, star_name, star_room, star_in_candidates, candidate_count, candidates, source")
      .gte("sent_at", new Date(until - DAYS * D).toISOString()).order("id").range(a, b) as never, 300)).filter((s) => s.conversation_id !== YUMA_CONVERSATION_ID);
    const snaps = snapsAll.filter((s) => s.property_customer_id && s.candidate_count >= 2 && s.star_in_candidates && custById.has(String(s.property_customer_id)));
    const pcs = [...new Set(snaps.map((s) => String(s.property_customer_id)))];
    const pats2: Row[] = [], picks: Row[] = [];
    for (const c of chunks(pcs, 80)) {
      pats2.push(...await all((a, b) => sb.from("property_selection_patterns").select("property_customer_id, selling_points, selection_label, created_at").in("property_customer_id", c).order("id").range(a, b) as never));
      picks.push(...await all((a, b) => sb.from("property_pickups").select("id, property_customer_id, created_at, property_name, room_no, reason_codes, summary_text, ad_yen, equipment, terms").in("property_customer_id", c).order("id").range(a, b) as never));
    }
    const pOf = groupBy(pats2), pkOf = groupBy(picks);
    const byImage = new Map<string, Row>();
    const urls = [...new Set(snaps.flatMap((s) => ((s.candidates ?? []) as Row[]).map((c) => String(c.image_url ?? "")).filter(Boolean)))];
    for (const c of chunks(urls, 20)) {
      const { data, error } = await sb.from("sent_image_properties").select("image_url, property_name, room_no, facts").in("image_url", c).not("facts", "is", null);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Row[]) {
        const fr = (r.facts as Row)?.room_no;
        if (fr != null && r.room_no != null && normRoom(fr) && normRoom(r.room_no) && normRoom(fr) !== normRoom(r.room_no)) continue;
        byImage.set(String(r.image_url), r.facts as Row);
      }
    }
    const roByKey = new Map<string, Row>();
    for (const r of await all((a, b) => sb.from("rent_observations").select("property_name, room_no, rent, admin_fee, area_sqm, building_age, walk_minutes, structure, floor, deposit_months, key_money_months, equipment, ad_yen, floor_plan").order("id").range(a, b) as never)) roByKey.set(`${nameKey(r.property_name)}#${normRoom(r.room_no)}`, r);
    for (const s of snaps) {
      const pc = String(s.property_customer_id); const base = custById.get(pc)!;
      const raw = ((typeof s.candidates === "string" ? JSON.parse(s.candidates) : s.candidates) ?? []) as Row[];
      const t = Date.parse(s.sent_at);
      const firstSent = Math.min(...raw.map((c) => Date.parse(String(c.sent_at ?? ""))).filter(Number.isFinite), t);
      const { c } = customerAt(base, (hOf.get(pc) ?? []) as ConditionHistoryRow[], s.sent_at);
      const before = (sOf.get(pc) ?? []).filter((x) => Date.parse(x.sent_at) < firstSent - 60_000 && isCustomerSend(x)) as unknown as SentRowLike[];
      const pt = (pOf.get(pc) ?? []).filter((p) => Date.parse(p.created_at) < t) as PatternRowLike[];
      const ctx = buildContext(c, before, pt, s.sent_at);
      const pkList = (pkOf.get(pc) ?? []).filter((r) => Date.parse(r.created_at) <= t + 60_000 && Date.parse(r.created_at) >= t - 14 * D);
      const fill = (x: Row, k: string, v: unknown) => { if (x[k] == null && v != null && v !== "") x[k] = v; };
      const filled = raw.map((cd0) => {
        const x: Row = { ...cd0, equipment: Array.isArray(cd0.equipment) ? cd0.equipment.map(toKey) : cd0.equipment, __structure: cd0.structure ?? null };
        const f = byImage.get(String(cd0.image_url ?? ""));
        if (f) {
          for (const k of ["rent", "admin_fee_yen", "area_sqm", "building_age", "walk_minutes", "floor_plan", "deposit_months", "key_money_months", "station", "floor"]) fill(x, k, f[k]);
          if (x.stations == null && Array.isArray(f.stations)) x.stations = f.stations;
          if (x.ad_months == null && x.ad_yen == null) { fill(x, "ad_months", f.ad_months); fill(x, "ad_yen", f.ad_yen); }
          if (f.status) x.__status = f.status;
        }
        const pk = bestBuildingMatch(String(x.name ?? ""), x.room_no ?? null, pkList, (r: Row) => r.property_name, (r: Row) => r.room_no);
        if (pk) {
          if (x.ad_months == null && x.ad_yen == null) { const m = adMonthsOfPickup(pk); if (m != null) x.ad_months = m; }
          const st = structureOf(pk.equipment); if (x.__structure == null && st) x.__structure = st;
          const eq = equipmentKeysOf(pk.equipment); if ((!Array.isArray(x.equipment) || !x.equipment.length) && eq) x.equipment = eq;
          fill(x, "building_age", pk.terms?.buildingAge); fill(x, "area_sqm", areaSqmOfPickup(pk));
          fill(x, "deposit_months", pk.terms?.deposit); fill(x, "key_money_months", pk.terms?.keyMoney);
        }
        const ro = roByKey.get(`${nameKey(x.name)}#${normRoom(x.room_no)}`);
        if (ro) {
          fill(x, "rent", ro.rent); fill(x, "admin_fee_yen", ro.admin_fee); fill(x, "area_sqm", ro.area_sqm != null ? Number(ro.area_sqm) : null); fill(x, "building_age", ro.building_age);
          fill(x, "walk_minutes", ro.walk_minutes); fill(x, "floor", ro.floor); fill(x, "deposit_months", ro.deposit_months != null ? Number(ro.deposit_months) : null);
          fill(x, "key_money_months", ro.key_money_months != null ? Number(ro.key_money_months) : null); fill(x, "floor_plan", ro.floor_plan);
          if (x.ad_yen == null && x.ad_months == null && ro.ad_yen != null) x.ad_yen = ro.ad_yen;
          if ((!Array.isArray(x.equipment) || !x.equipment.length) && ro.equipment && typeof ro.equipment === "object") x.equipment = Object.entries(ro.equipment as Row).filter(([, v]) => v === true).map(([k]) => k);
          if (x.__structure == null && ro.structure) x.__structure = ro.structure;
        }
        return x;
      });
      let e = null;
      try { e = episodeFromSnapshot({ ...s, candidates: filled }, ctx); } catch { e = null; }
      if (!e) continue;
      const rawOf = (key: string) => filled.find((fc) => key === `${fc.name}${fc.room_no ? ` ${normRoom(fc.room_no)}` : ""}`) ?? filled.find((fc) => key.startsWith(String(fc.name))) ?? {};
      const priorStars = snapsAll.filter((x) => x.conversation_id === s.conversation_id && Date.parse(x.sent_at) < t - 10 * 60_000 && Date.parse(x.sent_at) > t - 60 * D);
      const custBefore = (mOf.get(String(s.conversation_id)) ?? []).filter((m) => Date.parse(m.created_at) < t && Date.parse(m.created_at) > t - 7 * D);
      const sentRows = sOf.get(pc) ?? [];
      const cands: SC[] = e.cands.map((cc) => {
        const r = rawOf(cc.key);
        const name = String(r.name ?? cc.key), room = normRoom(r.room_no);
        const sentAt = Date.parse(String(r.sent_at ?? s.sent_at));
        const prevStar = !cc.chosen && priorStars.some((p) => sameBuildingName(String(p.star_name ?? ""), name) && (!p.star_room || !room || normRoom(p.star_room) === room));
        const rejected = sentRows.some((x) => x.customer_reaction === "rejected" && sameBuildingName(String(x.property_name ?? ""), name) && Date.parse(x.sent_at) < t)
          || custBefore.some((m) => mentions(String(m.text ?? ""), name) && /(微妙|ちょっと|やめ|見送|合わな|ないです|無しで|ナシ|古い|狭い|遠い|高い|NG|いらな|不要)/.test(String(m.text ?? "")));
        const st = String(r.__status ?? "");
        const recr = sentRows.find((x) => sameBuildingName(String(x.property_name ?? ""), name) && x.recruitment_status)?.recruitment_status;
        const unavailable = st === "occupied" || /終了|成約|申込/.test(String(recr ?? ""));
        return {
          key: cc.key, name, room, chosen: cc.chosen, codes: cc.codes, base: 50 + cc.codes.reduce((a, k) => a + baseReasonPoints(k), 0),
          f: { ...cc.feats, __structure: r.__structure ?? null, __status: r.__status ?? null, equipment: r.equipment ?? null },
          sentAt, sameSess: t - sentAt < 2 * H, prevStar, rejected, unavailable, sameBldStar: false,
        };
      });
      const star = cands.find((x) => x.chosen)!;
      for (const x of cands) x.sameBldStar = !x.chosen && nameKey(x.name) === nameKey(star.name);
      const p = customerPatternOf(c as PatternConditions);
      const cp = convPatternAt(pc, t);
      starEps.push({ id: Number(s.id), at: e.at, live: s.source === "live", pc, p, stage: cp.stage, bringsOwn: cp.bringsOwn, cands, sit: starSituationFromConditions(c as never), standalone: !cands.some((x) => !x.chosen && x.sameSess) });
    }
    starEps.sort((a, b) => a.at.localeCompare(b.at));
  }
  // 直した束（audit-star-mismatch-why の段5と同じ）
  const fixCands = (e: SE): SC[] => {
    let cs = e.cands.filter((c) => c.chosen || (!c.prevStar && !c.unavailable && !c.rejected));
    if (!e.standalone) cs = cs.filter((c) => c.chosen || c.sameSess);
    const seen = new Set<string>();
    return cs.filter((c) => { if (c.chosen) return true; const k = nameKey(c.name); if (c.sameBldStar || seen.has(k)) return false; seen.add(k); return true; });
  };
  const toStar = (c: SC): StarCandidate => ({
    key: c.key, codes: c.codes, score: c.base, pointsOf: baseReasonPoints, areaSqm: c.f.area_sqm, buildingAge: c.f.building_age, structure: c.f.__structure,
    equipmentCount: c.f.equipment_count, equipWantHits: c.f.equip_want_hits, adMonths: c.f.ad_months,
    zeroZero: c.f.zero_zero == null ? null : c.f.zero_zero === 1, walkMinutes: c.f.walk, vacancy: c.f.__status === "open" ? "open" : c.f.__status === "move_out_planned" || c.f.__status === "under_construction" ? "later" : null,
    equipmentKeys: Array.isArray(c.f.equipment) ? c.f.equipment : null, floor: c.f.floor,
  });
  const starBundles = starEps.filter((e) => !e.standalone).map((e) => ({ e, cs: fixCands(e) })).filter((x) => x.cs.length >= 2);
  /** 🌟の回 → 型ごとの特徴の材料（束の中の相対の特徴も入れる） */
  const starTagged = starBundles.map(({ e, cs }) => {
    const inputs = cs.map((c) => featInputOfStar(c.f));
    const bundle = bundleContext(inputs);
    return { e, cs, cands: cs.map((c, i) => ({ chosen: c.chosen, bits: patternFeatureBits(inputs[i], e.p, bundle) })) };
  });
  if (PARTS.has("3")) {
    P(`\n=== 3. 🌟（直した束・新着1件の単独の🌟は除く・${DAYS}日）: ${starBundles.length}回・お客様 ${new Set(starBundles.map((x) => x.e.pc)).size}人 ===`);
    // 今のオススメの点の1位一致（型ごと）
    const hitNow = (x: typeof starBundles[number], extra?: (c: StarCandidate) => { points: number; label: string } | null) => {
      const r = rankByRecommendScore(x.cs.map(toStar), x.e.sit, extra ? { extra: (c) => extra(c) } : {});
      return x.cs.find((c) => c.key === r[0].key)!.chosen;
    };
    const rows: Row[] = [];
    for (const k of [...PATTERN_KEYS, "全体"] as const) {
      const xs = k === "全体" ? starBundles : starBundles.filter((x) => x.e.p.patternKey === k);
      if (!xs.length) continue;
      const h = xs.filter((x) => hitNow(x)).length, rnd = xs.reduce((a, x) => a + 1 / x.cs.length, 0);
      rows.push({ type: k, n: xs.length, people: new Set(xs.map((x) => x.e.pc)).size, hit: h, rand: rnd });
      P(`  ${k.padEnd(10)} ${String(xs.length).padStart(3)}回（${new Set(xs.map((x) => x.e.pc)).size}人）: 今のオススメの点の1位＝🌟 ${pct(h, xs.length)}・ランダム ${pct(rnd, xs.length)}`);
    }
    for (const [lab, f] of [["世帯", (x: typeof starBundles[number]) => HOUSEHOLD_JA[x.e.p.household]], ["予算", (x: typeof starBundles[number]) => BUDGET_JA[x.e.p.budget]], ["一番の重視点", (x: typeof starBundles[number]) => FOCUS_JA[x.e.p.primaryFocus]], ["急ぎ", (x: typeof starBundles[number]) => URGENCY_JA[x.e.p.urgency]], ["段", (x: typeof starBundles[number]) => x.e.stage], ["持ち込み", (x: typeof starBundles[number]) => (x.e.bringsOwn ? "持ち込み型" : "ふつう")]] as const) {
      const g = new Map<string, typeof starBundles>();
      for (const x of starBundles) { const k = f(x); if (!g.has(k)) g.set(k, []); g.get(k)!.push(x); }
      P(`  ${lab}: ` + [...g].sort((a, b) => b[1].length - a[1].length).map(([k, xs]) => `${k} ${pct(xs.filter((x) => hitNow(x)).length, xs.length)}（ラ ${pct(xs.reduce((a, x) => a + 1 / x.cs.length, 0), xs.length)}・${xs.length}回）`).join("／"));
    }
    out.starNow = rows;
    // 一致が低い型の「ずれの中身」: 1位≠🌟の回で、🌟が1位より良い（大きい/小さい）率
    const CMP: Array<[string, (c: SC) => number | null, "high" | "low"]> = [
      ["家賃比", (c) => c.f.rent_ratio, "high"], ["広さ", (c) => c.f.area_sqm, "high"], ["築年", (c) => c.f.building_age, "low"], ["徒歩", (c) => c.f.walk, "low"],
      ["AD", (c) => c.f.ad_months, "high"], ["敷礼0", (c) => c.f.zero_zero, "high"], ["階", (c) => c.f.floor, "high"], ["間取り一致", (c) => c.f.plan_match, "high"], ["判定の点", (c) => c.base, "high"],
    ];
    const missWhy: Row = {};
    const groupsWeak: Array<[string, (x: typeof starBundles[number]) => boolean]> = [
      ["急ぎ", (x) => x.e.p.urgency === "urgent"], ["予算6万未満", (x) => x.e.p.budget === "low"], ["一人×初期費用", (x) => x.e.p.patternKey === "一人×初期費用"],
      ["世帯不明", (x) => x.e.p.household === "unknown"], ["二人以上（一致が高い型・比べ）", (x) => x.e.p.patternKey === "二人以上" || x.e.p.household === "family"], ["全体", () => true],
    ];
    P(`  [ずれの中身] 1位≠🌟の回で「🌟の方が 大きい/小さい/同じ」（家賃比は🌟が高い＝上限寄り・築年と徒歩は🌟が小さい＝新しい/近い を良いとして数える）`);
    for (const [g, sel] of groupsWeak) {
      const xs = starBundles.filter(sel).filter((x) => !hitNow(x));
      const cells = CMP.map(([lab, f, dir]) => {
        let better = 0, worse = 0, same = 0;
        for (const x of xs) {
          const top = x.cs.find((c) => c.key === rankByRecommendScore(x.cs.map(toStar), x.e.sit)[0].key)!, st = x.cs.find((c) => c.chosen)!;
          const a = f(st), b = f(top);
          if (a == null || b == null) continue;
          if (a === b) same++; else if ((dir === "high" ? a > b : a < b)) better++; else worse++;
        }
        return { lab, better, worse, same };
      });
      missWhy[g] = { misses: xs.length, cells };
      P(`    ${g}（ずれ ${xs.length}回）: ` + cells.filter((c) => c.better + c.worse + c.same >= 3).map((c) => `${c.lab} 良${c.better}/悪${c.worse}/同${c.same}`).join("・"));
    }
    out.missWhy = missWhy;
    if (!WEEKLY) out.stars = reportByType(starTagged.map(({ e, cands }) => ({ id: String(e.id), at: e.at, source: "star", pc: e.pc, p: e.p, stage: e.stage, bringsOwn: e.bringsOwn, cands: cands.map((c) => ({ ...c, score: 0 })) })), "🌟");
  }

  // ─── 4. 刺さった新着（v2 strong）──────────────────────────────────
  if (PARTS.has("4") && !WEEKLY) {
    const mats = await loadHookMaterials(sb as never, { until: new Date(until).toISOString(), days: DAYS, criteria: "v2" });
    const snapPc = new Map<number, string>();
    for (const c of chunks(mats.map((m) => m.snapshotId), 200)) { const { data } = await sb.from("recommendation_snapshots").select("id, property_customer_id").in("id", c); for (const r of (data ?? []) as Row[]) snapPc.set(Number(r.id), String(r.property_customer_id ?? "")); }
    const tagged = mats.map((m) => { const pc = snapPc.get(m.snapshotId) ?? ""; const p = pc ? patternAt(pc, m.sentAt) : null; return { m, p, bits: p ? patternFeatureBits(featInputOfHook(m.feats, m.facts as Row), p) : null }; }).filter((x) => x.p && !yumaCust.has(snapPc.get(x.m.snapshotId) ?? ""));
    P(`\n=== 4. 刺さった新着（v2 strong・${DAYS}日）: 新着1件の🌟 ${tagged.length}回・刺さった ${tagged.filter((x) => x.m.hooked).length} ===`);
    const res: Row = {};
    for (const k of [...PATTERN_KEYS, "全体"] as const) {
      const xs = k === "全体" ? tagged : tagged.filter((x) => x.p!.patternKey === k);
      const hk = xs.filter((x) => x.m.hooked);
      if (xs.length < 10) continue;
      const fs = PATTERN_FEATURES.map((f) => {
        const known = xs.filter((x) => x.bits![f] != null), kh = known.filter((x) => x.m.hooked);
        const a = known.filter((x) => x.bits![f] === 1).length / (known.length || 1), b = kh.filter((x) => x.bits![f] === 1).length / (kh.length || 1);
        return { f, sent: known.length, hooked: kh.length, sentRate: a, hookedRate: b, lift: a ? b / a : NaN };
      }).filter((r) => r.hooked >= 5);
      res[k] = { n: xs.length, hooked: hk.length, features: fs };
      P(`  ${k.padEnd(10)} 送った ${xs.length}・刺さった ${hk.length}（${pct(hk.length, xs.length)}）: ` + fs.filter((r) => Math.abs(r.lift - 1) >= 0.2).map((r) => `${PATTERN_FEATURE_JA[r.f]} ${pct(r.hookedRate)}/${pct(r.sentRate)}（×${r.lift.toFixed(2)}・刺さ${r.hooked}）`).join("・"));
    }
    out.hooks = res;
  }

  // ─── 5. 型ごとの足し点の当て直し ───────────────────────────────────
  if (PARTS.has("5")) {
    const keysOfStar = (e: SE) => patternGroupKeys(e.p, { stage: e.stage, bringsOwn: e.bringsOwn });
    const starPE: Array<PatternEpisode & { pc: string }> = starTagged.map(({ e, cands }) => ({ id: `star:${e.id}`, at: e.at, pc: e.pc, keys: keysOfStar(e), cands: cands.map((c) => ({ chosen: c.chosen, bits: c.bits })) }));
    const sendPE: Array<PatternEpisode & { pc: string }> = sendEps.filter((e) => e.source !== "pickup").map((e) => ({ id: e.id, at: e.at, pc: e.pc, keys: patternGroupKeys(e.p, { stage: e.stage, bringsOwn: e.bringsOwn }), cands: e.cands.map((c) => ({ chosen: c.chosen, bits: c.bits })) }));
    const sorted = starPE.slice().sort((a, b) => a.at.localeCompare(b.at));
    const starCut = sorted[Math.floor(sorted.length * 0.7)]?.at ?? "9999";
    // お客様で分ける（id の16進の末尾の偶奇）
    const half = (pc: string) => parseInt(pc.replace(/[^0-9a-f]/gi, "").slice(-1) || "0", 16) % 2 === 0 ? "A" : "B";
    const splits: Array<{ name: string; train: (x: { at: string; pc: string }) => boolean }> = [
      { name: "時期（前7割→後3割）", train: (x) => x.at < starCut },
      { name: "お客様 A→B", train: (x) => half(x.pc) === "A" },
      { name: "お客様 B→A", train: (x) => half(x.pc) === "B" },
    ];
    const FAMILIES: Array<[string, RegExp | null]> = [["型（一人/二人以上×初期費用）", /^型:/], ["世帯", /^世帯:/], ["予算", /^予算:/], ["重視点", /^重視:/], ["急ぎ", /^急ぎ:/], ["段", /^段:/], ["持ち込み", /^持ち込み$/], ["全部の軸", null]];
    P(`\n=== 5. 型ごとの足し点の当て直し（🌟 ${starPE.length}回・送った物 ${sendPE.length}回／時期の線 ${starCut.slice(0, 10)}）===`);
    const evalStar = (table: PatternBonusTable | null, sel: (x: typeof starTagged[number]) => boolean) => {
      let n = 0, h = 0, newOnly = 0, oldOnly = 0;
      for (const x of starTagged) {
        if (!sel(x)) continue;
        const inputs = x.cs.map((c) => featInputOfStar(c.f)); const bundle = bundleContext(inputs);
        const cands = x.cs.map(toStar);
        const keys = keysOfStar(x.e);
        const old = rankByRecommendScore(cands, x.e.sit);
        const nw = table ? rankByRecommendScore(cands, x.e.sit, { extra: (_c, i) => { const b = patternBonusOf(table, keys, x.e.p, inputs[i], bundle); return b.points ? { points: b.points, label: `型 ${b.hits.join("・")}` } : null; } }) : old;
        const ho = x.cs.find((c) => c.key === old[0].key)!.chosen, hn = x.cs.find((c) => c.key === nw[0].key)!.chosen;
        n++; if (hn) h++; if (hn && !ho) newOnly++; if (ho && !hn) oldOnly++;
      }
      return { n, h, newOnly, oldOnly };
    };
    const evalSend = (table: PatternBonusTable | null, sel: (e: Tagged) => boolean) => {
      let n = 0, h = 0, newOnly = 0, oldOnly = 0;
      for (const e of sendEps) {
        if (!sel(e) || e.source === "pickup") continue;
        const keys = patternGroupKeys(e.p, { stage: e.stage, bringsOwn: e.bringsOwn });
        const sc = e.cands.map((c) => c.score), nb = e.cands.map((c, i) => sc[i] + (table ? patternBonusOfBits(table, keys, c.bits).points : 0));
        const top = (xs: number[]) => { const mx = Math.max(...xs); const at = e.cands.filter((_, i) => xs[i] === mx); return at.filter((c) => c.chosen).length / at.length; };
        const ho = top(sc), hn = top(nb);
        n++; h += hn; if (hn > ho) newOnly += hn - ho; if (ho > hn) oldOnly += ho - hn;
      }
      return { n, h, newOnly, oldOnly };
    };
    const rows: Row[] = [];
    for (const sp of splits) {
      const trainStar = starPE.filter(sp.train), trainSend = sendPE.filter(sp.train);
      const testStar = (x: typeof starTagged[number]) => !sp.train({ at: x.e.at, pc: x.e.pc });
      const testSend = (e: Tagged) => !sp.train({ at: e.at, pc: e.pc });
      const b0 = evalStar(null, testStar), s0 = evalSend(null, testSend);
      P(`\n  ■ ${sp.name}: 学ぶ 🌟 ${trainStar.length}・送った物 ${trainSend.length}／確かめる 🌟 ${b0.n}（今 ${pct(b0.h, b0.n)}）・送った物 ${s0.n}（今の1位 ${pct(s0.h, s0.n)}）`);
      for (const pts of [5, 10]) {
        for (const [fam, re] of FAMILIES) {
          const groups = [...new Set([...trainStar, ...trainSend].flatMap((e) => e.keys))].filter((k) => (re ? re.test(k) : true));
          for (const src of ["🌟＋送った物", "🌟だけ"] as const) {
            const train = src === "🌟だけ" ? trainStar : [...trainStar, ...trainSend];
            const table = learnPatternBonusTable(train, { points: pts }, groups);
            if (!Object.keys(table).length) continue;
            const s = evalStar(table, testStar), d = evalSend(table, testSend);
            rows.push({ split: sp.name, pts, fam, src, table: describePatternBonusTable(table), star: s, send: d });
            P(`    +${pts} ${fam}［${src}］ 🌟 ${pct(s.h, s.n)}（新だけ ${s.newOnly}／旧だけ ${s.oldOnly}）・送った物 ${pct(d.h, d.n)}（新 ${d.newOnly.toFixed(1)}／旧 ${d.oldOnly.toFixed(1)}）｜${describePatternBonusTable(table).join("／")}`);
          }
        }
        const g = learnPatternBonusTable([...trainStar, ...trainSend], { points: pts, globalOnly: true });
        const s = evalStar(g, testStar), d = evalSend(g, testSend);
        rows.push({ split: sp.name, pts, fam: "全員同じ", src: "🌟＋送った物", table: describePatternBonusTable(g), star: s, send: d });
        P(`    +${pts} 全員同じ（比べる案） 🌟 ${pct(s.h, s.n)}（新だけ ${s.newOnly}／旧だけ ${s.oldOnly}）・送った物 ${pct(d.h, d.n)}（新 ${d.newOnly.toFixed(1)}／旧 ${d.oldOnly.toFixed(1)}）｜${describePatternBonusTable(g).join("／")}`);
      }
    }
    // --try=型:二人以上>rent_highest,段:deep>rent_highest … 手で決めた仮説の表を全回・前半/後半で確かめる（全期間を見て作った仮説なので参考・入れる判断は上の分けた当て直しで）
    if (args.try) {
      for (const spec of String(args.try).split(",")) {
        const [k, f] = spec.split(">");
        const table: PatternBonusTable = { [k]: [{ f: f as PatternFeature, points: 10, n: 0, win: 0 }] };
        const midAt = sorted[Math.floor(sorted.length / 2)]?.at ?? "9999";
        const a = evalStar(table, () => true), e1 = evalStar(table, (x) => x.e.at < midAt), e2 = evalStar(table, (x) => x.e.at >= midAt);
        const cA = evalStar(table, (x) => half(x.e.pc) === "A"), cB = evalStar(table, (x) => half(x.e.pc) === "B");
        const d = evalSend(table, () => true);
        P(`  仮説 ${k} → ${PATTERN_FEATURE_JA[f as PatternFeature] ?? f} +10: 🌟 全 ${pct(a.h, a.n)}（新 ${a.newOnly}／旧 ${a.oldOnly}）・前半 新 ${e1.newOnly}／旧 ${e1.oldOnly}・後半 新 ${e2.newOnly}／旧 ${e2.oldOnly}・お客様A 新 ${cA.newOnly}／旧 ${cA.oldOnly}・B 新 ${cB.newOnly}／旧 ${cB.oldOnly}｜送った物 新 ${d.newOnly.toFixed(1)}／旧 ${d.oldOnly.toFixed(1)}`);
      }
    }
    // 全期間で学んだ表（入れる候補の中身）
    const fullTable = learnPatternBonusTable([...starPE, ...sendPE], { points: 10 });
    P(`\n  全期間の回で学んだ表（全部の軸・+10）: ${describePatternBonusTable(fullTable).join("／") || "なし"}`);
    const fullStar = learnPatternBonusTable(starPE, { points: 10 });
    P(`  全期間の🌟だけで学んだ表: ${describePatternBonusTable(fullStar).join("／") || "なし"}`);
    out.experiment = { cut: starCut, rows, fullTable, fullStar };
  }

  if (args.out) { writeFileSync(String(args.out), JSON.stringify(out, null, 1)); P(`\n→ ${args.out}`); }

  // ─── 型ごとの集計（送った物・🌟で共通）─────────────────────────────
  function reportByType(eps: Tagged[], label: string): Row {
    const res: Row = {};
    const groups: Array<[string, (e: Tagged) => boolean]> = [
      ...PATTERN_KEYS.map((k) => [k, (e: Tagged) => e.p.patternKey === k] as [string, (e: Tagged) => boolean]),
      ["家族（2LDK以上）", (e) => e.p.household === "family"], ["二人（1LDK・2DK）", (e) => e.p.household === "pair"],
      ["予算6万未満", (e) => e.p.budget === "low"], ["予算11万以上", (e) => e.p.budget === "high"],
      ["新しさ重視", (e) => e.p.focus.includes("new")], ["広さ重視", (e) => e.p.focus.includes("space")], ["駅近重視", (e) => e.p.focus.includes("station")],
      ["設備重視", (e) => e.p.focus.includes("equip")], ["ペット", (e) => e.p.focus.includes("pet")], ["2階以上", (e) => e.p.focus.includes("floor")],
      ["急ぎ", (e) => e.p.urgency === "urgent"], ["固い（絶対2以上）", (e) => e.p.firmness === "firm"], ["学生", (e) => e.p.student],
      ["持ち込み型", (e) => e.bringsOwn], ["段:新規", (e) => e.stage === "new"], ["段:提案中", (e) => e.stage === "proposing"], ["段:内覧・見積", (e) => e.stage === "deep"],
    ];
    P(`  [${label}] 型ごとの「選んだ方が特徴を持つ率」（50%＝ランダム・他の型との差 z≥2 を ★）`);
    for (const [g, sel] of groups) {
      const xs = eps.filter(sel), others = eps.filter((e) => !sel(e));
      if (xs.length < 15) { P(`    ${g.padEnd(14)} ${xs.length}回（少ないので見ない）`); continue; }
      const cells: Row[] = [];
      for (const f of PATTERN_FEATURES) {
        const ra = xs.map((e) => episodeBitWin(e.cands, f)).filter((v): v is number => v != null);
        const rb = others.map((e) => episodeBitWin(e.cands, f)).filter((v): v is number => v != null);
        if (ra.length < 8) continue;
        const m = ra.reduce((a, v) => a + v, 0) / ra.length, mo = rb.length ? rb.reduce((a, v) => a + v, 0) / rb.length : NaN;
        const z = diffZ(ra, rb);
        cells.push({ f, n: ra.length, win: +m.toFixed(3), others: +mo.toFixed(3), z: +z.toFixed(2) });
      }
      res[g] = { episodes: xs.length, people: new Set(xs.map((e) => e.pc)).size, cells };
      const show = cells.filter((c) => Math.abs(c.z) >= 2 || Math.abs(c.win - 0.5) >= 0.2);
      P(`    ${g.padEnd(14)} ${xs.length}回（${new Set(xs.map((e) => e.pc)).size}人）: ` + (show.length ? show.map((c) => `${PATTERN_FEATURE_JA[c.f as PatternFeature]} ${pct(c.win)}（他 ${pct(c.others)}・${c.n}回${Math.abs(c.z) >= 2 ? "★" : ""}）`).join("・") : "目立つ差なし"));
    }
    return res;
  }
})().catch((e) => { console.error(e); process.exit(1); });

// ─── 特徴の材料（送った物・🌟・刺さった新着で同じ形に）────────────────────
function featInputOfEpisode(f: Record<string, number | null>): PatternFeatureInput {
  return { rentRatio: f.rent_ratio, areaSqm: f.area_sqm, buildingAge: f.building_age, walk: f.walk, zeroZero: f.zero_zero, adMonths: f.ad_months, floor: f.floor, planMatch: f.plan_match, equipmentCount: f.equipment_count, structure: null };
}
function featInputOfStar(f: Row): PatternFeatureInput {
  return { ...featInputOfEpisode(f), structure: f.__structure ?? null };
}
function featInputOfHook(f: Row, facts: Row): PatternFeatureInput {
  return { rentRatio: f.rent_ratio, areaSqm: f.area_sqm, buildingAge: f.building_age, walk: f.walk, zeroZero: f.zero_zero, adMonths: facts?.ad_months ?? null, floor: facts?.floor ?? null, planMatch: null, equipmentCount: null, structure: facts?.structure ?? null };
}
function bundleContext(xs: PatternFeatureInput[]) {
  const nums = (k: keyof PatternFeatureInput) => xs.map((x) => x[k]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const area = nums("areaSqm"), age = nums("buildingAge"), walk = nums("walk"), rent = nums("rentRatio");
  return {
    maxArea: area.length >= 2 && new Set(area).size >= 2 ? Math.max(...area) : null,
    minAge: age.length >= 2 && new Set(age).size >= 2 ? Math.min(...age) : null,
    minWalk: walk.length >= 2 && new Set(walk).size >= 2 ? Math.min(...walk) : null,
    maxRent: rent.length >= 2 && new Set(rent).size >= 2 ? Math.max(...rent) : null,
    minRent: rent.length >= 2 && new Set(rent).size >= 2 ? Math.min(...rent) : null,
  };
}
