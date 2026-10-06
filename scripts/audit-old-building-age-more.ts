// scripts/audit-old-building-age-more.ts
// 築年数が古すぎる物件の扱い（2026-10-06 竹内さん「築年数古すぎる物件はそもそもお客さんにささりにくい」）の残りの当て直し。
//   読むだけ・LLM なし・費用0・DB に書かない。🌟の記録の束での当て直しは scripts/audit-old-building-age.ts
//   A. 刺さった新着（基準 v2 の strong）: 築年の帯×お客様の型・古い半分／新しい半分（同じ向きか）
//   B. 売上サポの行（本番の 👑 と同じ材料・audit-recommend-score-pickups の回の組み方の写し）: オススメの点に築古の減点を足した案
//   C. 週の学習の回（loadEpisodes＝🌟の回・拡張の回・売上サポの回）: 判定の点（束に入れる段）に築古の減点を足した時の 1位・3位以内・相対順位
// 実行: npx tsx --env-file=.env.local scripts/audit-old-building-age-more.ts [--days=400] [--pkDays=60]
import { createClient } from "@supabase/supabase-js";
import { nameKey, bestBuildingMatch, toHalf } from "../app/lib/candidate-facts";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";
import { starSituationOf, type StarCandidate, type StarSituation } from "../app/lib/recommend-star-rank";
import { starCandidateOfPickup, starSituationFromConditions, starOpenRow, STAR_SITUATION_COLUMNS } from "../app/lib/star-rank-pickup";
import { overallPoints } from "../app/lib/pickup-best";
import { rankByRecommendScore, RECOMMEND_SCORE_RULE } from "../app/lib/recommend-score";
import { oldAgeApplies, oldAgePenalty } from "../app/lib/old-building-age";
import { loadEpisodes } from "../app/lib/scoring-learning-server";
import { loadHookMaterials } from "../app/lib/hooked-arrival-learning-server";
import { rankMetrics, splitHoldout, type Episode } from "../app/lib/scoring-learning";
import { baseReasonPoints } from "../app/lib/property-brain";
import { renovationOfText } from "../app/lib/listing-renovation";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "400"), 10);
const PK_DAYS = parseInt(String(args.pkDays ?? "60"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
type Row = Record<string, any>;
const D = 864e5, H = 36e5;
const P = (...x: unknown[]) => console.log(...x);
const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 100)}%` : "-");
const chunks = <T,>(xs: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };
const normRoom = (r: unknown) => toHalf(String(r ?? "")).replace(/[^0-9A-Za-z]/g, "").replace(/^0+(?=\d)/, "");
async function all(build: (a: number, b: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>, page = 500): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 200; p++) { const { data, error } = await build(p * page, p * page + page - 1); if (error) throw new Error(error.message); if (!data?.length) break; out = out.concat(data); if (data.length < page) break; }
  return out;
}
const band = (a: number | null | undefined) => a == null ? "?" : a <= 10 ? "≤10" : a <= 20 ? "11-20" : a <= 25 ? "21-25" : a <= 30 ? "26-30" : a <= 40 ? "31-40" : "41+";
const BANDS = ["≤10", "11-20", "21-25", "26-30", "31-40", "41+", "?"];
const COND_COLS = "id, building_age, preferences, ng_points, other_requests, additional_conditions, raw_format_text, floor_plan, initial_cost_limit, pet, walk_minutes, floor_area_min, move_in_time";

(async () => {
  const until = new Date().toISOString();
  // ─── A. 刺さった新着 ───
  const mats = await loadHookMaterials(sb as never, { until, days: DAYS });
  const pcOfSnap = new Map<number, string>();
  for (const c of chunks(mats.map((m) => m.snapshotId), 200)) { const { data } = await sb.from("recommendation_snapshots").select("id, property_customer_id").in("id", c); for (const r of (data ?? []) as Row[]) if (r.property_customer_id) pcOfSnap.set(Number(r.id), String(r.property_customer_id)); }
  const custA = new Map<string, Row>();
  for (const c of chunks([...new Set(pcOfSnap.values())], 80)) { const { data } = await sb.from("property_customers").select(COND_COLS).in("id", c); for (const r of (data ?? []) as Row[]) custA.set(String(r.id), r); }
  const sorted = mats.slice().sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  const half = Math.floor(sorted.length / 2);
  const tyOf = (m: (typeof mats)[number]) => !m.type ? "?" : `${m.type.household ? "二人以上" : "一人"}${m.type.initial ? "×初期" : ""}`;
  P(`=== A. 刺さった新着（基準 v2 strong・${DAYS}日・${mats.length}回）: 帯ごとの 刺さった/送った（率）===`);
  for (const [lab, xs] of [["全期間", sorted], ["古い半分", sorted.slice(0, half)], ["新しい半分", sorted.slice(half)]] as const) {
    for (const ty of ["ALL", "初期(全)", "初期でない", "一人×初期", "二人以上×初期"]) {
      const ms = xs.filter((m) => ty === "ALL" || (ty === "初期(全)" ? !!m.type?.initial : ty === "初期でない" ? m.type != null && !m.type.initial : tyOf(m) === ty));
      const s: Record<string, number> = {}, h: Record<string, number> = {};
      let oldS = 0, oldH = 0, newS = 0, newH = 0, oldOkS = 0, oldOkH = 0, renoOld = 0;
      for (const m of ms) {
        const a = m.facts.building_age as number | null | undefined; const b = band(a); s[b] = (s[b] ?? 0) + 1; const hit = m.level === "strong"; if (hit) h[b] = (h[b] ?? 0) + 1;
        const reno = renovationOfText(m.name) === true;
        if (a != null && a >= 31) { if (reno) { renoOld++; continue; } const cond = custA.get(pcOfSnap.get(m.snapshotId) ?? ""); if (cond && !oldAgeApplies(cond as never)) { oldOkS++; if (hit) oldOkH++; continue; } oldS++; if (hit) oldH++; }
        else if (a != null) { newS++; if (hit) newH++; }
      }
      P(`  ${lab.padEnd(6)} ${ty.padEnd(10)} n ${String(ms.length).padStart(3)} :: ` + BANDS.map((b) => `${b} ${h[b] ?? 0}/${s[b] ?? 0}`).join(" | ") + ` ‖ 築31以上（線の対象） ${oldH}/${oldS}=${pct(oldH, oldS)} ・築30以下 ${newH}/${newS}=${pct(newH, newS)} ・築31以上で気にしない/築年の列 ${oldOkH}/${oldOkS}・リノベ ${renoOld}`);
    }
  }
  P("  刺さった築31以上（目で見る）: " + mats.filter((m) => m.level === "strong" && (m.facts.building_age as number) >= 31).map((m) => `${m.name}（築${m.facts.building_age}・${tyOf(m)}・${m.signals.join("+")}）`).join(" ／ "));

  // ─── B. 売上サポの行 ───
  const untilMs = Date.now();
  const snaps = (await all((a, b) => sb.from("recommendation_snapshots").select("id, conversation_id, property_customer_id, sent_at, star_name, star_room, source")
    .gte("sent_at", new Date(untilMs - PK_DAYS * D).toISOString()).not("star_name", "is", null).order("id").range(a, b) as never)).filter((s) => s.conversation_id !== YUMA_CONVERSATION_ID && s.property_customer_id);
  const pcs = [...new Set(snaps.map((s) => String(s.property_customer_id)))];
  const picks: Row[] = [], custs = new Map<string, Row>();
  for (const c of chunks(pcs, 60)) {
    picks.push(...await all((a, b) => sb.from("property_pickups").select("id, batch_id, property_customer_id, created_at, rank, status, sent_at, recommended, property_name, room_no, verdict, score, reason_codes, image_analysis, terms, summary_text, ad_yen, equipment")
      .in("property_customer_id", c).gte("created_at", new Date(untilMs - (PK_DAYS + 5) * D).toISOString()).order("id").range(a, b) as never));
    const { data } = await sb.from("property_customers").select(`id, ${STAR_SITUATION_COLUMNS}, raw_format_text`).in("id", c);
    for (const r of (data ?? []) as Row[]) custs.set(String(r.id), r);
  }
  const pkOf = new Map<string, Row[]>(); for (const r of picks) { const k = String(r.property_customer_id); if (!pkOf.has(k)) pkOf.set(k, []); pkOf.get(k)!.push(r); }
  const dedupe = (rs: Row[]) => { const seen = new Set<string>(); return rs.filter((r) => { const k = `${nameKey(r.property_name)}#${normRoom(r.room_no)}`; if (seen.has(k)) return false; seen.add(k); return true; }); };
  type PEp = { at: string; star: Row; sent: Row[]; pool: Row[]; sit: StarSituation; ok: boolean; live: boolean };
  const eps: PEp[] = [];
  for (const s of snaps) {
    const t = Date.parse(s.sent_at); const pc = String(s.property_customer_id);
    const rows = (pkOf.get(pc) ?? []).filter((r) => Date.parse(r.created_at) <= t + 60_000 && Date.parse(r.created_at) >= t - 72 * H);
    if (!rows.length) continue;
    const star = bestBuildingMatch(String(s.star_name), s.star_room ?? null, rows, (r: Row) => r.property_name, (r: Row) => r.room_no);
    if (!star) continue;
    const sent = dedupe(rows.filter((r) => r.status === "sent" || r.sent_at)).filter((r) => r.id === star.id || nameKey(r.property_name) !== nameKey(star.property_name) || normRoom(r.room_no) !== normRoom(star.room_no));
    if (!sent.some((r) => r.id === star.id)) sent.push(star);
    const pool = dedupe(rows.filter((r) => r.verdict !== "drop" && typeof r.score === "number"));
    if (!pool.some((r) => r.id === star.id)) pool.push(star);
    const cond = custs.get(pc) ?? null;
    eps.push({ at: s.sent_at, star, sent, pool, sit: starSituationFromConditions(cond ? { ...cond, raw_format_text: null } as never : null) ?? starSituationOf({}), ok: oldAgeApplies(cond ? { ...cond, raw_format_text: null } as never : null), live: s.source === "live" });
  }
  eps.sort((a, b) => a.at.localeCompare(b.at));
  const toC = (r: Row): StarCandidate => starCandidateOfPickup(r as never, overallPoints(r as never) ?? 0);
  const poolOf = (rs: Row[]) => { const open = rs.filter((r) => starOpenRow(r as never)); return open.length ? open : rs; };
  type Pick = (e: PEp, rs: Row[]) => number | null;
  const Upk = (minAge: number | null, pts: number, scope: "all" | "initial"): Pick => (e, rs) => {
    const cs = poolOf(rs).map(toC);
    const k = rankByRecommendScore(cs, e.sit, { rule: { ...RECOMMEND_SCORE_RULE, oldAge: null }, extra: (c) => (minAge == null || !e.ok || (scope === "initial" && !e.sit.zero)) ? null : oldAgePenalty({ buildingAge: c.buildingAge, renovated: c.renovated }, { minAge, points: pts }) })[0]?.key;
    return k == null ? null : Number(k);
  };
  const base = Upk(null, 0, "all");
  P(`\n=== B. 売上サポの行（${PK_DAYS}日・🌟に結べた回 ${eps.length}・live ${eps.filter((e) => e.live).length}）: オススメの点に築古の減点 ===`);
  for (const which of ["pool", "sent"] as const) {
    const usable = eps.filter((e) => e[which].length >= 2);
    const cu = Math.floor(usable.length * 0.7);
    const ages = usable.flatMap((e) => e[which].map((r) => r.terms?.buildingAge)).filter((x) => typeof x === "number") as number[];
    P(`\n--- 束 ${which}（${usable.length}回・候補の築31以上 ${ages.filter((a) => a >= 31).length}/${ages.length}・🌟の築31以上 ${usable.filter((e) => (e.star.terms?.buildingAge ?? -1) >= 31).length}）: 前7割 ／ 後3割 ／ 全体 ・ 新だけ／旧だけ・違う ---`);
    const vs: Array<[string, Pick]> = [["U 今のオススメの点", base]];
    for (const sc of ["all", "initial"] as const) for (const m of [26, 30, 31, 36]) for (const p of [-10, -15, -25]) vs.push([`U＋${sc} 築${m}以上 ${p}`, Upk(m, p, sc)]);
    for (const [lab, f] of vs) {
      const hit = (e: PEp) => f(e, e[which]) === e.star.id;
      const rate = (xs: PEp[]) => `${pct(xs.filter(hit).length, xs.length)}(${xs.filter(hit).length}/${xs.length})`;
      let on = 0, oo = 0, diff = 0; const ex: string[] = [];
      for (const e of usable) { const a = base(e, e[which]), b = f(e, e[which]); if (a !== b) { diff++; const ra = e[which].find((r) => r.id === a), rb = e[which].find((r) => r.id === b); if (ex.length < 4) ex.push(`${ra?.property_name}(築${ra?.terms?.buildingAge ?? "?"})→${rb?.property_name}(築${rb?.terms?.buildingAge ?? "?"}) 🌟${e.star.property_name}(築${e.star.terms?.buildingAge ?? "?"})`); } const ha = a === e.star.id, hb = b === e.star.id; if (hb && !ha) on++; if (ha && !hb) oo++; }
      if (f !== base && diff === 0) continue;
      P(`  ${lab.padEnd(24)} ${rate(usable.slice(0, cu))} ／ ${rate(usable.slice(cu))} ／ ${rate(usable)} ・ ${on}／${oo}・違う ${diff}${lab === "U＋all 築31以上 -15" && ex.length ? `\n      例: ${ex.join(" ／ ")}` : ""}`);
    }
  }

  // ─── C. 週の学習の回（判定の点） ───
  const { episodes } = await loadEpisodes(sb as never, { until, days: DAYS });
  const pkBatches = [...new Set(episodes.filter((e) => e.source === "pickup").map((e) => e.id.slice(7)))];
  const pkAge = new Map<string, { age: number | null; reno: boolean | null }>();
  for (const c of chunks(pkBatches, 30)) {
    const { data } = await sb.from("property_pickups").select("batch_id, property_name, room_no, terms, summary_text").in("batch_id", c);
    for (const r of (data ?? []) as Row[]) pkAge.set(`${r.batch_id}|${r.property_name ?? ""}${r.room_no ? ` ${r.room_no}` : ""}`, { age: typeof r.terms?.buildingAge === "number" ? r.terms.buildingAge : null, reno: r.terms?.renovated === true || renovationOfText(r.property_name) === true || renovationOfText(r.summary_text) === true ? true : null });
  }
  const custC = new Map<string, Row>();
  for (const c of chunks([...new Set(episodes.map((e) => e.customerId).filter(Boolean) as string[])], 80)) { const { data } = await sb.from("property_customers").select(COND_COLS).in("id", c); for (const r of (data ?? []) as Row[]) custC.set(String(r.id), r); }
  const CODE = "__OLD_AGE_SIM";
  const withPen = (eps: Episode[], minAge: number, scope: "all" | "initial"): Episode[] => eps.map((e) => {
    const cond = e.customerId ? custC.get(e.customerId) : null;
    const on = !!cond && oldAgeApplies(cond as never) && (scope === "all" || !!e.ctype?.initial);
    return { ...e, cands: e.cands.map((c) => {
      const pk = e.source === "pickup" ? pkAge.get(`${e.id.slice(7)}|${c.key}`) : null;
      const age = e.source === "pickup" ? pk?.age ?? null : (c.feats.building_age ?? null);
      const reno = e.source === "pickup" ? pk?.reno ?? null : renovationOfText(c.key) === true ? true : null;
      const hit = on && oldAgePenalty({ buildingAge: age, renovated: reno }, { minAge, points: -1 }) != null;
      return hit ? { ...c, codes: [...c.codes, CODE] } : c;
    }) };
  });
  const fmtM = (m: ReturnType<typeof rankMetrics>) => `1位 ${(m.top1 * 100).toFixed(1)}%・3位以内 ${(m.top3 * 100).toFixed(1)}%・相対順位 ${m.relRank.toFixed(3)}（${m.episodes}回）`;
  P(`\n=== C. 週の学習の回（${DAYS}日・判定の点に築古の減点を足す）===`);
  const { train, holdout } = splitHoldout(episodes);
  for (const [lab, xs] of [["全体", episodes], ["前7割", train], ["後3割", holdout], ["🌟の回", episodes.filter((e) => e.source === "snapshot")], ["拡張の回", episodes.filter((e) => e.source === "pool")], ["売上サポの回", episodes.filter((e) => e.source === "pickup")]] as const) {
    P(`  ${lab}: 今 ${fmtM(rankMetrics(xs, baseReasonPoints))}`);
    for (const sc of ["all", "initial"] as const) for (const m of [26, 31]) for (const p of [-5, -10, -15]) {
      const w = { [CODE]: p };
      const ys = withPen(xs, m, sc);
      const touched = ys.filter((e) => e.cands.some((c) => c.codes.includes(CODE))).length;
      P(`    ${sc} 築${m}以上 ${p}: ${fmtM(rankMetrics(ys, baseReasonPoints, w))}・減点が付いた回 ${touched}`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
