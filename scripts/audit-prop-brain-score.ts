// scripts/audit-prop-brain-score.ts
// 物件出し（AIX ツール）のブレインの採点の当たりを、竹内さんの番／従業員の番に分けて数える（読むだけ・LLM なし・費用0・DB に書かない）。
//
// 2026-11-15 竹内さん「お客さんの条件をちゃんと読み取る部分と正確なスコアリングの部分で、今の返信のブレインの質と比べて、
//   AIX ツールのブレインの質も細かい部分を上げていく」（作業員K）。
//   正解は「スタッフが選んで送った🌟（一押し）」（memory feedback_property_selection_label）。お客様の返信は使わない。
//   回の組み方・値の補い・点の付け直しは scripts/audit-recommend-star-rank.ts の写し（そちらは触らない）。
//
// ■ 足した物
//   書き手 … recommendation_snapshots.aix_usage_log_id → aix_usage_logs.line_message_id → messages.staff_writer（takeuchi／employee）
//   1位一致 … 今の点（judgeProperty の付け直し）・🌟の並べ方（rankStarCandidates）・ランダム を書き手ごと
//   ツールの🌟 … 束の候補に残っている売上サポの🌟（candidates[].star）がスタッフの🌟と同じ割合
//   拡張の順位 … 束の候補の pool_rank（拡張の回の中の順位）で、スタッフの🌟が上位3／10に入る割合
//   ずれた項目 … 今の点の1位がスタッフの🌟と違う回で、1位の札の点 − 🌟の札の点 を項目ごと
//               （app/lib/prop-brain-score-category.ts の分け方）に足し、一番差が大きい項目を「ずれた項目」として数える
//               （🌟が1位と同点で外れた回は「同点」）
// ■ 個人情報: 会話もお客様も出さない（数だけ）。YUMA は外す
//
// 実行: npx tsx --env-file=.env.local scripts/audit-prop-brain-score.ts [--days=30] [--fill] [--json=path]
//   費用0。読むのは recommendation_snapshots（30日で約180行）と、その物件顧客の条件・履歴・送付だけ（軽い）。
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { categoryOfCode, SCORE_CATEGORIES } from "../app/lib/prop-brain-score-category";
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
  const writer = new Map<string, string>();
  const logIds = [...new Set(snaps.map((s) => String(s.aix_usage_log_id ?? "")).filter(Boolean))];
  const lmOf = new Map<string, string>();
  for (const c of chunks(logIds, 100)) {
    const { data } = await sb.from("aix_usage_logs").select("id, line_message_id").in("id", c);
    for (const r of (data ?? []) as Row[]) if (r.line_message_id) lmOf.set(String(r.id), String(r.line_message_id));
  }
  const wOfLm = new Map<string, string>();
  for (const c of chunks([...new Set(lmOf.values())], 100)) {
    const { data } = await sb.from("messages").select("line_message_id, staff_writer").in("line_message_id", c);
    for (const r of (data ?? []) as Row[]) wOfLm.set(String(r.line_message_id), String(r.staff_writer ?? "unknown"));
  }
  for (const s of snaps) writer.set(`snap:${s.id}`, wOfLm.get(lmOf.get(String(s.aix_usage_log_id ?? "")) ?? "") ?? "unknown");
  const snapOf = new Map<string, Row>(snaps.map((s) => [`snap:${s.id}`, s]));

  const groups: Array<[string, Ep[]]> = [["全体", eps], ["竹内さん", eps.filter((e) => writer.get(e.id) === "takeuchi")], ["従業員", eps.filter((e) => writer.get(e.id) === "employee")]];
  const scoreTop1 = (xs: Ep[]) => { let t = 0; for (const e of xs) { const mx = Math.max(...e.cands.map((c) => c.base)); const top = e.cands.filter((c) => c.base === mx); t += top.filter((c) => c.chosen).length / top.length; } return t / (xs.length || 1); };
  const rand = (xs: Ep[]) => xs.reduce((a, e) => a + e.cands.filter((c) => c.chosen).length / e.cands.length, 0) / (xs.length || 1);
  const toStar = (c: Cand) => ({ key: c.key, codes: c.codes, score: c.base, pointsOf: baseReasonPoints, areaSqm: c.feats.area_sqm, buildingAge: c.feats.building_age, structure: c.structure, equipmentCount: c.feats.equipment_count, equipWantHits: c.feats.equip_want_hits, adMonths: c.feats.ad_months });
  const starTop1 = (xs: Ep[]) => xs.filter((e) => { const r = rankStarCandidates(e.cands.map(toStar), STAR_RANK_RULE); return !!e.cands.find((c) => c.key === r[0].key)?.chosen; }).length / (xs.length || 1);

  // ツールの🌟（売上サポの🌟が束に残っている回）と拡張の順位
  const rawOf = (e: Ep) => { const v = snapOf.get(e.id)?.candidates; return ((typeof v === "string" ? JSON.parse(v) : v) ?? []) as Row[]; };
  const toolStar = (xs: Ep[]) => { let n = 0, hit = 0; for (const e of xs) { const ts = rawOf(e).filter((c) => c.star); if (!ts.length) continue; n++; if (ts.some((c) => c.is_star)) hit++; } return { n, hit }; };
  const poolRank = (xs: Ep[]) => { let n = 0, t3 = 0, t10 = 0; for (const e of xs) { const st = rawOf(e).find((c) => c.is_star); const r = Number(st?.pool_rank); if (st?.pool_rank == null || !Number.isFinite(r)) continue; n++; if (r <= 3) t3++; if (r <= 10) t10++; } return { n, t3, t10 }; };

  const out: Row = { days: DAYS, fill: FILL, groups: {} };
  console.log(`\n=== 採点の当たり（回・ランダム・今の点の1位・🌟の並べ方の1位・ツールの🌟＝スタッフの🌟・拡張の順位 上位3／上位10）===`);
  for (const [lab, xs] of groups) {
    const ts = toolStar(xs), pr = poolRank(xs);
    const g = { n: xs.length, random: rand(xs), scoreTop1: scoreTop1(xs), starRuleTop1: starTop1(xs), toolStar: ts, poolRank: pr };
    out.groups[lab] = g;
    console.log(`${lab.padEnd(6)} 回 ${String(xs.length).padStart(3)}・ラ ${pct(g.random)}・今の点 ${pct(g.scoreTop1)}・並べ方 ${pct(g.starRuleTop1)}・ツール🌟 ${ts.hit}/${ts.n}（${pct(ts.hit / (ts.n || 1))}）・拡張 上位3 ${pr.t3}/${pr.n}（${pct(pr.t3 / (pr.n || 1))}）上位10 ${pr.t10}/${pr.n}（${pct(pr.t10 / (pr.n || 1))}）`);
  }

  // ─── ずれた項目 ───
  console.log(`\n=== 今の点の1位がスタッフの🌟と違う回の「ずれた項目」（1位の札の点 − 🌟の札の点 が一番大きい項目）===`);
  for (const [lab, xs] of groups) {
    const cnt: Record<string, number> = {}; let miss = 0;
    const sumDiff: Record<string, number> = {};
    for (const e of xs) {
      const mx = Math.max(...e.cands.map((c) => c.base)); const top = e.cands.filter((c) => c.base === mx);
      if (top.length === 1 && top[0].chosen) continue;
      const star = e.cands.find((c) => c.chosen)!;
      miss++;
      if (star.base === mx) { cnt["同点"] = (cnt["同点"] ?? 0) + 1; continue; }
      const winner = top[0];
      const byCat = (codes: string[]) => { const m: Record<string, number> = {}; for (const k of codes) { const cat = categoryOfCode(k); m[cat] = (m[cat] ?? 0) + baseReasonPoints(k); } return m; };
      const a = byCat(winner.codes), b = byCat(star.codes);
      let best = "", bestD = 0;
      for (const cat of SCORE_CATEGORIES) { const d = (a[cat] ?? 0) - (b[cat] ?? 0); sumDiff[cat] = (sumDiff[cat] ?? 0) + Math.max(0, d); if (d > bestD) { bestD = d; best = cat; } }
      cnt[best || "不明"] = (cnt[best || "不明"] ?? 0) + 1;
    }
    out.groups[lab].drift = { miss, cnt, sumDiff };
    console.log(`${lab}（外れ ${miss}）: ` + Object.entries(cnt).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join("・"));
    console.log(`   差の合計（点）: ` + Object.entries(sumDiff).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join("・"));
  }
  if (args.json) writeFileSync(String(args.json), JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
