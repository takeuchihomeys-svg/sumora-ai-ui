// scripts/audit-old-building-age.ts
// 築年数が古すぎる物件の扱い（2026-10-06 竹内さん「築年数古すぎる物件はそもそもお客さんにささりにくい　結局は築年数の浅い物件でお客さん刺さることが多い」）
//   読むだけ・LLM なし・費用0・DB に書かない。🌟の記録の回の組み方は scripts/audit-recommend-score.ts の写し（そちらは触らない）。
//   1. 🌟の記録の束: 築年の帯ごとの🌟の選ばれ方（型ごと）
//   2. オススメの点（👑）に「築N年以上 −P（型ごと・リノベ済みと築年を気にしない人・築年の列を書いた人は除く）」を足した案の当て直し
//      前7割／後3割／live／全体の1位一致・今の U と比べて 新だけ当たり／旧だけ当たり（前7割・後3割に分けて）
//   3. 判定の点（束に入れる段・L）に同じ減点を足した案（同じ回で1位一致）
//   ※ 刺さった新着の帯ごとの数・売上サポの行での当て直し・週の学習の回（拡張の回・売上サポの回）は scripts/audit-old-building-age-more.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-old-building-age.ts [--days=400] [--why] [--all]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { baseReasonPoints, type SentRowLike, type PatternRowLike } from "../app/lib/property-brain";
import { customerAt, buildContext, episodeFromSnapshot, isCustomerSend, type ConditionHistoryRow } from "../app/lib/scoring-learning-episodes";
import { nameKey, bestBuildingMatch, sameBuildingName, toHalf } from "../app/lib/candidate-facts";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";
import { rankStarCandidates, starSituationOf, STAR_RANK_RULE, STAR_SITUATION_RULE, type StarCandidate, type StarSituation, type StarSituationRule } from "../app/lib/recommend-star-rank";
import { adMonthsOfPickup, structureOf, equipmentKeysOf, areaSqmOfPickup, starSituationFromConditions } from "../app/lib/star-rank-pickup";
import { appealTopics, customerWants, TOPIC_LABEL } from "../app/lib/recommendation-gaps";
import { renovationOfText } from "../app/lib/listing-renovation";
import { adHintFromDiscount } from "../app/lib/estimate-ad-hint";
import { parseRentFromSummary } from "../app/lib/property-summary-parse";
import { rankByRecommendScore, RECOMMEND_SCORE_RULE } from "../app/lib/recommend-score";
import { oldAgeApplies, oldAgePenalty } from "../app/lib/old-building-age";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "400"), 10);
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

type C = { reno: boolean | null; initialMonths: number | null; estBefore: number | null; estAny: number | null; rentY: number | null; key: string; name: string; room: string; chosen: boolean; codes: string[]; base: number; f: Row; sentAt: number; sameSess: boolean; prevStar: boolean; rejected: boolean; unavailable: boolean; sameBldStar: boolean; est: Row | null };
type Ep = {
  id: number; conv: string; at: string; live: boolean; cands: C[]; sit: StarSituation; wants: Set<string>; condWants: Set<string>; urgency: string;
  starText: string; headline: string; headTopics: string[]; appeal: string[]; newArrival: boolean; estEnclosed: boolean; standalone: boolean; starRepeat: boolean;
  types: string[]; react: { reply72: boolean; mention: boolean; viewing: boolean; apply: boolean; estimateAfter: boolean };
  rentMax: number | null; floorPlan: string; oldOk: boolean;
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
        x.__reno = renovationOfText(pk.pdf_text); if (x.rent == null) { const rr = parseRentFromSummary(pk.summary_text ?? null); if (rr) x.rent = rr; }
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
    // 本番（property-pickups の STAR_SITUATION_COLUMNS）は条件フォームの原文を読まないので、ここも外す（見出し「初期費用の限度額」で初期費用の型に入るのを防ぐ）
    const sit = starSituationFromConditions({ ...c, raw_format_text: null } as never) ?? starSituationOf({});
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
    eps.push({
      id: Number(s.id), conv: String(s.conversation_id).slice(0, 8), at: e.at, live: s.source === "live", cands, sit, wants: wantsAll, condWants, urgency,
      starText, headline, headTopics: appealTopics("x\n" + headline), appeal: (s.appeal_topics ?? []) as string[],
      newArrival: /新着/.test(starText.split("\n").slice(1).join("\n").slice(0, 120)),
      estEnclosed: /御見積書|お見積書|見積書(?:を)?(?:同封|お送り|添付)/.test(starText),
      standalone: !cands.some((x) => !x.chosen && x.sameSess), starRepeat: priorStars.length > 0, types, react, rentMax, floorPlan: fp, oldOk: oldAgeApplies({ ...c, raw_format_text: null } as never),
    });
  }
  eps.sort((a, b) => a.at.localeCompare(b.at));
  const P = (...x: unknown[]) => console.log(...x);


  const WITH_NEW = args["with-new"] === "1";
  type Opt = { rule: typeof STAR_RANK_RULE; est: "none" | "before" | "any"; staffReno?: Ep | null };
  const toStar = (c: C, o: Opt): StarCandidate => {
    let ad: number | null = c.f.ad_months ?? null;
    if (ad == null && o.est !== "none") ad = adHintFromDiscount(o.est === "before" ? c.estBefore : c.estAny, c.rentY ?? c.f.rent);
    return {
      key: c.key, codes: c.codes, score: c.base, pointsOf: baseReasonPoints, areaSqm: c.f.area_sqm, buildingAge: c.f.building_age, structure: c.f.__structure,
      equipmentCount: c.f.equipment_count, equipWantHits: c.f.equip_want_hits, adMonths: ad,
      zeroZero: c.f.zero_zero == null ? null : c.f.zero_zero === 1, walkMinutes: c.f.walk, vacancy: c.f.__status === "open" ? "open" : c.f.__status === "move_out_planned" || c.f.__status === "under_construction" ? "later" : null,
      equipmentKeys: Array.isArray(c.f.equipment) ? c.f.equipment : null, floor: c.f.floor,
      renovated: o.staffReno && c.chosen && /リノベ|リフォーム済/.test(o.staffReno.starText) ? true : c.reno, initialMonths: c.initialMonths,
    };
  };
  const fixCands = (e: Ep, lv: number): C[] => {
    let cs = e.cands;
    if (lv >= 1) cs = cs.filter((c) => c.chosen || !c.prevStar);
    if (lv >= 2) cs = cs.filter((c) => c.chosen || !c.unavailable);
    if (lv >= 3) cs = cs.filter((c) => c.chosen || !c.rejected);
    if (lv >= 4 && !e.standalone) cs = cs.filter((c) => c.chosen || c.sameSess);
    if (lv >= 5) { const seen = new Set<string>(); cs = cs.filter((c) => { if (c.chosen) return true; const k = nameKey(c.name); if (c.sameBldStar) return false; if (seen.has(k)) return false; seen.add(k); return true; }); }
    return cs;
  };
  const top = (e: Ep, cs: C[], o: Opt) => rankStarCandidates(cs.map((c) => toStar(c, o.staffReno === null ? { ...o, staffReno: e } : o)), o.rule, e.sit, STAR_SITUATION_RULE);
  const hit = (e: Ep, lv: number, o: Opt): boolean | null => { const cs = fixCands(e, lv); if (cs.length < 2) return null; const k = top(e, cs, o)[0]?.key; return k == null ? null : cs.find((c) => c.key === k)!.chosen; };
  const rate = (xs: Ep[], lv: number, o: Opt) => { let n = 0, h = 0; for (const e of xs) { const r = hit(e, lv, o); if (r == null) continue; n++; if (r) h++; } return { n, h }; };
  const rand = (xs: Ep[], lv: number) => { let n = 0, s = 0; for (const e of xs) { const cs = fixCands(e, lv); if (cs.length < 2) continue; n++; s += 1 / cs.length; } return { n, h: s }; };
  const fmt = (r: { n: number; h: number }) => `${pct(r.h, r.n)}(${Math.round(r.h)}/${r.n})`;

  const M = eps.filter((e) => !(e.standalone && e.newArrival));
  const cut = Math.floor(M.length * 0.7); const train = M.slice(0, cut), test = M.slice(cut), liveM = M.filter((e) => e.live);
  const O: Opt = { rule: STAR_RANK_RULE, est: "none" };
  type Ranker = (e: Ep, cs: C[]) => string | null;
  const F: Ranker = (e, cs) => top(e, cs, O)[0]?.key ?? null;
  const stars = (_e: Ep, cs: C[]) => cs.map((c) => toStar(c, O));
  const U = (k: number, adScale = 0, extra?: (e: Ep, c: C) => number): Ranker => (e, cs) => {
    const sc = stars(e, cs);
    // adScale>0: AD の点を戻す（判定の点の AD を adScale 倍で残す）
    return rankByRecommendScore(sc.map((s) => ({ ...s, score: s.score - (1 - adScale) * 0 })), e.sit, {
      rule: { ...RECOMMEND_SCORE_RULE, adLinePoints: k, oldAge: null }, // 築古の減点は案の側で足す（基準は 06e＝減点なし）
      extra: (s, i) => {
        const adPts = s.codes.filter((x) => /^(AD_|PROFIT_)/.test(x)).reduce((a, x) => a + s.pointsOf(x), 0);
        const p = adScale * adPts + (extra ? extra(e, cs[i]) : 0);
        return p ? { points: p, label: "案の足し点" } : null;
      },
    })[0]?.key ?? null;
  };
  const L: Ranker = (_e, cs) => { let b = -Infinity, k: string | null = null; for (const c of cs) if (c.base > b) { b = c.base; k = c.key; } return k; };
  const band = (a: number | null | undefined) => a == null ? "?" : a <= 10 ? "≤10" : a <= 20 ? "11-20" : a <= 25 ? "21-25" : a <= 30 ? "26-30" : a <= 40 ? "31-40" : "41+";
  const BANDS = ["≤10", "11-20", "21-25", "26-30", "31-40", "41+"];
  const typeOf = (e: Ep) => `${e.sit.household ? "二人以上" : "一人"}${e.sit.zero ? "×初期" : ""}`;
  // ─── 1. 帯ごとの🌟 ───
  P(`=== 1. 🌟の記録の束（${DAYS}日・YUMA と単独の新着を除く・${M.length}回・直した束）: 帯ごとの 🌟/候補・lift（🌟の中の割合÷候補の中の割合）・築年が分かる候補だけ ===`);
  for (const ty of ["ALL", "一人", "一人×初期", "二人以上", "二人以上×初期", "初期(全)", "初期でない"]) {
    const xs = M.filter((e) => ty === "ALL" || (ty === "初期(全)" ? e.sit.zero : ty === "初期でない" ? !e.sit.zero : typeOf(e) === ty));
    const ca: Record<string, number> = {}, ch: Record<string, number> = {}; let kc = 0, kch = 0, reno = 0;
    for (const e of xs) for (const c of fixCands(e, 5)) { const a = c.f.building_age; if (a == null) continue; const b = band(a); ca[b] = (ca[b] ?? 0) + 1; kc++; if (c.chosen) { ch[b] = (ch[b] ?? 0) + 1; kch++; } if (c.reno && a > 30) reno++; }
    P(`  ${ty.padEnd(10)} 回 ${xs.length}・築年の分かる候補 ${kc}（🌟 ${kch}・築31年以上のリノベ ${reno}）:: ` + BANDS.map((b) => `${b} ${ch[b] ?? 0}/${ca[b] ?? 0}${ca[b] ? ` lift ${(((ch[b] ?? 0) / Math.max(kch, 1)) / (ca[b] / kc)).toFixed(2)}` : ""}`).join(" | "));
  }
  // ─── 2. オススメの点に減点 ───
  type Scope = "initial" | "all" | "initial_hh" | "initial_single" | "not_initial";
  const inScope = (e: Ep, sc: Scope) => sc === "all" ? true : sc === "initial" ? e.sit.zero : sc === "initial_hh" ? e.sit.zero && !!e.sit.household : sc === "initial_single" ? e.sit.zero && !e.sit.household : !e.sit.zero;
  const pen = (minAge: number, points: number, sc: Scope, honorOk = true) => (e: Ep, c: C) => {
    if (!inScope(e, sc) || (honorOk && !e.oldOk)) return 0;
    return oldAgePenalty({ buildingAge: c.f.building_age, renovated: c.reno }, { minAge, points })?.points ?? 0;
  };
  const variants: Array<[string, Ranker]> = [["U 今のオススメの点", U(15)]];
  // 本番の決まり（star-fit@2026-10-06f: 状況 oldAgeAvoid＋OLD_AGE_RULE）＝ 下の「initial 築31以上 -15」と同じ1位になるはず
  variants.push(["本番 06f（RECOMMEND_SCORE_RULE そのまま）", (e, cs) => rankByRecommendScore(stars(e, cs), e.sit)[0]?.key ?? null]);
  for (const sc of ["initial", "all", "initial_hh", "initial_single", "not_initial"] as Scope[]) for (const minAge of [21, 26, 30, 31, 36]) for (const p of [-5, -10, -15, -25, -40]) variants.push([`U＋${sc} 築${minAge}以上 ${p}`, U(15, 0, pen(minAge, p, sc))]);
  variants.push(["U＋initial 築31以上 -15（気にしない人にも）", U(15, 0, pen(31, -15, "initial", false))]);
  const hitR = (r: Ranker, e: Ep, lv: number): boolean | null => { const cs = fixCands(e, lv); if (cs.length < 2) return null; const k = r(e, cs); return k == null ? null : cs.find((c) => c.key === k)!.chosen; };
  const rateR = (r: Ranker, xs: Ep[], lv: number) => { let n = 0, h = 0; for (const e of xs) { const x = hitR(r, e, lv); if (x == null) continue; n++; if (x) h++; } return { n, h }; };
  const trainSet = new Set(train);
  const show = (title: string, base: Ranker, vs: Array<[string, Ranker]>) => {
    for (const lv of [0, 5]) {
      P(`\n--- ${title}・${lv === 0 ? "今の物差し" : "直した束"}: 前7割 ／ 後3割 ／ live ／ 全体 ・ 基準と比べて 新だけ当たり／旧だけ当たり・1位が違う回（前7割で 新/旧・後3割で 新/旧）---`);
      P(`  ランダム: ${fmt(rand(train, lv))} ／ ${fmt(rand(test, lv))} ／ ${fmt(rand(liveM, lv))} ／ ${fmt(rand(M, lv))}`);
      for (const [lab, r] of vs) {
        let on = 0, oo = 0, diff = 0; const sp = { tn: 0, to: 0, sn: 0, so: 0 };
        M.forEach((e) => { const cs = fixCands(e, lv); if (cs.length < 2) return; if (base(e, cs) !== r(e, cs)) diff++; const a = hitR(base, e, lv), b = hitR(r, e, lv); if (a == null || b == null) return; const isTr = trainSet.has(e); if (b && !a) { on++; if (isTr) sp.tn++; else sp.sn++; } if (a && !b) { oo++; if (isTr) sp.to++; else sp.so++; } });
        if (r !== base && diff === 0 && !args.all) continue;
        P(`  ${lab.padEnd(34)} ${fmt(rateR(r, train, lv))} ／ ${fmt(rateR(r, test, lv))} ／ ${fmt(rateR(r, liveM, lv))} ／ ${fmt(rateR(r, M, lv))} ・ ${on}／${oo}・違う ${diff}（前 ${sp.tn}/${sp.to}・後 ${sp.sn}/${sp.so}）`);
      }
    }
  };
  P(`\n=== 2. オススメの点（👑）に築古の減点（${M.length}回・live ${liveM.length}）===`);
  show("👑", variants[0][1], variants);
  if (args.why) {
    const minAge = parseInt(String(args.minAge ?? "31"), 10), p = parseInt(String(args.points ?? "-15"), 10);
    const scope = String(args.scope ?? "all") as Scope;
    const r = U(15, 0, pen(minAge, p, scope));
    P(`\n--- 減点で👑が変わる回（${scope} 築${minAge}以上 ${p}・今の物差し）---`);
    for (const e of M) { const cs = fixCands(e, 0); if (cs.length < 2) continue; const a = variants[0][1](e, cs), b = r(e, cs); if (a === b) continue; const st = cs.find((c) => c.chosen)!; P(`  #${e.id} ${e.at.slice(0, 10)} ${typeOf(e)} 🌟=${st.key}(築${st.f.building_age ?? "?"}) 今=${a}(築${cs.find((c) => c.key === a)?.f.building_age ?? "?"}) 新=${b}(築${cs.find((c) => c.key === b)?.f.building_age ?? "?"}) 見出し「${e.headline.replace(/\n/g, " ").slice(0, 40)}」`); }
  }
  // ─── 3. 判定の点（束に入れる段） ───
  const Lp = (minAge: number, p: number, sc: Scope): Ranker => (e, cs) => { let b = -Infinity, k: string | null = null; for (const c of cs) { const v = c.base + pen(minAge, p, sc)(e, c); if (v > b) { b = v; k = c.key; } } return k; };
  const lvars: Array<[string, Ranker]> = [["L 判定の点の1位", L]];
  for (const sc of ["initial", "all"] as Scope[]) for (const minAge of [26, 31]) for (const p of [-5, -10, -15]) lvars.push([`L＋${sc} 築${minAge}以上 ${p}`, Lp(minAge, p, sc)]);
  P(`\n=== 3. 判定の点（束に入れる段）に築古の減点 ===`);
  show("判定の点", L, lvars);
})().catch((e) => { console.error(e); process.exit(1); });
