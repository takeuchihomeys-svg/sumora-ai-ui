// scripts/audit-star-two-axis.ts
// 🌟（一番オススメ）の2軸「お客様に刺さりそう（お客様ごと）」×「ある程度 AD が高い」の当て直し（読むだけ・LLM なし・費用0・DB に書かない）。
// 回の組み方は scripts/audit-star-fit-d.ts と同じ（そちらは触らない・ここは写し＋足し）。
//
// 2026-10-06 竹内さん（原文）:「他に精度上げるために　一番オススメの基準はお客さんが刺さりそうな物件をそれぞれのお客さんにあわせてそして　ある程度ADが高い物件を一番オススメにしている
//   そう考えるとスコアリング基準もっと正確にならないか　原因を徹底的に調査する　設計知見と協力しておこなう」
// 段:
//   A. AD 軸: 🌟の AD は束の中でどこか（一番高い・上位・線の上）／AD 不明の割合と出どころ／不明の扱い（線の下・中立）／補える出どころ（他の回の売上サポの行・送った記録・見積書の前の記録）
//   B. 刺さり軸: お客様本人の要望（条件欄・会話）に何個合うか・前に刺さった物件と似ているか／🌟の見出しの話題が本人の言葉に入っているか
//   C. 2軸の組み合わせ: 線＋合い方（今）／合い方の上位から AD／AD の上位から合い方／順位の足し合わせ／点の足し合わせ・前7割で選び後3割で確かめる
//   D. ずれの残りの内訳
// ■ 正解はスタッフが🌟にした事実（お客様の返信の有無で正誤を決めない）・個人情報は出さない・YUMA は外す・新着1件の🌟は外す（feedback_star_new_arrival_hook）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-star-two-axis.ts [--days=180] [--show=8]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { baseReasonPoints, type SentRowLike, type PatternRowLike } from "../app/lib/property-brain";
import { customerAt, buildContext, episodeFromSnapshot, isCustomerSend, judgeCandidate, type ConditionHistoryRow } from "../app/lib/scoring-learning-episodes";
import { nameKey, bestBuildingMatch, sameBuildingName, toHalf } from "../app/lib/candidate-facts";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";
import { rankStarCandidates, starSituationOf, STAR_RANK_RULE, STAR_SITUATION_RULE, type StarCandidate, type StarSituation, type StarSituationRule } from "../app/lib/recommend-star-rank";
import { adMonthsOfPickup, structureOf, equipmentKeysOf, areaSqmOfPickup, starSituationFromConditions } from "../app/lib/star-rank-pickup";
import { appealTopics, customerWants, TOPIC_LABEL } from "../app/lib/recommendation-gaps";
import { renovationOfText } from "../app/lib/listing-renovation";
import { adHintFromDiscount } from "../app/lib/estimate-ad-hint";
import { parseRentFromSummary } from "../app/lib/property-summary-parse";
import { newArrivalHookOf } from "../app/lib/new-arrival-hook";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "180"), 10);
const SHOW = parseInt(String(args.show ?? "12"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
type Row = Record<string, any>;
const D = 864e5, H = 36e5;
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
const LABEL_KEY: Record<string, string> = {
  エレベーター: "elevator", 宅配ボックス: "delivery_box", オートロック: "autolock", ネット無料: "net_free", 駐車場: "parking", "バス・トイレ別": "bath_toilet",
  独立洗面台: "washbasin", 室内洗濯機置場: "laundry_in", 角部屋: "corner", ペット相談: "pet", 南向き: "south", エアコン: "aircon", システムキッチン: "system_kitchen",
  対面キッチン: "counter_kitchen", 追い焚き: "reheating", 浴室乾燥機: "bath_dryer", 温水洗浄便座: "washlet", ウォークインクローゼット: "walk_in_closet",
  "2口コンロ": "burner2", フローリング: "flooring", 駐輪場: "bike_parking", "24時間ゴミ出し": "garbage24", モニター付インターホン: "monitor_intercom", 最上階: "top_floor",
};
const toKey = (s: string) => LABEL_KEY[s] ?? s;

/** 🌟の本文の見出し＝「〇〇で（の）△△さんにかなりオススメ」の〇〇（1行目の物件名の後〜「オススメ」まで）。無ければ（オススメポイント）の先頭3行 */
export function starHeadline(text: string): string {
  const lines = String(text ?? "").split("\n").slice(1).join("\n");
  const m = lines.match(/^([\s\S]{0,160}?)(?:オススメ|おすすめ)/);
  if (m && !/（オススメポイント）|\(オススメポイント\)/.test(m[1])) return m[1];
  const pts = lines.split("\n").filter((l) => /^\s*[・･]/.test(l)).slice(0, 3).join("\n");
  return pts || lines.slice(0, 120);
}
function moveInUrgency(moveIn: unknown, atIso: string): string {
  const s = toHalf(String(moveIn ?? ""));
  if (!s.trim()) return "unknown";
  if (/即|すぐ|至急|急ぎ|今月|早め|なるべく早|今週|来週/.test(s)) return "urgent";
  const m = s.match(/(\d{1,2})\s*月/);
  if (m) return ((parseInt(m[1], 10) - (new Date(atIso).getMonth() + 1) + 12) % 12) <= 1 ? "urgent" : "later";
  return "unknown";
}
const estMax = (rows: Row[], name: string, room: string) => { let b: number | null = null; for (const x of rows) { if (!sameBuildingName(String(x.property_name ?? ""), name)) continue; if (x.room_no && room && normRoom(x.room_no) !== room) continue; const d = Number(x.discount_yen); if (Number.isFinite(d) && d > 0 && (b == null || d > b)) b = d; } return b; };
const isNewArrivalText = (t: string) => /新着/.test(t.split(String.fromCharCode(10)).slice(1).join(String.fromCharCode(10)).slice(0, 120));
const mentions = (text: string, name: string) => { const k = nameKey(name); return k.length >= 3 && nameKey(text).includes(k.slice(0, Math.min(k.length, 6))); };

type C = { adSrc: string; adExtra: Record<string, number | null>; reno: boolean | null; initialMonths: number | null; estBefore: number | null; estAny: number | null; rentY: number | null; key: string; name: string; room: string; chosen: boolean; codes: string[]; base: number; f: Row; sentAt: number; sameSess: boolean; prevStar: boolean; rejected: boolean; unavailable: boolean; sameBldStar: boolean; est: Row | null };
type Ep = {
  id: number; conv: string; at: string; live: boolean; cands: C[]; sit: StarSituation; wants: Set<string>; condWants: Set<string>; urgency: string;
  starText: string; headline: string; headTopics: string[]; appeal: string[]; newArrival: boolean; estEnclosed: boolean; standalone: boolean; starRepeat: boolean;
  types: string[]; react: { reply72: boolean; mention: boolean; viewing: boolean; apply: boolean; estimateAfter: boolean };
  rentMax: number | null; floorPlan: string;
  msgWants: Set<string>; msgTexts: string[]; hookedPrior: Row[]; firstSent: number; poolC: C[] | null;
};

(async () => {
  const until = Date.now();
  const snapsAll = (await all((a, b) => sb.from("recommendation_snapshots").select("id, conversation_id, property_customer_id, sent_at, star_name, star_room, star_text, star_in_candidates, candidate_count, candidates, source, customer_wants, appeal_topics")
    .gte("sent_at", new Date(until - DAYS * D).toISOString()).order("id").range(a, b) as never, 300)).filter((s) => s.conversation_id !== YUMA_CONVERSATION_ID);
  const snaps = snapsAll.filter((s) => s.property_customer_id && s.candidate_count >= 2 && s.star_in_candidates);
  const naSnaps = snapsAll.filter((s) => s.candidate_count < 2 || isNewArrivalText(String(s.star_text ?? "")));
  const pcs = [...new Set([...snaps, ...naSnaps].filter((s) => s.property_customer_id).map((s) => String(s.property_customer_id)))];
  const convs = [...new Set([...snaps, ...naSnaps].map((s) => String(s.conversation_id)))];
  const custs = new Map<string, Row>(); const hist: Row[] = [], sents: Row[] = [], pats: Row[] = [], picks: Row[] = [];
  for (const c of chunks(pcs, 80)) {
    const { data } = await sb.from("property_customers").select("id, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, created_at, floor_area_min, raw_format_text, desired_area, commute_station, commute_minutes").in("id", c);
    for (const r of (data ?? []) as Row[]) custs.set(r.id, r);
    hist.push(...await all((a, b) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, created_at").in("property_customer_id", c).order("id").range(a, b) as never));
    sents.push(...await all((a, b) => sb.from("sent_properties").select("property_customer_id, conversation_id, property_name, room_no, rent, delivery, source, channel, sent_at, customer_reaction, recruitment_status, ad_months").in("property_customer_id", c).order("id").range(a, b) as never));
    pats.push(...await all((a, b) => sb.from("property_selection_patterns").select("property_customer_id, selling_points, selection_label, created_at").in("property_customer_id", c).order("id").range(a, b) as never));
    picks.push(...await all((a, b) => sb.from("property_pickups").select("id, property_customer_id, created_at, property_name, room_no, reason_codes, summary_text, ad_yen, equipment, terms, pdf_text").in("property_customer_id", c).order("id").range(a, b) as never));
  }
  const msgs: Row[] = [], aix: Row[] = [], ests: Row[] = [];
  for (const c of chunks(convs, 50)) {
    msgs.push(...await all((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at, referenced_property_id").in("conversation_id", c).gte("created_at", new Date(until - (DAYS + 30) * D).toISOString()).order("id").range(a, b) as never));
    aix.push(...await all((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, generated_text, created_at").in("conversation_id", c).in("aix_type", ["viewing_invite", "meeting_place", "application_push", "estimate_sheet"]).order("id").range(a, b) as never));
    ests.push(...await all((a, b) => sb.from("estimate_records").select("conversation_id, property_name, room_no, discount_yen, initial_cost_yen, rent, ad_months, estimated_at, created_at").in("conversation_id", c).order("id").range(a, b) as never));
  }
  // AD の補いの出どころ（A 段）: 他のお客様・他の回の売上サポの行（同じ建物・号室）・送った記録の AD・見積書の AD
  const gPicks = await all((a, b) => sb.from("property_pickups").select("property_customer_id, created_at, property_name, room_no, reason_codes, ad_yen, summary_text").gte("created_at", new Date(until - (DAYS + 60) * D).toISOString()).order("id").range(a, b) as never);
  const gPickByKey = new Map<string, Row[]>(); for (const r of gPicks) { const k = nameKey(r.property_name).slice(0, 4); if (!gPickByKey.has(k)) gPickByKey.set(k, []); gPickByKey.get(k)!.push(r); }
  const gSents = await all((a, b) => sb.from("sent_properties").select("property_customer_id, property_name, room_no, ad_months, sent_at").not("ad_months", "is", null).gte("sent_at", new Date(until - (DAYS + 60) * D).toISOString()).order("id").range(a, b) as never);
  const sameRoom = (a: unknown, b: string) => !a || !b || normRoom(a) === b;
  // 拡張の候補プール（2026-09-02〜・候補の約半分に AD）と相場の表（ad_yen）
  const gPools = await all((a, b) => sb.from("property_candidate_pools").select("property_customer_id, sent_at, candidates").gte("sent_at", new Date(until - (DAYS + 60) * D).toISOString()).order("id").range(a, b) as never, 200);
  const gPoolByKey = new Map<string, Row[]>();
  for (const pl of gPools) { const cs = ((typeof pl.candidates === "string" ? JSON.parse(pl.candidates) : pl.candidates) ?? []) as Row[]; for (const c of cs) { if (c.ad_months == null && !(c.ad_yen && c.rent)) continue; const k = nameKey(c.name).slice(0, 4); if (!gPoolByKey.has(k)) gPoolByKey.set(k, []); gPoolByKey.get(k)!.push({ ...c, __pc: pl.property_customer_id, __at: pl.sent_at }); } }
  const gRo = await all((a, b) => sb.from("rent_observations").select("property_name, room_no, rent, ad_yen").not("ad_yen", "is", null).order("id").range(a, b) as never);
  const gRoByKey = new Map<string, Row[]>(); for (const r of gRo) { const k = nameKey(r.property_name).slice(0, 4); if (!gRoByKey.has(k)) gRoByKey.set(k, []); gRoByKey.get(k)!.push(r); }
  const poolsByPc = new Map<string, Row[]>(); for (const pl of gPools) { const k = String(pl.property_customer_id); if (!poolsByPc.has(k)) poolsByPc.set(k, []); poolsByPc.get(k)!.push(pl); }
  const poolAd = (c: Row) => (c.ad_months != null ? Number(c.ad_months) : Math.round((Number(c.ad_yen) / Number(c.rent)) * 100) / 100);
  /** AD の補い: 出どころごとの月数（無ければ null）。答えの漏れを避けるため🌟の束より前の記録だけ（売上サポの行は🌟の時刻+1分まで＝👑 を決める時に在る） */
  function adExtraOf(name: string, room: string, pc: string, t: number, firstSent: number, convEst: Row[]): Record<string, number | null> {
    const k = nameKey(name).slice(0, 4);
    const pk = (gPickByKey.get(k) ?? []).filter((r) => Date.parse(r.created_at) <= t + 60_000 && sameBuildingName(String(r.property_name ?? ""), name) && sameRoom(r.room_no, room));
    const last = (rs: Row[]) => { let b: number | null = null; for (const r of rs) { const m = adMonthsOfPickup(r); if (m != null) b = m; } return b; };
    const sp = gSents.filter((r) => Date.parse(r.sent_at) < firstSent - 60_000 && sameBuildingName(String(r.property_name ?? ""), name) && sameRoom(r.room_no, room));
    const es = convEst.filter((x) => x.ad_months != null && Date.parse(String(x.estimated_at ?? x.created_at)) < firstSent - 60_000 && sameBuildingName(String(x.property_name ?? ""), name) && sameRoom(x.room_no, room));
    const pl = (gPoolByKey.get(k) ?? []).filter((c) => Date.parse(c.__at) <= t + 60_000 && sameBuildingName(String(c.name ?? ""), name) && sameRoom(c.room_no, room));
    const ro = (gRoByKey.get(k) ?? []).filter((r) => sameBuildingName(String(r.property_name ?? ""), name) && sameRoom(r.room_no, room) && Number(r.rent) > 0);
    return { poolOwn: pl.filter((c) => String(c.__pc) === pc).map(poolAd).pop() ?? null, poolAny: pl.map(poolAd).pop() ?? null, rentObs: ro.length ? Math.round((Number(ro[ro.length - 1].ad_yen) / Number(ro[ro.length - 1].rent)) * 100) / 100 : null,
      pickupOwn: last(pk.filter((r) => String(r.property_customer_id) === pc)), pickupAny: last(pk), sentRec: sp.length ? Number(sp[sp.length - 1].ad_months) : null, estimateBefore: es.length ? Number(es[es.length - 1].ad_months) : null };
  }
  const g = (xs: Row[], k = "property_customer_id") => { const m = new Map<string, Row[]>(); for (const x of xs) { const v = String(x[k]); if (!m.has(v)) m.set(v, []); m.get(v)!.push(x); } return m; };
  const hOf = g(hist), sOf = g(sents), pOf = g(pats), pkOf = g(picks), mOf = g(msgs, "conversation_id"), aOf = g(aix, "conversation_id"), eOf = g(ests, "conversation_id");

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

  // ─── 回を組む（材料は audit-star-rank-situation の段4と同じ埋め方）──────────────
  const measure = { snapsTotal: snapsAll.length, notInCands: snapsAll.filter((s) => s.property_customer_id && s.candidate_count >= 2 && !s.star_in_candidates).length, oneCand: snapsAll.filter((s) => s.candidate_count < 2).length, starNameFar: 0, starNameExact: 0 };
  const eps: Ep[] = [];
  for (const s of snaps) {
    const pc = String(s.property_customer_id); const base = custs.get(pc); if (!base) continue;
    const raw = ((typeof s.candidates === "string" ? JSON.parse(s.candidates) : s.candidates) ?? []) as Row[];
    const t = Date.parse(s.sent_at);
    const firstSent = Math.min(...raw.map((c) => Date.parse(String(c.sent_at ?? ""))).filter(Number.isFinite), t);
    const { c } = customerAt(base, (hOf.get(pc) ?? []) as ConditionHistoryRow[], s.sent_at);
    const before = (sOf.get(pc) ?? []).filter((x) => Date.parse(x.sent_at) < firstSent - 60_000 && isCustomerSend(x)) as SentRowLike[];
    const pt = (pOf.get(pc) ?? []).filter((p) => Date.parse(p.created_at) < t) as PatternRowLike[];
    const ctx = buildContext(c, before, pt, s.sent_at);
    const pkList = (pkOf.get(pc) ?? []).filter((r) => Date.parse(r.created_at) <= t + 60_000 && Date.parse(r.created_at) >= t - 14 * D);
    const fill = (x: Row, k: string, v: unknown) => { if (x[k] == null && v != null && v !== "") x[k] = v; };
    const filled = raw.map((cd0) => {
      const x: Row = { ...cd0, equipment: Array.isArray(cd0.equipment) ? cd0.equipment.map(toKey) : cd0.equipment, __structure: cd0.structure ?? null };
      x.__adSrc = cd0.ad_months != null || cd0.ad_yen != null ? "snap" : "";
      const f = byImage.get(String(cd0.image_url ?? ""));
      if (f) {
        for (const k of ["rent", "admin_fee_yen", "area_sqm", "building_age", "walk_minutes", "floor_plan", "deposit_months", "key_money_months", "station", "floor"]) fill(x, k, f[k]);
        if (x.stations == null && Array.isArray(f.stations)) x.stations = f.stations;
        if (x.ad_months == null && x.ad_yen == null) { fill(x, "ad_months", f.ad_months); fill(x, "ad_yen", f.ad_yen); if (x.ad_months != null || x.ad_yen != null) x.__adSrc = "image"; }
        if (f.status) x.__status = f.status;
      }
      const pk = bestBuildingMatch(String(x.name ?? ""), x.room_no ?? null, pkList, (r: Row) => r.property_name, (r: Row) => r.room_no);
      if (pk) {
        if (x.ad_months == null && x.ad_yen == null) { const m = adMonthsOfPickup(pk); if (m != null) { x.ad_months = m; x.__adSrc = "pickup"; } }
        const st = structureOf(pk.equipment); if (x.__structure == null && st) x.__structure = st;
        const eq = equipmentKeysOf(pk.equipment); if ((!Array.isArray(x.equipment) || !x.equipment.length) && eq) x.equipment = eq;
        fill(x, "building_age", pk.terms?.buildingAge); fill(x, "area_sqm", areaSqmOfPickup(pk));
        fill(x, "deposit_months", pk.terms?.deposit); fill(x, "key_money_months", pk.terms?.keyMoney);
        x.__reno = renovationOfText(pk.pdf_text); if (x.rent == null) { const rr = parseRentFromSummary(pk.summary_text ?? null); if (rr) x.rent = rr; }
      }
      const ro = roByKey.get(`${nameKey(x.name)}#${normRoom(x.room_no)}`);
      if (ro) {
        fill(x, "rent", ro.rent); fill(x, "admin_fee_yen", ro.admin_fee); fill(x, "area_sqm", ro.area_sqm != null ? Number(ro.area_sqm) : null); fill(x, "building_age", ro.building_age);
        fill(x, "walk_minutes", ro.walk_minutes); fill(x, "floor", ro.floor); fill(x, "deposit_months", ro.deposit_months != null ? Number(ro.deposit_months) : null);
        fill(x, "key_money_months", ro.key_money_months != null ? Number(ro.key_money_months) : null); fill(x, "floor_plan", ro.floor_plan);
        if (x.ad_yen == null && x.ad_months == null && ro.ad_yen != null) { x.ad_yen = ro.ad_yen; x.__adSrc = "rent_obs"; }
        if ((!Array.isArray(x.equipment) || !x.equipment.length) && ro.equipment && typeof ro.equipment === "object") x.equipment = Object.entries(ro.equipment as Row).filter(([, v]) => v === true).map(([k]) => k);
        if (x.__structure == null && ro.structure) x.__structure = ro.structure;
      }
      return x;
    });
    let e = null;
    try { e = episodeFromSnapshot({ ...s, candidates: filled }, ctx); } catch { e = null; }
    if (!e) continue;
    const rawOf = (key: string) => filled.find((fc) => key === `${fc.name}${fc.room_no ? ` ${normRoom(fc.room_no)}` : ""}`) ?? filled.find((fc) => key.startsWith(String(fc.name))) ?? {};
    // 物差しの材料
    const priorStars = snapsAll.filter((x) => x.conversation_id === s.conversation_id && Date.parse(x.sent_at) < t - 10 * 60_000 && Date.parse(x.sent_at) > t - 60 * D);
    const custBefore = (mOf.get(String(s.conversation_id)) ?? []).filter((m) => m.sender === "customer" && Date.parse(m.created_at) < t && Date.parse(m.created_at) > t - 7 * D);
    const sentRows = sOf.get(pc) ?? [];
    const starRaw = filled.find((x) => x.is_star) ?? {};
    const starHead = { name: String(s.star_name ?? ""), room: normRoom(s.star_room) };
    if (nameKey(starHead.name) === nameKey(String(starRaw.name ?? ""))) measure.starNameExact++; else if (!sameBuildingName(starHead.name, String(starRaw.name ?? ""))) measure.starNameFar++;
    const convEst = eOf.get(String(s.conversation_id)) ?? [];
    const cands: C[] = e.cands.map((cc) => {
      const r = rawOf(cc.key);
      const name = String(r.name ?? cc.key), room = normRoom(r.room_no);
      const sentAt = Date.parse(String(r.sent_at ?? s.sent_at));
      const prevStar = !cc.chosen && priorStars.some((p) => sameBuildingName(String(p.star_name ?? ""), name) && (!p.star_room || !room || normRoom(p.star_room) === room));
      const rejected = sentRows.some((x) => x.customer_reaction === "rejected" && sameBuildingName(String(x.property_name ?? ""), name) && Date.parse(x.sent_at) < t)
        || custBefore.some((m) => mentions(String(m.text ?? ""), name) && /(微妙|ちょっと|やめ|見送|合わな|ないです|無しで|ナシ|古い|狭い|遠い|高い|NG|いらな|不要)/.test(String(m.text ?? "")));
      const st = String(r.__status ?? "");
      const recr = sentRows.find((x) => sameBuildingName(String(x.property_name ?? ""), name) && x.recruitment_status)?.recruitment_status;
      const unavailable = st === "occupied" || /終了|成約|申込/.test(String(recr ?? ""));
      const est = convEst.find((x) => sameBuildingName(String(x.property_name ?? ""), name) && (!x.room_no || !room || normRoom(x.room_no) === room)) ?? null;
      return {
        key: cc.key, name, room, chosen: cc.chosen, codes: cc.codes, base: 50 + cc.codes.reduce((a, k) => a + baseReasonPoints(k), 0),
        f: { ...cc.feats, __structure: r.__structure ?? null, __status: r.__status ?? null, equipment: r.equipment ?? null, rent: r.rent ?? null, ad_yen: r.ad_yen ?? null },
        sentAt, sameSess: t - sentAt < 2 * H, prevStar, rejected, unavailable, sameBldStar: false, est,
        adSrc: cc.feats.ad_months == null ? "none" : String(r.__adSrc ?? "") || "snap",
        adExtra: adExtraOf(name, room, pc, t, firstSent, convEst),
        reno: renovationOfText(name) === true ? true : ((r.__reno ?? null) as boolean | null),
        initialMonths: r.deposit_months != null && r.key_money_months != null ? Number(r.deposit_months) + Number(r.key_money_months) : null,
        rentY: Number(r.rent ?? 0) || null,
        estBefore: estMax(convEst.filter((x) => Date.parse(String(x.estimated_at ?? x.created_at)) < firstSent - 60_000), name, room),
        estAny: estMax(convEst, name, room),
      };
    });
    const star = cands.find((x) => x.chosen)!;
    for (const x of cands) x.sameBldStar = !x.chosen && nameKey(x.name) === nameKey(star.name);
    const wantsAll = new Set<string>(((s.customer_wants ?? []) as Row[]).map((w) => String(w.key)));
    const condWants = new Set<string>(customerWants({ conditions: c as never }).map((w) => String(w.key)));
    const urgency = moveInUrgency(c.move_in_time, s.sent_at);
    const sit = starSituationFromConditions(c as never) ?? starSituationOf({});
    const starText = String(s.star_text ?? "");
    const headline = starHeadline(starText);
    // 反応（正誤には使わない）
    const ms = mOf.get(String(s.conversation_id)) ?? [];
    const cust72 = ms.filter((m) => m.sender === "customer" && Date.parse(m.created_at) > t && Date.parse(m.created_at) <= t + 72 * H);
    const ax = (aOf.get(String(s.conversation_id)) ?? []).filter((a) => Date.parse(a.created_at) > t && Date.parse(a.created_at) <= t + 14 * D);
    const react = {
      reply72: cust72.length > 0,
      mention: cust72.some((m) => mentions(String(m.text ?? ""), star.name) || m.referenced_property_id),
      viewing: ax.some((a) => /viewing_invite|meeting_place/.test(a.aix_type) && mentions(String(a.generated_text ?? ""), star.name)),
      apply: ax.some((a) => a.aix_type === "application_push" && mentions(String(a.generated_text ?? ""), star.name)),
      estimateAfter: ax.some((a) => a.aix_type === "estimate_sheet" && mentions(String(a.generated_text ?? ""), star.name)),
    };
    const rentMax = Number(c.rent_max ?? c.max_rent ?? 0) || null;
    const fp = toHalf(String(c.floor_plan ?? c.layout ?? ""));
    // お客様の型（条件欄から・実データで作る）
    const types: string[] = [];
    const wantsU = new Set([...condWants, ...wantsAll]);
    if (wantsU.has("low_initial") || wantsU.has("zero_deposit") || Number(c.initial_cost_limit ?? 0) > 0) types.push("初期費用重視");
    if (wantsU.has("spacious") || Number(c.floor_area_min ?? 0) > 0) types.push("広さ重視");
    if (wantsU.has("new_build") || Number(c.building_age ?? 0) > 0) types.push("築浅重視");
    if (wantsU.has("station_near") || wantsU.has("commute") || Number(c.walk_minutes ?? 0) > 0 || c.commute_station) types.push("駅・通勤重視");
    if (c.pet || wantsU.has("pet")) types.push("ペット");
    if (/[2-4]\s*(?:S?L?DK|K)|二人|2人|カップル|同棲|夫婦|家族/.test(fp + toHalf(String(c.preferences ?? "") + String(c.other_requests ?? "")))) types.push("二人以上・広い間取り"); else types.push("一人暮らし");
    // 型の言い方の違い（section 10 で比べる）
    {
      const ns = [...fp.matchAll(/([1-5])\s*(?:S?L?DK|K|R)/g)].map((m) => Number(m[1]));
      const minRooms = ns.length ? Math.min(...ns) : null;
      const txt = toHalf(String(c.preferences ?? "") + String(c.other_requests ?? "") + String(c.additional_conditions ?? "") + String(c.raw_format_text ?? ""));
      const twoText = /二人|2人|ふたり|カップル|同棲|夫婦|家族|子供|子ども|お子/.test(txt);
      if (minRooms != null && minRooms >= 2) types.push("HH:最小2部屋以上");
      if ((minRooms != null && minRooms >= 2) || twoText) types.push("HH:2部屋以上か二人の文");
      if (twoText) types.push("HH:二人の文だけ");
      if (/LDK|DK/.test(fp) && !/1K|1R|ワンルーム/.test(fp)) types.push("HH:DK以上（1LDK含む）");
      if (customerWants({ conditions: c as never }).some((w) => w.key === "layout")) types.push("HH:間取りの話題");
    }
    if (urgency === "urgent") types.push("入居急ぎ");
    if (wantsU.has("screening")) types.push("審査が不安");
    if (["autolock", "security", "floor2"].some((k) => wantsU.has(k))) types.push("防犯・2階以上");
    if (["bath_toilet", "washbasin", "laundry_in", "bath_dryer", "reheating", "delivery_box", "internet"].some((k) => wantsU.has(k))) types.push("設備の指定あり");
    if (rentMax) types.push(rentMax < 70000 ? "予算7万未満" : rentMax < 100000 ? "予算7〜10万" : "予算10万以上");
    types.push(priorStars.length ? "2回目以降の🌟" : "最初の🌟");
    const convMsgs = mOf.get(String(s.conversation_id)) ?? [];
    const msgTexts = convMsgs.filter((m) => m.sender === "customer" && Date.parse(m.created_at) < firstSent && Date.parse(m.created_at) > firstSent - 60 * D).map((m) => String(m.text ?? ""));
    const msgWants = new Set<string>(customerWants({ messages: msgTexts }).map((w) => String(w.key)));
    const hookedPrior = priorStars.filter((p) => newArrivalHookOf({ starName: String(p.star_name ?? ""), sentAt: p.sent_at, messages: convMsgs.filter((m) => Date.parse(m.created_at) < firstSent) as never, aix: (aOf.get(String(s.conversation_id)) ?? []).filter((a) => Date.parse(a.created_at) < firstSent) as never }).hooked);
    // 送る前の束（拡張の候補プール・🌟の前72時間で🌟が入っている一番新しい回）＝👑 を決める時の束に近い
    let poolC: C[] | null = null;
    for (const pl of (poolsByPc.get(pc) ?? []).filter((x) => Date.parse(x.sent_at) <= t + 60_000 && Date.parse(x.sent_at) >= t - 72 * H).reverse()) {
      const raw = ((typeof pl.candidates === "string" ? JSON.parse(pl.candidates) : pl.candidates) ?? []) as Row[];
      const si = raw.findIndex((x) => sameBuildingName(String(x.name ?? ""), starHead.name) && (!starHead.room || !x.room_no || normRoom(x.room_no) === starHead.room));
      if (si < 0) continue;
      const seen = new Set<string>(); poolC = [];
      raw.forEach((x0, i) => {
        const k = `${nameKey(x0.name)}#${normRoom(x0.room_no)}`; if (!x0.name || seen.has(k)) return; seen.add(k);
        const x: Row = { ...x0, equipment: Array.isArray(x0.equipment) ? x0.equipment.map(toKey) : x0.equipment };
        const ro = roByKey.get(`${nameKey(x.name)}#${normRoom(x.room_no)}`);
        if (ro) { fill(x, "area_sqm", ro.area_sqm != null ? Number(ro.area_sqm) : null); fill(x, "building_age", ro.building_age); fill(x, "walk_minutes", ro.walk_minutes); fill(x, "floor", ro.floor); fill(x, "deposit_months", ro.deposit_months != null ? Number(ro.deposit_months) : null); fill(x, "key_money_months", ro.key_money_months != null ? Number(ro.key_money_months) : null); if (x.__structure == null && ro.structure) x.__structure = ro.structure; if ((!Array.isArray(x.equipment) || !x.equipment.length) && ro.equipment && typeof ro.equipment === "object") x.equipment = Object.entries(ro.equipment as Row).filter(([, v]) => v === true).map(([kk]) => kk); }
        const jr = judgeCandidate(x as never, i, ctx);
        const nm = String(x.name), rm = normRoom(x.room_no);
        poolC!.push({ key: `${nm}${rm ? ` ${rm}` : ""}#${i}`, name: nm, room: rm, chosen: i === si, codes: jr.codes, base: 50 + jr.codes.reduce((a, kk) => a + baseReasonPoints(kk), 0),
          f: { ...jr.feats, __structure: x.__structure ?? x.structure ?? null, equipment: x.equipment ?? null, rent: x.rent ?? null, ad_yen: x.ad_yen ?? null },
          sentAt: t, sameSess: true, prevStar: false, rejected: false, unavailable: false, sameBldStar: false, est: null,
          adSrc: jr.feats.ad_months == null ? "none" : "pool", adExtra: adExtraOf(nm, rm, pc, t, firstSent, convEst),
          reno: renovationOfText(nm) === true ? true : null, initialMonths: x.deposit_months != null && x.key_money_months != null ? Number(x.deposit_months) + Number(x.key_money_months) : null,
          rentY: Number(x.rent ?? 0) || null, estBefore: null, estAny: null });
      });
      break;
    }
    eps.push({
      msgWants, msgTexts, hookedPrior, firstSent, poolC,
      id: Number(s.id), conv: String(s.conversation_id).slice(0, 8), at: e.at, live: s.source === "live", cands, sit, wants: wantsAll, condWants, urgency,
      starText, headline, headTopics: appealTopics("x\n" + headline), appeal: (s.appeal_topics ?? []) as string[],
      newArrival: /新着/.test(starText.split("\n").slice(1).join("\n").slice(0, 120)),
      estEnclosed: /御見積書|お見積書|見積書(?:を)?(?:同封|お送り|添付)/.test(starText),
      standalone: !cands.some((x) => !x.chosen && x.sameSess), starRepeat: priorStars.length > 0, types, react, rentMax, floorPlan: fp,
    });
  }
  eps.sort((a, b) => a.at.localeCompare(b.at));
  const P = (...x: unknown[]) => console.log(...x);

  // ─── 共通: 物差し（新着1件の🌟は外す）・束の直し（fit-d と同じ）──────────────────
  const M = eps.filter((e) => !(e.standalone && e.newArrival));
  const cut = Math.floor(M.length * 0.7); const train = M.slice(0, cut), test = M.slice(cut), liveM = M.filter((e) => e.live);
  const fixCands = (e: Ep, lv: number): C[] => {
    if (lv < 0) return e.poolC ?? [];
    let cs = e.cands;
    if (lv >= 1) cs = cs.filter((c) => c.chosen || !c.prevStar);
    if (lv >= 2) cs = cs.filter((c) => c.chosen || !c.unavailable);
    if (lv >= 3) cs = cs.filter((c) => c.chosen || !c.rejected);
    if (lv >= 4 && !e.standalone) cs = cs.filter((c) => c.chosen || c.sameSess);
    if (lv >= 5) { const seen = new Set<string>(); cs = cs.filter((c) => { if (c.chosen) return true; const k = nameKey(c.name); if (c.sameBldStar) return false; if (seen.has(k)) return false; seen.add(k); return true; }); }
    return cs;
  };
  type AdMode = "base" | "plus";
  const adOf = (c: C, mode: AdMode): number | null => {
    const a = (c.f.ad_months ?? null) as number | null;
    if (a != null || mode === "base") return a;
    const x = c.adExtra; return x.pickupOwn ?? x.poolOwn ?? x.pickupAny ?? x.poolAny ?? x.sentRec ?? x.rentObs ?? x.estimateBefore ?? null;
  };
  const toStar = (c: C, mode: AdMode, extraScore = 0): StarCandidate => ({
    key: c.key, codes: c.codes, score: c.base + extraScore, pointsOf: baseReasonPoints, areaSqm: c.f.area_sqm, buildingAge: c.f.building_age, structure: c.f.__structure,
    equipmentCount: c.f.equipment_count, equipWantHits: c.f.equip_want_hits, adMonths: adOf(c, mode),
    zeroZero: c.f.zero_zero == null ? null : c.f.zero_zero === 1, walkMinutes: c.f.walk, vacancy: c.f.__status === "open" ? "open" : c.f.__status === "move_out_planned" || c.f.__status === "under_construction" ? "later" : null,
    equipmentKeys: Array.isArray(c.f.equipment) ? c.f.equipment : null, floor: c.f.floor, renovated: c.reno, initialMonths: c.initialMonths,
  });
  const LV = Number(args.lv ?? 5);
  const AM: AdMode = args.ad === "plus" ? "plus" : "base";
  const fmt = (r: { n: number; h: number }) => `${pct(r.h, r.n)}(${Math.round(r.h)}/${r.n})`;
  const randRate = (xs: Ep[], lv = LV) => { let n = 0, s = 0; for (const e of xs) { const cs = fixCands(e, lv); if (cs.length < 2) continue; n++; s += 1 / cs.length; } return { n, h: s }; };

  // ─── 刺さり（B 段）: お客様本人の要望（条件欄・会話）と物件の事実 ──────────────────
  const EQ_TOPIC: Record<string, string> = { bath_toilet: "bath_toilet", washbasin: "washbasin", laundry_in: "laundry_in", autolock: "autolock", delivery_box: "delivery_box", bath_dryer: "bath_dryer", reheating: "reheating", net_free: "internet", corner: "corner", south: "sunny", parking: "parking", walk_in_closet: "storage", monitor_intercom: "security", system_kitchen: "kitchen", counter_kitchen: "kitchen", burner2: "kitchen", pet: "pet" };
  /** 候補の事実 → 話題ごとの yes/no（値が無い話題は入れない＝分からない） */
  const factMap = (c: C, cs: C[]): Map<string, boolean> => {
    const m = new Map<string, boolean>(); const f = c.f;
    if (f.zero_zero != null) { m.set("zero_deposit", f.zero_zero === 1); m.set("low_initial", f.zero_zero === 1); }
    if (f.within_walk != null) m.set("station_near", f.within_walk === 1); else if (f.walk != null) m.set("station_near", f.walk <= 7);
    if (f.within_age != null) m.set("new_build", f.within_age === 1); else if (f.building_age != null) m.set("new_build", f.building_age <= 10);
    const areas = cs.map((x) => x.f.area_sqm).filter((v): v is number => v != null).sort((a, b) => a - b);
    if (f.area_sqm != null && areas.length >= 2) m.set("spacious", f.area_sqm >= areas[Math.floor(areas.length / 2)]);
    if (f.floor != null) m.set("floor2", f.floor >= 2);
    if (f.within_rent != null) m.set("rent", f.within_rent === 1);
    if (f.plan_match != null) m.set("layout", f.plan_match === 2);
    const st = String(f.__structure ?? ""); if (st) m.set("quiet", /^(RC|SRC)$/.test(st));
    if (Array.isArray(f.equipment) && f.equipment.length) { for (const k of f.equipment as string[]) { const tp = EQ_TOPIC[k]; if (tp) m.set(tp, true); } }
    if (c.reno === true) m.set("new_build", true);
    return m;
  };
  type WantSrc = "cond" | "msg" | "both";
  const wantsOf = (e: Ep, src: WantSrc) => src === "cond" ? e.condWants : src === "msg" ? e.msgWants : new Set([...e.condWants, ...e.msgWants]);
  const wantScore = (c: C, cs: C[], W: Set<string>) => { const m = factMap(c, cs); let s = 0; for (const k of W) { const v = m.get(k); if (v === true) s++; else if (v === false) s--; } return s; };
  /** 前に刺さった物件（同じ会話の前の🌟で、お客様が反応した物）との近さ */
  const hookedFacts = (e: Ep): Row[] => e.hookedPrior.map((p) => { const raw = ((typeof p.candidates === "string" ? JSON.parse(p.candidates) : p.candidates) ?? []) as Row[]; return raw.find((x) => x.is_star) ?? null; }).filter((x): x is Row => !!x);
  const simTo = (c: C, h: Row) => {
    let s = 0;
    if (c.f.area_sqm != null && h.area_sqm != null && Math.abs(c.f.area_sqm - h.area_sqm) <= 0.15 * h.area_sqm) s++;
    if (c.f.building_age != null && h.building_age != null && Math.abs(c.f.building_age - h.building_age) <= 8) s++;
    if (c.rentY && h.rent && Math.abs(c.rentY - h.rent) <= 0.08 * h.rent) s++;
    if (c.f.walk != null && h.walk_minutes != null && Math.abs(c.f.walk - h.walk_minutes) <= 3) s++;
    return s;
  };

  // ─── 並べ方の案（C 段）───────────────────────────────────────────────
  type Variant = { name: string; pick: (e: Ep, cs: C[]) => string | null };
  const curPick = (mode: AdMode, rule: Partial<typeof STAR_RANK_RULE> = {}, unknownAs: number | "median" | null = null, extra?: (e: Ep, cs: C[]) => (c: C) => number, sitOf?: (e: Ep) => StarSituation, zeroAdLine: number | null = null) => (e: Ep, cs: C[]) => {
    const ex = extra ? extra(e, cs) : null;
    const sc = cs.map((c) => toStar(c, mode, ex ? ex(c) : 0));
    if (zeroAdLine != null && e.sit.zero) for (const s2 of sc) if (s2.zeroZero === false && (s2.adMonths ?? 0) >= zeroAdLine) s2.zeroZero = true;
    if (unknownAs != null) { const known = sc.map((s) => s.adMonths).filter((v): v is number => v != null).sort((a, b) => a - b); const u = unknownAs === "median" ? (known.length ? known[Math.floor(known.length / 2)] : null) : unknownAs; for (const s of sc) if (s.adMonths == null) s.adMonths = u; }
    return rankStarCandidates(sc, { ...STAR_RANK_RULE, ...rule }, sitOf ? sitOf(e) : e.sit, STAR_SITUATION_RULE)[0]?.key ?? null;
  };
  /** 合い方（AD の家族の点を外した fit）と AD を1つの物差しで */
  const pieces = (e: Ep, cs: C[], mode: AdMode) => {
    const sc = cs.map((c) => toStar(c, mode));
    const ranked = rankStarCandidates(sc, STAR_RANK_RULE, e.sit, STAR_SITUATION_RULE);
    const fit = new Map(ranked.map((r) => [r.key, r.fit]));
    return sc.map((s) => ({ key: s.key, fit: fit.get(s.key)!, ad: s.adMonths ?? null, never: s.adMonths != null && s.adMonths < 1 }));
  };
  const pctRank = (vals: Array<number | null>, v: number | null) => { const xs = vals.filter((x): x is number => x != null); if (v == null || xs.length < 2) return 0.5; return xs.filter((x) => x < v).length / (xs.length - 1) + 0.5 * (xs.filter((x) => x === v).length - 1) / (xs.length - 1); };
  const relLine = (mode: AdMode, drop: number) => (e: Ep, cs: C[]) => { const ads = cs.map((c) => adOf(c, mode)).filter((v): v is number => v != null); if (!ads.length) return curPick(mode)(e, cs); return curPick(mode, { adLine: Math.max(1, Math.max(...ads) - drop) })(e, cs); };
  const fitThenAd = (mode: AdMode, m: number) => (e: Ep, cs: C[]) => { const ps = pieces(e, cs, mode); const pool0 = ps.filter((p) => !p.never); const pool = pool0.length ? pool0 : ps; const mx = Math.max(...pool.map((p) => p.fit)); const near = pool.filter((p) => p.fit >= mx - m); near.sort((a, b) => (b.ad ?? -1) - (a.ad ?? -1) || b.fit - a.fit); return near[0]?.key ?? null; };
  const adThenFit = (mode: AdMode, m: number) => (e: Ep, cs: C[]) => { const ps = pieces(e, cs, mode); const known = ps.filter((p) => p.ad != null); if (!known.length) return [...ps].sort((a, b) => b.fit - a.fit)[0]?.key ?? null; const mx = Math.max(...known.map((p) => p.ad!)); const near = known.filter((p) => p.ad! >= mx - m); near.sort((a, b) => b.fit - a.fit); return near[0]?.key ?? null; };
  const borda = (mode: AdMode, a: number) => (e: Ep, cs: C[]) => { const ps = pieces(e, cs, mode); const fs = ps.map((p) => p.fit), as = ps.map((p) => p.ad); return [...ps].map((p) => ({ k: p.key, s: a * pctRank(fs, p.fit) + (1 - a) * pctRank(as, p.ad) - (p.never ? 1 : 0) })).sort((x, y) => y.s - x.s)[0]?.k ?? null; };
  const linear = (mode: AdMode, w: number, u: number) => (e: Ep, cs: C[]) => { const ps = pieces(e, cs, mode); return [...ps].map((p) => ({ k: p.key, s: p.fit + w * Math.min(p.ad ?? u, 3) - (p.never ? 100 : 0) })).sort((x, y) => y.s - x.s)[0]?.k ?? null; };
  const sitBoth = (e: Ep) => starSituationOf({ wantTopics: [...e.condWants, ...e.msgWants], household: e.sit.household });
  const wantExtra = (src: WantSrc, k: number) => (e: Ep, cs: C[]) => { const W = wantsOf(e, src); const sc = cs.map((c) => wantScore(c, cs, W)); const mx = Math.max(...sc); const split = new Set(sc).size > 1; return (c: C) => (split && wantScore(c, cs, W) === mx ? k : 0); };
  const hookExtra = (k: number) => (e: Ep, cs: C[]) => { const hs = hookedFacts(e); if (!hs.length) return () => 0; const sim = (c: C) => Math.max(...hs.map((h) => simTo(c, h))); const vs = cs.map(sim); const mx = Math.max(...vs); const split = new Set(vs).size > 1; return (c: C) => (split && mx >= 2 && sim(c) === mx ? k : 0); };

  const hitOf = (v: Variant, e: Ep, lv = LV): boolean | null => { const cs = fixCands(e, lv); if (cs.length < 2) return null; const k = v.pick(e, cs); return k == null ? null : !!cs.find((c) => c.key === k)?.chosen; };
  const rateOf = (v: Variant, xs: Ep[], lv = LV) => { let n = 0, h = 0; for (const e of xs) { const r = hitOf(v, e, lv); if (r == null) continue; n++; if (r) h++; } return { n, h }; };
  const CUR: Variant = { name: `今（06d・AD=${AM}）`, pick: curPick(AM) };
  const row = (v: Variant, lv = LV) => { let on = 0, oo = 0; for (const e of M) { const a = hitOf(CUR, e, lv), b = hitOf(v, e, lv); if (a == null || b == null) continue; if (b && !a) on++; if (a && !b) oo++; } return `${v.name.padEnd(34)} ${fmt(rateOf(v, train, lv))} ／ ${fmt(rateOf(v, test, lv))} ／ ${fmt(rateOf(v, liveM, lv))} ／ ${fmt(rateOf(v, M, lv))} ・ ${on}／${oo}`; };

  P(`=== 0. 物差し: 測れる回 ${eps.length}・新着1件を外して ${M.length}（前7割 ${train.length}・後3割 ${test.length}・live ${liveM.length}）・束 lv${LV} ===`);
  P(`  ランダム: ${fmt(randRate(train))} ／ ${fmt(randRate(test))} ／ ${fmt(randRate(liveM))} ／ ${fmt(randRate(M))}`);
  P(`  ${row(CUR)}`);

  // ─── A. AD 軸 ─────────────────────────────────────────────────────
  P(`\n=== A1. AD の出どころ（束 lv${LV} の候補）===`);
  const allC = M.flatMap((e) => fixCands(e, LV).map((c) => ({ e, c })));
  const srcCount = (xs: typeof allC) => { const o: Record<string, number> = {}; for (const x of xs) o[x.c.adSrc] = (o[x.c.adSrc] ?? 0) + 1; return Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}(${pct(v, xs.length)})`).join("・"); };
  P(`  🌟 ${allC.filter((x) => x.c.chosen).length}: ${srcCount(allC.filter((x) => x.c.chosen))}`);
  P(`  他 ${allC.filter((x) => !x.c.chosen).length}: ${srcCount(allC.filter((x) => !x.c.chosen))}`);
  const unk = allC.filter((x) => x.c.f.ad_months == null);
  const ex: Record<string, number> = {}; for (const x of unk) for (const [k, v] of Object.entries(x.c.adExtra)) if (v != null) ex[k] = (ex[k] ?? 0) + 1;
  P(`  AD 不明 ${unk.length}/${allC.length}（${pct(unk.length, allC.length)}）・補える: ${JSON.stringify(ex)}・どれかで補える ${unk.filter((x) => adOf(x.c, "plus") != null).length}（🌟 ${unk.filter((x) => x.c.chosen && adOf(x.c, "plus") != null).length}/${unk.filter((x) => x.c.chosen).length}）`);
  for (const k of ["pickupOwn", "poolOwn", "pickupAny", "poolAny", "sentRec", "rentObs", "estimateBefore"]) {
    const kn = allC.filter((x) => x.c.f.ad_months != null && x.c.adExtra[k] != null);
    const same = kn.filter((x) => Math.abs(Number(x.c.f.ad_months) - Number(x.c.adExtra[k])) < 0.26).length;
    const lineSame = kn.filter((x) => (Number(x.c.f.ad_months) >= 1.5) === (Number(x.c.adExtra[k]) >= 1.5)).length;
    P(`  補いの確かさ ${k}: AD が分かる候補で値が近い ${pct(same, kn.length)}・1.5の線の側が同じ ${pct(lineSame, kn.length)}（${kn.length}件）`);
  }
  for (const x of unk.filter((x) => x.c.chosen).slice(-Number(SHOW))) P(`   🌟 AD 不明 ${x.e.at.slice(0, 10)} ${x.c.key}`);
  // 時期で分ける（売上サポの行が出来る前後）
  {
    const byMonth: Record<string, [number, number]> = {};
    for (const x of allC) { const mth = x.e.at.slice(0, 7); byMonth[mth] ??= [0, 0]; byMonth[mth][0]++; if (x.c.f.ad_months == null) byMonth[mth][1]++; }
    P(`  月ごとの AD 不明: ` + Object.entries(byMonth).sort().map(([k, [n, u]]) => `${k} ${pct(u, n)}(${n})`).join("・"));
  }
  for (const mode of ["base", "plus"] as AdMode[]) /*keep*/ {
    P(`\n=== A2. 🌟の AD は束の中でどこか（AD=${mode === "base" ? "今の材料" : "補いあり"}）===`);
    let nUnkStar = 0, nEp = 0, nKnownSplit = 0, isMax = 0, randMax = 0, pctSum = 0; const lineHit: Record<string, [number, number, number]> = {};
    const posHist: Record<string, number> = {};
    for (const e of M) {
      const cs = fixCands(e, LV); if (cs.length < 2) continue; nEp++;
      const st = cs.find((c) => c.chosen)!; const sa = adOf(st, mode);
      if (sa == null) { nUnkStar++; continue; }
      const ks = cs.map((c) => adOf(c, mode)).filter((v): v is number => v != null);
      for (const L of [1, 1.5, 2, 2.5]) { lineHit[L] ??= [0, 0, 0]; lineHit[L][0]++; if (sa >= L) lineHit[L][1]++; lineHit[L][2] += ks.filter((v) => v >= L).length / ks.length; }
      if (ks.length < 2 || new Set(ks).size < 2) continue;
      nKnownSplit++; const mx = Math.max(...ks);
      if (sa === mx) isMax++; randMax += ks.filter((v) => v === mx).length / ks.length;
      const pr = pctRank(ks, sa); pctSum += pr;
      const b = sa === mx ? "一番" : pr >= 0.5 ? "上半分" : "下半分"; posHist[b] = (posHist[b] ?? 0) + 1;
    }
    P(`  回 ${nEp}・🌟の AD 不明 ${nUnkStar}（${pct(nUnkStar, nEp)}）・AD が割れて🌟も分かる回 ${nKnownSplit}`);
    P(`  🌟が束の一番の AD ${pct(isMax, nKnownSplit)}（ランダム ${pct(randMax, nKnownSplit)}）・🌟の AD の順位（0=一番低い 1=一番高い）平均 ${(pctSum / Math.max(1, nKnownSplit)).toFixed(2)}（ランダム 0.50）・${JSON.stringify(posHist)}`);
    for (const [L, [n, h, r]] of Object.entries(lineHit)) P(`  🌟が AD${L}以上 ${pct(h, n)}（束の分かる候補の平均 ${pct(r, n)}）`);
  }
  {
    let miss = 0, unkStarLineTop = 0, unkStarFitBetter = 0;
    for (const e of M) {
      const cs = fixCands(e, LV); if (cs.length < 2) continue; const k = CUR.pick(e, cs); const top = cs.find((c) => c.key === k)!; if (top.chosen) continue; miss++;
      const st = cs.find((c) => c.chosen)!;
      if (adOf(st, AM) == null && (adOf(top, AM) ?? 0) >= 1.5) { unkStarLineTop++; const r = rankStarCandidates(cs.map((c) => toStar(c, AM)), STAR_RANK_RULE, e.sit, STAR_SITUATION_RULE); const fs = r.find((x) => x.key === st.key)!.fit, ft = r.find((x) => x.key === top.key)!.fit; if (fs > ft) unkStarFitBetter++; }
    }
    P(`\n=== A3. AD 不明が段を壊すか: ずれ ${miss} のうち🌟が AD 不明・1位が線の上 ${unkStarLineTop}（うち🌟の方が合い方が上 ${unkStarFitBetter}）===`);
  }

  // ─── B. 刺さり軸 ─────────────────────────────────────────────────
  P(`\n=== B0. お客様本人の要望の出どころ（${M.length}回）===`);
  P(`  条件欄に要望 ${pct(M.filter((e) => e.condWants.size).length, M.length)}・会話（🌟の前60日の本人の発言）に要望 ${pct(M.filter((e) => e.msgWants.size).length, M.length)}・会話だけの話題がある ${pct(M.filter((e) => [...e.msgWants].some((k) => !e.condWants.has(k))).length, M.length)}・前に刺さった🌟あり ${pct(M.filter((e) => hookedFacts(e).length).length, M.length)}`);
  P(`  発言の数の中央 ${(() => { const v = M.map((e) => e.msgTexts.length).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; })()}`);
  {
    const tot: Record<string, [number, number, number, number]> = {};
    const base: Record<string, number> = {}; for (const e of M) for (const k of new Set([...e.condWants, ...e.msgWants])) base[k] = (base[k] ?? 0) + 1;
    let nH = 0, inCond = 0, inMsg = 0, inAny = 0, expAny = 0;
    for (const e of M) {
      const H = [...new Set(e.headTopics)].filter((k) => !["move_in", "rent"].includes(k)); if (!H.length) continue;
      for (const k of H) { nH++; const c = e.condWants.has(k), m = e.msgWants.has(k); if (c) inCond++; if (m) inMsg++; if (c || m) inAny++; expAny += (base[k] ?? 0) / M.length; tot[k] ??= [0, 0, 0, 0]; tot[k][0]++; if (c || m) tot[k][1]++; if (m && !c) tot[k][2]++; tot[k][3] += (base[k] ?? 0) / M.length; }
    }
    P(`\n=== B1. 🌟の見出しの話題（スタッフが言った理由）が本人の言葉にあるか: 話題 ${nH}・条件欄 ${pct(inCond, nH)}・会話 ${pct(inMsg, nH)}・どちらか ${pct(inAny, nH)}（その話題を言うお客様の割合の平均＝偶然 ${pct(expAny, nH)}）===`);
    for (const [k, [n, a, m, ex2]] of Object.entries(tot).sort((x, y) => y[1][0] - x[1][0]).slice(0, 12)) P(`  ${TOPIC_LABEL[k as keyof typeof TOPIC_LABEL] ?? k} ${n}回: 本人の言葉にある ${pct(a, n)}（会話だけ ${m}）・偶然 ${pct(ex2, n)}`);
  }
  P(`\n=== B2. 本人の要望（条件欄・会話・両方）に合う数（合う−合わない）が束の一番か ===`);
  for (const src of ["cond", "msg", "both"] as WantSrc[]) {
    let n = 0, top = 0, rnd = 0, nWithW = 0;
    for (const e of M) {
      const cs = fixCands(e, LV); if (cs.length < 2) continue; const W = wantsOf(e, src); if (!W.size) continue; nWithW++;
      const sc = cs.map((c) => wantScore(c, cs, W)); if (new Set(sc).size < 2) continue; n++;
      const mx = Math.max(...sc); const st = cs.findIndex((c) => c.chosen); if (sc[st] === mx) top++; rnd += sc.filter((v) => v === mx).length / sc.length;
    }
    P(`  ${src.padEnd(4)}: 要望のある回 ${nWithW}・合う数が割れた回 ${n}・🌟が一番 ${pct(top, n)}（ランダム ${pct(rnd, n)}）`);
  }
  {
    const per: Record<string, [number, number, number]> = {};
    for (const e of M) {
      const cs = fixCands(e, LV); if (cs.length < 2) continue; const W = wantsOf(e, "both");
      for (const k of W) {
        const ms = cs.map((c) => factMap(c, cs).get(k)); const known = ms.filter((v) => v != null); if (known.length < 2 || new Set(known).size < 2) continue;
        const sv = ms[cs.findIndex((c) => c.chosen)]; if (sv == null) continue;
        per[k] ??= [0, 0, 0]; per[k][0]++; if (sv) per[k][1]++; per[k][2] += known.filter((v) => v).length / known.length;
      }
    }
    P(`  話題ごと（本人が言った話題・束で割れた回）🌟が持つ率/束の割合: ` + Object.entries(per).sort((a, b) => b[1][0] - a[1][0]).map(([k, [n, h, r]]) => `${TOPIC_LABEL[k as keyof typeof TOPIC_LABEL] ?? k} ${pct(h, n)}/${pct(r, n)}(${n})`).join("・"));
  }
  {
    let n = 0, top = 0, rnd = 0;
    for (const e of M) {
      const hs = hookedFacts(e); if (!hs.length) continue; const cs = fixCands(e, LV); if (cs.length < 2) continue;
      const vs = cs.map((c) => Math.max(...hs.map((h) => simTo(c, h)))); if (new Set(vs).size < 2) continue; n++;
      const mx = Math.max(...vs); if (vs[cs.findIndex((c) => c.chosen)] === mx) top++; rnd += vs.filter((v) => v === mx).length / vs.length;
    }
    P(`\n=== B3. 前に刺さった🌟（同じ会話・反応あり）と一番似ているか: 回 ${n}・🌟が一番似ている ${pct(top, n)}（ランダム ${pct(rnd, n)}）===`);
  }

  // ─── C. 2軸の組み合わせ ──────────────────────────────────────────────
  const V = (name: string, pick: Variant["pick"]): Variant => ({ name, pick });
  const groups: Array<[string, Variant[]]> = [
    ["AD の材料・線", [
      V("AD 補いあり（他の回の行・送った記録・前の見積書）", curPick("plus")),
      V("線 1.0", curPick(AM, { adLine: 1 })), V("線 2.0", curPick(AM, { adLine: 2 })),
      V("AD 不明を 1.5 とみなす（線の上）", curPick(AM, {}, 1.5)), V("AD 不明を束の中央とみなす", curPick(AM, {}, "median")),
      V("線＝束の一番の AD", relLine(AM, 0)), V("線＝束の一番の AD −0.5", relLine(AM, 0.5)), V("線＝束の一番の AD −1", relLine(AM, 1)),
      V("差の上書き 10", curPick(AM, { overrideMargin: 10 })), V("差の上書き 25", curPick(AM, { overrideMargin: 25 })), V("差の上書き なし", curPick(AM, { overrideMargin: 999 })),
    ]],
    ["束の中の一番（広さ・新しさ）の重み", [[0, 8], [8, 8], [22, 8], [15, 0], [15, 4], [15, 12], [8, 4], [8, 0], [0, 0]].map(([a, g]) => V(`一番広い +${a}・一番新しい +${g}`, curPick(AM, { areaBest: a, ageBest: g })))],
    ["合い方の上位から AD（差 m 以内で AD が一番）", [0, 5, 10, 15, 20, 30].map((m) => V(`合い方 −${m} 以内 → AD`, fitThenAd(AM, m)))],
    ["AD の上位から合い方（一番の AD −m 以内で合い方が一番）", [0, 0.5, 1].map((m) => V(`AD −${m} 以内 → 合い方`, adThenFit(AM, m)))],
    ["順位の足し合わせ（a×合い方の順位＋(1−a)×AD の順位）", [0.5, 0.6, 0.7, 0.8, 0.9].map((a) => V(`順位 a=${a}`, borda(AM, a)))],
    ["点の足し合わせ（合い方＋w×AD・不明=1.5）", [0, 5, 10, 15, 20].map((w) => V(`合い方＋${w}×AD`, linear(AM, w, 1.5)))],
    ["刺さり（本人の要望・前に刺さった物件）", [
      V("状況を条件欄＋会話から", curPick(AM, {}, null, undefined, sitBoth)),
      V("初期費用の希望: AD2以上は敷礼0扱い", curPick(AM, {}, null, undefined, undefined, 2)),
      V("初期費用の希望: AD1.5以上は敷礼0扱い", curPick(AM, {}, null, undefined, undefined, 1.5)),
      ...[5, 10, 15].flatMap((k) => (["cond", "msg", "both"] as WantSrc[]).map((src) => V(`要望に一番合う +${k}（${src}）`, curPick(AM, {}, null, wantExtra(src, k))))),
      ...[5, 10, 15].map((k) => V(`前に刺さった物件と一番似ている +${k}`, curPick(AM, {}, null, hookExtra(k)))),
    ]],
  ];
  for (const lv of [0, LV, -1]) {
    if (lv < 0) {
      const pe = M.filter((e) => (e.poolC?.length ?? 0) >= 2); const pc2 = pe.flatMap((e) => e.poolC!);
      P(`\n=== 送る前の束（拡張の候補プール）: 回 ${pe.length}・束の大きさ中央 ${pe.map((e) => e.poolC!.length).sort((a, b) => a - b)[Math.floor(pe.length / 2)] ?? "-"}・AD 不明の候補 ${pct(pc2.filter((c) => adOf(c, AM) == null).length, pc2.length)} ===`);
      let kn = 0, mx = 0, rmx = 0, prs = 0, l2 = 0, l2b = 0, l15 = 0, l15b = 0, nk = 0;
      for (const e of pe) { const cs = e.poolC!; const sa = adOf(cs.find((c) => c.chosen)!, AM); if (sa == null) continue; nk++; const ks = cs.map((c) => adOf(c, AM)).filter((v): v is number => v != null); if (sa >= 2) l2++; l2b += ks.filter((v) => v >= 2).length / ks.length; if (sa >= 1.5) l15++; l15b += ks.filter((v) => v >= 1.5).length / ks.length; if (new Set(ks).size < 2) continue; kn++; const m = Math.max(...ks); if (sa === m) mx++; rmx += ks.filter((v) => v === m).length / ks.length; prs += pctRank(ks, sa); }
      P(`  🌟の AD が分かる回 ${nk}: AD1.5以上 ${pct(l15, nk)}（束 ${pct(l15b, nk)}）・AD2以上 ${pct(l2, nk)}（束 ${pct(l2b, nk)}）・割れた回 ${kn}: 🌟が束の一番の AD ${pct(mx, kn)}（ランダム ${pct(rmx, kn)}）・順位の平均 ${(prs / Math.max(1, kn)).toFixed(2)}`);
    }
    P(`\n=== C. 2軸の組み合わせ（束 lv${lv}${lv < 0 ? "＝送る前の束" : ""}）:前7割 ／ 後3割 ／ live ／ 全体 ・ 今と比べて 新だけ当たり／旧だけ当たり ===`);
    P(`  ランダム: ${fmt(randRate(train, lv))} ／ ${fmt(randRate(test, lv))} ／ ${fmt(randRate(liveM, lv))} ／ ${fmt(randRate(M, lv))}`);
    P(`  ${row(CUR, lv)}`);
    for (const [gname, vs] of groups) {
      P(`  ── ${gname}`);
      for (const v of vs) P(`  ${row(v, lv)}`);
      const best = [...vs].sort((a, b) => rateOf(b, train, lv).h - rateOf(a, train, lv).h)[0];
      P(`   → 前7割で一番: ${best.name}・後3割 ${fmt(rateOf(best, test, lv))}（今 ${fmt(rateOf(CUR, test, lv))}）`);
    }
  }

  // ─── D. ずれの残りの内訳（今の並べ方）────────────────────────────
  {
    const why: Record<string, number> = {}; let miss = 0;
    const loses: Record<string, number> = {};
    for (const e of M) {
      const cs = fixCands(e, LV); if (cs.length < 2) continue;
      const sc = cs.map((c) => toStar(c, AM)); const r = rankStarCandidates(sc, STAR_RANK_RULE, e.sit, STAR_SITUATION_RULE);
      const top = cs.find((c) => c.key === r[0].key)!; if (top.chosen) continue; miss++;
      const st = cs.find((c) => c.chosen)!; const rs = r.find((x) => x.key === st.key)!, rt = r[0];
      const sa = adOf(st, AM), ta = adOf(top, AM);
      let k: string;
      if (rs.tier !== rt.tier) k = sa == null ? "段: 🌟の AD 不明で線の下" : rs.tier === "never" ? "段: 🌟が AD1未満" : "段: 🌟の AD が線の下（分かっている）";
      else if (rs.fit === rt.fit) k = "同じ段・同点";
      else if (st.f.area_sqm == null && st.f.building_age == null) k = "同じ段・🌟の材料の欠け（広さ・築年とも不明）";
      else k = "同じ段・🌟の合い方が下";
      if (k.startsWith("同じ段・🌟")) {
        if (sa != null && ta != null && sa > ta) why["  （同じ段の内 🌟の AD が1位より高い）"] = (why["  （同じ段の内 🌟の AD が1位より高い）"] ?? 0) + 1;
        for (const x of rt.reasons) if (!rs.reasons.includes(x)) { const kk = x.replace(/\s*\d+$/, ""); loses[kk] = (loses[kk] ?? 0) + 1; }
        const W = wantsOf(e, "both"); if (W.size && wantScore(st, cs, W) > wantScore(top, cs, W)) why["  （同じ段の内 本人の要望に🌟の方が多く合う）"] = (why["  （同じ段の内 本人の要望に🌟の方が多く合う）"] ?? 0) + 1;
      }
      why[k] = (why[k] ?? 0) + 1;
    }
    P(`\n=== D. ずれの残りの内訳（今・束 lv${LV}）: ずれ ${miss} ===`);
    for (const [k, v] of Object.entries(why).sort((a, b) => b[1] - a[1])) P(`  ${k} ${v}（${pct(v, miss)}）`);
    P(`  合い方が下の回で1位だけが持っていた理由: ${Object.entries(loses).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k} ${v}`).join("・")}`);
  }
  if (args.out) writeFileSync(String(args.out), JSON.stringify({ n: M.length }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
