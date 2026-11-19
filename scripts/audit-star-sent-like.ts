// scripts/audit-star-sent-like.ts
// 「送ってきた物件・刺さった物件の像」（app/lib/sent-like-fit.ts）を🌟の並べ方に足した時、スタッフの🌟との1位一致が上がるか下がるかを過去の🌟の回で確かめる
// （読むだけ・LLM なし・費用0・DB に書かない）。回の組み方・点の付け直しは scripts/audit-recommend-star-rank.ts の写し。
//
// 2026-11-15 作業員K（統括役の頼み「送ってきた物件と刺さった物件を judgeProperty と🌟の並べ方へ渡す口」）
//   像の元: ①お客様が送ってきた物件（collectCustomerSentProperties・🌟を送る前の120日のお客様の発言・ページは取りに行かない）
//          ②刺さった物件（sent_properties.customer_reaction='interested'・🌟の束より前に送った物・値は rent_observations）
//   比べる: 今の点の1位／🌟の並べ方の1位、それぞれ像の点を足す前と後（書き手ごと・像のある回だけも）。対の比べ（片方だけ当たり）も出す
// ■ 個人情報: 会話もお客様も出さない（数だけ）。YUMA は外す
// 実行: npx tsx --env-file=.env.local scripts/audit-star-sent-like.ts [--days=60] --fill
import { createClient } from "@supabase/supabase-js";
import { collectCustomerSentProperties } from "../app/lib/customer-sent-property";
import { buildSentLikeProfile, sentLikePoints, type SentLikeItem } from "../app/lib/sent-like-fit";
import { baseReasonPoints, type SentRowLike, type PatternRowLike } from "../app/lib/property-brain";
import { customerAt, buildContext, episodeFromSnapshot, isCustomerSend, segmentsOf, type ConditionHistoryRow } from "../app/lib/scoring-learning-episodes";
import type { Episode, EpisodeCandidate } from "../app/lib/scoring-learning";
import { nameKey } from "../app/lib/candidate-facts";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";
import { rankStarCandidates, STAR_RANK_RULE } from "../app/lib/recommend-star-rank";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "180"), 10);
const FILL = !!args.fill;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = Record<string, any>;
const D = 864e5, H = 36e5;
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "-");
const chunks = <T,>(xs: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };
const normRoom = (r: unknown) => String(r ?? "").replace(/[^0-9A-Za-z]/g, "").replace(/^0+(?=\d)/, "");
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
const STRUCT_RANK: Record<string, number> = { RC: 2, SRC: 2, 鉄骨: 1, 軽量鉄骨: 1, 木造: 0 };

type Cand = EpisodeCandidate & { base: number; structure: string | null };
type Ep = Omit<Episode, "cands"> & { cands: Cand[]; live: boolean; sits: string[] };

function moveInUrgency(moveIn: unknown, atIso: string): string {
  const s = String(moveIn ?? "");
  if (!s.trim()) return "unknown";
  if (/即|すぐ|至急|急ぎ|今月|早め|なるべく早|今週|来週/.test(s)) return "urgent";
  const m = s.match(/(\d{1,2})\s*月/);
  if (m) return ((parseInt(m[1], 10) - (new Date(atIso).getMonth() + 1) + 12) % 12) <= 1 ? "urgent" : "later";
  return "unknown";
}

(async () => {
  const until = Date.now();
  const snaps = (await all((a, b) => sb.from("recommendation_snapshots").select("id, aix_usage_log_id, conversation_id, property_customer_id, sent_at, star_in_candidates, candidate_count, candidates, source, customer_wants")
    .gte("sent_at", new Date(until - DAYS * D).toISOString()).gte("candidate_count", 2).order("id").range(a, b) as never, 300)).filter((s) => s.conversation_id !== YUMA_CONVERSATION_ID && s.property_customer_id);
  const pcs = [...new Set(snaps.map((s) => String(s.property_customer_id)))];
  const custs = new Map<string, Row>(); const hist: Row[] = [], sents: Row[] = [], pats: Row[] = [];
  for (const c of chunks(pcs, 80)) {
    const { data } = await sb.from("property_customers").select("id, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, created_at, floor_area_min, raw_format_text, desired_area, commute_station, commute_minutes").in("id", c);
    for (const r of (data ?? []) as Row[]) custs.set(r.id, r);
    hist.push(...await all((a, b) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, created_at").in("property_customer_id", c).order("id").range(a, b) as never));
    sents.push(...await all((a, b) => sb.from("sent_properties").select("property_customer_id, property_name, room_no, rent, delivery, source, sent_at, customer_reaction").in("property_customer_id", c).order("id").range(a, b) as never));
    pats.push(...await all((a, b) => sb.from("property_selection_patterns").select("property_customer_id, selling_points, selection_label, created_at").in("property_customer_id", c).order("id").range(a, b) as never));
  }
  const g = (xs: Row[]) => { const m = new Map<string, Row[]>(); for (const x of xs) { const k = String(x.property_customer_id); if (!m.has(k)) m.set(k, []); m.get(k)!.push(x); } return m; };
  const hOf = g(hist), sOf = g(sents), pOf = g(pats);

  // 補う材料
  const byImage = new Map<string, Row>(); const roByKey = new Map<string, Row>();
  let linkErr = 0, imgFacts = 0;
  if (FILL) {
    const urls = [...new Set(snaps.flatMap((s) => ((s.candidates ?? []) as Row[]).map((c) => String(c.image_url ?? "")).filter(Boolean)))];
    for (const c of chunks(urls, 20)) {
      const { data, error } = await sb.from("sent_image_properties").select("image_url, property_name, room_no, facts").in("image_url", c).not("facts", "is", null);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Row[]) {
        imgFacts++;
        const fr = (r.facts as Row)?.room_no;
        if (fr != null && r.room_no != null && normRoom(fr) && normRoom(r.room_no) && normRoom(fr) !== normRoom(r.room_no)) { linkErr++; continue; }
        byImage.set(String(r.image_url), r.facts as Row);
      }
    }
    const ros = await all((a, b) => sb.from("rent_observations").select("property_name, room_no, rent, admin_fee, area_sqm, building_age, walk_minutes, structure, floor, deposit_months, key_money_months, equipment, ad_yen, floor_plan").order("id").range(a, b) as never);
    for (const r of ros) roByKey.set(`${nameKey(r.property_name)}#${normRoom(r.room_no)}`, r);
  }

  const have: Record<string, [number, number]> = {}; // 項目 → [補う前, 補った後]
  const KEYS = ["rent", "area_sqm", "building_age", "walk_minutes", "ad", "equipment", "structure", "deposit_months"];
  const has = (x: Row, k: string) => k === "ad" ? (x.ad_months != null || x.ad_yen != null) : k === "equipment" ? (Array.isArray(x.equipment) && x.equipment.length > 0) : k === "structure" ? x.__structure != null : x[k] != null;
  let candN = 0;
  const eps: Ep[] = [];
  for (const s of snaps) {
    const pc = String(s.property_customer_id); const base = custs.get(pc); if (!base) continue;
    const cands = ((typeof s.candidates === "string" ? JSON.parse(s.candidates) : s.candidates) ?? []) as Row[];
    const firstSent = Math.min(...cands.map((c) => Date.parse(String(c.sent_at ?? ""))).filter(Number.isFinite), Date.parse(s.sent_at));
    const { c } = customerAt(base, (hOf.get(pc) ?? []) as ConditionHistoryRow[], s.sent_at);
    const before = (sOf.get(pc) ?? []).filter((x) => Date.parse(x.sent_at) < firstSent - 60_000 && isCustomerSend(x)) as SentRowLike[];
    const pt = (pOf.get(pc) ?? []).filter((p) => Date.parse(p.created_at) < Date.parse(s.sent_at)) as PatternRowLike[];
    const ctx = buildContext(c, before, pt, s.sent_at);
    const filled = cands.map((cd) => {
      const x: Row = { ...cd };
      const fill = (k: string, v: unknown) => { if (x[k] == null && v != null && v !== "") x[k] = v; };
      if (FILL) {
        const f = byImage.get(String(cd.image_url ?? ""));
        if (f) {
          for (const k of ["rent", "admin_fee_yen", "area_sqm", "building_age", "walk_minutes", "floor_plan", "deposit_months", "key_money_months", "station"]) fill(k, f[k]);
          if (x.stations == null && Array.isArray(f.stations)) x.stations = f.stations;
          if (x.ad_months == null && x.ad_yen == null) { fill("ad_months", f.ad_months); fill("ad_yen", f.ad_yen); }
        }
        const ro = roByKey.get(`${nameKey(cd.name)}#${normRoom(cd.room_no)}`);
        if (ro) {
          fill("rent", ro.rent); fill("admin_fee_yen", ro.admin_fee); fill("area_sqm", ro.area_sqm != null ? Number(ro.area_sqm) : null); fill("building_age", ro.building_age);
          fill("walk_minutes", ro.walk_minutes); fill("floor", ro.floor); fill("deposit_months", ro.deposit_months != null ? Number(ro.deposit_months) : null);
          fill("key_money_months", ro.key_money_months != null ? Number(ro.key_money_months) : null); fill("floor_plan", ro.floor_plan);
          if (x.ad_yen == null && x.ad_months == null && ro.ad_yen != null) x.ad_yen = ro.ad_yen;
          if ((!Array.isArray(x.equipment) || !x.equipment.length) && ro.equipment && typeof ro.equipment === "object") x.equipment = Object.entries(ro.equipment as Row).filter(([, v]) => v === true).map(([k]) => k);
          x.__structure = ro.structure ?? null;
        }
      }
      return x;
    });
    if (s.star_in_candidates) {
      for (let i = 0; i < cands.length; i++) { candN++; for (const k of KEYS) { have[k] ??= [0, 0]; if (has(cands[i], k)) have[k][0]++; if (has(filled[i], k)) have[k][1]++; } }
    }
    let e: Episode | null = null;
    try { e = episodeFromSnapshot({ ...s, candidates: filled }, ctx); } catch { e = null; }
    if (!e) continue;
    const ec: Cand[] = e.cands.map((cc) => {
      const src = filled.find((fc) => cc.key === `${fc.name}${fc.room_no ? ` ${normRoom(fc.room_no)}` : ""}`) ?? filled.find((fc) => cc.key.startsWith(String(fc.name)));
      const st = (src?.__structure as string | null | undefined) ?? null;
      cc.feats.structure_rank = st != null && st in STRUCT_RANK ? STRUCT_RANK[st] : null;
      return { ...cc, base: 50 + cc.codes.reduce((a, k) => a + baseReasonPoints(k), 0), structure: st };
    });
    // 状況
    const t = Date.parse(s.sent_at);
    const priorStars = snaps.filter((x) => x.conversation_id === s.conversation_id && Date.parse(x.sent_at) < t - 10 * 60_000).length;
    const prior = (sOf.get(pc) ?? []).filter((x) => x.delivery !== "shared" && Date.parse(x.sent_at) < firstSent - H);
    const wants = new Set(((s.customer_wants ?? []) as Row[]).map((w) => String(w.key)));
    const rentMax = Number(c.rent_max ?? c.max_rent ?? 0) || null;
    const sits: string[] = [priorStars === 0 && prior.length === 0 ? "最初" : "2回目以降", `入居 ${moveInUrgency(c.move_in_time, s.sent_at)}`];
    if (rentMax) sits.push(rentMax < 70000 ? "予算7万未満" : rentMax < 100000 ? "予算7〜10万" : "予算10万以上");
    if (wants.has("pet") || c.pet) sits.push("ペット");
    if (wants.has("screening")) sits.push("審査が不安");
    if (e.segments.includes("low_initial") || wants.has("low_initial")) sits.push("初期費用重視");
    if (prior.some((x) => x.customer_reaction === "rejected")) sits.push("断った後");
    eps.push({ ...e, cands: ec, live: s.source === "live", sits, segments: segmentsOf(ctx.profile, ctx.customer) });
  }
  eps.sort((a, b) => a.at.localeCompare(b.at));


  // ─── 書き手 ───
  const lmOf = new Map<string, string>(), wOfLm = new Map<string, string>();
  for (const c of chunks([...new Set(snaps.map((s) => String(s.aix_usage_log_id ?? "")).filter(Boolean))], 100)) {
    const { data } = await sb.from("aix_usage_logs").select("id, line_message_id").in("id", c);
    for (const r of (data ?? []) as Row[]) if (r.line_message_id) lmOf.set(String(r.id), String(r.line_message_id));
  }
  for (const c of chunks([...new Set(lmOf.values())], 100)) {
    const { data } = await sb.from("messages").select("line_message_id, staff_writer").in("line_message_id", c);
    for (const r of (data ?? []) as Row[]) wOfLm.set(String(r.line_message_id), String(r.staff_writer ?? "unknown"));
  }
  const snapOf = new Map<string, Row>(snaps.map((s) => [`snap:${s.id}`, s]));
  const writerOf = (e: Ep) => wOfLm.get(lmOf.get(String(snapOf.get(e.id)?.aix_usage_log_id ?? "")) ?? "") ?? "unknown";

  // ─── 像の元①: お客様が送ってきた物件（お客様の発言だけ・画像の書き起こしと URL）───
  const convs = [...new Set(snaps.map((s) => String(s.conversation_id)))];
  const msgsOf = new Map<string, Row[]>();
  const since = new Date(Date.now() - (DAYS + 120) * D).toISOString();
  for (const c of chunks(convs, 20)) {
    const ms = await all((a, b) => sb.from("messages").select("conversation_id, sender, text, image_type, created_at").in("conversation_id", c).eq("sender", "customer").gte("created_at", since).order("id").range(a, b) as never);
    for (const m of ms) { const k = String(m.conversation_id); if (!msgsOf.has(k)) msgsOf.set(k, []); msgsOf.get(k)!.push(m); }
  }
  if (!FILL) console.log("※ --fill が無いと刺さった物件の値（rent_observations）が読めません");

  const rawOf = (e: Ep) => { const v = snapOf.get(e.id)?.candidates; return ((typeof v === "string" ? JSON.parse(v) : v) ?? []) as Row[]; };
  let withProfile = 0, fromCust = 0, fromInt = 0;
  const likeOf = new Map<string, Map<string, number>>();
  for (const e of eps) {
    const s = snapOf.get(e.id)!; const t = Date.parse(s.sent_at);
    const ms = (msgsOf.get(String(s.conversation_id)) ?? []).filter((m) => Date.parse(m.created_at) < t - 60_000 && Date.parse(m.created_at) >= t - 120 * D)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const items: SentLikeItem[] = collectCustomerSentProperties(ms as never).items.map((x) => ({ floorPlan: x.madori, areaSqm: x.areaSqm, ageYears: x.ageYears, walk: x.walk, from: "customer_sent" as const }));
    const raw = rawOf(e);
    const firstSent = Math.min(...raw.map((c) => Date.parse(String(c.sent_at ?? ""))).filter(Number.isFinite), t);
    const inter = (sOf.get(String(s.property_customer_id)) ?? []).filter((x) => x.customer_reaction === "interested" && Date.parse(x.sent_at) < firstSent - 60_000);
    for (const x of inter) {
      const ro = roByKey.get(`${nameKey(x.property_name)}#${normRoom(x.room_no)}`);
      if (ro) items.push({ floorPlan: ro.floor_plan, areaSqm: ro.area_sqm != null ? Number(ro.area_sqm) : null, ageYears: ro.building_age, walk: ro.walk_minutes, from: "interested" });
    }
    const p = buildSentLikeProfile(items);
    if (!p) continue;
    withProfile++; if (items.some((i) => i.from === "customer_sent")) fromCust++; if (items.some((i) => i.from === "interested")) fromInt++;
    const m = new Map<string, number>();
    for (const c of e.cands) {
      const src = raw.find((fc) => c.key === `${fc.name}${fc.room_no ? ` ${normRoom(fc.room_no)}` : ""}`) ?? raw.find((fc) => c.key.startsWith(String(fc.name)));
      m.set(c.key, sentLikePoints(p, { floorPlan: src?.floor_plan ?? null, areaSqm: c.feats.area_sqm, buildingAge: c.feats.building_age, walkMinutes: c.feats.walk_minutes ?? c.feats.walk ?? null }).points);
    }
    likeOf.set(e.id, m);
  }
  const like = (e: Ep, c: Cand, on: boolean) => (on ? likeOf.get(e.id)?.get(c.key) ?? 0 : 0);
  const scoreHit = (e: Ep, on: boolean) => { const v = e.cands.map((c) => c.base + like(e, c, on)); const mx = Math.max(...v); const top = e.cands.filter((_, i) => v[i] === mx); return top.filter((c) => c.chosen).length / top.length; };
  const toStar = (e: Ep, c: Cand, on: boolean) => ({ key: c.key, codes: c.codes, score: c.base + like(e, c, on), pointsOf: baseReasonPoints, areaSqm: c.feats.area_sqm, buildingAge: c.feats.building_age, structure: c.structure, equipmentCount: c.feats.equipment_count, equipWantHits: c.feats.equip_want_hits, adMonths: c.feats.ad_months });
  const starHit = (e: Ep, on: boolean) => { const r = rankStarCandidates(e.cands.map((c) => toStar(e, c, on)), STAR_RANK_RULE); return e.cands.find((c) => c.key === r[0].key)?.chosen ? 1 : 0; };
  const avg = (xs: Ep[], f: (e: Ep) => number) => xs.reduce((a, e) => a + f(e), 0) / (xs.length || 1);

  console.log(`\n=== 像のある回 ${withProfile}/${eps.length}（送ってきた物件 ${fromCust}・刺さった物件 ${fromInt}）===`);
  const groups: Array<[string, Ep[]]> = [["全体", eps], ["竹内さん", eps.filter((e) => writerOf(e) === "takeuchi")], ["従業員", eps.filter((e) => writerOf(e) === "employee")], ["像のある回", eps.filter((e) => likeOf.has(e.id))]];
  console.log(`（回・今の点の1位 前→後・🌟の並べ方の1位 前→後・並べ方の対の比べ 後だけ当たり／前だけ当たり）`);
  for (const [lab, xs] of groups) {
    let onlyNew = 0, onlyOld = 0;
    for (const e of xs) { const a = starHit(e, false), b = starHit(e, true); if (b && !a) onlyNew++; if (a && !b) onlyOld++; }
    console.log(`${lab.padEnd(6)} 回 ${String(xs.length).padStart(3)}・今の点 ${pct(avg(xs, (e) => scoreHit(e, false)))}→${pct(avg(xs, (e) => scoreHit(e, true)))}・並べ方 ${pct(avg(xs, (e) => starHit(e, false)))}→${pct(avg(xs, (e) => starHit(e, true)))}・後だけ ${onlyNew}／前だけ ${onlyOld}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
