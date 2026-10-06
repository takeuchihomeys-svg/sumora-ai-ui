// app/lib/hooked-arrival-learning-server.ts（サーバー専用・画面から import しない）
// 刺さった新着1件（new-arrival-hook）を物件の点の週1回の学習（scoring-learning-server.runScoringLearning）に強い材料として入れる口。
//   読むだけ（LLM なし・費用 0）。学んだ表は「提案」として週の記録（scoring_learning_runs.hook_learning）に残すだけで、判定の点はまだ変えない。
//   採点に効かせるのは evaluateHookBonus が use＝スタッフの選択（🌟・送った物）との一致がどれも下がらず、相対順位が minGain 以上良くなった時だけ
//   （その時も判定への配線は竹内さんの確認の後。2026-10-06 の当て直しでは学べる物が無かった＝scripts/audit-hooked-arrival-learning.ts）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildContext, customerAt, type ConditionHistoryRow } from "./scoring-learning-episodes";
import { YUMA_CONVERSATION_ID } from "./test-conversations";
import { newArrivalHookOf } from "./new-arrival-hook";
import { baseReasonPoints } from "./property-brain";
import type { Episode } from "./scoring-learning";
import {
  fillArrivalFacts, hookFeatsOfFacts, hookCustomerTypeOf, isNewArrivalSnapshot, rentObservationKey, learnHookLeans, hookLeanTable, evaluateHookBonus, pruneHookTable,
  HOOK_LEARN_CONFIG, ARRIVAL_FACT_FIELDS,
  type ArrivalFacts, type HookCustomerType, type HookRecord, type HookFeats, type HookEvalEpisode, type HookLearnConfig, type HookLeanTable,
} from "./hooked-arrival-learning";

type Row = Record<string, any>;
const D = 24 * 3600_000;
const CUST_COLS = "id, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, created_at, floor_area_min, raw_format_text, desired_area, commute_station, commute_minutes";

async function all(build: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>, page = 1000, maxPages = 80): Promise<Row[]> {
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
const groupBy = (xs: Row[], k: string) => { const m = new Map<string, Row[]>(); for (const x of xs) { const v = String(x[k] ?? ""); if (!v) continue; if (!m.has(v)) m.set(v, []); m.get(v)!.push(x); } return m; };

export type HookMaterial = {
  snapshotId: number; conversationId: string; sentAt: string; name: string; room: string | null;
  hooked: boolean; signals: string[]; declined: boolean;
  facts: ArrivalFacts; type: HookCustomerType | null; rentMax: number | null; feats: HookFeats;
};

/** 期間の新着1件の🌟と、刺さったか・物件の事実（埋めた物）・お客様の型（その時点の条件） */
export async function loadHookMaterials(sb: SupabaseClient, opts: { until: string; days: number }): Promise<HookMaterial[]> {
  const until = Date.parse(opts.until);
  const sinceIso = new Date(until - opts.days * D).toISOString();
  const snaps = (await all((a, b) => sb.from("recommendation_snapshots").select("id, conversation_id, property_customer_id, sent_at, star_name, star_room, star_text, star_text_facts, candidate_count, candidates")
    .gte("sent_at", sinceIso).lt("sent_at", new Date(until).toISOString()).order("id").range(a, b) as never, 300)).filter((s) => s.conversation_id !== YUMA_CONVERSATION_ID && isNewArrivalSnapshot(s));
  const pcs = [...new Set(snaps.map((s) => String(s.property_customer_id ?? "")).filter(Boolean))];
  const convs = [...new Set(snaps.map((s) => String(s.conversation_id)))];
  const custs = new Map<string, Row>(); const hist: Row[] = [], sents: Row[] = [], picks: Row[] = [];
  for (const c of chunks(pcs, 80)) {
    const { data, error } = await sb.from("property_customers").select(CUST_COLS).in("id", c);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Row[]) custs.set(r.id, r);
    hist.push(...await all((a, b) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, created_at").in("property_customer_id", c).order("id").range(a, b) as never));
    sents.push(...await all((a, b) => sb.from("sent_properties").select("property_customer_id, property_name, room_no, rent, ad_months, ad_yen, sent_at").in("property_customer_id", c).order("id").range(a, b) as never));
    picks.push(...await all((a, b) => sb.from("property_pickups").select("id, property_customer_id, property_name, room_no, summary_text, terms, equipment").in("property_customer_id", c).order("id").range(a, b) as never));
  }
  // お客様の返事は送った後 48時間・AIX は 14日だけ使う（newArrivalHookOf）→ 期間の最初の送付より前は読まない
  const msgSince = new Date(until - (opts.days + 1) * D).toISOString();
  const msgs: Row[] = [], aix: Row[] = [], imgs: Row[] = [];
  for (const c of chunks(convs, 50)) {
    msgs.push(...await all((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at, referenced_property_id").in("conversation_id", c).eq("sender", "customer").gte("created_at", msgSince).order("id").range(a, b) as never));
    aix.push(...await all((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, generated_text, created_at").in("conversation_id", c).in("aix_type", ["viewing_invite", "meeting_place", "application_push", "estimate_sheet"]).gte("created_at", msgSince).order("id").range(a, b) as never));
    imgs.push(...await all((a, b) => sb.from("sent_image_properties").select("image_url, conversation_id, property_name, room_no, facts").in("conversation_id", c).not("facts", "is", null).order("image_url").range(a, b) as never));
  }
  const ros = await all((a, b) => sb.from("rent_observations").select("property_name, room_no, rent, admin_fee, area_sqm, building_age, walk_minutes, structure, deposit_months, key_money_months, ad_yen, floor_plan, station").order("id").range(a, b) as never);
  const hOf = groupBy(hist, "property_customer_id"), sOf = groupBy(sents, "property_customer_id"), pkOf = groupBy(picks, "property_customer_id");
  const mOf = groupBy(msgs, "conversation_id"), aOf = groupBy(aix, "conversation_id"), iOf = groupBy(imgs, "conversation_id");
  const imgByUrl = new Map(imgs.map((r) => [String(r.image_url), r]));
  const roByKey = new Map<string, Row>(); for (const r of ros) roByKey.set(rentObservationKey(r.property_name, r.room_no), r);

  const out: HookMaterial[] = [];
  for (const s of snaps) {
    const cv = String(s.conversation_id), name = String(s.star_name);
    const h = newArrivalHookOf({ starName: name, sentAt: s.sent_at, messages: (mOf.get(cv) ?? []) as never, aix: (aOf.get(cv) ?? []) as never });
    const raw = ((typeof s.candidates === "string" ? JSON.parse(s.candidates) : s.candidates) ?? []) as Row[];
    const cand = raw.find((x) => x.is_star) ?? raw[0] ?? null;
    const room = (s.star_room ?? cand?.room_no ?? null) as string | null;
    const pc = s.property_customer_id ? String(s.property_customer_id) : "";
    const facts = fillArrivalFacts({
      name, room, sentAt: s.sent_at, starTextFacts: s.star_text_facts as Row, cand,
      imageByUrl: (u) => imgByUrl.get(u), convImages: iOf.get(cv) ?? [], pickups: pkOf.get(pc) ?? [],
      rentObservation: roByKey.get(rentObservationKey(name, room)) ?? null, sends: sOf.get(pc) ?? [],
    });
    let type: HookCustomerType | null = null, rentMax: number | null = null;
    const base = pc ? custs.get(pc) : undefined;
    if (base) {
      const { c } = customerAt(base, (hOf.get(pc) ?? []) as ConditionHistoryRow[], s.sent_at);
      type = hookCustomerTypeOf(c);
      rentMax = buildContext(c, [], [], s.sent_at).profile.rentMax;
    }
    out.push({ snapshotId: Number(s.id), conversationId: cv, sentAt: new Date(s.sent_at).toISOString(), name, room, hooked: h.hooked, signals: h.signals, declined: h.declined, facts, type, rentMax, feats: hookFeatsOfFacts(facts, rentMax) });
  }
  return out;
}

/** 材料の埋まり方（項目 → 埋まった数・刺さった物の中で埋まった数・出どころ） */
export function hookFillSummary(mats: ReadonlyArray<HookMaterial>): Record<string, { filled: number; hookedFilled: number; sources: Record<string, number> }> {
  const out: Record<string, { filled: number; hookedFilled: number; sources: Record<string, number> }> = {};
  for (const k of ARRIVAL_FACT_FIELDS) {
    const has = mats.filter((m) => m.facts[k] != null);
    const sources: Record<string, number> = {};
    for (const m of has) { const v = m.facts._src[k]!; sources[v] = (sources[v] ?? 0) + 1; }
    out[k] = { filled: has.length, hookedFilled: has.filter((m) => m.hooked).length, sources };
  }
  return out;
}

/** scoring-learning の回 → 加点の当て直し用（点は今の札の点・特徴は judgeCandidate の feats・型は loadEpisodes が付けた ctype） */
export function hookEvalEpisodesOf(eps: ReadonlyArray<Episode>, pointsOf: (code: string) => number = baseReasonPoints): HookEvalEpisode[] {
  return eps.map((e) => ({
    id: e.id, at: e.at, source: e.source, type: e.ctype ?? null,
    cands: e.cands.map((c) => ({ chosen: c.chosen, score: 50 + c.codes.reduce((a, k) => a + pointsOf(k), 0), feats: c.feats as HookFeats })),
  }));
}

export type HookLearningReport = {
  ok: boolean; error?: string;
  materials: { snapshots: number; hooked: number; withType: number; fill: ReturnType<typeof hookFillSummary> };
  learned: ReturnType<typeof learnHookLeans>;
  /** 学んだ表（線を越え・新しい半分でも同じ向き）→ 1つずつ確かめて残した表 */
  table: HookLeanTable;
  kept: HookLeanTable;
  dropped: ReturnType<typeof pruneHookTable>["dropped"];
  evaluation: ReturnType<typeof evaluateHookBonus>;
  /** 採点に効かせてよいか（evaluation.use かつ残した表が空でない）。true でも判定への配線は竹内さんの確認の後 */
  proposeUse: boolean;
};

/**
 * 週1回: 新着1件の材料を読み → 型ごとに刺さった物に多い特徴を学び → スタッフが選んだ回（scoring-learning の episodes）に加点を当てて確かめる。
 *   episodes は runScoringLearning が読んだ物を渡す（同じ回で確かめる・読み直さない）
 */
export async function runHookLearning(sb: SupabaseClient, episodes: ReadonlyArray<Episode>, opts: { until: string; days?: number; cfg?: HookLearnConfig } = { until: new Date().toISOString() }): Promise<HookLearningReport> {
  const cfg = opts.cfg ?? HOOK_LEARN_CONFIG;
  const mats = await loadHookMaterials(sb, { until: opts.until, days: opts.days ?? 400 });
  const records: HookRecord[] = mats.filter((m) => m.type).map((m) => ({ at: m.sentAt, hooked: m.hooked, type: m.type!, feats: m.feats }));
  const learned = learnHookLeans(records, cfg);
  const table = hookLeanTable(learned.leans);
  const evs = hookEvalEpisodesOf(episodes);
  const pr = pruneHookTable(evs, table, cfg);
  const evaluation = evaluateHookBonus(evs, pr.table, cfg);
  return {
    ok: true,
    materials: { snapshots: mats.length, hooked: mats.filter((m) => m.hooked).length, withType: records.length, fill: hookFillSummary(mats) },
    learned: { ...learned, cells: learned.cells, skipped: learned.skipped.slice(0, 80) },
    table, kept: pr.table, dropped: pr.dropped, evaluation,
    proposeUse: evaluation.use && Object.keys(pr.table).length > 0,
  };
}
