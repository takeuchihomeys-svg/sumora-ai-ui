// scripts/audit-appeal-fit-lines.ts
// 統括役の (a) の残り2つ: 竹内さんの「お部屋の中でも」の強さ・狙う返事を、推した物件（束の🌟）の
//   ①条件の合い方（判定の札に外れ＝負の点の札があるか・全部合うか）②判定の点（束の中で一番か・2番以下か）で分ける（読むだけ・LLM なし・費用0）。
//   回の組み方・点の付け直しは scripts/audit-recommend-star-rank.ts の写し。線が無ければ「見つからない」と出す。
// 実行: npx tsx --env-file=.env.local scripts/audit-appeal-fit-lines.ts [--days=120] --fill
import { createClient } from "@supabase/supabase-js";
import { appealRecordFromText } from "../app/lib/appeal-record";
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

  const snapOf = new Map<string, Row>(snaps.map((s) => [`snap:${s.id}`, s]));
  type F = { fit: string; rank: string; aim: string; strength: string };
  const fs2: F[] = [];
  for (const e of eps) {
    const s = snapOf.get(e.id)!; const t = Date.parse(s.sent_at);
    const { data: ms } = await sb.from("messages").select("text, created_at").eq("conversation_id", s.conversation_id).eq("sender", "staff").eq("staff_writer", "takeuchi")
      .gte("created_at", new Date(t).toISOString()).lte("created_at", new Date(t + 2 * H).toISOString()).like("text", "%お部屋の中でも%").limit(1);
    const m = (ms ?? [])[0] as Row | undefined; if (!m) continue;
    const star = e.cands.find((c) => c.chosen)!;
    const neg = star.codes.filter((k) => baseReasonPoints(k) < 0);
    const fit = neg.length ? "外れあり" : "全部合う";
    const better = e.cands.filter((c) => c.base > star.base).length;
    const rank = better === 0 ? "点が一番" : "2番以下";
    const r = appealRecordFromText(String(m.text), { surface: "reply", writer: "takeuchi" });
    fs2.push({ fit, rank, aim: r.aim, strength: r.strength });
  }
  const n = fs2.length;
  console.log(`\n竹内さんの🌟の直後の「お部屋の中でも」と結べた ${n}通（${DAYS}日）`);
  const base = fs2.filter((f) => f.aim === "viewing").length / (n || 1);
  const lines: string[] = [];
  for (const key of ["fit", "rank"] as const) {
    console.log(`=== ${key === "fit" ? "①条件の合い方（推した物件の判定の札）" : "②判定の点（束の中で）"} ===`);
    const g = new Map<string, F[]>(); for (const f of fs2) { if (!g.has(f[key])) g.set(f[key], []); g.get(f[key])!.push(f); }
    for (const [k, xs] of g) {
      const c = (fl: "aim" | "strength") => { const mm = new Map<string, number>(); for (const x of xs) mm.set(x[fl], (mm.get(x[fl]) ?? 0) + 1); return [...mm.entries()].sort((a, b) => b[1] - a[1]).map(([v, cc]) => `${v} ${cc}`).join("・"); };
      console.log(`  ${k.padEnd(6)} ${String(xs.length).padStart(3)}通 ｜ 狙う返事: ${c("aim")} ｜ 強さ: ${c("strength")}`);
      const v = xs.filter((x) => x.aim === "viewing").length / xs.length;
      const sInv = xs.filter((x) => x.strength === "invite").length / xs.length;
      if (xs.length >= 5 && (Math.abs(v - base) >= 0.3)) lines.push(`${key}=${k}（${xs.length}通）で内覧に案内 ${Math.round(v * 100)}%（全体 ${Math.round(base * 100)}%）`);
      void sInv;
    }
  }
  console.log(lines.length ? `線の候補:\n  ${lines.join("\n  ")}` : "線の候補: 見つからない（条件の合い方・判定の点で内覧に案内の割合が全体と30点以上変わらない）");
})().catch((e) => { console.error(e); process.exit(1); });
