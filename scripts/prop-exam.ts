// scripts/prop-exam.ts — 物件出しの試験 A: 🌟の並べ方（決定論・LLM なし・費用0）
//
// 2026-11-18 作業員K（統括役の付け忘れ防止の表「物件出しのブレインの6つ」の②・A）。
//   問題＝竹内さんの🌟の回（recommendation_snapshots・messages.staff_writer='takeuchi' の送信だけ。従業員の回は正解にしない＝決まり）。
//   写す物: 束の候補（送った画像の読み取り・rent_observations で値を補った後）・その番の時点の条件（property_condition_history で戻す）・
//          その番より前の送付と選定パターン。正解＝竹内さんの🌟（is_star）。
//   解く: 今のコードの judgeProperty（scoring-learning-episodes.episodeFromSnapshot）・🌟の並べ方（recommend-star-rank.rankStarCandidates）で
//         1位一致・3位以内・平均の順位を出す。--baseline で前の結果と比べ、悪くなった問題（前は1位一致・今は外れ）を並べる。
//   回すのは property-brain・recommend-star-rank・star-rank-pickup・recommend-score を変えた時（前と後で悪くなった問題が0か）。
//
// 実行:
//   作る（DB を読む・重い読みは JST 22時以降）: npx tsx --env-file=.env.local scripts/prop-exam.ts --build [--days=120]
//   解く（DB を読まない）: npx tsx scripts/prop-exam.ts --label=<名前> [--baseline=<前の名前>]
//   問題: <倉庫の根>/.claude/exam-cache/prop-exam/problems.json（会話・お客様の名前は持たない・物件名と値だけ）
//   結果: <倉庫の根>/.claude/exam-cache/prop-exam/results/<label>.json
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { baseReasonPoints, type SentRowLike, type PatternRowLike } from "../app/lib/property-brain";
import { customerAt, buildContext, episodeFromSnapshot, isCustomerSend, type ConditionHistoryRow } from "../app/lib/scoring-learning-episodes";
import { rankStarCandidates, STAR_RANK_RULE } from "../app/lib/recommend-star-rank";
import { nameKey } from "../app/lib/candidate-facts";

type Row = Record<string, any>;
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
// 倉庫の根（作業ツリーの中でも同じ所）
const repoRoot = (() => { const p = resolve(process.cwd()); const i = p.replace(/\\/g, "/").indexOf("/.claude/worktrees/"); return i >= 0 ? p.slice(0, i) : p; })();
const DIR = join(repoRoot, ".claude", "exam-cache", "prop-exam");
const PROBLEMS = join(DIR, "problems.json");
const normRoom = (r: unknown) => String(r ?? "").replace(/[^0-9A-Za-z]/g, "").replace(/^0+(?=\d)/, "");
const STRUCT_RANK: Record<string, number> = { RC: 2, SRC: 2, 鉄骨: 1, 軽量鉄骨: 1, 木造: 0 };

export type PropProblem = { id: string; sentAt: string; snap: Row; customer: Row; sentBefore: SentRowLike[]; patterns: PatternRowLike[] };

async function build() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const { TEST_ONLY_CONVERSATION_IDS } = await import("../app/lib/test-conversations");
  const days = Number(args.days ?? 120);
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const page = async (q: (a: number, b: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>) => { const out: Row[] = []; for (let p = 0; p < 80; p++) { const { data, error } = await q(p * 500, p * 500 + 499); if (error) throw new Error(error.message); out.push(...((data ?? []) as Row[])); if (!data || data.length < 500) break; } return out; };
  const chunks = <T,>(xs: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };
  const snaps0 = (await page((a, b) => sb.from("recommendation_snapshots").select("id, aix_usage_log_id, conversation_id, property_customer_id, sent_at, star_in_candidates, candidate_count, candidates").gte("sent_at", since).gte("candidate_count", 2).order("id").range(a, b) as never))
    .filter((s) => s.property_customer_id && s.star_in_candidates && !TEST_ONLY_CONVERSATION_IDS.includes(String(s.conversation_id)));
  // 竹内さんの回だけ
  const lm = new Map<string, string>();
  for (const c of chunks([...new Set(snaps0.map((s) => String(s.aix_usage_log_id ?? "")).filter(Boolean))], 100)) { const { data } = await sb.from("aix_usage_logs").select("id, line_message_id").in("id", c); for (const r of (data ?? []) as Row[]) if (r.line_message_id) lm.set(String(r.id), String(r.line_message_id)); }
  const tk = new Set<string>();
  for (const c of chunks([...new Set(lm.values())], 100)) { const { data } = await sb.from("messages").select("line_message_id, staff_writer").in("line_message_id", c); for (const r of (data ?? []) as Row[]) if (r.staff_writer === "takeuchi") tk.add(String(r.line_message_id)); }
  const snaps = snaps0.filter((s) => tk.has(lm.get(String(s.aix_usage_log_id ?? "")) ?? ""));
  const pcs = [...new Set(snaps.map((s) => String(s.property_customer_id)))];
  const custs = new Map<string, Row>(); const hist: Row[] = [], sents: Row[] = [], pats: Row[] = [];
  for (const c of chunks(pcs, 80)) {
    const { data } = await sb.from("property_customers").select("id, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, created_at, floor_area_min, raw_format_text, desired_area, commute_station, commute_minutes, structure_types, requirement_strength").in("id", c);
    for (const r of (data ?? []) as Row[]) custs.set(String(r.id), r);
    hist.push(...await page((a, b) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, created_at").in("property_customer_id", c).order("id").range(a, b) as never));
    sents.push(...await page((a, b) => sb.from("sent_properties").select("property_customer_id, property_name, room_no, rent, delivery, source, sent_at, customer_reaction").in("property_customer_id", c).order("id").range(a, b) as never));
    pats.push(...await page((a, b) => sb.from("property_selection_patterns").select("property_customer_id, selling_points, selection_label, created_at").in("property_customer_id", c).order("id").range(a, b) as never));
  }
  // 値の補い（audit-recommend-star-rank の --fill と同じ）
  const byImage = new Map<string, Row>();
  for (const c of chunks([...new Set(snaps.flatMap((s) => ((s.candidates ?? []) as Row[]).map((x) => String(x.image_url ?? "")).filter(Boolean)))], 20)) {
    const { data } = await sb.from("sent_image_properties").select("image_url, room_no, facts").in("image_url", c).not("facts", "is", null);
    for (const r of (data ?? []) as Row[]) { const fr = (r.facts as Row)?.room_no; if (fr != null && r.room_no != null && normRoom(fr) && normRoom(r.room_no) && normRoom(fr) !== normRoom(r.room_no)) continue; byImage.set(String(r.image_url), r.facts as Row); }
  }
  // 全件は読まない: 候補の物件名だけ
  const names = [...new Set(snaps.flatMap((s) => ((s.candidates ?? []) as Row[]).map((x) => String(x.name ?? "")).filter(Boolean)))];
  const ros: Row[] = [];
  for (const c of chunks(names, 50)) { const { data } = await sb.from("rent_observations").select("property_name, room_no, rent, admin_fee, area_sqm, building_age, walk_minutes, structure, floor, deposit_months, key_money_months, equipment, ad_yen, floor_plan").in("property_name", c); ros.push(...((data ?? []) as Row[])); }
  const roByKey = new Map<string, Row>(ros.map((r) => [`${nameKey(r.property_name)}#${normRoom(r.room_no)}`, r]));
  const g = (xs: Row[]) => { const m = new Map<string, Row[]>(); for (const x of xs) { const k = String(x.property_customer_id); if (!m.has(k)) m.set(k, []); m.get(k)!.push(x); } return m; };
  const hOf = g(hist), sOf = g(sents), pOf = g(pats);
  const problems: PropProblem[] = [];
  for (const s of snaps) {
    const pc = String(s.property_customer_id); const base = custs.get(pc); if (!base) continue;
    const cands = ((typeof s.candidates === "string" ? JSON.parse(s.candidates) : s.candidates) ?? []) as Row[];
    const firstSent = Math.min(...cands.map((c) => Date.parse(String(c.sent_at ?? ""))).filter(Number.isFinite), Date.parse(s.sent_at));
    const { c } = customerAt(base, (hOf.get(pc) ?? []) as ConditionHistoryRow[], s.sent_at);
    const filled = cands.map((cd) => {
      const x: Row = { ...cd };
      const fill = (k: string, v: unknown) => { if (x[k] == null && v != null && v !== "") x[k] = v; };
      const f = byImage.get(String(cd.image_url ?? ""));
      if (f) { for (const k of ["rent", "admin_fee_yen", "area_sqm", "building_age", "walk_minutes", "floor_plan", "deposit_months", "key_money_months", "station"]) fill(k, f[k]); if (x.stations == null && Array.isArray(f.stations)) x.stations = f.stations; if (x.ad_months == null && x.ad_yen == null) { fill("ad_months", f.ad_months); fill("ad_yen", f.ad_yen); } }
      const ro = roByKey.get(`${nameKey(cd.name)}#${normRoom(cd.room_no)}`);
      if (ro) { fill("rent", ro.rent); fill("admin_fee_yen", ro.admin_fee); fill("area_sqm", ro.area_sqm != null ? Number(ro.area_sqm) : null); fill("building_age", ro.building_age); fill("walk_minutes", ro.walk_minutes); fill("floor", ro.floor); fill("deposit_months", ro.deposit_months != null ? Number(ro.deposit_months) : null); fill("key_money_months", ro.key_money_months != null ? Number(ro.key_money_months) : null); fill("floor_plan", ro.floor_plan); if (x.ad_yen == null && x.ad_months == null && ro.ad_yen != null) x.ad_yen = ro.ad_yen; x.__structure = ro.structure ?? null; }
      delete x.image_url; delete x.pdf_url;
      return x;
    });
    const sentBefore = (sOf.get(pc) ?? []).filter((x) => Date.parse(x.sent_at) < firstSent - 60_000 && isCustomerSend(x)).map((x) => ({ property_name: x.property_name, room_no: x.room_no, rent: x.rent, delivery: x.delivery, source: x.source, sent_at: x.sent_at, customer_reaction: x.customer_reaction })) as SentRowLike[];
    const patterns = (pOf.get(pc) ?? []).filter((p) => Date.parse(p.created_at) < Date.parse(s.sent_at)).map((p) => ({ selling_points: p.selling_points, selection_label: p.selection_label, created_at: p.created_at })) as PatternRowLike[];
    const { id: _cid, ...cust } = c as Row;
    problems.push({ id: `p${s.id}`, sentAt: s.sent_at, snap: { id: s.id, sent_at: s.sent_at, star_in_candidates: true, candidates: filled }, customer: cust, sentBefore, patterns });
  }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(PROBLEMS, JSON.stringify({ builtAt: new Date().toISOString(), days, problems }, null, 1));
  console.log(`問題 ${problems.length}（竹内さんの🌟の回・${days}日）→ ${PROBLEMS}`);
}

function solve() {
  if (!existsSync(PROBLEMS)) throw new Error(`問題が無い: ${PROBLEMS}（先に --build）`);
  const { problems } = JSON.parse(readFileSync(PROBLEMS, "utf8")) as { problems: PropProblem[] };
  const per: Array<{ id: string; n: number; scoreRank: number; starRank: number; scoreTop1: boolean; starTop1: boolean }> = [];
  for (const p of problems) {
    const ctx = buildContext(p.customer, p.sentBefore, p.patterns, p.sentAt);
    const e = episodeFromSnapshot(p.snap, ctx);
    if (!e) continue;
    const cands = e.cands.map((cc) => {
      const src = (p.snap.candidates as Row[]).find((fc) => cc.key === `${fc.name}${fc.room_no ? ` ${normRoom(fc.room_no)}` : ""}`);
      const st = (src?.__structure as string | null | undefined) ?? null;
      return { ...cc, base: 50 + cc.codes.reduce((a, k) => a + baseReasonPoints(k), 0), structure: st };
    });
    const star = cands.find((c) => c.chosen); if (!star) continue;
    const scoreRank = 1 + cands.filter((c) => c.base > star.base).length + cands.filter((c) => c !== star && c.base === star.base).length / 2;
    const ranked = rankStarCandidates(cands.map((c) => ({ key: c.key, codes: c.codes, score: c.base, pointsOf: baseReasonPoints, areaSqm: c.feats.area_sqm, buildingAge: c.feats.building_age, structure: c.structure, equipmentCount: c.feats.equipment_count, equipWantHits: c.feats.equip_want_hits, adMonths: c.feats.ad_months })), STAR_RANK_RULE);
    const starRank = 1 + ranked.findIndex((r) => r.key === star.key);
    per.push({ id: p.id, n: cands.length, scoreRank, starRank, scoreTop1: scoreRank === 1, starTop1: starRank === 1 });
  }
  const n = per.length;
  const pct = (a: number) => (n ? `${Math.round((a / n) * 100)}%` : "-");
  const sum = {
    label: String(args.label ?? "now"), at: new Date().toISOString(), n,
    starTop1: per.filter((x) => x.starTop1).length, starTop3: per.filter((x) => x.starRank <= 3).length, starMeanRank: n ? +(per.reduce((a, x) => a + x.starRank, 0) / n).toFixed(2) : null,
    scoreTop1: per.filter((x) => x.scoreTop1).length, randomTop1: n ? +(per.reduce((a, x) => a + 1 / x.n, 0) / n).toFixed(3) : null,
  };
  console.log(`物件出しの試験 A（🌟の並べ方）${sum.label}: 問題 ${n}・🌟の並べ方の1位 ${pct(sum.starTop1)}・3位以内 ${pct(sum.starTop3)}・平均の順位 ${sum.starMeanRank}・今の点の1位 ${pct(sum.scoreTop1)}・ランダム ${sum.randomTop1 != null ? Math.round(sum.randomTop1 * 100) + "%" : "-"}`);
  mkdirSync(join(DIR, "results"), { recursive: true });
  writeFileSync(join(DIR, "results", `${sum.label}.json`), JSON.stringify({ ...sum, per }, null, 1));
  if (args.baseline) {
    const prevPath = join(DIR, "results", `${args.baseline}.json`);
    if (!existsSync(prevPath)) throw new Error(`前の結果が無い: ${prevPath}`);
    const prev = JSON.parse(readFileSync(prevPath, "utf8")) as { per: typeof per };
    const pm = new Map(prev.per.map((x) => [x.id, x]));
    const worse = per.filter((x) => pm.get(x.id)?.starTop1 && !x.starTop1).map((x) => x.id);
    const better = per.filter((x) => pm.get(x.id) && !pm.get(x.id)!.starTop1 && x.starTop1).map((x) => x.id);
    console.log(`前（${args.baseline}）と比べて: 悪くなった ${worse.length}${worse.length ? `（${worse.join(",")}）` : ""}・良くなった ${better.length}`);
    if (worse.length) process.exitCode = 2;
  }
}

(async () => { if (args.build) await build(); else solve(); })().catch((e) => { console.error(e); process.exit(1); });
