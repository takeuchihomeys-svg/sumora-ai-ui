// scripts/audit-star-mismatch-why.ts
// 🌟（一番オススメ）の並べ方とスタッフの🌟が「なぜずれるか」を回ごとに掘る（読むだけ・LLM なし・費用0・DB に書かない）。
//
// 2026-10-06 竹内「なんで一致率がそんなにひくいのか　実際に送っている物件の部分とくちょうあるのでは　初期費用抑えたい方には敷金礼金0の物件おくって
//   見積書もおくっているなど　見積書の割引金額みれば、ADがある物件かもわかる…お客さんにたいするオススメしている文と、お客さんの反応もみたら
//   もっと今ずれている原因がわかる…ずれがあれば、何が理由なのか深くまで考える…過去の似たパターンなど、分類できれば、更にスコアリング細分化」
//
// ■ 順番（ずれを見つけたら深く掘る型）
//   0. 物差しを疑う: 回の作り（候補＝直近72時間の送付）・🌟の結び付け・同率・前に🌟にした物・審査中/入居中・同じ建物の別の部屋
//   1. 物差しを直した回で当て直す（今の点／並べ方／並べ方＋状況）
//   2. 一致しない回ごとに「なぜスタッフはこれを選んだか」を仮説→材料で確かめて分類
//   3. 🌟の本文の見出し（「〇〇で△△さんにかなりオススメ」の〇〇）＝スタッフが言った一番の理由
//   4. 見積書（同封・estimate_records の割引）と AD
//   5. お客様の反応（正誤には使わない・ずれの理由の材料だけ）
//   6. お客様の型ごとに🌟を決める要素（前7割で作り後3割で確かめ）
// ■ 正解はスタッフが🌟にした事実（お客様の返信の有無で正誤を決めない）
// ■ 個人情報: お客様の名前・発言は出さない（会話は先頭8字・物件名は出す）。YUMA は外す
//
// 実行: npx tsx --env-file=.env.local scripts/audit-star-mismatch-why.ts [--days=180] [--show=12] [--out=path.json]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { baseReasonPoints, type SentRowLike, type PatternRowLike } from "../app/lib/property-brain";
import { customerAt, buildContext, episodeFromSnapshot, isCustomerSend, type ConditionHistoryRow } from "../app/lib/scoring-learning-episodes";
import { nameKey, bestBuildingMatch, sameBuildingName, toHalf } from "../app/lib/candidate-facts";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";
import { rankStarCandidates, starSituationOf, STAR_RANK_RULE, STAR_SITUATION_RULE, type StarCandidate, type StarSituation, type StarSituationRule } from "../app/lib/recommend-star-rank";
import { adMonthsOfPickup, structureOf, equipmentKeysOf, areaSqmOfPickup, starSituationFromConditions } from "../app/lib/star-rank-pickup";
import { appealTopics, customerWants, TOPIC_LABEL } from "../app/lib/recommendation-gaps";

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
const mentions = (text: string, name: string) => { const k = nameKey(name); return k.length >= 3 && nameKey(text).includes(k.slice(0, Math.min(k.length, 6))); };

type C = { key: string; name: string; room: string; chosen: boolean; codes: string[]; base: number; f: Row; sentAt: number; sameSess: boolean; prevStar: boolean; rejected: boolean; unavailable: boolean; sameBldStar: boolean; est: Row | null };
type Ep = {
  id: number; conv: string; at: string; live: boolean; cands: C[]; sit: StarSituation; wants: Set<string>; condWants: Set<string>; urgency: string;
  starText: string; headline: string; headTopics: string[]; appeal: string[]; newArrival: boolean; estEnclosed: boolean; standalone: boolean; starRepeat: boolean;
  types: string[]; react: { reply72: boolean; mention: boolean; viewing: boolean; apply: boolean; estimateAfter: boolean };
  rentMax: number | null; floorPlan: string;
};

(async () => {
  const until = Date.now();
  const snapsAll = (await all((a, b) => sb.from("recommendation_snapshots").select("id, conversation_id, property_customer_id, sent_at, star_name, star_room, star_text, star_in_candidates, candidate_count, candidates, source, customer_wants, appeal_topics")
    .gte("sent_at", new Date(until - DAYS * D).toISOString()).order("id").range(a, b) as never, 300)).filter((s) => s.conversation_id !== YUMA_CONVERSATION_ID);
  const snaps = snapsAll.filter((s) => s.property_customer_id && s.candidate_count >= 2 && s.star_in_candidates);
  const pcs = [...new Set(snaps.map((s) => String(s.property_customer_id)))];
  const convs = [...new Set(snaps.map((s) => String(s.conversation_id)))];
  const custs = new Map<string, Row>(); const hist: Row[] = [], sents: Row[] = [], pats: Row[] = [], picks: Row[] = [];
  for (const c of chunks(pcs, 80)) {
    const { data } = await sb.from("property_customers").select("id, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, created_at, floor_area_min, raw_format_text, desired_area, commute_station, commute_minutes").in("id", c);
    for (const r of (data ?? []) as Row[]) custs.set(r.id, r);
    hist.push(...await all((a, b) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, created_at").in("property_customer_id", c).order("id").range(a, b) as never));
    sents.push(...await all((a, b) => sb.from("sent_properties").select("property_customer_id, conversation_id, property_name, room_no, rent, delivery, source, channel, sent_at, customer_reaction, recruitment_status, ad_months").in("property_customer_id", c).order("id").range(a, b) as never));
    pats.push(...await all((a, b) => sb.from("property_selection_patterns").select("property_customer_id, selling_points, selection_label, created_at").in("property_customer_id", c).order("id").range(a, b) as never));
    picks.push(...await all((a, b) => sb.from("property_pickups").select("id, property_customer_id, created_at, property_name, room_no, reason_codes, summary_text, ad_yen, equipment, terms").in("property_customer_id", c).order("id").range(a, b) as never));
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
    eps.push({
      id: Number(s.id), conv: String(s.conversation_id).slice(0, 8), at: e.at, live: s.source === "live", cands, sit, wants: wantsAll, condWants, urgency,
      starText, headline, headTopics: appealTopics("x\n" + headline), appeal: (s.appeal_topics ?? []) as string[],
      newArrival: /新着/.test(starText.split("\n").slice(1).join("\n").slice(0, 120)),
      estEnclosed: /御見積書|お見積書|見積書(?:を)?(?:同封|お送り|添付)/.test(starText),
      standalone: !cands.some((x) => !x.chosen && x.sameSess), starRepeat: priorStars.length > 0, types, react, rentMax, floorPlan: fp,
    });
  }
  eps.sort((a, b) => a.at.localeCompare(b.at));
  const P = (...x: unknown[]) => console.log(...x);

  const toStar = (c: C): StarCandidate => ({
    key: c.key, codes: c.codes, score: c.base, pointsOf: baseReasonPoints, areaSqm: c.f.area_sqm, buildingAge: c.f.building_age, structure: c.f.__structure,
    equipmentCount: c.f.equipment_count, equipWantHits: c.f.equip_want_hits, adMonths: c.f.ad_months,
    zeroZero: c.f.zero_zero == null ? null : c.f.zero_zero === 1, walkMinutes: c.f.walk, vacancy: c.f.__status === "open" ? "open" : c.f.__status === "move_out_planned" || c.f.__status === "under_construction" ? "later" : null,
    equipmentKeys: Array.isArray(c.f.equipment) ? c.f.equipment : null, floor: c.f.floor,
  });
  type Pick = (cs: C[], e: Ep) => string | null;
  const pickLegacy: Pick = (cs) => { const mx = Math.max(...cs.map((c) => c.base)); return cs.find((c) => c.base === mx)!.key; };
  const pickFit: Pick = (cs) => rankStarCandidates(cs.map(toStar))[0]?.key ?? null;
  const pickFitSit: Pick = (cs, e) => rankStarCandidates(cs.map(toStar), STAR_RANK_RULE, e.sit)[0]?.key ?? null;
  // 物差しの直し（候補を絞る）
  const fixCands = (e: Ep, lv: number): C[] => {
    let cs = e.cands;
    if (lv >= 1) cs = cs.filter((c) => c.chosen || !c.prevStar);                       // 前に🌟にした物
    if (lv >= 2) cs = cs.filter((c) => c.chosen || !c.unavailable);                    // 入居中・募集終了
    if (lv >= 3) cs = cs.filter((c) => c.chosen || !c.rejected);                       // お客様が断った物
    if (lv >= 4 && !e.standalone) cs = cs.filter((c) => c.chosen || c.sameSess);       // 同じ束（2時間以内に一緒に送った物）だけ
    if (lv >= 5) { const seen = new Set<string>(); cs = cs.filter((c) => { if (c.chosen) return true; const k = nameKey(c.name); if (c.sameBldStar) return false; if (seen.has(k)) return false; seen.add(k); return true; }); } // 同じ建物の別の部屋は1つ
    return cs;
  };
  const hit = (e: Ep, cs: C[], p: Pick) => { if (cs.length < 2) return null; const k = p(cs, e); return k == null ? null : cs.find((c) => c.key === k)!.chosen; };
  const rate = (xs: Ep[], lv: number, p: Pick) => { let n = 0, h = 0; for (const e of xs) { const r = hit(e, fixCands(e, lv), p); if (r == null) continue; n++; if (r) h++; } return { n, h }; };
  const rand = (xs: Ep[], lv: number) => { let n = 0, s = 0; for (const e of xs) { const cs = fixCands(e, lv); if (cs.length < 2) continue; n++; s += 1 / cs.length; } return { n, h: s }; };

  P(`=== 0. 物差し（🌟の記録 ${measure.snapsTotal}件・180日・YUMA 除く）===`);
  P(`  候補1件以下で測れない ${measure.oneCand}・🌟が候補に無い ${measure.notInCands}・測れる回 ${eps.length}（live ${eps.filter((e) => e.live).length}）`);
  P(`  🌟の結び付け: 見出しの名前と候補の名前が同じ字 ${measure.starNameExact}・近い（0.75以上）${eps.length - measure.starNameExact - measure.starNameFar}・遠い ${measure.starNameFar}`);
  const nC = (f: (e: Ep) => boolean) => eps.filter(f).length;
  P(`  🌟を単独で送った回（同じ2時間に他の送付なし＝束から選んでいない・候補は前の日の送付）${nC((e) => e.standalone)}（うち本文に「新着」${nC((e) => e.standalone && e.newArrival)}）`);
  P(`  束から選んだ回 ${nC((e) => !e.standalone)}（うち候補に72時間内の前の束が混ざる ${nC((e) => !e.standalone && e.cands.some((c) => !c.chosen && !c.sameSess))}）`);
  P(`  候補に前に🌟にした物 ${nC((e) => e.cands.some((c) => c.prevStar))}・入居中/募集終了 ${nC((e) => e.cands.some((c) => c.unavailable))}・お客様が断った物 ${nC((e) => e.cands.some((c) => c.rejected))}・🌟と同じ建物の別の部屋 ${nC((e) => e.cands.some((c) => c.sameBldStar))}`);
  const tieTop = eps.filter((e) => { const r = rankStarCandidates(e.cands.map(toStar), STAR_RANK_RULE, e.sit); return r.length > 1 && r[0].fit === r[1].fit && r[0].tier === r[1].tier; }).length;
  P(`  並べ方の1位が同点（同じ段・同じ合い方の点）${tieTop}`);
  const LV = ["そのまま", "+前の🌟を外す", "+入居中/終了を外す", "+断った物を外す", "+同じ束だけ", "+同じ建物は1つ"];
  P(`\n=== 1. 物差しを1段ずつ直した1位一致（全回 ／ 束から選んだ回だけ）: ランダム ・ 今の点 ・ 並べ方 ・ 並べ方＋状況 ===`);
  const fmt = (r: { n: number; h: number }) => `${pct(r.h, r.n)}(${r.n})`;
  const bundle = eps.filter((e) => !e.standalone);
  for (let lv = 0; lv < LV.length; lv++) {
    P(`  ${LV[lv].padEnd(14)} 全回: ラ ${fmt(rand(eps, lv))} 今 ${fmt(rate(eps, lv, pickLegacy))} 並 ${fmt(rate(eps, lv, pickFit))} 状 ${fmt(rate(eps, lv, pickFitSit))} ｜ 束: ラ ${fmt(rand(bundle, lv))} 今 ${fmt(rate(bundle, lv, pickLegacy))} 並 ${fmt(rate(bundle, lv, pickFit))} 状 ${fmt(rate(bundle, lv, pickFitSit))}`);
  }
  const single = eps.filter((e) => e.standalone);
  P(`  単独の回だけ（参考・束から選んでいない）: ラ ${fmt(rand(single, 0))} 今 ${fmt(rate(single, 0, pickLegacy))} 並 ${fmt(rate(single, 0, pickFit))} 状 ${fmt(rate(single, 0, pickFitSit))}`);

  // ─── 3. 🌟の見出し（スタッフが言った一番の理由）──────────────────────
  const LV_FIX = 5;
  P(`\n=== 3. 🌟の本文の見出し（「〇〇で…さんにかなりオススメ」の〇〇）＝スタッフが言った一番の理由 ===`);
  const headCount: Record<string, number> = {};
  for (const e of eps) for (const k of e.headTopics) headCount[k] = (headCount[k] ?? 0) + 1;
  P(`  見出しの話題（${eps.length}回）: ` + Object.entries(headCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${TOPIC_LABEL[k as never] ?? k} ${v}(${pct(v, eps.length)})`).join("・"));
  P(`  見出しに「新着」${nC((e) => e.newArrival)}・「ピッタリ／ご希望」${nC((e) => /ピッタリ|ぴったり|ご希望|条件/.test(e.headline))}・見積書同封 ${nC((e) => e.estEnclosed)}`);
  // 見出しの話題 → 🌟がその値で束の一番か（直した束）
  const FEAT: Record<string, [(c: C) => number | null, string]> = {
    zero_deposit: [(c) => c.f.zero_zero, "敷礼0"], low_initial: [(c) => c.f.zero_zero, "敷礼0"], spacious: [(c) => c.f.area_sqm, "広さ"], new_build: [(c) => (c.f.building_age == null ? null : -c.f.building_age), "新しさ"],
    station_near: [(c) => (c.f.walk == null ? null : -c.f.walk), "駅近"], rent: [(c) => (c.f.rent_ratio == null ? null : -c.f.rent_ratio), "家賃の安さ"], floor2: [(c) => c.f.floor, "階"],
    layout: [(c) => c.f.plan_match, "間取りの一致"], corner: [(c) => (Array.isArray(c.f.equipment) ? (c.f.equipment.includes("corner") ? 1 : 0) : null), "角部屋"],
    washbasin: [(c) => (Array.isArray(c.f.equipment) ? (c.f.equipment.includes("washbasin") ? 1 : 0) : null), "独立洗面台"],
  };
  const bestOf = (xs: Ep[], f: (c: C) => number | null) => {
    let n = 0, b = 0, r = 0;
    for (const e of xs) {
      const cs = fixCands(e, LV_FIX); const vals = cs.map(f).filter((v): v is number => v != null); const sv = f(cs.find((c) => c.chosen)!);
      if (sv == null || vals.length < 2 || new Set(vals).size < 2) continue;
      const mx = Math.max(...vals); n++; if (sv === mx) b++; r += vals.filter((v) => v === mx).length / vals.length;
    }
    return { n, b, r };
  };
  for (const [k, [f, lab]] of Object.entries(FEAT)) {
    const w = bestOf(eps.filter((e) => e.headTopics.includes(k)), f), wo = bestOf(eps.filter((e) => !e.headTopics.includes(k)), f);
    P(`  見出しが「${TOPIC_LABEL[k as never] ?? k}」→🌟が束で一番の${lab}: 見出しあり ${pct(w.b, w.n)}（ラ ${pct(w.r, w.n)}・${w.n}回）／なし ${pct(wo.b, wo.n)}（ラ ${pct(wo.r, wo.n)}・${wo.n}回）`);
  }
  // 見出しの話題 ↔ お客様の希望（条件欄）
  const wantHead: Record<string, [number, number]> = {};
  for (const e of eps) for (const k of e.condWants) { wantHead[k] ??= [0, 0]; wantHead[k][0]++; if (e.headTopics.includes(k)) wantHead[k][1]++; }
  P(`  条件欄の希望を見出しで言った率: ` + Object.entries(wantHead).filter(([, v]) => v[0] >= 8).sort((a, b) => b[1][0] - a[1][0]).map(([k, v]) => `${TOPIC_LABEL[k as never] ?? k} ${v[1]}/${v[0]}`).join("・"));

  // ─── 4. 見積書と AD ────────────────────────────────────────────
  P(`\n=== 4. 見積書と AD ===`);
  const estStar = eps.filter((e) => e.cands.find((c) => c.chosen)!.est), estOther = eps.filter((e) => e.cands.some((c) => !c.chosen && c.est));
  P(`  🌟の本文に見積書同封 ${nC((e) => e.estEnclosed)}・🌟の物件に estimate_records の割引あり ${estStar.length}・🌟以外の候補に見積書あり ${estOther.length}`);
  P(`  見積書同封の率: 初期費用重視 ${pct(nC((e) => e.estEnclosed && e.types.includes("初期費用重視")), nC((e) => e.types.includes("初期費用重視")))}・それ以外 ${pct(nC((e) => e.estEnclosed && !e.types.includes("初期費用重視")), nC((e) => !e.types.includes("初期費用重視")))}`);
  P(`  見積書同封の🌟の敷礼0: ${pct(nC((e) => e.estEnclosed && e.cands.find((c) => c.chosen)!.f.zero_zero === 1), nC((e) => e.estEnclosed && e.cands.find((c) => c.chosen)!.f.zero_zero != null))}（同封なし ${pct(nC((e) => !e.estEnclosed && e.cands.find((c) => c.chosen)!.f.zero_zero === 1), nC((e) => !e.estEnclosed && e.cands.find((c) => c.chosen)!.f.zero_zero != null))}）`);
  // 割引/家賃 と AD（候補の家賃・AD で結ぶ）
  const estRows: Array<{ disc: number; rent: number | null; ad: number | null; star: boolean }> = [];
  for (const e of eps) for (const c of e.cands) if (c.est?.discount_yen != null) estRows.push({ disc: Number(c.est.discount_yen), rent: Number(c.f.rent ?? c.est.rent ?? 0) || null, ad: c.f.ad_months ?? (c.est.ad_months != null ? Number(c.est.ad_months) : null), star: c.chosen });
  const uniq = estRows; // 回をまたいで同じ物件が数回出る（参考の数）
  const withRent = uniq.filter((r) => r.rent);
  const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN; };
  const ratios = withRent.map((r) => r.disc / r.rent!);
  P(`  割引のある候補 ${uniq.length}（家賃が分かる ${withRent.length}・AD が分かる ${uniq.filter((r) => r.ad != null).length}）・割引÷家賃 中央 ${q(ratios, 0.5).toFixed(2)}ヶ月（Q1 ${q(ratios, 0.25).toFixed(2)}・Q3 ${q(ratios, 0.75).toFixed(2)}）`);
  for (const band of [[0, 1], [1, 1.5], [1.5, 2], [2, 9]] as const) {
    const xs = withRent.filter((r) => r.ad != null && r.ad >= band[0] && r.ad < band[1]).map((r) => r.disc / r.rent!);
    if (xs.length) P(`    AD ${band[0]}〜${band[1]}ヶ月: ${xs.length}件 割引÷家賃 中央 ${q(xs, 0.5).toFixed(2)}（最小 ${Math.min(...xs).toFixed(2)}・最大 ${Math.max(...xs).toFixed(2)}）`);
  }
  P(`  → 割引÷家賃は AD の下限（利益＝AD−割引≧0）: 割引 ≧1ヶ月 ${withRent.filter((r) => r.disc / r.rent! >= 1).length}件・0.5〜1 ${withRent.filter((r) => r.disc / r.rent! >= 0.5 && r.disc / r.rent! < 1).length}件・<0.5 ${withRent.filter((r) => r.disc / r.rent! < 0.5).length}件`);
  // AD の届き方（🌟と点の1位）
  const adKnown = eps.filter((e) => fixCands(e, LV_FIX).filter((c) => c.f.ad_months != null).length >= 2);
  P(`  AD が2件以上分かる回 ${adKnown.length}/${eps.length}（🌟の AD が分かる ${nC((e) => e.cands.find((c) => c.chosen)!.f.ad_months != null)}）`);

  // ─── 5. ずれの分類（直した束・並べ方＋状況の1位≠🌟）────────────────────
  P(`\n=== 5. ずれた回ごとに「なぜスタッフはこれを選んだか」（物差しを直した束・並べ方＋状況）===`);
  const KEYF: Array<[string, (c: C) => number | null, "high" | "low"]> = [
    ["敷礼0", (c) => c.f.zero_zero, "high"], ["広さ", (c) => c.f.area_sqm, "high"], ["新しさ", (c) => c.f.building_age, "low"], ["駅近", (c) => c.f.walk, "low"],
    ["AD", (c) => c.f.ad_months, "high"], ["階", (c) => c.f.floor, "high"], ["家賃比", (c) => c.f.rent_ratio, "low"], ["間取り一致", (c) => c.f.plan_match, "high"],
    ["設備数", (c) => c.f.equipment_count, "high"], ["空室", (c) => (c.f.__status === "open" ? 1 : c.f.__status ? 0 : null), "high"],
  ];
  const reasonCount: Record<string, number> = {}; const examples: Row[] = [];
  let missN = 0, matchN = 0;
  const react = { hit: [] as Ep[], miss: [] as Ep[] };
  for (const e of eps) {
    const cs = fixCands(e, LV_FIX); if (cs.length < 2) continue;
    const r = rankStarCandidates(cs.map(toStar), STAR_RANK_RULE, e.sit);
    const top = cs.find((c) => c.key === r[0].key)!; const star = cs.find((c) => c.chosen)!;
    if (top.chosen) { matchN++; react.hit.push(e); continue; }
    missN++; react.miss.push(e);
    const why: string[] = [];
    const known = (c: C) => ["area_sqm", "building_age", "zero_zero", "ad_months", "walk"].filter((k) => c.f[k] != null).length;
    if (e.standalone) why.push("物差し:単独の🌟（束から選んでいない）");
    if (r[0].fit === r.find((x) => x.key === star.key)!.fit) why.push("物差し:同点");
    if (known(star) <= 1 || known(top) <= 1) why.push("材料の欠け（🌟か1位の値が1つ以下）");
    // スタッフが言った理由で🌟の方が上か
    const better: string[] = [], worse: string[] = [];
    for (const [lab, f, d] of KEYF) { const a = f(star), b = f(top); if (a == null || b == null || a === b) continue; ((d === "high") === (a > b) ? better : worse).push(lab); }
    const headBetter = e.headTopics.map((k) => FEAT[k]?.[1]).filter((x): x is string => !!x).map((l) => l === "新しさ" ? "新しさ" : l).filter((l) => better.includes(l === "家賃の安さ" ? "家賃比" : l === "間取りの一致" ? "間取り一致" : l));
    if (headBetter.length) why.push(`見出しの理由で🌟が上（${[...new Set(headBetter)].join("・")}）`);
    if (better.includes("AD")) why.push("AD で🌟が上");
    if (e.estEnclosed) why.push("見積書同封（初期費用の訴求）");
    const condHit = [...e.condWants].filter((k) => e.headTopics.includes(k));
    if (condHit.length) why.push(`お客様の条件を見出しで（${condHit.map((k) => TOPIC_LABEL[k as never] ?? k).join("・")}）`);
    if (e.newArrival) why.push("新着として推す");
    if (worse.includes("空室") || (star.f.__status === "move_out_planned")) why.push("退去予定の部屋を推す");
    if (!why.length) why.push(better.length ? `その他（🌟が上: ${better.join("・")}）` : "理由が材料に無い（揺れ・好み・会話の流れ）");
    for (const w of why) { const k = w.replace(/（.*）/, ""); reasonCount[k] = (reasonCount[k] ?? 0) + 1; }
    examples.push({ at: e.at.slice(0, 10), conv: e.conv, live: e.live, n: cs.length, star: `${star.key}`, top: `${top.key}`, head: e.headline.replace(/\s+/g, " ").replace(/[^\s、。！!]*さん/g, "〇〇さん").slice(0, 70), why, better, worse,
      sf: KEYF.map(([l, f]) => `${l}${f(star) ?? "?"}`).join(" "), tf: KEYF.map(([l, f]) => `${l}${f(top) ?? "?"}`).join(" "), fitStar: r.find((x) => x.key === star.key)!.fit, fitTop: r[0].fit, tierStar: r.find((x) => x.key === star.key)!.tier, tierTop: r[0].tier });
  }
  P(`  一致 ${matchN}・ずれ ${missN}（${pct(matchN, matchN + missN)}）`);
  P(`  ずれの理由（1回に複数）: ` + Object.entries(reasonCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}(${pct(v, missN)})`).join("・"));
  // 段（線の上・下）
  const tierMiss: Record<string, number> = {};
  for (const x of examples) { const k = `🌟${x.tierStar}/1位${x.tierTop}`; tierMiss[k] = (tierMiss[k] ?? 0) + 1; }
  P(`  ずれの回の段（line＝AD1.5以上・below＝線の下/不明・never＝AD1未満）: ${JSON.stringify(tierMiss)}`);
  const pairWin: Record<string, [number, number]> = {};
  for (const x of examples) { for (const b of x.better) { pairWin[b] ??= [0, 0]; pairWin[b][0]++; } for (const w of x.worse) { pairWin[w] ??= [0, 0]; pairWin[w][1]++; } }
  P(`  ずれの回で🌟が1位より 上／下: ` + Object.entries(pairWin).sort((a, b) => (b[1][0] - b[1][1]) - (a[1][0] - a[1][1])).map(([k, [a, b]]) => `${k} ${a}/${b}`).join("・"));
  P(`  例（新しい順 ${SHOW}）:`);
  for (const x of examples.slice(-SHOW).reverse()) {
    P(`   ${x.at} ${x.conv} ${x.live ? "live" : "bf"} 候補${x.n} 🌟 ${x.star}（${x.tierStar}・合${x.fitStar}）／1位 ${x.top}（${x.tierTop}・合${x.fitTop}）`);
    P(`      見出し「${x.head}」 理由: ${x.why.join("／")}`);
    P(`      🌟 ${x.sf}`);
    P(`      1位 ${x.tf}`);
  }

  // ─── 6. 反応（正誤ではなく、ずれの理由の材料）─────────────────────────
  P(`\n=== 6. お客様の反応（正誤には使わない）===`);
  const rr = (xs: Ep[]) => `返信 ${pct(xs.filter((e) => e.react.reply72).length, xs.length)}・物件に言及 ${pct(xs.filter((e) => e.react.mention).length, xs.length)}・その物件の内覧 ${pct(xs.filter((e) => e.react.viewing).length, xs.length)}・申込 ${pct(xs.filter((e) => e.react.apply).length, xs.length)}・見積書 ${pct(xs.filter((e) => e.react.estimateAfter).length, xs.length)}（${xs.length}）`;
  P(`  並べ方の1位＝🌟の回: ${rr(react.hit)}`);
  P(`  ずれた回:          ${rr(react.miss)}`);
  P(`  見積書同封の🌟: ${rr(eps.filter((e) => e.estEnclosed))}`);
  P(`  同封なし:       ${rr(eps.filter((e) => !e.estEnclosed))}`);
  P(`  新着の🌟: ${rr(eps.filter((e) => e.newArrival))}`);

  // ─── 7. お客様の型ごとに🌟を決める要素 ─────────────────────────────
  P(`\n=== 7. お客様の型ごと: 🌟が束で一番（直した束・値が割れる回）— 🌟 ／ ランダム（回）と 1位一致 ===`);
  const TF: Array<[string, (c: C) => number | null]> = [
    ["敷礼0", (c) => c.f.zero_zero], ["広さ", (c) => c.f.area_sqm], ["新しさ", (c) => (c.f.building_age == null ? null : -c.f.building_age)], ["駅近", (c) => (c.f.walk == null ? null : -c.f.walk)],
    ["AD", (c) => c.f.ad_months], ["階", (c) => c.f.floor], ["家賃安", (c) => (c.f.rent_ratio == null ? null : -c.f.rent_ratio)], ["家賃高", (c) => c.f.rent_ratio], ["空室", (c) => (c.f.__status === "open" ? 1 : c.f.__status ? 0 : null)],
  ];
  const typeList = [...new Set(eps.flatMap((e) => e.types))].sort();
  const typeOut: Row = {};
  for (const ty of typeList) {
    const sub = eps.filter((e) => e.types.includes(ty)); if (sub.length < 15) continue;
    const parts = TF.map(([lab, f]) => { const r = bestOf(sub, f); return r.n >= 8 ? `${lab} ${pct(r.b, r.n)}/${pct(r.r, r.n)}(${r.n})` : null; }).filter(Boolean);
    const m = rate(sub, LV_FIX, pickFitSit), rd = rand(sub, LV_FIX);
    P(`  ${ty.padEnd(12)} n=${String(sub.length).padStart(3)} 一致 ${fmt(m)}（ラ ${pct(rd.h, rd.n)}）| ${parts.join(" ")}`);
    typeOut[ty] = Object.fromEntries(TF.map(([lab, f]) => [lab, bestOf(sub, f)]));
  }

  // ─── 8. 型ごとの重みの案（前7割で選び・後3割で確かめ）──────────────────
  P(`\n=== 8. 型ごとの足し点の案（前7割で効いた物だけ・後3割で確かめ・直した束・並べ方＋状況が土台）===`);
  const cut = Math.floor(eps.length * 0.7); const train = eps.slice(0, cut), test = eps.slice(cut);
  type Bonus = { ty: string; lab: string; f: (c: C) => number | null; w: number };
  const withBonus = (bonuses: Bonus[]): Pick => (cs, e) => {
    const r = rankStarCandidates(cs.map(toStar), STAR_RANK_RULE, e.sit);
    // 段（tier）を保ったまま、型の足し点で同じ段の中を並べ直す（線の決まりは変えない）
    const add = (c: C) => bonuses.filter((b) => e.types.includes(b.ty)).reduce((a, b) => { const vals = cs.map(b.f).filter((v): v is number => v != null); const v = b.f(c); return a + (v != null && vals.length >= 2 && new Set(vals).size >= 2 && v === Math.max(...vals) ? b.w : 0); }, 0);
    const rows = r.map((x, i) => ({ ...x, i, s: x.fit + add(cs.find((c) => c.key === x.key)!) }));
    const tierOrd = (t: string) => (t === "never" ? 2 : 0);
    rows.sort((a, b) => tierOrd(a.tier) - tierOrd(b.tier) || (a.tier === b.tier ? b.s - a.s : 0) || a.i - b.i);
    // 線の上と下の関係は rankStarCandidates の順（line→below）を保つ: 先頭の段だけ並べ直す
    const headTier = r[0].tier; const same = rows.filter((x) => x.tier === headTier).sort((a, b) => b.s - a.s || a.i - b.i);
    return same[0]?.key ?? r[0].key;
  };
  const cands: Bonus[] = [];
  for (const ty of typeList) for (const [lab, f] of TF) for (const w of [10, 20]) cands.push({ ty, lab, f, w });
  const base = (xs: Ep[]) => rate(xs, LV_FIX, pickFitSit);
  const b0 = base(train), t0 = base(test);
  P(`  土台: 前7割 ${fmt(b0)}・後3割 ${fmt(t0)}`);
  const good: Array<{ b: Bonus; dTrain: number; dTest: number; onlyNew: number; onlyOld: number; nTy: number }> = [];
  for (const b of cands) {
    const nTy = train.filter((e) => e.types.includes(b.ty)).length; if (nTy < 20) continue;
    const tr = rate(train, LV_FIX, withBonus([b])); const dTrain = tr.h - b0.h;
    if (dTrain < 2) continue;
    const te = rate(test, LV_FIX, withBonus([b])); const dTest = te.h - t0.h;
    let onlyNew = 0, onlyOld = 0;
    for (const e of eps) { const cs = fixCands(e, LV_FIX); if (cs.length < 2) continue; const a = hit(e, cs, pickFitSit), n = hit(e, cs, withBonus([b])); if (n && !a) onlyNew++; if (a && !n) onlyOld++; }
    good.push({ b, dTrain, dTest, onlyNew, onlyOld, nTy });
  }
  good.sort((a, b) => b.dTrain - a.dTrain);
  for (const x of good.slice(0, 25)) P(`  ${x.b.ty}×${x.b.lab} +${x.b.w}（前7割の型 ${x.nTy}回）前7割 +${x.dTrain}回・後3割 ${x.dTest >= 0 ? "+" : ""}${x.dTest}回・全体 新だけ当たり ${x.onlyNew}／旧だけ ${x.onlyOld}`);
  if (!good.length) P(`  前7割で2回以上上がる案なし`);

  // ─── 9. 全体の重み（広さ・築年の一番）を動かす案（前7割・後3割・対の比べ）────────────
  P(`\n=== 9. 全体の重みの案（直した束・並べ方＋状況）: 前7割 ／ 後3割 ／ live ・ 新だけ当たり／旧だけ ===`);
  const pickRule = (rule: typeof STAR_RANK_RULE, sr: Readonly<StarSituationRule> = STAR_SITUATION_RULE): Pick => (cs, e) => rankStarCandidates(cs.map(toStar), rule, e.sit, sr)[0]?.key ?? null;
  const liveEps = eps.filter((e) => e.live);
  const ruleVariants: Array<[string, typeof STAR_RANK_RULE]> = [
    ["今（広さ15・築年8）", STAR_RANK_RULE],
    ["築年 15", { ...STAR_RANK_RULE, ageBest: 15 }], ["築年 20", { ...STAR_RANK_RULE, ageBest: 20 }], ["築年 25", { ...STAR_RANK_RULE, ageBest: 25 }],
    ["広さ 8", { ...STAR_RANK_RULE, areaBest: 8 }], ["広さ 0", { ...STAR_RANK_RULE, areaBest: 0 }],
    ["広さ 8・築年 15", { ...STAR_RANK_RULE, areaBest: 8, ageBest: 15 }], ["広さ 8・築年 20", { ...STAR_RANK_RULE, areaBest: 8, ageBest: 20 }],
    ["広さ 15・築年 15", { ...STAR_RANK_RULE, areaBest: 15, ageBest: 15 }],
  ];
  for (const [lab, rule] of ruleVariants) {
    let onlyNew = 0, onlyOld = 0;
    for (const e of eps) { const cs = fixCands(e, LV_FIX); if (cs.length < 2) continue; const a = hit(e, cs, pickFitSit), n = hit(e, cs, pickRule(rule)); if (n && !a) onlyNew++; if (a && !n) onlyOld++; }
    P(`  ${lab.padEnd(16)} ${fmt(rate(train, LV_FIX, pickRule(rule)))} ／ ${fmt(rate(test, LV_FIX, pickRule(rule)))} ／ ${fmt(rate(liveEps, LV_FIX, pickRule(rule)))} ・ ${onlyNew}／${onlyOld}`);
  }
  // 敷礼0 を状況によらず（全員に）
  {
    const allZero: Pick = (cs, e) => rankStarCandidates(cs.map(toStar), STAR_RANK_RULE, { ...e.sit, zero: true })[0]?.key ?? null;
    let onlyNew = 0, onlyOld = 0;
    for (const e of eps) { const cs = fixCands(e, LV_FIX); if (cs.length < 2) continue; const a = hit(e, cs, pickFitSit), n = hit(e, cs, allZero); if (n && !a) onlyNew++; if (a && !n) onlyOld++; }
    P(`  敷礼0 +15 を全員に   ${fmt(rate(train, LV_FIX, allZero))} ／ ${fmt(rate(test, LV_FIX, allZero))} ／ ${fmt(rate(liveEps, LV_FIX, allZero))} ・ ${onlyNew}／${onlyOld}`);
  }

  // ─── 10. 二人以上・広い間取りの型の言い方ごと（一番新しい +W）────────────────
  P(`\n=== 10. 型の言い方ごとに「一番新しい +W」: 型の回 ・ 🌟が一番新しい／ラ ・ 前7割 ／ 後3割 ／ live ・ 新だけ／旧だけ ===`);
  const ageF = (c: C) => (c.f.building_age == null ? null : -c.f.building_age);
  for (const ty of ["二人以上・広い間取り", "HH:最小2部屋以上", "HH:2部屋以上か二人の文", "HH:二人の文だけ", "HH:DK以上（1LDK含む）", "HH:間取りの話題", "一人暮らし"]) {
    const sub = eps.filter((e) => e.types.includes(ty)); const bo = bestOf(sub, ageF);
    for (const w of [10, 15, 20]) {
      const pk = withBonus([{ ty, lab: "新しさ", f: ageF, w }]);
      let onlyNew = 0, onlyOld = 0;
      for (const e of eps) { const cs = fixCands(e, LV_FIX); if (cs.length < 2) continue; const a = hit(e, cs, pickFitSit), n = hit(e, cs, pk); if (n && !a) onlyNew++; if (a && !n) onlyOld++; }
      P(`  ${ty.padEnd(18)} n=${String(sub.length).padStart(3)} 🌟一番新しい ${pct(bo.b, bo.n)}/${pct(bo.r, bo.n)}(${bo.n}) +${w}: ${fmt(rate(train, LV_FIX, pk))} ／ ${fmt(rate(test, LV_FIX, pk))} ／ ${fmt(rate(liveEps, LV_FIX, pk))} ・ ${onlyNew}／${onlyOld}`);
    }
  }

  if (args.out) writeFileSync(String(args.out), JSON.stringify({ measure, examples, typeOut, reasonCount, good: good.map((x) => ({ ty: x.b.ty, lab: x.b.lab, w: x.b.w, dTrain: x.dTrain, dTest: x.dTest, onlyNew: x.onlyNew, onlyOld: x.onlyOld })) }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
