// scripts/audit-star-two-axis-pickups.ts
// 🌟の2軸（刺さり×AD）を「本番の 👑 と同じ材料」＝売上サポの束の行（property_pickups・AD がほぼ全部分かる）で当て直す（読むだけ・LLM なし・費用0・DB に書かない）。
//   scripts/audit-star-two-axis.ts は🌟の記録の束（送った画像）で測るので AD が 8 割分からない（画像に AD は載らない）。こちらは本番の 👑 の材料そのもの。
// 回: スタッフの🌟（recommendation_snapshots の star_name）を、そのお客様の🌟の前72時間の売上サポの行に結べた回。
//   束 sent … その回にスタッフが送った行（status sent／sent_at あり）＝🌟を選んだ束
//   束 pool … 👑 を決める時と同じ「待ちの行」（外す候補を除く・送る前の束全部）
// ■ 正解はスタッフが🌟にした事実・個人情報は出さない（物件名は出す）・YUMA は外す
//
// 実行: npx tsx --env-file=.env.local scripts/audit-star-two-axis-pickups.ts [--days=60] [--show=10]
import { createClient } from "@supabase/supabase-js";
import { nameKey, bestBuildingMatch, toHalf } from "../app/lib/candidate-facts";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";
import { rankStarCandidates, STAR_RANK_RULE, STAR_SITUATION_RULE, starSituationOf, type StarCandidate, type StarSituation } from "../app/lib/recommend-star-rank";
import { starCandidateOfPickup, starSituationFromConditions, householdLayoutOf, STAR_SITUATION_COLUMNS } from "../app/lib/star-rank-pickup";
import { overallPoints, compareOverall } from "../app/lib/pickup-best";
import { customerWants } from "../app/lib/recommendation-gaps";
import { HOLD_REASON_CODES } from "../app/lib/property-brain";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "60"), 10);
const SHOW = parseInt(String(args.show ?? "10"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
type Row = Record<string, any>;
const D = 864e5, H = 36e5;
const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 100)}%` : "-");
const chunks = <T,>(xs: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };
const normRoom = (r: unknown) => toHalf(String(r ?? "")).replace(/[^0-9A-Za-z]/g, "").replace(/^0+(?=\d)/, "");
async function all(build: (a: number, b: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>, page = 500): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 200; p++) { const { data, error } = await build(p * page, p * page + page - 1); if (error) throw new Error(error.message); if (!data?.length) break; out = out.concat(data); if (data.length < page) break; }
  return out;
}

type Ep = { at: string; star: Row; sent: Row[]; pool: Row[]; sit: StarSituation; sitBoth: StarSituation; condW: Set<string>; msgW: Set<string>; live: boolean };

(async () => {
  const until = Date.now();
  const snaps = (await all((a, b) => sb.from("recommendation_snapshots").select("id, conversation_id, property_customer_id, sent_at, star_name, star_room, star_text, candidate_count, source")
    .gte("sent_at", new Date(until - DAYS * D).toISOString()).not("star_name", "is", null).order("id").range(a, b) as never)).filter((s) => s.conversation_id !== YUMA_CONVERSATION_ID && s.property_customer_id);
  const pcs = [...new Set(snaps.map((s) => String(s.property_customer_id)))];
  const picks: Row[] = [], custs = new Map<string, Row>(), msgs: Row[] = [];
  for (const c of chunks(pcs, 60)) {
    picks.push(...await all((a, b) => sb.from("property_pickups").select("id, batch_id, property_customer_id, created_at, rank, status, sent_at, recommended, property_name, room_no, verdict, score, reason_codes, image_analysis, terms, summary_text, ad_yen, equipment")
      .in("property_customer_id", c).gte("created_at", new Date(until - (DAYS + 5) * D).toISOString()).order("id").range(a, b) as never));
    const { data } = await sb.from("property_customers").select(`id, ${STAR_SITUATION_COLUMNS}`).in("id", c);
    for (const r of (data ?? []) as Row[]) custs.set(String(r.id), r);
  }
  const convs = [...new Set(snaps.map((s) => String(s.conversation_id)))];
  for (const c of chunks(convs, 50)) msgs.push(...await all((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at").in("conversation_id", c).eq("sender", "customer").gte("created_at", new Date(until - (DAYS + 60) * D).toISOString()).order("id").range(a, b) as never, 1000));
  const pkOf = new Map<string, Row[]>(); for (const r of picks) { const k = String(r.property_customer_id); if (!pkOf.has(k)) pkOf.set(k, []); pkOf.get(k)!.push(r); }
  const mOf = new Map<string, Row[]>(); for (const m of msgs) { const k = String(m.conversation_id); if (!mOf.has(k)) mOf.set(k, []); mOf.get(k)!.push(m); }

  const dedupe = (rs: Row[]) => { const seen = new Set<string>(); return rs.filter((r) => { const k = `${nameKey(r.property_name)}#${normRoom(r.room_no)}`; if (seen.has(k)) return false; seen.add(k); return true; }); };
  const eps: Ep[] = []; let tried = 0, noRows = 0, noMatch = 0;
  for (const s of snaps) {
    const t = Date.parse(s.sent_at); const pc = String(s.property_customer_id);
    const rows = (pkOf.get(pc) ?? []).filter((r) => Date.parse(r.created_at) <= t + 60_000 && Date.parse(r.created_at) >= t - 72 * H);
    tried++;
    if (!rows.length) { noRows++; continue; }
    const star = bestBuildingMatch(String(s.star_name), s.star_room ?? null, rows, (r: Row) => r.property_name, (r: Row) => r.room_no);
    if (!star) { noMatch++; continue; }
    const sent = dedupe(rows.filter((r) => r.status === "sent" || r.sent_at)).filter((r) => r.id === star.id || nameKey(r.property_name) !== nameKey(star.property_name) || normRoom(r.room_no) !== normRoom(star.room_no));
    if (!sent.some((r) => r.id === star.id)) sent.push(star);
    const pool = dedupe(rows.filter((r) => r.verdict !== "drop" && typeof r.score === "number"));
    if (!pool.some((r) => r.id === star.id)) pool.push(star);
    const cond = custs.get(pc) ?? null;
    const sit = starSituationFromConditions(cond as never) ?? starSituationOf({});
    const mt = (mOf.get(String(s.conversation_id)) ?? []).filter((m) => Date.parse(m.created_at) < t && Date.parse(m.created_at) > t - 60 * D).map((m) => String(m.text ?? ""));
    const condW = new Set(customerWants({ conditions: cond as never }).map((w) => String(w.key)));
    const msgW = new Set(customerWants({ messages: mt }).map((w) => String(w.key)));
    const sitBoth = starSituationOf({ wantTopics: [...condW, ...msgW], household: householdLayoutOf(cond?.floor_plan) });
    eps.push({ at: s.sent_at, star, sent, pool, sit, sitBoth, condW, msgW, live: s.source === "live" });
  }
  eps.sort((a, b) => a.at.localeCompare(b.at));
  const P = (...x: unknown[]) => console.log(...x);
  P(`=== 0. 物差し（${DAYS}日・🌟の記録 ${tried}）: 前72時間に売上サポの行なし ${noRows}・🌟を行に結べない ${noMatch}・結べた回 ${eps.length} ===`);

  const toC = (r: Row, extra = 0): StarCandidate => { const c = starCandidateOfPickup(r as never, (overallPoints(r as never) ?? 0) + extra); return c; };
  type Pick = (e: Ep, rs: Row[]) => number | null;
  // 保留の札（property-brain の isHoldCode と同じ）
  const holdCodes = (r: Row) => ((r.reason_codes ?? []) as string[]).filter((c) => HOLD_REASON_CODES.has(c) || /^(?:IMAGE|EQUIP|CONDITION)_.*_NG$/.test(c));
  /** 開いた行: soft＝保留の理由が「初期費用が0でない」だけの行も開く（adMin があれば AD がそれ以上の時だけ） */
  type OpenRule = { soft: boolean; adMin?: number; zeroAd?: number };
  const isOpen = (r: Row, o: OpenRule) => r.verdict !== "hold" || (o.soft && holdCodes(r).length > 0 && holdCodes(r).every((c) => c === "INITIAL_COST_NOT_ZERO") && (o.adMin == null || (toC(r).adMonths ?? 0) >= o.adMin));
  const cur = (rule: Partial<typeof STAR_RANK_RULE> = {}, sitOf: (e: Ep) => StarSituation = (e) => e.sit, extra?: (e: Ep, rs: Row[]) => (r: Row) => number, openRule: OpenRule = { soft: false }): Pick => (e, rs) => {
    const ex = extra ? extra(e, rs) : null;
    const open = rs.filter((r) => isOpen(r, openRule)); const pool = open.length ? open : rs;
    const k = rankStarCandidates(pool.map((r) => { const c = toC(r, ex ? ex(r) : 0); if (openRule.zeroAd != null && sitOf(e).zero && c.zeroZero === false && (c.adMonths ?? 0) >= openRule.zeroAd) c.zeroZero = true; return c; }), { ...STAR_RANK_RULE, ...rule }, sitOf(e), STAR_SITUATION_RULE)[0]?.key;
    return k == null ? null : Number(k);
  };
  const legacy: Pick = (_e, rs) => rs.slice().sort(compareOverall as never)[0]?.id ?? null;
  const pieces = (e: Ep, rs: Row[]) => { const open = rs.filter((r) => r.verdict !== "hold"); const pool = open.length ? open : rs; const cs = pool.map((r) => toC(r)); const rk = rankStarCandidates(cs, STAR_RANK_RULE, e.sit, STAR_SITUATION_RULE); const fit = new Map(rk.map((x) => [x.key, x.fit])); return cs.map((c) => ({ id: Number(c.key), fit: fit.get(c.key)!, ad: c.adMonths ?? null, never: c.adMonths != null && c.adMonths < 1 })); };
  const pctRank = (vals: Array<number | null>, v: number | null) => { const xs = vals.filter((x): x is number => x != null); if (v == null || xs.length < 2) return 0.5; return xs.filter((x) => x < v).length / (xs.length - 1) + 0.5 * (xs.filter((x) => x === v).length - 1) / (xs.length - 1); };
  const fitThenAd = (m: number): Pick => (e, rs) => { const ps = pieces(e, rs).filter((p) => !p.never); const pool = ps.length ? ps : pieces(e, rs); const mx = Math.max(...pool.map((p) => p.fit)); return pool.filter((p) => p.fit >= mx - m).sort((a, b) => (b.ad ?? -1) - (a.ad ?? -1) || b.fit - a.fit)[0]?.id ?? null; };
  const adThenFit = (m: number): Pick => (e, rs) => { const ps = pieces(e, rs); const kn = ps.filter((p) => p.ad != null); if (!kn.length) return ps.sort((a, b) => b.fit - a.fit)[0]?.id ?? null; const mx = Math.max(...kn.map((p) => p.ad!)); return kn.filter((p) => p.ad! >= mx - m).sort((a, b) => b.fit - a.fit)[0]?.id ?? null; };
  const borda = (a: number): Pick => (e, rs) => { const ps = pieces(e, rs); const fs = ps.map((p) => p.fit), as = ps.map((p) => p.ad); return ps.map((p) => ({ id: p.id, s: a * pctRank(fs, p.fit) + (1 - a) * pctRank(as, p.ad) - (p.never ? 1 : 0) })).sort((x, y) => y.s - x.s)[0]?.id ?? null; };
  const linear = (w: number): Pick => (e, rs) => pieces(e, rs).map((p) => ({ id: p.id, s: p.fit + w * Math.min(p.ad ?? 1.5, 3) - (p.never ? 100 : 0) })).sort((x, y) => y.s - x.s)[0]?.id ?? null;
  // 刺さり: 本人の要望（条件欄・会話）に合う数（行の事実）
  const factYes = (c: StarCandidate, cs: StarCandidate[]) => {
    const m = new Map<string, boolean>();
    if (c.zeroZero != null) { m.set("zero_deposit", c.zeroZero); m.set("low_initial", c.zeroZero); }
    if (c.walkMinutes != null) m.set("station_near", c.walkMinutes <= 7);
    if (c.buildingAge != null) m.set("new_build", c.buildingAge <= 10 || c.renovated === true);
    const ar = cs.map((x) => x.areaSqm).filter((v): v is number => v != null).sort((a, b) => a - b); if (c.areaSqm != null && ar.length >= 2) m.set("spacious", c.areaSqm >= ar[Math.floor(ar.length / 2)]);
    if (c.floor != null) m.set("floor2", c.floor >= 2);
    if (c.structure) m.set("quiet", /^(RC|SRC)$/.test(c.structure));
    for (const k of c.equipmentKeys ?? []) m.set(({ net_free: "internet", south: "sunny", walk_in_closet: "storage", monitor_intercom: "security" } as Record<string, string>)[k] ?? k, true);
    return m;
  };
  const wantExtra = (src: "cond" | "msg" | "both", k: number) => (e: Ep, rs: Row[]) => { const W = src === "cond" ? e.condW : src === "msg" ? e.msgW : new Set([...e.condW, ...e.msgW]); const cs = rs.map((r) => toC(r)); const sc = cs.map((c) => { const m = factYes(c, cs); let s = 0; for (const w of W) { const v = m.get(w); if (v === true) s++; else if (v === false) s--; } return s; }); const mx = Math.max(...sc); const split = new Set(sc).size > 1; const by = new Map(rs.map((r, i) => [r.id, sc[i]])); return (r: Row) => (split && by.get(r.id) === mx ? k : 0); };

  for (const bundle of ["sent", "pool"] as const) {
    const M = eps.filter((e) => e[bundle].length >= 2);
    const cut = Math.floor(M.length * 0.7), train = M.slice(0, cut), test = M.slice(cut);
    const hit = (p: Pick, e: Ep) => p(e, e[bundle]) === e.star.id;
    const rate = (p: Pick, xs: Ep[]) => `${pct(xs.filter((e) => hit(p, e)).length, xs.length)}(${xs.filter((e) => hit(p, e)).length}/${xs.length})`;
    const rnd = (xs: Ep[]) => `${pct(xs.reduce((a, e) => a + 1 / e[bundle].length, 0), xs.length)}`;
    const CUR = cur();
    const row = (name: string, p: Pick) => { let on = 0, oo = 0; for (const e of M) { const a = hit(CUR, e), b = hit(p, e); if (b && !a) on++; if (a && !b) oo++; } return `  ${name.padEnd(30)} ${rate(p, train)} ／ ${rate(p, test)} ／ ${rate(p, M)} ・ ${on}／${oo}`; };
    P(`\n=== 束 ${bundle}（${bundle === "sent" ? "スタッフが送った行" : "👑 を決める待ちの行"}）: 回 ${M.length}・束の大きさ中央 ${M.map((e) => e[bundle].length).sort((a, b) => a - b)[Math.floor(M.length / 2)] ?? "-"} ===`);
    // A: AD の位置
    let kn = 0, mx = 0, rmx = 0, unkStar = 0, l15 = 0, l15b = 0, l2 = 0, l2b = 0, prs = 0, adUnkC = 0, allC = 0;
    for (const e of M) {
      const cs = e[bundle].map((r) => toC(r)); allC += cs.length; adUnkC += cs.filter((c) => c.adMonths == null).length;
      const sa = toC(e.star).adMonths; if (sa == null) { unkStar++; continue; }
      const ks = cs.map((c) => c.adMonths).filter((v): v is number => v != null);
      if (sa >= 1.5) l15++; l15b += ks.filter((v) => v >= 1.5).length / ks.length; if (sa >= 2) l2++; l2b += ks.filter((v) => v >= 2).length / ks.length;
      if (new Set(ks).size < 2) continue; kn++; const m = Math.max(...ks); if (sa === m) mx++; rmx += ks.filter((v) => v === m).length / ks.length; prs += pctRank(ks, sa);
    }
    const nk = M.length - unkStar;
    P(`  A. AD 不明の候補 ${pct(adUnkC, allC)}（${adUnkC}/${allC}）・🌟の AD 不明 ${unkStar}`);
    P(`     🌟が AD1.5以上 ${pct(l15, nk)}（束の平均 ${pct(l15b, nk)}）・AD2以上 ${pct(l2, nk)}（束 ${pct(l2b, nk)}）`);
    P(`     AD が割れた回 ${kn}: 🌟が束の一番の AD ${pct(mx, kn)}（ランダム ${pct(rmx, kn)}）・🌟の AD の順位 平均 ${(prs / Math.max(1, kn)).toFixed(2)}（ランダム 0.50）`);
    P(`  C. 前7割 ／ 後3割 ／ 全体 ・ 今と比べて 新だけ当たり／旧だけ当たり（ランダム ${rnd(train)} ／ ${rnd(test)} ／ ${rnd(M)}）`);
    P(row("今（06d）", CUR));
    P(row("今までの点の1位（legacy）", legacy));
    for (const L of [1, 2]) P(row(`線 ${L}`, cur({ adLine: L })));
    P(row("差の上書き なし", cur({ overrideMargin: 999 })));
    P(row("差の上書き 25", cur({ overrideMargin: 25 })));
    for (const m of [5, 10, 15, 20]) P(row(`合い方 −${m} 以内 → AD`, fitThenAd(m)));
    for (const m of [0, 0.5]) P(row(`AD −${m} 以内 → 合い方`, adThenFit(m)));
    for (const a of [0.6, 0.8]) P(row(`順位 a=${a}`, borda(a)));
    for (const w of [5, 10, 20]) P(row(`合い方＋${w}×AD`, linear(w)));
    P(row("状況を条件欄＋会話から", cur({}, (e) => e.sitBoth)));
    P(row("保留（初期費用だけ）も👑の候補に", cur({}, (e) => e.sit, undefined, { soft: true })));
    P(row("同・AD1.5以上の時だけ", cur({}, (e) => e.sit, undefined, { soft: true, adMin: 1.5 })));
    P(row("同・AD2以上の時だけ", cur({}, (e) => e.sit, undefined, { soft: true, adMin: 2 })));
    P(row("初期費用の希望: AD2以上は敷礼0扱い", cur({}, (e) => e.sit, undefined, { soft: false, zeroAd: 2 })));
    P(row("同＋保留（初期費用だけ・AD2以上）も候補", cur({}, (e) => e.sit, undefined, { soft: true, adMin: 2, zeroAd: 2 })));
    P(row("同 AD1.5以上は敷礼0扱い＋保留も", cur({}, (e) => e.sit, undefined, { soft: true, adMin: 1.5, zeroAd: 1.5 })));
    for (const k of [5, 10]) for (const src of ["cond", "both"] as const) P(row(`要望に一番合う +${k}（${src}）`, cur({}, (e) => e.sit, wantExtra(src, k))));
    // D. ずれ
    const why: Record<string, number> = {}; let miss = 0; const ex: string[] = [];
    for (const e of M) {
      if (hit(CUR, e)) continue; miss++;
      const rs = e[bundle]; const open = rs.filter((r) => r.verdict !== "hold"); const pool = open.length ? open : rs;
      const rk = rankStarCandidates(pool.map((r) => toC(r)), STAR_RANK_RULE, e.sit, STAR_SITUATION_RULE);
      const st = rk.find((x) => Number(x.key) === e.star.id), tp = rk[0];
      let k: string;
      if (!st) k = "🌟が保留（通すがある時は候補外）";
      else if (st.tier !== tp.tier) k = toC(e.star).adMonths == null ? "段: 🌟の AD 不明" : st.tier === "never" ? "段: 🌟が AD1未満" : "段: 🌟の AD が線の下";
      else if (st.fit === tp.fit) k = "同じ段・同点";
      else k = "同じ段・🌟の合い方が下";
      why[k] = (why[k] ?? 0) + 1;
      if (ex.length < SHOW && st) { const top = rs.find((r) => r.id === Number(tp.key))!; ex.push(`   ${e.at.slice(0, 10)} 🌟 ${e.star.property_name} ${e.star.room_no ?? ""}（AD${toC(e.star).adMonths ?? "?"}・合い方${st.fit.toFixed(0)}）↔ 1位 ${top.property_name} ${top.room_no ?? ""}（AD${toC(top).adMonths ?? "?"}・合い方${tp.fit.toFixed(0)}・${tp.reasons.slice(0, 3).join("・")}）`); }
    }
    P(`  D. ずれ ${miss}: ` + Object.entries(why).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・"));
    for (const x of ex) P(x);
  }
})().catch((e) => { console.error(e); process.exit(1); });
