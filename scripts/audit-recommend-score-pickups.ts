// scripts/audit-recommend-score-pickups.ts
// 「オススメの点の一番＝👑」の当て直しを本番の 👑 と同じ材料（売上サポの行 property_pickups・06e の保留の初期費用×AD2以上を含む）で（読むだけ・LLM なし・費用0・DB に書かない）。
//   回の組み方は scripts/audit-star-two-axis-pickups.ts の写し（そちらは触らない）。束 sent（スタッフが送った行）と pool（👑 を決める時と同じ待ちの行）。
//   案 F06e … 今の 👑（pickup-best.pickCustomerBest と同じ: starOpenRow の行 → rankStarCandidates）
//   案 F06d … 保留は候補にしない（06e の前）
//   案 U    … オススメの点（recommend-score.rankByRecommendScore・F06e と同じ行）＝F06e と同じ1位になるはず
//   案 A    … 判定の点（＋画像の加点）そのまま＋束の中の比べ＋状況（AD の点も全部入れる＝「ピックアップの点を状況で変えた点の1位」）
//   案 L    … 今までの並び（compareOverall・legacy）
// 実行: npx tsx --env-file=.env.local scripts/audit-recommend-score-pickups.ts [--days=60]
import { createClient } from "@supabase/supabase-js";
import { nameKey, bestBuildingMatch, toHalf } from "../app/lib/candidate-facts";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";
import { rankStarCandidates, STAR_RANK_RULE, STAR_SITUATION_RULE, starSituationOf, type StarCandidate, type StarSituation } from "../app/lib/recommend-star-rank";
import { starCandidateOfPickup, starSituationFromConditions, householdLayoutOf, STAR_SITUATION_COLUMNS } from "../app/lib/star-rank-pickup";
import { overallPoints, compareOverall } from "../app/lib/pickup-best";
import { customerWants } from "../app/lib/recommendation-gaps";
import { starOpenRow } from "../app/lib/star-rank-pickup";
import { rankByRecommendScore, RECOMMEND_SCORE_RULE } from "../app/lib/recommend-score";

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
  P(`=== 0. 物差し（${DAYS}日・🌟の記録 ${tried}）: 前72時間に売上サポの行なし ${noRows}・🌟を行に結べない ${noMatch}・結べた回 ${eps.length}（live ${eps.filter((e) => e.live).length}）===`);
  const toC = (r: Row): StarCandidate => starCandidateOfPickup(r as never, overallPoints(r as never) ?? 0);
  type Pick = (e: Ep, rs: Row[]) => number | null;
  const poolOf = (rs: Row[], soft: boolean) => { const open = rs.filter((r) => (soft ? starOpenRow(r as never) : r.verdict !== "hold")); return open.length ? open : rs; };
  const F = (soft: boolean): Pick => (e, rs) => { const k = rankStarCandidates(poolOf(rs, soft).map(toC), STAR_RANK_RULE, e.sit, STAR_SITUATION_RULE)[0]?.key; return k == null ? null : Number(k); };
  const U = (adScale: number): Pick => (e, rs) => {
    const cs = poolOf(rs, true).map(toC);
    const k = rankByRecommendScore(cs, e.sit, { rule: RECOMMEND_SCORE_RULE, extra: (c) => { const ad = c.codes.filter((x) => /^(AD_|PROFIT_)/.test(x)).reduce((a, x) => a + c.pointsOf(x), 0); return adScale ? { points: adScale * ad - (adScale ? RECOMMEND_SCORE_RULE.adLinePoints * (c.adMonths != null && c.adMonths >= RECOMMEND_SCORE_RULE.adLine ? 1 : 0) : 0), label: "AD の点" } : null; } })[0]?.key;
    return k == null ? null : Number(k);
  };
  const L: Pick = (_e, rs) => rs.slice().sort(compareOverall as never)[0]?.id ?? null;
  const variants: Array<[string, Pick]> = [["F06e 今の👑", F(true)], ["F06d（保留は候補にしない）", F(false)], ["U オススメの点", U(0)], ["A 判定の点そのまま＋比べ＋状況", U(1)], ["A½ AD の点を半分", U(0.5)], ["L 今までの並び（legacy）", L]];
  const cut = Math.floor(eps.length * 0.7);
  for (const which of ["pool", "sent"] as const) {
    P(`\n--- 束 ${which}: 前7割 ／ 後3割 ／ live ／ 全体 ・ F06e と比べて 新だけ当たり／旧だけ当たり・1位が違う回 ---`);
    const usable = eps.filter((e) => e[which].length >= 2);
    const rnd = (xs: Ep[]) => { const s = xs.reduce((a, e) => a + 1 / e[which].length, 0); return `${pct(s, xs.length)}(${xs.length})`; };
    P(`  ランダム: ${rnd(usable.slice(0, Math.floor(usable.length * 0.7)))} ／ ${rnd(usable.slice(Math.floor(usable.length * 0.7)))} ／ ${rnd(usable.filter((e) => e.live))} ／ ${rnd(usable)}`);
    for (const [lab, f] of variants) {
      const hit = (e: Ep) => f(e, e[which]) === e.star.id;
      const rate = (xs: Ep[]) => `${pct(xs.filter(hit).length, xs.length)}(${xs.filter(hit).length}/${xs.length})`;
      let on = 0, oo = 0, diff = 0;
      for (const e of usable) { const a = F(true)(e, e[which]), b = f(e, e[which]); if (a !== b) diff++; const ha = a === e.star.id, hb = b === e.star.id; if (hb && !ha) on++; if (ha && !hb) oo++; }
      const cu = Math.floor(usable.length * 0.7);
      P(`  ${lab.padEnd(26)} ${rate(usable.slice(0, cu))} ／ ${rate(usable.slice(cu))} ／ ${rate(usable.filter((e) => e.live))} ／ ${rate(usable)} ・ ${on}／${oo}・違う ${diff}`);
    }
  }
  void cut;
})().catch((e) => { console.error(e); process.exit(1); });
