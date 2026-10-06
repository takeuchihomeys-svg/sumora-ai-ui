// scripts/audit-recommend-star-rank.ts
// 🌟（物件オススメ＝束の中の一番）の並べ方 app/lib/recommend-star-rank.ts を、保存済みの🌟の回に当てて、
// スタッフの🌟との1位一致を「今の点（ピックアップの点）」と並べて出す（読むだけ・LLM なし・費用0・DB に書かない）。
//
// 2026-10-06 竹内さんの決定（⑰）: 束の中の一番は合い方が主軸・AD は線（1.5）・線の上に刺さる物が無ければ低い AD でも合う物（内覧を組むのが優先）。
//   切り替えるのは「全体で悪くならず・直近（後3割・live）で良くなる」時だけ。
//
// ■ 材料
//   回 … recommendation_snapshots（候補2件以上・🌟が候補にある）。条件はその時点に戻す（customerAt）。点は今の判定で付け直し（episodeFromSnapshot）
//   候補の値の補い（--fill の時）… ①送った画像の読み取り sent_image_properties.facts（候補の image_url で引く）
//                                  ②rent_observations（建物名＋号室）。どちらも候補に無い項目だけ埋める
//   読み取りの結び違い … 同じ画像が別の物件名の行に結ばれた古い行（8/16 等）がある。facts.room_no と行の room_no（正規化）が違う行は使わない（数を出す）
// ■ 出す物: 値の有り率（補う前→後）・1位一致（今の点／並べ方の案ごと × 全体・後3割・live）・状況ごとの数
// ■ 個人情報: 会話もお客様も出さない（数だけ）。YUMA は外す
//
// 実行: npx tsx --env-file=.env.local scripts/audit-recommend-star-rank.ts [--days=180] [--fill]
import { createClient } from "@supabase/supabase-js";
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
  const snaps = (await all((a, b) => sb.from("recommendation_snapshots").select("id, conversation_id, property_customer_id, sent_at, star_in_candidates, candidate_count, candidates, source, customer_wants")
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
  const hold = eps.slice(Math.floor(eps.length * 0.7)), live = eps.filter((e) => e.live);

  console.log(`=== 材料 ${FILL ? "（補った後）" : "（補う前）"} ===`);
  console.log(`回 ${eps.length}（live ${live.length}・後3割 ${hold.length}）・候補 ${candN}`);
  if (FILL) console.log(`送った画像の読み取り（候補の画像に当たった行）${imgFacts}・結び違いで外した ${linkErr}`);
  console.log(`値の有り率（補う前 → ${FILL ? "補った後" : "同じ"}）: ` + KEYS.map((k) => `${k} ${pct(have[k][0] / candN)}→${pct(have[k][1] / candN)}`).join("・"));

  // 1位一致
  const scoreTop1 = (xs: Ep[]) => { let t = 0; for (const e of xs) { const mx = Math.max(...e.cands.map((c) => c.base)); const top = e.cands.filter((c) => c.base === mx); t += top.filter((c) => c.chosen).length / top.length; } return t / (xs.length || 1); };
  const scoreTop1First = (xs: Ep[]) => { let t = 0; for (const e of xs) { const mx = Math.max(...e.cands.map((c) => c.base)); if (e.cands.find((c) => c.base === mx)!.chosen) t++; } return t / (xs.length || 1); };
  const rand = (xs: Ep[]) => xs.reduce((a, e) => a + e.cands.filter((c) => c.chosen).length / e.cands.length, 0) / (xs.length || 1);
  const toStar = (c: Cand) => ({ key: c.key, codes: c.codes, score: c.base, pointsOf: baseReasonPoints, areaSqm: c.feats.area_sqm, buildingAge: c.feats.building_age, structure: c.structure, equipmentCount: c.feats.equipment_count, equipWantHits: c.feats.equip_want_hits, adMonths: c.feats.ad_months });
  const starTop1 = (xs: Ep[], rule: typeof STAR_RANK_RULE) => xs.filter((e) => { const r = rankStarCandidates(e.cands.map(toStar), rule); return !!e.cands.find((c) => c.key === r[0].key)?.chosen; }).length / (xs.length || 1);
  console.log(`\n=== 1位一致（全体 ／ 後3割 ／ live）===`);
  console.log(`ランダム                 ${pct(rand(eps))} ／ ${pct(rand(hold))} ／ ${pct(rand(live))}`);
  console.log(`今の点（同点は按分）       ${pct(scoreTop1(eps))} ／ ${pct(scoreTop1(hold))} ／ ${pct(scoreTop1(live))}`);
  console.log(`今の点（同点は元の並び）    ${pct(scoreTop1First(eps))} ／ ${pct(scoreTop1First(hold))} ／ ${pct(scoreTop1First(live))}`);
  const variants: Array<[string, typeof STAR_RANK_RULE]> = [
    ["並べ方 既定（線1.5・差15）", STAR_RANK_RULE],
    ["差 10", { ...STAR_RANK_RULE, overrideMargin: 10 }],
    ["差 25", { ...STAR_RANK_RULE, overrideMargin: 25 }],
    ["線 1.0", { ...STAR_RANK_RULE, adLine: 1.0 }],
    ["線 2.0", { ...STAR_RANK_RULE, adLine: 2.0 }],
    ["広さ +10", { ...STAR_RANK_RULE, areaBest: 10 }],
    ["構造・設備なし", { ...STAR_RANK_RULE, structureRc: 0, structureWood: 0, equipRankMax: 0, equipWantEach: 0 }],
  ];
  for (const [lab, rule] of variants) console.log(`${lab.padEnd(22)} ${pct(starTop1(eps, rule))} ／ ${pct(starTop1(hold, rule))} ／ ${pct(starTop1(live, rule))}`);

  // 対になった比べ（同じ回で 片方だけ当たった数）＝差が揺れの内かを見る
  const disc = (xs: Ep[]) => {
    let onlyNew = 0, onlyOld = 0;
    for (const e of xs) {
      const mx = Math.max(...e.cands.map((c) => c.base));
      const oldHit = !!e.cands.find((c) => c.base === mx)!.chosen;
      const r = rankStarCandidates(e.cands.map(toStar), STAR_RANK_RULE);
      const newHit = !!e.cands.find((c) => c.key === r[0].key)?.chosen;
      if (newHit && !oldHit) onlyNew++; if (oldHit && !newHit) onlyOld++;
    }
    return `並べ方だけ当たり ${onlyNew}・今の点だけ当たり ${onlyOld}`;
  };
  console.log(`対の比べ（今の点は同点を元の並び）: 全体 ${disc(eps)}／後3割 ${disc(hold)}／live ${disc(live)}`);

  // 🌟が束の中で一番の率（値のある候補2件以上の回）
  console.log(`\n=== 🌟が束の中で一番（ランダム）===`);
  for (const [f, d] of [["area_sqm", "high"], ["building_age", "low"], ["walk", "low"], ["rent_ratio", "high"], ["rent_ratio", "low"], ["ad_months", "high"], ["equipment_count", "high"], ["structure_rank", "high"], ["plan_match", "high"], ["zero_zero", "high"]] as Array<[string, "high" | "low"]>) {
    let n = 0, best = 0, r = 0;
    for (const e of eps) {
      const vals = e.cands.map((c) => c.feats[f]).filter((x): x is number => x != null);
      const st = e.cands.find((c) => c.chosen)!.feats[f];
      if (st == null || vals.length < 2) continue;
      n++; r += vals.filter((x) => x === (d === "high" ? Math.max(...vals) : Math.min(...vals))).length / vals.length;
      if (st === (d === "high" ? Math.max(...vals) : Math.min(...vals))) best++;
    }
    console.log(`  ${f}(${d === "high" ? "大" : "小"}) 回 ${n} 🌟が一番(同じ値含む) ${pct(best / (n || 1))}（ランダム ${pct(r / (n || 1))}）`);
  }

  console.log(`\n=== 状況ごと（回 ・ ランダム ・ 今の点(按分) → 並べ方 既定）===`);
  for (const s of [...new Set(eps.flatMap((e) => e.sits))].sort()) {
    const sub = eps.filter((e) => e.sits.includes(s)); if (sub.length < 10) continue;
    console.log(`  ${s.padEnd(12)} n=${String(sub.length).padStart(3)} ラ ${pct(rand(sub))} ・ 今 ${pct(scoreTop1(sub))} → 並べ方 ${pct(starTop1(sub, STAR_RANK_RULE))}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
